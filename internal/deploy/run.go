package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// defaultWorkers is used by Run when called with workers <= 0. Callers
// (main.go's runDeploy) are expected to pass an explicit value (16 — see
// spec §8: 10k files must not upload one-at-a-time), but Run defends against
// a zero/negative value rather than deadlocking on a worker pool of size 0.
const defaultWorkers = 16

// Uploader is the subset of BunnyClient that Run depends on: putting a
// file's bytes at a path, removing a path, and purging the CDN cache once a
// deploy's worth of changes has landed. Defining the interface here (rather
// than depending on the concrete *BunnyClient type) lets tests inject an
// in-memory fake that records calls and can be told to fail a specific
// upload, without any network or Bunny.net credentials; *BunnyClient
// satisfies it with no changes required on that side.
type Uploader interface {
	Upload(ctx context.Context, relPath string, data []byte) error
	Delete(ctx context.Context, relPath string) error
	Purge(ctx context.Context) error
}

var _ Uploader = (*BunnyClient)(nil)

// Run executes one deploy: load the manifest saved after the previous
// deploy, diff it against distDir (Plan), upload every changed/new file,
// delete every file that's no longer in distDir, purge the CDN, and persist
// the new manifest — in that order, because each step's safety depends on
// the one before it having fully succeeded first.
//
// Ordering invariants (why they matter, not just what they are):
//
//   - Uploads happen before the manifest is saved, and the manifest is
//     saved only if every upload succeeded. If upload N of 50 fails, Run
//     returns before touching the manifest file at all — the next `deploy`
//     run reads the SAME old manifest, re-runs Plan against it, and
//     naturally retries exactly the files that never made it up (the ones
//     that did upload now hash-match distDir and re-diff as unchanged).
//     Saving a manifest that claims files were uploaded when some weren't
//     would silently drop those files from every future deploy's diff.
//   - Deletes happen after uploads succeed but are themselves also
//     upload-equivalent for this invariant: a failed Delete aborts before
//     the manifest is saved too, for the same reason — newManifest already
//     has that key removed (Plan doesn't include still-referenced files in
//     deletes), so if the manifest were saved anyway, the next run's diff
//     would never re-attempt the delete and the file would be orphaned on
//     Bunny.net forever.
//   - Purge happens before the manifest save and is skipped entirely both on
//     any failure above AND on a genuine no-op deploy (uploads and deletes
//     both empty). If purge fails, the old manifest remains authoritative so
//     the next run repeats the diff and retries the purge instead of silently
//     accepting a stale CDN cache.
//
// Concurrency: uploads run across a bounded worker pool (workers goroutines,
// stdlib sync.WaitGroup + a jobs channel — no unbounded goroutine spawn
// regardless of how many files changed). Deletes run sequentially after all
// uploads complete; a deploy's delete list is normally tiny (files removed
// from the site) so this needs no pool of its own.
func Run(ctx context.Context, client Uploader, distDir, manifestPath string, workers int, log func(string, ...any)) error {
	if log == nil {
		log = func(string, ...any) {}
	}
	if workers <= 0 {
		workers = defaultWorkers
	}

	oldManifest, err := LoadManifest(manifestPath)
	if err != nil {
		return fmt.Errorf("deploy: load manifest %s: %w", manifestPath, err)
	}

	uploads, deletes, newManifest, err := Plan(distDir, oldManifest)
	if err != nil {
		return fmt.Errorf("deploy: plan %s: %w", distDir, err)
	}

	if len(uploads) == 0 && len(deletes) == 0 {
		log("deploy: nothing to deploy — %s matches the last deployed manifest", distDir)
		return nil
	}

	if err := uploadAll(ctx, client, distDir, uploads, workers); err != nil {
		return fmt.Errorf("deploy: aborted, manifest not saved, CDN not purged: %w", err)
	}

	for _, rel := range deletes {
		if err := client.Delete(ctx, rel); err != nil {
			return fmt.Errorf("deploy: delete %s: aborted, manifest not saved, CDN not purged: %w", rel, err)
		}
	}

	if err := client.Purge(ctx); err != nil {
		return fmt.Errorf("deploy: purge failed, manifest not saved (files may be live with stale CDN cache; re-run to retry): %w", err)
	}

	if err := SaveManifest(manifestPath, newManifest); err != nil {
		return fmt.Errorf("deploy: save manifest %s (uploads, deletes, and purge already applied — re-run to persist state): %w", manifestPath, err)
	}

	log("deploy: uploaded %d, deleted %d, purged", len(uploads), len(deletes))
	return nil
}

// uploadAll reads each upload's bytes from distDir and calls client.Upload,
// spread across a bounded pool of `workers` goroutines. On the first
// failure (a disk read or an Upload call), it cancels a context private to
// this phase so idle workers stop picking up further queued jobs, then
// returns that first error once every already-dispatched goroutine has
// finished. The cancellation is scoped to a child of ctx, not ctx itself, so
// it has no effect on the deletes/purge that Run performs afterward on
// success.
func uploadAll(ctx context.Context, client Uploader, distDir string, uploads []string, workers int) error {
	phaseCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan string, len(uploads))
	for _, rel := range uploads {
		jobs <- rel
	}
	close(jobs)

	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	recordErr := func(err error) {
		mu.Lock()
		defer mu.Unlock()
		if firstErr == nil {
			firstErr = err
			cancel()
		}
	}

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for rel := range jobs {
				select {
				case <-phaseCtx.Done():
					continue // drain remaining jobs without doing new work
				default:
				}

				data, err := os.ReadFile(filepath.Join(distDir, filepath.FromSlash(rel)))
				if err != nil {
					recordErr(fmt.Errorf("read %s: %w", rel, err))
					continue
				}
				if err := client.Upload(phaseCtx, rel, data); err != nil {
					recordErr(fmt.Errorf("upload %s: %w", rel, err))
					continue
				}
			}
		}()
	}
	wg.Wait()

	return firstErr
}

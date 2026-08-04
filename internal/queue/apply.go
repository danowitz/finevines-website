package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// Store is the subset of the Bunny storage zone a drain needs: read a file,
// write a file, delete a file. Declared here rather than depending on
// *deploy.BunnyClient so tests inject an in-memory fake with no network and no
// credentials — the same reasoning as internal/deploy.Uploader.
// *deploy.BunnyClient satisfies it unchanged (asserted in
// cmd/finevines/applyqueue.go).
type Store interface {
	Download(ctx context.Context, relPath string) ([]byte, error)
	Upload(ctx context.Context, relPath string, data []byte) error
	Delete(ctx context.Context, relPath string) error
}

// TextEnricher regenerates a wine's catalog prose with a reviewer's note
// appended to the prompt. *enrich.OpenAIEnricher satisfies it.
type TextEnricher interface {
	EnrichWithNote(ctx context.Context, w salesforce.WineRaw, note string) (enrich.EnrichResult, error)
}

// Normalizer re-composes a candidate image onto the catalog's fixed 600x900
// canvas — the same tools/imgnorm step tools/labelfetch/import.mjs runs, so a
// console swap and a nightly import produce identical geometry and the
// portfolio grid does not start jostling wherever a human intervened.
type Normalizer interface {
	Normalize(ctx context.Context, srcPath, dstPath string) error
}

// Input is everything one drain needs. A struct rather than an argument list
// because that list is eleven values long, and both callers — main.go and the
// tests — would otherwise have to keep them in the same order by hand.
type Input struct {
	Store   Store
	Texts   TextEnricher
	Norm    Normalizer
	Actions []Action
	Wines   []model.Wine
	Ledger  Ledger
	Flags   []Flag
	// ImgDir is the on-disk catalog image directory (assets/img/wines).
	ImgDir string
	// CandidateDir is the storage-zone prefix the console stages candidate
	// images under (_review/candidates). Payload.Candidate is relative to it.
	CandidateDir string
	// QueuePath is the storage-zone path of the queue file itself, deleted once
	// the drain has finished (_review/queue.json).
	QueuePath string
	// RunID names the archive copy of the batch (see archiveBatch). The workflow
	// passes GITHUB_RUN_ID so an archive can be traced to the run that read it;
	// empty falls back to a timestamp derived from Now, so a local invocation
	// still produces a distinct, sortable name.
	RunID string
	Now   time.Time
	Log   func(string, ...any)
}

// Result is what one drain changed. Wines and Ledger are the new values to
// persist; Applied is only THIS run's entries, which is what the digest email
// reports (the ledger holds every entry ever).
type Result struct {
	Wines   []model.Wine
	Ledger  Ledger
	Flags   []Flag
	Applied []Applied
	Skipped int
}

// Apply drains in.Actions against in.Wines.
//
// Order and failure handling, both load-bearing:
//
//   - Actions already in the ledger are skipped without calling anything. That
//     is the idempotency guarantee: a run that crashes halfway through a drain,
//     or a second repository_dispatch fired for the same batch, re-reads the
//     same queue and applies nothing twice.
//   - A per-action failure is logged and that action is left OUT of the ledger,
//     so the next run retries it. It does not abort the drain: one unreachable
//     candidate image must not strand the other four reviewers' fixes.
//   - An action naming a SKU the catalog does not hold IS ledgered, with the
//     reason. Leaving it unrecorded would have every future run retry it
//     forever and the queue would never drain.
//   - The batch is ARCHIVED to the storage zone before a single action is
//     applied. The ledger and the catalog only reach the repo at the run's
//     commit-back, several steps later; if enrich, the image stage, build or
//     deploy fails in between, the run dies with the queue already deleted and
//     nothing persisted, and the reviewer's correction exists nowhere. The
//     archive is the copy that survives that — see archiveBatch. An archive that
//     cannot be written aborts the drain before any side effect: applying work we
//     could not first copy aside is the exact trade this exists to refuse.
//   - The queue file is deleted last, only if there was anything in it, and ONLY
//     when every action either applied or was skipped. A batch containing a
//     failure leaves the queue in place: keeping the action out of the ledger is
//     only half of "the next run retries it" — if the queue were cleared anyway
//     there would be nothing left to retry FROM, and a 502 on one reviewer's
//     candidate download would lose their correction permanently. Re-reading a
//     queue whose healthy actions already landed is free: the ledger skips them.
//     Deleting rather than truncating is safe even though the console may append
//     mid-drain: the console rewrites the whole file, so an action that
//     reappears is simply re-read next run and skipped by the ledger.
func Apply(ctx context.Context, in Input) (Result, error) {
	log := in.Log
	if log == nil {
		log = func(string, ...any) {}
	}

	res := Result{Wines: append([]model.Wine(nil), in.Wines...), Ledger: in.Ledger, Flags: in.Flags}
	if len(in.Actions) == 0 {
		return res, nil
	}

	if err := archiveBatch(ctx, in, log); err != nil {
		return res, err
	}

	bySKU := make(map[string]int, len(res.Wines))
	for i, w := range res.Wines {
		bySKU[w.SKU] = i
	}
	stamp := in.Now.UTC().Format(time.RFC3339)

	record := func(a Action, outcome string) {
		entry := Applied{ID: a.ID, SKU: a.SKU, Kind: a.Kind, Reviewer: a.Reviewer,
			AppliedAt: stamp, Outcome: outcome}
		res.Ledger.Applied = append(res.Ledger.Applied, entry)
		res.Applied = append(res.Applied, entry)
	}

	failed := 0
	for _, a := range in.Actions {
		if res.Ledger.Has(a.ID) {
			res.Skipped++
			continue
		}
		i, ok := bySKU[a.SKU]
		if !ok {
			log("applyqueue: action %s (%s) names SKU %s, which is not in the catalog — recording and moving on",
				a.ID, a.Kind, a.SKU)
			record(a, "no such SKU in the catalog")
			continue
		}

		outcome, err := applyOne(ctx, in, &res, i, a)
		if err != nil {
			// Not ledgered AND the queue is kept below: together those are what
			// make "the next run retries it" true.
			failed++
			log("applyqueue: action %s (%s, SKU %s) failed, will retry next run: %v",
				a.ID, a.Kind, a.SKU, err)
			continue
		}
		log("applyqueue: %s on %s by %s — %s", a.Kind, a.SKU, a.Reviewer, outcome)
		record(a, outcome)
	}

	// A failure anywhere in the batch keeps the whole queue file. The successful
	// actions in it are already ledgered, so re-reading them next run costs one
	// skip apiece; the failed ones get a real second chance instead of being
	// deleted along with everything else.
	if failed > 0 {
		log("applyqueue: %d of %d action(s) failed — leaving %s in place so they retry next run "+
			"(the ones that landed are ledgered and will be skipped)",
			failed, len(in.Actions), in.QueuePath)
		return res, nil
	}

	if err := in.Store.Delete(ctx, in.QueuePath); err != nil {
		// The caller aborts here without persisting the catalog or the ledger, so
		// the next run re-reads this same queue and re-applies the batch from
		// scratch. That is safe (every action kind is idempotent against a given
		// wine) but it is NOT the ledger protecting us — nothing was written.
		return res, fmt.Errorf("applyqueue: clear %s (nothing persisted yet, so the next run re-applies this batch from scratch): %w",
			in.QueuePath, err)
	}
	return res, nil
}

// archiveBatch writes the batch about to be drained beside the queue file, as
// _review/queue-applied-<run>.json, BEFORE anything is applied.
//
// It exists because "a crashed run re-applies safely" was only ever true of a
// crash DURING the drain. Apply deletes the queue at the end of step 1, but the
// ledger and the catalog it produced are held in memory and only land in the
// repo at the commit-back in step 6 — so a failure in enrich, the image stage,
// build or deploy loses every action in that batch with no copy anywhere: not in
// the queue (deleted), not in the ledger (never written), not in the digest
// (never sent). The reviewer sees their correction silently not happen and has
// no way to know it was ever read.
//
// The archive is written in the queue's own format, so recovery is a copy:
// download the archive, upload it to _review/queue.json, re-run the pipeline.
// The ledger makes that safe even for the actions that DID land — they are
// skipped.
//
// Never deleted here. These files are small, human-readable, and land in a
// storage prefix the public pull zone does not serve; keeping them is a cheap
// audit trail of every correction the pipeline has ever consumed.
func archiveBatch(ctx context.Context, in Input, log func(string, ...any)) error {
	data, err := json.MarshalIndent(in.Actions, "", "  ")
	if err != nil {
		return fmt.Errorf("applyqueue: encode the batch for archiving: %w", err)
	}
	relPath := archivePath(in)
	if err := in.Store.Upload(ctx, relPath, append(data, '\n')); err != nil {
		return fmt.Errorf("applyqueue: archive the batch to %s before applying it "+
			"(nothing has been applied and %s is untouched, so the next run re-reads it): %w",
			relPath, in.QueuePath, err)
	}
	// The one log line manual recovery is driven from — docs/operations.md quotes
	// this format. It has to name the archive path verbatim.
	log("applyqueue: archived %d queued action(s) to %s before applying them "+
		"(recover a lost batch by copying that file back to %s)", len(in.Actions), relPath, in.QueuePath)
	return nil
}

// archivePath names the archive after the run that read the batch, so an
// operator reading a failed workflow run can find its archive by run ID. A local
// invocation has no run ID and falls back to the drain's own clock, which is
// passed in (Input.Now) rather than read here so the name is testable.
func archivePath(in Input) string {
	id := in.RunID
	if id == "" {
		id = in.Now.UTC().Format("20060102T150405Z")
	}
	return path.Join(path.Dir(in.QueuePath), "queue-applied-"+id+".json")
}

// applyOne applies a single action to res.Wines[i] and returns the ledger
// outcome prose. An unknown Kind is an error, not a silent skip: a console
// shipping an action type this binary predates must be visible.
func applyOne(ctx context.Context, in Input, res *Result, i int, a Action) (string, error) {
	switch a.Kind {
	case ActionImageSwap:
		return swapImage(ctx, in, &res.Wines[i], a)
	case ActionTextFeedback:
		return regenerateText(ctx, in, &res.Wines[i], a)
	case ActionFlag:
		res.Flags = append(res.Flags, Flag{
			SKU: a.SKU, Slug: res.Wines[i].Slug, Reviewer: a.Reviewer,
			Reason: a.Payload.Reason, FlaggedAt: in.Now.UTC().Format(time.RFC3339),
		})
		return "flagged for human attention: " + a.Payload.Reason, nil
	default:
		return "", fmt.Errorf("unknown action kind %q", a.Kind)
	}
}

// swapImage replaces the wine's photograph with the candidate the reviewer
// picked, or drops back to the SVG label when they rejected all of them.
//
// The candidate goes through the normalizer rather than straight to disk: the
// catalog's images are all 600x900 with the bottle at a fixed height, and a raw
// fetched candidate is anywhere between 500x650 and 1200x1200. Consistency is
// the point of that step, and a console swap must not be the one place it is
// skipped.
func swapImage(ctx context.Context, in Input, w *model.Wine, a Action) (string, error) {
	if a.Payload.Candidate == CandidateNone {
		rel, err := writeSibling(in.ImgDir, w.Slug, "svg", "jpg", nil)
		if err != nil {
			return "", err
		}
		w.ImagePath, w.ImageSource, w.ImageSourceURL = rel, model.ImageGeneratedLabel, ""
		rescoreImage(w)
		// No bytes are written for a label: build.ensureLabels regenerates the
		// SVG deterministically from the wine's own fields, and the generated
		// labels are gitignored build artifacts precisely so nothing has to
		// carry them around.
		return "reverted to the generated label", nil
	}

	// sourceUrl is REQUIRED on a real swap (design spec §B, the wire contract):
	// it becomes the wine's ImageSourceURL, and "where did this picture come
	// from" has to stay answerable from data/wines.json alone — the client's
	// accepted copyright posture rests on that being true for every scraped
	// image. Rejected BEFORE any side effect, and deliberately as a failure
	// rather than a ledgered outcome: a ledgered swap can never be corrected,
	// whereas a failed one keeps the queue (see Apply) so the console can repost
	// the same action ID with the provenance filled in. The CandidateNone
	// fallback above is the one legitimate exemption — a generated label has no
	// external source to cite.
	if strings.TrimSpace(a.Payload.SourceURL) == "" {
		return "", fmt.Errorf("image-swap names candidate %s but carries no sourceUrl; "+
			"provenance is required on every real image (only the %q fallback is exempt)",
			a.Payload.Candidate, CandidateNone)
	}

	storagePath := path.Join(in.CandidateDir, a.Payload.Candidate)
	data, err := in.Store.Download(ctx, storagePath)
	if err != nil {
		return "", fmt.Errorf("fetch candidate %s: %w", storagePath, err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("candidate %s is empty or absent in the storage zone", storagePath)
	}

	staged := filepath.Join(os.TempDir(), "finevines-swap-"+w.Slug+filepath.Ext(a.Payload.Candidate))
	if err := os.WriteFile(staged, data, 0o644); err != nil {
		return "", fmt.Errorf("stage candidate: %w", err)
	}
	defer os.Remove(staged)

	dst := filepath.Join(in.ImgDir, w.Slug+".jpg")
	if err := os.MkdirAll(in.ImgDir, 0o755); err != nil {
		return "", err
	}
	if err := in.Norm.Normalize(ctx, staged, dst); err != nil {
		return "", fmt.Errorf("normalise candidate: %w", err)
	}
	// Remove the stale .svg placeholder, exactly as enrich.writeImageFile and
	// import.mjs both do — otherwise it ships as an orphan asset beside the jpg.
	if err := os.Remove(filepath.Join(in.ImgDir, w.Slug+".svg")); err != nil && !os.IsNotExist(err) {
		return "", err
	}

	w.ImagePath = path.Join(filepath.ToSlash(in.ImgDir), w.Slug+".jpg")
	w.ImageSource = model.ImageScrapedWeb
	// Provenance survives a console swap: the payload carries where the
	// candidate came from precisely so this stays answerable from the catalog.
	w.ImageSourceURL = a.Payload.SourceURL
	rescoreImage(w)
	return "image replaced with " + a.Payload.Candidate, nil
}

// regenerateText re-runs the wine's text generation with the reviewer's note
// appended, and writes back ONLY the prose. Everything else is deliberately
// untouched: the image (a text fix must never trade away a real photograph),
// the Salesforce-authoritative identity fields, and above all SourceHash —
// which is what stops the next enrich run paying OpenAI for this wine again.
func regenerateText(ctx context.Context, in Input, w *model.Wine, a Action) (string, error) {
	out, err := in.Texts.EnrichWithNote(ctx, enrich.RawFromWine(*w), a.Payload.Note)
	if err != nil {
		return "", fmt.Errorf("regenerate text: %w", err)
	}
	w.Description = out.Description
	w.SommelierNotes = out.SommelierNotes
	w.Aroma, w.Palate, w.Finish = out.Aroma, out.Palate, out.Finish
	w.FoodPairings = out.FoodPairings
	w.EnrichedAt = in.Now.UTC().Format(time.RFC3339)

	if w.Sources == nil {
		w.Sources = map[string]model.FieldSource{}
	}
	for field, src := range out.Sources {
		switch field {
		case "description", "sommelierNotes", "aroma", "palate", "finish", "foodPairings":
			w.Sources[field] = model.ParseFieldSource(src)
		}
	}
	w.MetadataScore = model.MetadataScore(w.Sources)
	return "text regenerated with the reviewer's note", nil
}

// rescoreImage re-derives the image field's provenance and the wine's coverage
// score after the image changed. Kept in one place so a swap can never leave
// Sources["image"] disagreeing with ImageSource — which would score the wine
// wrong AND, if it read as derived, have the next enrich run regenerate over it.
func rescoreImage(w *model.Wine) {
	if w.Sources == nil {
		w.Sources = map[string]model.FieldSource{}
	}
	w.Sources["image"] = model.ImageFieldSource(w.ImageSource)
	w.MetadataScore = model.MetadataScore(w.Sources)
}

// writeSibling computes the site-relative image path for <slug>.<ext> and
// removes the <slug>.<siblingExt> companion, writing data first when there is
// any. It mirrors enrich.writeImageFile, which is unexported.
func writeSibling(imgDir, slug, ext, siblingExt string, data []byte) (string, error) {
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		return "", err
	}
	if data != nil {
		if err := os.WriteFile(filepath.Join(imgDir, slug+"."+ext), data, 0o644); err != nil {
			return "", err
		}
	}
	if err := os.Remove(filepath.Join(imgDir, slug+"."+siblingExt)); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	return path.Join(filepath.ToSlash(imgDir), slug+"."+ext), nil
}

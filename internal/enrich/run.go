package enrich

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// enrichWorkers bounds concurrent per-wine enrichment (one text call plus
// one image call each) against the two external APIs (Anthropic, Imagen).
// Both tolerate this concurrency level, and at this width the initial
// 5-10k-wine run finishes in hours, not days. It's a const, not a var:
// nothing in the current design needs to change it per-environment or
// per-test — checkpointEvery is the knob tests actually need to turn.
const enrichWorkers = 4

// checkpointEvery controls how often Run persists partial progress to
// dataPath while working through Diff.Enrich. It's a package var, not a
// const, purely so tests can lower it (e.g. to 1) to exercise the
// checkpoint-and-resume path deterministically without enriching dozens of
// wines. Production always runs with the default of 50: a crash or Ctrl-C
// mid-run then loses at most 50 wines' worth of already-paid-for API calls,
// and re-running resumes almost for free because every wine that made it
// into the last checkpoint now hash-matches on the next pass and lands in
// Diff.Keep instead of being re-enriched.
var checkpointEvery = 50

// Texts is the subset of *TextEnricher that Run depends on. Defining the
// interface here (rather than depending on the concrete *TextEnricher type)
// lets tests inject a fake without touching the Anthropic SDK; *TextEnricher
// satisfies it with no changes required on that side.
type Texts interface {
	Enrich(ctx context.Context, w salesforce.WineRaw) (TextResult, error)
}

var _ Texts = (*TextEnricher)(nil)

// enrichResult is one worker's output for one Diff.Enrich wine, carried back
// to the coordinating goroutine over the results channel.
type enrichResult struct {
	raw  salesforce.WineRaw
	wine model.Wine
	err  error
}

// resolveImageError marks a ResolveImage failure as distinct from a
// texts.Enrich failure so Run's result loop can tell them apart. ResolveImage
// returns a non-nil error only for filesystem failures (MkdirAll/WriteFile/
// Remove — see its doc comment): unlike a flaky text-generation call, a
// broken image directory will fail identically for every remaining wine, so
// Run treats it as fatal instead of logging-and-skipping just that one wine.
type resolveImageError struct{ err error }

func (e *resolveImageError) Error() string { return e.err.Error() }
func (e *resolveImageError) Unwrap() error { return e.err }

// Run executes one incremental enrich pass: pull the Salesforce roster,
// filter to web-eligible wines (Eligible), diff against the wines already on
// record at dataPath (DiffRoster), and for every new-or-changed wine
// generate catalog text (texts.Enrich) and resolve a bottle image
// (ResolveImage), writing the merged result back to dataPath.
//
// ⚠ FIELD-NAME CHECKPOINT (client action item C1): salesforce.Client's SOQL
// text and record-to-WineRaw mapping are PROVISIONAL GUESSES against a
// standard Product2 layout — see the checkpoint comment on rosterSOQL in
// internal/salesforce/client.go. Before the first live run against the real
// FineVines org, confirm the actual Product2 field API names (and in
// particular which field carries the QuickBooks-synced stock quantity) and
// correct that mapping. That confirmation does NOT block this function: Run
// itself is fully exercised in run_test.go against fakes and needs no live
// Salesforce/Anthropic/Imagen credentials to be trusted at the orchestration
// level — only the live field mapping remains unverified.
//
// Concurrency: up to enrichWorkers wines are enriched at once via a bounded
// worker pool (stdlib sync.WaitGroup + channels, no unbounded goroutine
// spawn regardless of roster size). Progress is checkpointed to dataPath
// every checkpointEvery completions — see the package doc on checkpointEvery
// for why, and buildSnapshot for exactly what gets written at each
// checkpoint. A final SaveWines happens once every job has completed.
//
// Per-wine failures: an error from texts.Enrich is logged and that wine is
// skipped for this pass — it stays entirely absent from dataPath and is
// retried as if new on the next run, because a single bad prompt or
// transient API hiccup must not abort a 5-10k-wine run. An error from
// ResolveImage can only be a filesystem failure and is fatal: Run stops
// dispatching further work, saves whatever progress exists, and returns the
// error (see resolveImageError).
func Run(ctx context.Context, src salesforce.Source, texts Texts, imgs ImageProvider, dataPath, imgDir string, log func(string, ...any)) error {
	if log == nil {
		log = func(string, ...any) {}
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	rawRoster, err := src.Roster(ctx)
	if err != nil {
		return fmt.Errorf("enrich: fetch roster: %w", err)
	}

	eligible := make([]salesforce.WineRaw, 0, len(rawRoster))
	for _, w := range rawRoster {
		if Eligible(w.StockQty, w.SKU) {
			eligible = append(eligible, w)
		}
	}

	existing, err := model.LoadWines(dataPath)
	if err != nil {
		return fmt.Errorf("enrich: load %s: %w", dataPath, err)
	}
	existingByID := make(map[string]model.Wine, len(existing))
	for _, w := range existing {
		existingByID[w.ID] = w
	}

	diff := DiffRoster(eligible, existing)
	log("enrich: %d roster rows, %d eligible, %d need enrichment, %d unchanged",
		len(rawRoster), len(eligible), len(diff.Enrich), len(diff.Keep))

	jobs := make(chan salesforce.WineRaw, len(diff.Enrich))
	for _, raw := range diff.Enrich {
		jobs <- raw
	}
	close(jobs)

	results := make(chan enrichResult)
	var wg sync.WaitGroup
	for i := 0; i < enrichWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for raw := range jobs {
				wine, err := enrichOne(ctx, texts, imgs, raw, existingByID, imgDir, log)
				results <- enrichResult{raw: raw, wine: wine, err: err}
			}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	var enriched []model.Wine
	attempted := make(map[string]bool, len(diff.Enrich))
	var enrichedCount, droppedCount, labelFallbacks int
	var fatalErr error
	completions := 0

	save := func() error {
		return model.SaveWines(dataPath, buildSnapshot(enriched, diff, existingByID, attempted))
	}

	for res := range results {
		attempted[res.raw.ID] = true
		completions++

		var rie *resolveImageError
		switch {
		case errors.As(res.err, &rie):
			log("enrich: FATAL filesystem error resolving image for SKU %s: %v", res.raw.SKU, res.err)
			if fatalErr == nil {
				fatalErr = res.err
				cancel() // best-effort: stop in-flight/queued work as soon as callers notice ctx is done
			}
			droppedCount++
		case res.err != nil:
			log("enrich: skipping %s %q (SKU %s) — text enrichment failed, will retry next run: %v",
				res.raw.Producer, res.raw.Name, res.raw.SKU, res.err)
			droppedCount++
		default:
			enriched = append(enriched, res.wine)
			enrichedCount++
			if res.wine.ImageSource == model.ImageGeneratedLabel {
				labelFallbacks++
			}
		}

		if completions%checkpointEvery == 0 {
			if err := save(); err != nil {
				return fmt.Errorf("enrich: checkpoint save: %w", err)
			}
		}
	}

	if err := save(); err != nil {
		return fmt.Errorf("enrich: final save: %w", err)
	}

	log("enrich: complete — enriched %d, kept %d, dropped %d, label-fallbacks %d",
		enrichedCount, len(diff.Keep), droppedCount, labelFallbacks)

	if fatalErr != nil {
		return fmt.Errorf("enrich: aborted after filesystem error (partial progress saved to %s): %w", dataPath, fatalErr)
	}
	return nil
}

// enrichOne does the actual per-wine work for one Diff.Enrich row: text
// enrichment, then image resolution (passing the matching previous wine, if
// any, so a producer-supplied image is preserved), then assembling the
// resulting model.Wine. It is called concurrently by up to enrichWorkers
// goroutines; existingByID is read-only for the duration of Run's worker
// phase, so no synchronization is needed around it.
func enrichOne(ctx context.Context, texts Texts, imgs ImageProvider, raw salesforce.WineRaw, existingByID map[string]model.Wine, imgDir string, log func(string, ...any)) (model.Wine, error) {
	text, err := texts.Enrich(ctx, raw)
	if err != nil {
		return model.Wine{}, err
	}

	var prev *model.Wine
	if p, ok := existingByID[raw.ID]; ok {
		p := p // local copy: taking the address of a map value directly isn't allowed
		prev = &p
	}

	imagePath, imageSource, err := ResolveImage(ctx, imgs, raw, text.ImagePrompt, imgDir, prev, log)
	if err != nil {
		return model.Wine{}, &resolveImageError{err: err}
	}

	return model.Wine{
		ID:             raw.ID,
		SourceHash:     SourceHash(raw),
		SKU:            raw.SKU,
		Producer:       raw.Producer,
		Name:           raw.Name,
		Vintage:        raw.Vintage,
		Varietal:       raw.Varietal,
		Region:         raw.Region,
		Appellation:    raw.Appellation,
		Style:          raw.Style,
		StockQty:       raw.StockQty,
		Description:    text.Description,
		SommelierNotes: text.SommelierNotes,
		ImagePath:      imagePath,
		ImageSource:    imageSource,
		Slug:           model.Slugify(raw.Producer, raw.Name, raw.Vintage),
	}, nil
}

// buildSnapshot assembles the current best-known full wines.json content at
// any point during (or at the end of) Run: wines finished so far (enriched)
// plus Diff.Keep (unchanged, zero-cost carryover) plus — for any Diff.Enrich
// wine that hasn't been attempted yet — its previous entry, if it had one.
// That last part is what makes a mid-run checkpoint safe: a wine already on
// the site doesn't vanish from wines.json just because its refresh hasn't
// started yet. Once a wine has been attempted (success or a logged text
// error), it leaves this fallback set for good — a text-enrich failure
// drops the wine from output entirely rather than reusing stale data, so it
// is picked up as "new" again on the next run (see Run's doc comment).
func buildSnapshot(enriched []model.Wine, diff Diff, existingByID map[string]model.Wine, attempted map[string]bool) []model.Wine {
	out := make([]model.Wine, 0, len(enriched)+len(diff.Keep)+len(diff.Enrich))
	out = append(out, enriched...)
	out = append(out, diff.Keep...)
	for _, raw := range diff.Enrich {
		if attempted[raw.ID] {
			continue
		}
		if prev, ok := existingByID[raw.ID]; ok {
			out = append(out, prev)
		}
	}
	return out
}

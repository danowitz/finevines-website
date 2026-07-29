package enrich

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/normalize"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// nowUTC is the clock enrichOne stamps EnrichedAt with. It's a package var so
// a test can pin it for a deterministic timestamp; production uses the wall
// clock in UTC.
var nowUTC = func() time.Time { return time.Now().UTC() }

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

// Enricher is the subset of *SearchEnricher that Run depends on. Defining the
// interface here (rather than depending on the concrete *SearchEnricher type)
// lets tests inject a fake without touching the Anthropic SDK; *SearchEnricher
// satisfies it with no changes required on that side.
type Enricher interface {
	Enrich(ctx context.Context, w salesforce.WineRaw) (EnrichResult, error)
}

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
// skipped for this pass. If it already had a record in dataPath (existingByID),
// that OLD record is retained as-is (stale SourceHash and all) rather than
// dropped — see buildSnapshot's doc comment for why: dropping it would orphan
// a RENAMED wine's old URL forever, since the retry would have no prior
// record left to diff the rename against. A brand-new wine with no prior
// record simply stays absent, exactly as before, and either way the wine is
// retried as if new (or as a rename, if it has a stale record) on the next
// run — a single bad prompt or transient API hiccup must not abort a
// 5-10k-wine run. An error from ResolveImage can only be a filesystem
// failure and is fatal: Run stops dispatching further work, saves whatever
// progress exists, and returns the error (see resolveImageError).
func Run(ctx context.Context, src salesforce.Source, enr Enricher, imgs ImageProvider, oldImages map[string]string, dataPath, imgDir string, log func(string, ...any)) error {
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
		if Eligible(w.StockQty, w.SKU, w.ReadyToSell) {
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

	eligibleIDs := make(map[string]bool, len(eligible))
	for _, w := range eligible {
		eligibleIDs[w.ID] = true
	}

	diff := DiffRoster(eligible, existing)
	log("enrich: %d roster rows, %d eligible, %d need enrichment, %d unchanged",
		len(rawRoster), len(eligible), len(diff.Enrich), len(diff.Keep))

	unavailable, drops := Delist(existing, rawRoster, eligibleIDs, nowUTC())

	redirectsPath := filepath.Join(filepath.Dir(dataPath), "lifecycle-redirects.json")
	lifecycle, err := LoadLifecycleRedirects(redirectsPath)
	if err != nil {
		return fmt.Errorf("enrich: load %s: %w", redirectsPath, err)
	}
	for from, to := range drops {
		lifecycle[from] = to
	}

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
				wine, err := enrichOne(ctx, enr, imgs, raw, existingByID, oldImages, imgDir, log)
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
	// failed tracks the subset of attempted whose text enrichment errored out
	// (as opposed to succeeding) — see buildSnapshot's doc comment for why
	// this distinction matters for a wine that already had a prior record.
	failed := make(map[string]bool, len(diff.Enrich))
	var enrichedCount, droppedCount, labelFallbacks int
	var fatalErr error
	completions := 0

	// currentWines assembles the current best-known full wines.json content —
	// see buildSnapshot's doc comment — plus the retained-unavailable set.
	currentWines := func() []model.Wine {
		return append(buildSnapshot(enriched, diff, existingByID, attempted, failed), unavailable...)
	}

	// save persists BOTH files for one checkpoint, lifecycle first: if a
	// crash or write failure happens between the two, wines.json must never
	// get ahead of lifecycle-redirects.json. A drop or slug-rename recorded
	// in `lifecycle` but not yet flushed to disk is unrecoverable on the next
	// run — the dropped wine is gone from `existing` so Delist can't re-derive
	// its redirect, and a renamed wine now hash-matches so the rename check
	// never re-fires — so the redirect knowledge must hit disk no later than
	// the wines.json snapshot that reflects it. The map written here is
	// intentionally uncollapsed at checkpoint time (collapse is a pure
	// normalization the caller applies once, right before the final save;
	// the next full run collapses again regardless).
	save := func(wines []model.Wine) error {
		if err := SaveLifecycleRedirects(redirectsPath, lifecycle); err != nil {
			return err
		}
		return model.SaveWines(dataPath, wines)
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
			failed[res.raw.ID] = true
			droppedCount++
		default:
			// A re-enriched wine whose slug changed leaves a 301 behind so
			// the old URL keeps working (and keeps its search ranking).
			if prev, ok := existingByID[res.raw.ID]; ok && prev.Slug != "" && prev.Slug != res.wine.Slug {
				lifecycle["/wines/"+prev.Slug+"/"] = "/wines/" + res.wine.Slug + "/"
			}
			enriched = append(enriched, res.wine)
			enrichedCount++
			if res.wine.ImageSource == model.ImageGeneratedLabel {
				labelFallbacks++
			}
		}

		if completions%checkpointEvery == 0 {
			if err := save(currentWines()); err != nil {
				return fmt.Errorf("enrich: checkpoint save: %w", err)
			}
		}
	}

	// Final save: collapse the accumulated lifecycle map against the final
	// live slugs BEFORE persisting anything, then save() writes the collapsed
	// lifecycle followed by the final wines snapshot, in that order — the
	// same crash-safety ordering as every mid-run checkpoint above.
	finalWines := currentWines()
	liveSlugs := make(map[string]bool, len(finalWines))
	for _, w := range finalWines {
		liveSlugs[w.Slug] = true
	}
	lifecycle = CollapseRedirects(lifecycle, liveSlugs)
	if err := save(finalWines); err != nil {
		return fmt.Errorf("enrich: final save: %w", err)
	}

	log("enrich: complete — enriched %d, kept %d, unavailable %d, delisted %d, dropped %d, label-fallbacks %d",
		enrichedCount, len(diff.Keep), len(unavailable), len(drops), droppedCount, labelFallbacks)

	if fatalErr != nil {
		return fmt.Errorf("enrich: aborted after filesystem error (partial progress saved to %s): %w", dataPath, fatalErr)
	}
	return nil
}

// enrichOne does the actual per-wine work for one Diff.Enrich row: text
// enrichment, then image resolution (passing the matching previous wine, if
// any, so a real image is preserved — see hasRealImage), then assembling the
// resulting model.Wine. It is called concurrently by up to enrichWorkers
// goroutines; existingByID is read-only for the duration of Run's worker
// phase, so no synchronization is needed around it.
func enrichOne(ctx context.Context, enr Enricher, imgs ImageProvider, raw salesforce.WineRaw, existingByID map[string]model.Wine, oldImages map[string]string, imgDir string, log func(string, ...any)) (model.Wine, error) {
	res, err := enr.Enrich(ctx, raw)
	if err != nil {
		return model.Wine{}, err
	}

	var prev *model.Wine
	if p, ok := existingByID[raw.ID]; ok {
		p := p // local copy: taking the address of a map value directly isn't allowed
		prev = &p
	}

	// Normalize the terse Salesforce trade shorthand into presentable display
	// values (drives the name, producer, vintage AND the SEO slug / image
	// filename). Already-clean data (enriched/mock) passes through untouched.
	producer := normalize.Producer(raw.Producer)
	name := normalize.WineName(raw.Name, raw.Producer)
	vintage := normalize.Vintage(raw.Vintage)
	varietal := normalize.Text(raw.Varietal)
	region := normalize.Text(raw.Region)
	// Country: prefer the enrichment's value; fall back to the Salesforce field
	// (FV_Country__c) for un-enriched wines so they still show a country.
	country := res.Country
	if country == "" {
		country = normalize.Text(raw.Country)
	}
	slug := model.Slugify(producer, name, vintage)

	// Image chain: a REAL image the catalog already holds (producer-supplied,
	// old-site, scraped — anything a human verified or that came from a real
	// photograph) is kept as-is; a re-enrich refreshes TEXT, it never trades a
	// real photograph for a generated one. Otherwise try a real image —
	// FineVines' own old-site photo, then a found web image — downloaded and
	// self-hosted under the SEO slug; failing that, ResolveImage generates a
	// photo or writes the guaranteed SVG-label floor. A download failure is
	// logged and falls through, never fatal.
	var imagePath, imageSource, imageSourceURL string
	switch {
	case hasRealImage(prev):
		imagePath, imageSource, imageSourceURL = prev.ImagePath, prev.ImageSource, prev.ImageSourceURL
	default:
		if url, src := imageCandidate(raw.SKU, res.ImageURL, oldImages); url != "" {
			if data, derr := downloadImage(ctx, url); derr == nil {
				p, werr := writeImageFile(imgDir, slug, "jpg", "svg", data)
				if werr != nil {
					return model.Wine{}, &resolveImageError{err: werr}
				}
				imagePath, imageSource, imageSourceURL = p, src, url
			} else if log != nil {
				log("enrich: image download failed for SKU %s (%s), falling back: %v", raw.SKU, url, derr)
			}
		}
		if imagePath == "" {
			p, s, rerr := ResolveImage(ctx, imgs, raw, res.ImagePrompt, imgDir, prev, log)
			if rerr != nil {
				return model.Wine{}, &resolveImageError{err: rerr}
			}
			imagePath, imageSource = p, s
		}
	}

	// Salesforce-authoritative fields win over anything the search inferred,
	// and are marked as such in the provenance. Appellation is the only scored
	// field Salesforce can currently supply directly (Product2 has no field
	// for it today, so raw.Appellation is usually empty — but if a future
	// mapping fills it, it takes precedence here without further changes).
	appellation := res.Appellation
	if raw.Appellation != "" {
		appellation = raw.Appellation
	}

	// Per-field provenance: start from what the search reported, force the
	// Salesforce-sourced fields, then classify the resolved image.
	sources := make(map[string]model.FieldSource, len(model.ScoredFields))
	for k, v := range res.Sources {
		sources[k] = model.ParseFieldSource(v)
	}
	if raw.Appellation != "" {
		sources["appellation"] = model.SourceSalesforce
	}
	if res.Country == "" && raw.Country != "" {
		sources["country"] = model.SourceSalesforce // filled from FV_Country__c
	}
	sources["image"] = model.ImageFieldSource(imageSource)

	return model.Wine{
		ID:              raw.ID,
		SourceHash:      SourceHash(raw),
		SKU:             raw.SKU,
		Producer:        producer,
		Name:            name,
		Vintage:         vintage,
		Varietal:        varietal,
		Region:          region,
		Appellation:     appellation,
		Country:         country,
		Color:           res.Color,
		Style:           raw.Style,
		StockQty:        raw.StockQty,
		Description:     res.Description,
		SommelierNotes:  res.SommelierNotes,
		Aroma:           res.Aroma,
		Palate:          res.Palate,
		Finish:          res.Finish,
		FoodPairings:    res.FoodPairings,
		ABV:             res.ABV,
		BottleSize:      res.BottleSize,
		DrinkWindow:     res.DrinkWindow,
		ImagePath:       imagePath,
		ImageSource:     imageSource,
		ImageSourceURL:  imageSourceURL,
		Sources:         sources,
		MetadataScore:   model.MetadataScore(sources),
		MatchConfidence: res.MatchConfidence,
		EnrichedAt:      nowUTC().Format(time.RFC3339),
		Slug:            slug,
	}, nil
}

// buildSnapshot assembles the current best-known full wines.json content at
// any point during (or at the end of) Run: wines finished so far (enriched)
// plus Diff.Keep (unchanged, zero-cost carryover) plus, for any Diff.Enrich
// wine, its previous entry (if it had one) UNLESS that wine already
// succeeded this pass (it's in `enriched` already, via the `default` branch
// of Run's results loop).
//
// That fallback covers two cases:
//
//   - not yet attempted: this is what makes a mid-run checkpoint safe — a
//     wine already on the site doesn't vanish from wines.json just because
//     its refresh hasn't started yet;
//   - attempted but FAILED (in `failed`): the wine's re-enrichment errored
//     out this pass (a bad prompt, a transient API hiccup), but its OLD page
//     must not be orphaned. This matters most for a RENAMED wine: dropping
//     it entirely here would leave the next successful retry with no prior
//     record (existingByID) to diff the rename against, so the old URL
//     could never get its 301 (see Run's rename-detection in the results
//     loop's default case). The retained record's stale SourceHash also
//     guarantees DiffRoster re-selects it for enrichment on the next run,
//     same as a brand-new wine.
//
// A brand-new wine (no prior entry in existingByID) that fails has nothing
// to fall back to and stays absent, exactly as before — it is picked up as
// "new" again on the next run (see Run's doc comment).
func buildSnapshot(enriched []model.Wine, diff Diff, existingByID map[string]model.Wine, attempted, failed map[string]bool) []model.Wine {
	out := make([]model.Wine, 0, len(enriched)+len(diff.Keep)+len(diff.Enrich))
	out = append(out, enriched...)
	out = append(out, diff.Keep...)
	for _, raw := range diff.Enrich {
		if attempted[raw.ID] && !failed[raw.ID] {
			continue // succeeded already — its fresh record is in `enriched`
		}
		if prev, ok := existingByID[raw.ID]; ok {
			out = append(out, prev)
		}
	}
	return out
}

package enrich

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// fakeSource is a fixed-roster salesforce.Source for testing Run without a
// live org.
type fakeSource struct {
	roster []salesforce.WineRaw
	err    error
}

func (f *fakeSource) Roster(ctx context.Context) ([]salesforce.WineRaw, error) {
	return f.roster, f.err
}

// fakeTexts is a Texts fake with three knobs tests use independently:
// errs injects a per-wine-ID failure (log-and-skip test), blockIDs+release
// lets a test hold specific wines open mid-call (checkpoint test), and calls
// records every ID seen so tests can assert unchanged wines were never
// enriched at all.
type fakeTexts struct {
	mu       sync.Mutex
	calls    []string
	errs     map[string]error
	blockIDs map[string]bool
	release  chan struct{}
}

func (f *fakeTexts) Enrich(ctx context.Context, w salesforce.WineRaw) (EnrichResult, error) {
	f.mu.Lock()
	f.calls = append(f.calls, w.ID)
	f.mu.Unlock()

	if f.blockIDs[w.ID] {
		<-f.release
	}
	if f.errs != nil {
		if err, ok := f.errs[w.ID]; ok {
			return EnrichResult{}, err
		}
	}
	return EnrichResult{
		Description:    "FAKE description for " + w.Name,
		SommelierNotes: "FAKE notes for " + w.Name,
		ImagePrompt:    "FAKE prompt for " + w.Name,
	}, nil
}

func (f *fakeTexts) callList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// fakeImages is an ImageProvider fake that always "succeeds", so tests can
// count how many wines actually went through image generation (as opposed
// to the producer-supplied guard, which must never call it).
type fakeImages struct {
	mu    sync.Mutex
	calls int
}

func (f *fakeImages) GenerateJPEG(ctx context.Context, prompt string) ([]byte, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return []byte("fake jpeg bytes"), nil
}

func (f *fakeImages) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// TestRun_FullPipeline exercises Run end to end against fakes: eligibility
// filtering (ineligible SKU and out-of-stock roster rows must never reach
// output), an unchanged wine carried over verbatim (untouched Description a
// fake would never produce), a stale wine (existing but absent from the
// roster) dropped entirely, a brand-new wine enriched from scratch, and a
// producer-supplied wine whose text is refreshed but whose image is left
// alone because ResolveImage must see its previous entry via prev.
func TestRun_FullPipeline(t *testing.T) {
	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")

	rawKeep := salesforce.WineRaw{
		ID: "SF-KEEP", SKU: "AB1111", Producer: "Chateau Keep", Name: "Reserve",
		Vintage: "2018", Varietal: "Cabernet", Region: "Napa", StockQty: 5, ReadyToSell: true,
	}
	rawNew := salesforce.WineRaw{
		ID: "SF-NEW", SKU: "CD2222", Producer: "Domaine New", Name: "Cuvee",
		Vintage: "2020", Varietal: "Pinot Noir", Region: "Burgundy", StockQty: 10, ReadyToSell: true,
	}
	rawProd := salesforce.WineRaw{
		ID: "SF-PROD", SKU: "IJ7890", Producer: "Estate Z", Name: "Cuvee Z",
		Vintage: "2021", StockQty: 8, ReadyToSell: true,
	}
	rawNine := salesforce.WineRaw{ID: "SF-NINE", SKU: "9X3333", Producer: "Nine Winery", StockQty: 8, ReadyToSell: true}
	rawOOS := salesforce.WineRaw{ID: "SF-OOS", SKU: "EF4444", Producer: "OOS Winery", StockQty: 0, ReadyToSell: true}

	src := &fakeSource{roster: []salesforce.WineRaw{rawKeep, rawNew, rawProd, rawNine, rawOOS}}

	seed := []model.Wine{
		{
			ID: "SF-KEEP", SourceHash: SourceHash(rawKeep), SKU: "AB1111",
			Producer: "Chateau Keep", Name: "Reserve", Vintage: "2018",
			Description: "ORIGINAL untouched description", SommelierNotes: "ORIGINAL notes",
			ImagePath: "img/AB1111.jpg", ImageSource: model.ImageGeneratedPhoto,
			Slug: model.Slugify("Chateau Keep", "Reserve", "2018"),
		},
		{
			ID: "SF-STALE", SourceHash: "whatever", SKU: "GH5555", Producer: "Old Winery",
			Slug: "old-winery-gh5555",
		},
		{
			ID: "SF-PROD", SourceHash: "stale-hash-does-not-match", SKU: "IJ7890",
			Producer: "Estate Z", Name: "Cuvee Z", Vintage: "2020",
			ImagePath: "img/IJ7890-original.png", ImageSource: model.ImageProducerSupplied,
			Slug: "estate-z-cuvee-z-2020",
		},
	}
	if err := model.SaveWines(dataPath, seed); err != nil {
		t.Fatalf("seed wines.json: %v", err)
	}

	texts := &fakeTexts{}
	images := &fakeImages{}

	if err := Run(context.Background(), src, texts, images, nil, dataPath, imgDir, t.Logf); err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	got, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatalf("reload wines.json: %v", err)
	}
	byID := make(map[string]model.Wine, len(got))
	for _, w := range got {
		byID[w.ID] = w
	}

	if len(got) != 3 {
		t.Fatalf("want 3 wines in output, got %d: %+v", len(got), got)
	}
	if _, ok := byID["SF-STALE"]; ok {
		t.Error("stale wine SF-STALE (absent from roster) must be dropped from output")
	}
	if _, ok := byID["SF-NINE"]; ok {
		t.Error("ineligible (SKU starts with 9) wine must never appear in output")
	}
	if _, ok := byID["SF-OOS"]; ok {
		t.Error("out-of-stock wine must never appear in output")
	}

	keep, ok := byID["SF-KEEP"]
	if !ok {
		t.Fatal("unchanged wine SF-KEEP missing from output")
	}
	if keep.Description != "ORIGINAL untouched description" {
		t.Errorf("unchanged wine Description = %q, want untouched original (fake never produces this text)", keep.Description)
	}
	if keep.SourceHash != SourceHash(rawKeep) {
		t.Errorf("unchanged wine SourceHash = %q, want %q", keep.SourceHash, SourceHash(rawKeep))
	}

	newWine, ok := byID["SF-NEW"]
	if !ok {
		t.Fatal("new wine SF-NEW missing from output")
	}
	if newWine.SourceHash != SourceHash(rawNew) {
		t.Errorf("SF-NEW SourceHash = %q, want %q", newWine.SourceHash, SourceHash(rawNew))
	}
	if want := model.Slugify(rawNew.Producer, rawNew.Name, rawNew.Vintage); newWine.Slug != want {
		t.Errorf("SF-NEW Slug = %q, want %q", newWine.Slug, want)
	}
	if newWine.Description == "" || newWine.Description == "ORIGINAL untouched description" {
		t.Errorf("SF-NEW Description = %q, want fake-generated text", newWine.Description)
	}
	if newWine.ImageSource != model.ImageGeneratedPhoto {
		t.Errorf("SF-NEW ImageSource = %q, want %q", newWine.ImageSource, model.ImageGeneratedPhoto)
	}

	prod, ok := byID["SF-PROD"]
	if !ok {
		t.Fatal("producer-supplied wine SF-PROD missing from output")
	}
	if prod.ImageSource != model.ImageProducerSupplied || prod.ImagePath != "img/IJ7890-original.png" {
		t.Errorf("SF-PROD image must be preserved untouched via prev, got path=%q source=%q",
			prod.ImagePath, prod.ImageSource)
	}
	if prod.SourceHash != SourceHash(rawProd) {
		t.Errorf("SF-PROD SourceHash not refreshed: got %q want %q", prod.SourceHash, SourceHash(rawProd))
	}
	if prod.Description == "" {
		t.Error("SF-PROD Description should have been refreshed by text enrichment")
	}

	calls := texts.callList()
	for _, id := range calls {
		if id == "SF-KEEP" {
			t.Errorf("Texts.Enrich must not be called for unchanged wine SF-KEEP, calls=%v", calls)
		}
	}
	if len(calls) != 2 {
		t.Errorf("want 2 Texts.Enrich calls (SF-NEW, SF-PROD), got %v", calls)
	}

	if got := images.callCount(); got != 1 {
		t.Errorf("want 1 image-provider call (only SF-NEW; SF-PROD preserved via prev), got %d", got)
	}
}

// TestRun_RealImagesPreservedAcrossReEnrich: a descriptive-field change
// re-enriches a wine's TEXT, but a real image the catalog already holds —
// old-site, scraped-web, scraped-google, producer-supplied (anything
// ImageFieldSource classifies as found) — must survive untouched: same path,
// same source, same provenance URL, no image-provider call. Only generated
// placeholders (SVG label, AI photo) are re-resolved, since replacing those
// with a real image is an upgrade.
func TestRun_RealImagesPreservedAcrossReEnrich(t *testing.T) {
	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")

	rawOld := salesforce.WineRaw{
		ID: "SF-OLD", SKU: "OL1111", Producer: "Chateau Old", Name: "Reserve",
		Vintage: "2018", StockQty: 5, ReadyToSell: true,
	}
	rawWeb := salesforce.WineRaw{
		ID: "SF-WEB", SKU: "WB2222", Producer: "Domaine Web", Name: "Cuvee",
		Vintage: "2019", StockQty: 4, ReadyToSell: true,
	}
	rawGen := salesforce.WineRaw{
		ID: "SF-GEN", SKU: "GN3333", Producer: "Estate Gen", Name: "Blanc",
		Vintage: "2021", StockQty: 2, ReadyToSell: true,
	}
	src := &fakeSource{roster: []salesforce.WineRaw{rawOld, rawWeb, rawGen}}

	seed := []model.Wine{
		{
			ID: "SF-OLD", SourceHash: "stale-hash", SKU: "OL1111",
			Producer: "Chateau Old", Name: "Reserve", Vintage: "2018",
			ImagePath: "img/chateau-old-reserve-2018.jpg", ImageSource: model.ImageOldSite,
			ImageSourceURL: "https://finevines.com/old/OL1111.jpg",
			Slug:           model.Slugify("Chateau Old", "Reserve", "2018"),
		},
		{
			ID: "SF-WEB", SourceHash: "stale-hash", SKU: "WB2222",
			Producer: "Domaine Web", Name: "Cuvee", Vintage: "2019",
			ImagePath: "img/domaine-web-cuvee-2019.jpg", ImageSource: model.ImageScrapedWeb,
			ImageSourceURL: "https://producer.example/cuvee.jpg",
			Slug:           model.Slugify("Domaine Web", "Cuvee", "2019"),
		},
		{
			ID: "SF-GEN", SourceHash: "stale-hash", SKU: "GN3333",
			Producer: "Estate Gen", Name: "Blanc", Vintage: "2021",
			ImagePath: "img/estate-gen-blanc-2021.svg", ImageSource: model.ImageGeneratedLabel,
			Slug: model.Slugify("Estate Gen", "Blanc", "2021"),
		},
	}
	if err := model.SaveWines(dataPath, seed); err != nil {
		t.Fatalf("seed wines.json: %v", err)
	}

	texts := &fakeTexts{}
	images := &fakeImages{}

	if err := Run(context.Background(), src, texts, images, nil, dataPath, imgDir, t.Logf); err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	got, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatalf("reload wines.json: %v", err)
	}
	byID := make(map[string]model.Wine, len(got))
	for _, w := range got {
		byID[w.ID] = w
	}

	for id, want := range map[string]model.Wine{
		"SF-OLD": seed[0],
		"SF-WEB": seed[1],
	} {
		w, ok := byID[id]
		if !ok {
			t.Fatalf("%s missing from output", id)
		}
		if w.ImagePath != want.ImagePath || w.ImageSource != want.ImageSource || w.ImageSourceURL != want.ImageSourceURL {
			t.Errorf("%s real image must be preserved: got path=%q source=%q url=%q, want path=%q source=%q url=%q",
				id, w.ImagePath, w.ImageSource, w.ImageSourceURL, want.ImagePath, want.ImageSource, want.ImageSourceURL)
		}
		if w.Description == "" {
			t.Errorf("%s text must still be re-enriched", id)
		}
	}

	gen, ok := byID["SF-GEN"]
	if !ok {
		t.Fatal("SF-GEN missing from output")
	}
	if gen.ImageSource != model.ImageGeneratedPhoto {
		t.Errorf("SF-GEN placeholder must be re-resolved (upgradeable), got source=%q", gen.ImageSource)
	}

	if got := images.callCount(); got != 1 {
		t.Errorf("want 1 image-provider call (only SF-GEN; real images preserved), got %d", got)
	}
}

// TestRun_CheckpointsProgressMidRun proves the every-N-completions
// checkpoint actually lands on disk before the run finishes, not just at
// the end. checkpointEvery is lowered to 1; two wines (SF-BLOCK1,
// SF-BLOCK2) are held open inside Texts.Enrich while the test polls
// wines.json for the intermediate state (SF-KEEP kept + SF-FAST enriched,
// nothing else yet), then releases the blocked wines and confirms the
// final file has all four.
func TestRun_CheckpointsProgressMidRun(t *testing.T) {
	orig := checkpointEvery
	checkpointEvery = 1
	t.Cleanup(func() { checkpointEvery = orig })

	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")

	rawKeep := salesforce.WineRaw{ID: "SF-KEEP", SKU: "AB1111", Producer: "Chateau Keep", StockQty: 5, ReadyToSell: true}
	rawFast := salesforce.WineRaw{ID: "SF-FAST", SKU: "CD2222", Producer: "Fast Winery", Name: "Fast Wine", StockQty: 10, ReadyToSell: true}
	rawBlock1 := salesforce.WineRaw{ID: "SF-BLOCK1", SKU: "EF3333", Producer: "Block One", Name: "Block Wine 1", StockQty: 6, ReadyToSell: true}
	rawBlock2 := salesforce.WineRaw{ID: "SF-BLOCK2", SKU: "GH4444", Producer: "Block Two", Name: "Block Wine 2", StockQty: 7, ReadyToSell: true}

	// rawPending is a wine that ALREADY EXISTS in wines.json but whose
	// Salesforce data changed (Vintage differs from what's seeded below), so
	// it lands in Diff.Enrich rather than Diff.Keep — unlike SF-BLOCK1/2
	// (brand-new wines with no prior entry), holding SF-PENDING open lets
	// this test exercise buildSnapshot's fallback to existingByID[raw.ID]:
	// a changed-but-not-yet-processed wine must keep showing its OLD stale
	// entry in a mid-run checkpoint rather than vanishing from the catalog,
	// and then get replaced once its worker actually completes.
	rawPending := salesforce.WineRaw{
		ID: "SF-PENDING", SKU: "IJ5555", Producer: "Pending Winery", Name: "Pending Wine",
		Vintage: "2022", StockQty: 9, ReadyToSell: true,
	}

	src := &fakeSource{roster: []salesforce.WineRaw{rawKeep, rawFast, rawBlock1, rawBlock2, rawPending}}

	seed := []model.Wine{
		{ID: "SF-KEEP", SourceHash: SourceHash(rawKeep), SKU: "AB1111", Producer: "Chateau Keep", Slug: "chateau-keep"},
		{
			ID: "SF-PENDING", SourceHash: "stale-hash-does-not-match", SKU: "IJ5555",
			Producer: "Pending Winery", Name: "Pending Wine", Vintage: "2021", // vs. rawPending's 2022 -> hash mismatch -> Diff.Enrich
			Description: "OLD STALE DESCRIPTION FROM BEFORE THIS RUN",
			Slug:        "pending-winery-pending-wine-2021",
		},
	}
	if err := model.SaveWines(dataPath, seed); err != nil {
		t.Fatalf("seed: %v", err)
	}

	release := make(chan struct{})
	texts := &fakeTexts{
		blockIDs: map[string]bool{"SF-BLOCK1": true, "SF-BLOCK2": true, "SF-PENDING": true},
		release:  release,
	}
	images := &fakeImages{}

	runErr := make(chan error, 1)
	go func() {
		runErr <- Run(context.Background(), src, texts, images, nil, dataPath, imgDir, t.Logf)
	}()

	// Poll for the intermediate checkpoint: SF-KEEP (kept) + SF-FAST (freshly
	// enriched) + SF-PENDING's OLD stale entry (carried over by
	// buildSnapshot's not-yet-processed fallback, since SF-PENDING is still
	// held open in Texts.Enrich) = 3 wines.
	deadline := time.Now().Add(5 * time.Second)
	var midRun []model.Wine
	for time.Now().Before(deadline) {
		wines, err := model.LoadWines(dataPath)
		if err == nil && len(wines) == 3 {
			midRun = wines
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if midRun == nil {
		close(release) // don't leak the goroutine even though the test failed
		<-runErr
		t.Fatal("never observed the mid-run checkpoint (SF-KEEP + SF-FAST + stale SF-PENDING) before timing out")
	}

	var pendingMidRun *model.Wine
	for i := range midRun {
		if midRun[i].ID == "SF-PENDING" {
			pendingMidRun = &midRun[i]
		}
	}
	if pendingMidRun == nil {
		close(release)
		<-runErr
		t.Fatal("mid-run checkpoint is missing SF-PENDING entirely — a changed-but-not-yet-processed " +
			"wine must not vanish from the catalog while its worker is still in flight")
	}
	if pendingMidRun.Description != "OLD STALE DESCRIPTION FROM BEFORE THIS RUN" {
		t.Errorf("mid-run SF-PENDING.Description = %q, want the OLD stale seeded description to survive "+
			"until the worker actually completes", pendingMidRun.Description)
	}
	if pendingMidRun.SourceHash != "stale-hash-does-not-match" {
		t.Errorf("mid-run SF-PENDING.SourceHash = %q, want the old stale hash (not yet refreshed)", pendingMidRun.SourceHash)
	}

	close(release)

	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after unblocking the held wines")
	}

	final, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatalf("reload final wines.json: %v", err)
	}
	if len(final) != 5 {
		t.Fatalf("want 5 wines in final output, got %d: %+v", len(final), final)
	}

	var pendingFinal *model.Wine
	for i := range final {
		if final[i].ID == "SF-PENDING" {
			pendingFinal = &final[i]
		}
	}
	if pendingFinal == nil {
		t.Fatal("final output is missing SF-PENDING")
	}
	if pendingFinal.Description == "OLD STALE DESCRIPTION FROM BEFORE THIS RUN" {
		t.Error("final SF-PENDING.Description should have been replaced by the fresh enrichment once its worker completed, not left stale")
	}
	if pendingFinal.SourceHash != SourceHash(rawPending) {
		t.Errorf("final SF-PENDING.SourceHash = %q, want %q (refreshed)", pendingFinal.SourceHash, SourceHash(rawPending))
	}
}

// TestRun_TextErrorIsLoggedAndSkipped confirms the documented log-and-skip
// behavior: a single wine's text-enrichment failure must not abort the run
// for every other wine, and the failed wine must be logged and simply
// absent from output (so it's retried as "new" on the next run).
func TestRun_TextErrorIsLoggedAndSkipped(t *testing.T) {
	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")

	rawGood := salesforce.WineRaw{ID: "SF-GOOD", SKU: "AB1111", Producer: "Good Winery", Name: "Good Wine", Vintage: "2019", StockQty: 5, ReadyToSell: true}
	rawBad := salesforce.WineRaw{ID: "SF-BAD", SKU: "CD2222", Producer: "Bad Winery", Name: "Bad Wine", Vintage: "2019", StockQty: 3, ReadyToSell: true}

	src := &fakeSource{roster: []salesforce.WineRaw{rawGood, rawBad}}
	texts := &fakeTexts{errs: map[string]error{"SF-BAD": fmt.Errorf("simulated claude failure")}}
	images := &fakeImages{}

	var logMu sync.Mutex
	var logs []string
	logFn := func(format string, args ...any) {
		logMu.Lock()
		logs = append(logs, fmt.Sprintf(format, args...))
		logMu.Unlock()
	}

	if err := Run(context.Background(), src, texts, images, nil, dataPath, imgDir, logFn); err != nil {
		t.Fatalf("Run returned error for a per-wine text failure (want log-and-skip, not abort): %v", err)
	}

	got, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(got) != 1 || got[0].ID != "SF-GOOD" {
		t.Fatalf("want only SF-GOOD in output (SF-BAD skipped), got %+v", got)
	}

	found := false
	for _, l := range logs {
		if strings.Contains(l, "SF-BAD") || strings.Contains(l, "CD2222") {
			found = true
		}
	}
	if !found {
		t.Errorf("want the text-enrich failure logged mentioning the failed wine, got logs=%v", logs)
	}
}

// TestRun_ResumeAfterPartialRun proves the resume story end to end across
// two separate Run calls against the same dataPath: a wine dropped by
// log-and-skip in the first pass (simulating one wine's share of a crash or
// a transient API failure) is picked up as "new" and enriched on the
// second pass, while a wine that succeeded in the first pass hash-matches
// on the second and is carried over via Keep — Texts.Enrich must not be
// called for it again.
func TestRun_ResumeAfterPartialRun(t *testing.T) {
	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")

	rawA := salesforce.WineRaw{ID: "SF-A", SKU: "AB1111", Producer: "Winery A", Name: "Wine A", Vintage: "2019", StockQty: 5, ReadyToSell: true}
	rawB := salesforce.WineRaw{ID: "SF-B", SKU: "CD2222", Producer: "Winery B", Name: "Wine B", Vintage: "2020", StockQty: 4, ReadyToSell: true}
	src := &fakeSource{roster: []salesforce.WineRaw{rawA, rawB}}
	images := &fakeImages{}

	// Pass 1: SF-B fails (simulates a dropped wine from a crash or a
	// transient API error) and must be logged-and-skipped, not abort the run.
	pass1Texts := &fakeTexts{errs: map[string]error{"SF-B": fmt.Errorf("simulated failure")}}
	if err := Run(context.Background(), src, pass1Texts, images, nil, dataPath, imgDir, t.Logf); err != nil {
		t.Fatalf("pass 1: Run returned error: %v", err)
	}

	afterPass1, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatalf("pass 1: reload: %v", err)
	}
	if len(afterPass1) != 1 || afterPass1[0].ID != "SF-A" {
		t.Fatalf("pass 1: want only SF-A in output, got %+v", afterPass1)
	}

	// Pass 2: re-run against the same dataPath with a Texts fake that would
	// succeed for everyone. SF-A must hash-match and be skipped entirely
	// (Keep); only SF-B should go through Texts.Enrich this time.
	pass2Texts := &fakeTexts{}
	if err := Run(context.Background(), src, pass2Texts, images, nil, dataPath, imgDir, t.Logf); err != nil {
		t.Fatalf("pass 2: Run returned error: %v", err)
	}

	calls := pass2Texts.callList()
	if len(calls) != 1 || calls[0] != "SF-B" {
		t.Errorf("pass 2: want Texts.Enrich called only for SF-B (SF-A resumes via hash match), got calls=%v", calls)
	}

	final, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatalf("pass 2: reload: %v", err)
	}
	if len(final) != 2 {
		t.Fatalf("pass 2: want both SF-A and SF-B in final output, got %+v", final)
	}
}

// TestRun_DelistLifecycle exercises Run's lifecycle wiring end to end: an
// out-of-stock wine is retained unavailable with its enrichment intact, a
// withheld (ready-to-sell=false) wine is dropped entirely and gains a
// portfolio redirect, and a re-enriched wine whose slug changed leaves a 301
// from its old URL to the new one.
func TestRun_DelistLifecycle(t *testing.T) {
	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")

	// Roster: SF-OOS is out of stock but otherwise fine; SF-HIDE is
	// withheld (ready-to-sell false); SF-RENAME is in stock with a CHANGED
	// name (hash mismatch -> re-enriched -> new slug).
	rawOOS := salesforce.WineRaw{ID: "SF-OOS", SKU: "AA1111", Producer: "Alpha", Name: "Old Vine Red", StockQty: 0, ReadyToSell: true}
	rawHide := salesforce.WineRaw{ID: "SF-HIDE", SKU: "BB2222", Producer: "Beta", Name: "Hidden Cuvee", StockQty: 9, ReadyToSell: false}
	rawRename := salesforce.WineRaw{ID: "SF-REN", SKU: "CC3333", Producer: "Gamma", Name: "New Name Blanc", Vintage: "2021", StockQty: 4, ReadyToSell: true}

	seed := []model.Wine{
		{ID: "SF-OOS", SKU: "AA1111", Slug: "alpha-old-vine-red", SourceHash: SourceHash(rawOOS), Description: "keep me"},
		{ID: "SF-HIDE", SKU: "BB2222", Slug: "beta-hidden-cuvee", SourceHash: "whatever", Description: "hide me"},
		{ID: "SF-REN", SKU: "CC3333", Slug: "gamma-old-name-blanc-2021", SourceHash: "stale", Description: "rename me"},
	}
	if err := model.SaveWines(dataPath, seed); err != nil {
		t.Fatal(err)
	}

	src := &fakeSource{roster: []salesforce.WineRaw{rawOOS, rawHide, rawRename}}
	if err := Run(context.Background(), src, &fakeTexts{}, &fakeImages{}, nil, dataPath, imgDir, t.Logf); err != nil {
		t.Fatalf("Run: %v", err)
	}

	got, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]model.Wine{}
	for _, w := range got {
		byID[w.ID] = w
	}

	// SF-OOS survives as unavailable with its enrichment intact.
	oos, ok := byID["SF-OOS"]
	if !ok || oos.Status != model.StatusUnavailable || oos.Description != "keep me" {
		t.Errorf("SF-OOS must be retained unavailable with text intact, got %+v", oos)
	}
	// SF-HIDE is gone entirely.
	if _, ok := byID["SF-HIDE"]; ok {
		t.Error("withheld SF-HIDE must be dropped from the catalog")
	}

	redirects, err := LoadLifecycleRedirects(filepath.Join(dir, "lifecycle-redirects.json"))
	if err != nil {
		t.Fatal(err)
	}
	if redirects["/wines/beta-hidden-cuvee/"] != "/portfolio/" {
		t.Errorf("dropped wine must gain a portfolio redirect, got %v", redirects)
	}
	// SF-REN was re-enriched under a new slug; the old URL must 301 to it.
	ren := byID["SF-REN"]
	if ren.Slug == "" || ren.Slug == "gamma-old-name-blanc-2021" {
		t.Fatalf("SF-REN should have a new slug, got %q", ren.Slug)
	}
	if redirects["/wines/gamma-old-name-blanc-2021/"] != "/wines/"+ren.Slug+"/" {
		t.Errorf("slug rename must 301 old->new, got %v", redirects)
	}
}

// TestRun_CheckpointPersistsLifecycleBeforeWinesGoStale proves the crash-safety
// ordering fix: lifecycle-redirects.json must already carry a drop's redirect
// by the time of the FIRST mid-run checkpoint, not only at the very end of
// Run. If the redirect knowledge only hit disk at the final save, a crash (or
// a save failure) between an earlier wines.json checkpoint and the final save
// would lose it permanently — the dropped wine is gone from `existing` on the
// next run, so Delist can never re-derive its redirect.
//
// checkpointEvery is lowered to 1 (the existing test knob) and one wine
// (SF-BLOCK) is held open in Texts.Enrich so Run cannot reach its final save
// while the test polls disk for the intermediate state: SF-FAST's completion
// alone must trigger a checkpoint, and lifecycle-redirects.json must show
// SF-HIDE's drop redirect at that point, well before Run returns.
func TestRun_CheckpointPersistsLifecycleBeforeWinesGoStale(t *testing.T) {
	orig := checkpointEvery
	checkpointEvery = 1
	t.Cleanup(func() { checkpointEvery = orig })

	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")
	redirectsPath := filepath.Join(dir, "lifecycle-redirects.json")

	rawFast := salesforce.WineRaw{ID: "SF-FAST", SKU: "AB1111", Producer: "Fast Winery", Name: "Fast Wine", StockQty: 10, ReadyToSell: true}
	rawBlock := salesforce.WineRaw{ID: "SF-BLOCK", SKU: "CD2222", Producer: "Block Winery", Name: "Block Wine", StockQty: 5, ReadyToSell: true}
	// SF-HIDE is withheld (ready-to-sell false): Delist drops it and records
	// its redirect BEFORE the enrich worker loop even starts.
	rawHide := salesforce.WineRaw{ID: "SF-HIDE", SKU: "EF3333", Producer: "Hidden Winery", Name: "Hidden Wine", StockQty: 9, ReadyToSell: false}

	seed := []model.Wine{
		{ID: "SF-HIDE", SKU: "EF3333", Slug: "hidden-winery-hidden-wine", SourceHash: "whatever"},
	}
	if err := model.SaveWines(dataPath, seed); err != nil {
		t.Fatal(err)
	}

	src := &fakeSource{roster: []salesforce.WineRaw{rawFast, rawBlock, rawHide}}
	release := make(chan struct{})
	texts := &fakeTexts{blockIDs: map[string]bool{"SF-BLOCK": true}, release: release}
	images := &fakeImages{}

	runErr := make(chan error, 1)
	go func() {
		runErr <- Run(context.Background(), src, texts, images, nil, dataPath, imgDir, t.Logf)
	}()

	deadline := time.Now().Add(5 * time.Second)
	var observed map[string]string
	for time.Now().Before(deadline) {
		m, err := LoadLifecycleRedirects(redirectsPath)
		if err == nil && m["/wines/hidden-winery-hidden-wine/"] == "/portfolio/" {
			observed = m
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	close(release) // don't leak the goroutine regardless of pass/fail
	if err := <-runErr; err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	if observed == nil {
		t.Fatal("lifecycle-redirects.json never showed SF-HIDE's drop redirect while SF-BLOCK was still held open — " +
			"the redirect must be durable at every checkpoint, not only written at the final save")
	}
}

// TestRun_ResolveImageFilesystemErrorAbortsRun confirms the one class of
// error ResolveImage can return (a filesystem failure, per its doc comment)
// is treated as fatal by Run rather than logged-and-skipped like a text
// error — a broken image directory will fail identically for every
// remaining wine, so limping forward wastes paid API calls for nothing.
func TestRun_ResolveImageFilesystemErrorAbortsRun(t *testing.T) {
	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")

	blocker := filepath.Join(dir, "blocker-file")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("seed blocker file: %v", err)
	}
	imgDir := filepath.Join(blocker, "wines") // parent is a file: MkdirAll must fail

	rawNew := salesforce.WineRaw{ID: "SF-NEW", SKU: "AB1111", Producer: "New Winery", Name: "New Wine", Vintage: "2020", StockQty: 5, ReadyToSell: true}
	src := &fakeSource{roster: []salesforce.WineRaw{rawNew}}
	texts := &fakeTexts{}
	images := &fakeImages{}

	err := Run(context.Background(), src, texts, images, nil, dataPath, imgDir, t.Logf)
	if err == nil {
		t.Fatal("want Run to return an error when ResolveImage hits a filesystem failure, got nil")
	}
}

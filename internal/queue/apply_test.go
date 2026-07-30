package queue

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// fakeStore is an in-memory Store. It records every Download and Delete so a
// test can assert the queue was cleared exactly once, and can be told to fail a
// specific path — the same shape internal/deploy's fakeUploader has, for the
// same reason: no network, no Bunny credentials, deterministic failures.
type fakeStore struct {
	mu      sync.Mutex
	files   map[string][]byte
	deleted []string
	failOn  string
}

func (f *fakeStore) Download(_ context.Context, relPath string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if relPath == f.failOn {
		return nil, errors.New("storage unavailable")
	}
	return f.files[relPath], nil
}

func (f *fakeStore) Delete(_ context.Context, relPath string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, relPath)
	return nil
}

// fakeTexts records the note it was asked to enrich with and returns fixed prose.
type fakeTexts struct {
	notes []string
	err   error
}

func (f *fakeTexts) EnrichWithNote(_ context.Context, w salesforce.WineRaw, note string) (enrich.EnrichResult, error) {
	f.notes = append(f.notes, note)
	if f.err != nil {
		return enrich.EnrichResult{}, f.err
	}
	return enrich.EnrichResult{
		Description:    "Steely and unoaked, cut with citrus.",
		SommelierNotes: "Pour cool alongside shellfish.",
		Aroma:          "white peach",
		Palate:         "taut",
		Finish:         "saline",
		FoodPairings:   []string{"oysters", "grilled bream"},
		Sources:        map[string]string{"description": "found", "sommelierNotes": "derived"},
	}, nil
}

// fakeNorm stands in for tools/imgnorm: it just copies, so the test asserts the
// swap wrote SOMETHING to the catalog path without shelling out to a binary
// that may not be built.
type fakeNorm struct{ calls [][2]string }

func (f *fakeNorm) Normalize(_ context.Context, src, dst string) error {
	f.calls = append(f.calls, [2]string{src, dst})
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

func testWines() []model.Wine {
	return []model.Wine{
		{ID: "1", SKU: "AB1201", Producer: "Domaine Bart", Name: "Marsannay La Montagne",
			Vintage: "2019", Slug: "bart-marsannay-la-montagne-2019",
			ImagePath: "assets/img/wines/bart-marsannay-la-montagne-2019.svg",
			ImageSource: model.ImageGeneratedLabel, SourceHash: "hash-ab",
			Sources: map[string]model.FieldSource{"description": model.SourceDerived, "image": model.SourceDerived}},
		{ID: "2", SKU: "MB5110", Producer: "Brezza", Name: "Langhe Chardonnay",
			Vintage: "2021", Slug: "brezza-langhe-chardonnay-2021",
			ImagePath: "assets/img/wines/brezza-langhe-chardonnay-2021.jpg",
			ImageSource: model.ImageScrapedWeb, SourceHash: "hash-mb",
			Description: "Broad and oaked.", Sources: map[string]model.FieldSource{"description": model.SourceFound}},
	}
}

func baseInput(t *testing.T, store *fakeStore, actions []Action) Input {
	t.Helper()
	// ImgDir must be the RELATIVE "assets/img/wines" production passes, because
	// Wine.ImagePath is derived from it and has to come out site-relative
	// (forward slashes, no leading slash — templates prepend the "/"). t.Chdir
	// into a scratch directory so that relative dir is writable and isolated.
	// The same trick, for the same reason, as
	// enrich.TestResolveImage_ImagePathIsSiteRelativeFormEvenOnWindows: an
	// absolute t.TempDir() imgDir would silently pass a suffix check on Windows
	// (drive letter, no leading slash) and fail on Linux.
	t.Chdir(t.TempDir())
	imgDir := filepath.Join("assets", "img", "wines")
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// The swap target's existing SVG sibling has to be on disk so the test can
	// assert it was removed.
	if err := os.WriteFile(filepath.Join(imgDir, "bart-marsannay-la-montagne-2019.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	return Input{
		Store:        store,
		Texts:        &fakeTexts{},
		Norm:         &fakeNorm{},
		Actions:      actions,
		Wines:        testWines(),
		ImgDir:       imgDir,
		CandidateDir: "_review/candidates",
		QueuePath:    "_review/queue.json",
		Now:          time.Date(2026, 7, 29, 8, 15, 0, 0, time.UTC),
	}
}

func find(t *testing.T, wines []model.Wine, sku string) model.Wine {
	t.Helper()
	for _, w := range wines {
		if w.SKU == sku {
			return w
		}
	}
	t.Fatalf("no wine with SKU %s in the result", sku)
	return model.Wine{}
}

func TestApply_ImageSwapWritesTheCandidateAndKeepsProvenance(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{
		"_review/candidates/AB1201/cand-2.png": []byte("candidate-bytes"),
	}}
	in := baseInput(t, store, []Action{{
		ID: "a1", Reviewer: "barbara", SKU: "AB1201", Kind: ActionImageSwap,
		Payload: Payload{Candidate: "AB1201/cand-2.png", SourceURL: "https://example-producer.fr/vins/"},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	w := find(t, res.Wines, "AB1201")
	if w.ImagePath != "assets/img/wines/bart-marsannay-la-montagne-2019.jpg" {
		t.Errorf("ImagePath = %q, want the .jpg under assets/img/wines", w.ImagePath)
	}
	if w.ImageSource != model.ImageScrapedWeb {
		t.Errorf("ImageSource = %q, want %q", w.ImageSource, model.ImageScrapedWeb)
	}
	if w.ImageSourceURL != "https://example-producer.fr/vins/" {
		t.Errorf("ImageSourceURL = %q — provenance must survive a console swap", w.ImageSourceURL)
	}
	if w.Sources["image"] != model.SourceFound {
		t.Errorf(`Sources["image"] = %q, want found`, w.Sources["image"])
	}
	if w.MetadataScore == 0 {
		t.Error("MetadataScore was not recomputed after the swap")
	}
	// The bytes must actually be on disk at the catalog path, via the normalizer.
	if _, err := os.Stat(filepath.Join(in.ImgDir, "bart-marsannay-la-montagne-2019.jpg")); err != nil {
		t.Errorf("the swapped image is not on disk: %v", err)
	}
	// And the stale SVG placeholder must be gone, exactly as
	// enrich.writeImageFile and import.mjs both do it.
	if _, err := os.Stat(filepath.Join(in.ImgDir, "bart-marsannay-la-montagne-2019.svg")); !os.IsNotExist(err) {
		t.Error("the stale .svg sibling was left behind")
	}
	// A swap must not disturb the enrichment hash: SourceHash is what stops the
	// next enrich run re-billing OpenAI for this wine.
	if w.SourceHash != "hash-ab" {
		t.Errorf("SourceHash changed to %q — a swap must not trigger re-enrichment", w.SourceHash)
	}
}

// The CandidateNone fallback is the one image-swap exempt from the sourceUrl
// requirement: a deterministically generated label has no external source to
// cite. This payload carries no sourceUrl and must still apply.
func TestApply_ImageSwapToNoneFallsBackToTheSVGLabel(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a1", Reviewer: "george", SKU: "MB5110", Kind: ActionImageSwap,
		Payload: Payload{Candidate: CandidateNone},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	w := find(t, res.Wines, "MB5110")
	if w.ImagePath != "assets/img/wines/brezza-langhe-chardonnay-2021.svg" {
		t.Errorf("ImagePath = %q, want the .svg label path", w.ImagePath)
	}
	if w.ImageSource != model.ImageGeneratedLabel {
		t.Errorf("ImageSource = %q, want %q", w.ImageSource, model.ImageGeneratedLabel)
	}
	if w.ImageSourceURL != "" {
		t.Errorf("ImageSourceURL = %q, want empty — a label has no source URL", w.ImageSourceURL)
	}
	if w.Sources["image"] != model.SourceDerived {
		t.Errorf(`Sources["image"] = %q, want derived`, w.Sources["image"])
	}
}

func TestApply_TextFeedbackRegeneratesProseWithTheNoteAndLeavesTheRestAlone(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a2", Reviewer: "george", SKU: "MB5110", Kind: ActionTextFeedback,
		Payload: Payload{Note: "says oaked; this wine is unoaked"},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	texts := in.Texts.(*fakeTexts)
	if len(texts.notes) != 1 || texts.notes[0] != "says oaked; this wine is unoaked" {
		t.Errorf("the reviewer note reached the enricher as %v", texts.notes)
	}

	w := find(t, res.Wines, "MB5110")
	if w.Description != "Steely and unoaked, cut with citrus." {
		t.Errorf("Description = %q, want the regenerated prose", w.Description)
	}
	if w.Aroma != "white peach" || w.Finish != "saline" || len(w.FoodPairings) != 2 {
		t.Errorf("the tasting fields were not refreshed: %+v", w)
	}
	if w.EnrichedAt != "2026-07-29T08:15:00Z" {
		t.Errorf("EnrichedAt = %q, want the run's clock", w.EnrichedAt)
	}
	// The image and the Salesforce-authoritative fields are NOT this action's
	// business. A text fix must never trade away a real photograph.
	if w.ImagePath != "assets/img/wines/brezza-langhe-chardonnay-2021.jpg" || w.ImageSource != model.ImageScrapedWeb {
		t.Errorf("a text fix changed the image: %q / %q", w.ImagePath, w.ImageSource)
	}
	if w.Producer != "Brezza" || w.Vintage != "2021" || w.SourceHash != "hash-mb" {
		t.Errorf("a text fix changed identity or the enrichment hash: %+v", w)
	}
}

func TestApply_FlagRecordsAndTakesNoAutomaticAction(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	before := testWines()
	in := baseInput(t, store, []Action{{
		ID: "a3", Reviewer: "george", SKU: "PM5030", Kind: ActionFlag,
		Payload: Payload{Reason: "wrong producer, this is not Brezza"},
	}})
	// The flag names a SKU that IS in the catalog, so use one that is.
	in.Actions[0].SKU = "MB5110"

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(res.Flags) != 1 {
		t.Fatalf("res.Flags = %d entries, want 1", len(res.Flags))
	}
	f := res.Flags[0]
	if f.SKU != "MB5110" || f.Slug != "brezza-langhe-chardonnay-2021" ||
		f.Reviewer != "george" || f.Reason != "wrong producer, this is not Brezza" ||
		f.FlaggedAt != "2026-07-29T08:15:00Z" {
		t.Errorf("flag recorded as %+v", f)
	}
	w := find(t, res.Wines, "MB5110")
	if w.Status != "" || w.Description != before[1].Description {
		t.Errorf("a flag changed the wine: status %q, description %q", w.Status, w.Description)
	}
}

// The idempotency guarantee: a crashed run, or a second repository_dispatch for
// the same batch, must not apply anything twice.
func TestApply_SkipsActionsAlreadyInTheLedger(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a2", Reviewer: "george", SKU: "MB5110", Kind: ActionTextFeedback,
		Payload: Payload{Note: "says oaked; this wine is unoaked"},
	}})
	in.Ledger = Ledger{Applied: []Applied{{ID: "a2", SKU: "MB5110", Kind: ActionTextFeedback,
		AppliedAt: "2026-07-28T08:15:00Z", Outcome: "text regenerated"}}}

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if res.Skipped != 1 {
		t.Errorf("res.Skipped = %d, want 1", res.Skipped)
	}
	if len(res.Applied) != 0 {
		t.Errorf("res.Applied = %+v, want empty", res.Applied)
	}
	if n := len(in.Texts.(*fakeTexts).notes); n != 0 {
		t.Errorf("the enricher was called %d times for an already-applied action", n)
	}
	if len(res.Ledger.Applied) != 1 {
		t.Errorf("the ledger grew to %d entries for a no-op drain", len(res.Ledger.Applied))
	}
	w := find(t, res.Wines, "MB5110")
	if w.Description != "Broad and oaked." {
		t.Errorf("an already-applied action was applied again: %q", w.Description)
	}
}

// An action naming a SKU the catalog does not hold is recorded as applied, with
// the reason. Leaving it unrecorded would make every future run retry it
// forever, and the queue would never drain.
func TestApply_UnknownSKUIsRecordedNotRetriedForever(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a9", Reviewer: "barbara", SKU: "NOPE99", Kind: ActionTextFeedback,
		Payload: Payload{Note: "n/a"},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(res.Applied) != 1 || !strings.Contains(res.Applied[0].Outcome, "no such SKU") {
		t.Errorf("res.Applied = %+v, want one entry naming the missing SKU", res.Applied)
	}
	if !res.Ledger.Has("a9") {
		t.Error("the unknown-SKU action was not recorded in the ledger")
	}
}

// A failing action must not take the whole drain down, and must NOT be recorded
// as applied — the next run retries it.
func TestApply_AFailedActionIsNotLedgeredAndDoesNotAbortTheDrain(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}, failOn: "_review/candidates/AB1201/cand-2.png"}
	in := baseInput(t, store, []Action{
		// A complete, valid swap: the sourceUrl is present so this fails on the
		// unreachable STORAGE, not on provenance validation — otherwise this test
		// would stop covering the transport-failure path it exists for.
		{ID: "a1", SKU: "AB1201", Reviewer: "barbara", Kind: ActionImageSwap,
			Payload: Payload{Candidate: "AB1201/cand-2.png", SourceURL: "https://example-producer.fr/vins/"}},
		{ID: "a2", SKU: "MB5110", Reviewer: "george", Kind: ActionTextFeedback,
			Payload: Payload{Note: "says oaked; this wine is unoaked"}},
	})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if res.Ledger.Has("a1") {
		t.Error("the failed swap was recorded as applied — it would never be retried")
	}
	if !res.Ledger.Has("a2") {
		t.Error("the drain stopped at the failure instead of continuing")
	}
}

// Leaving an action out of the ledger only means "retry it next run" if there is
// still a queue to retry FROM. Clearing the queue on a batch that contained a
// failure would lose that reviewer's correction permanently — not applied, not
// ledgered, not in the digest, and no longer in the queue. So: a failure keeps
// the file, and the following run drains it for real.
func TestApply_KeepsTheQueueWhenAnActionFailedThenDrainsItOnTheRetry(t *testing.T) {
	store := &fakeStore{
		files:  map[string][]byte{"_review/candidates/AB1201/cand-2.png": []byte("candidate-bytes")},
		failOn: "_review/candidates/AB1201/cand-2.png",
	}
	in := baseInput(t, store, []Action{
		{ID: "a1", SKU: "AB1201", Reviewer: "barbara", Kind: ActionImageSwap,
			Payload: Payload{Candidate: "AB1201/cand-2.png", SourceURL: "https://example-producer.fr/vins/"}},
		{ID: "a2", SKU: "MB5110", Reviewer: "george", Kind: ActionTextFeedback,
			Payload: Payload{Note: "says oaked; this wine is unoaked"}},
	})

	first, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("first Apply returned error: %v", err)
	}
	if len(store.deleted) != 0 {
		t.Fatalf("store.deleted = %v — a batch containing a failure must leave the queue in place", store.deleted)
	}
	if first.Ledger.Has("a1") {
		t.Error("the failed swap was ledgered — it would never be retried")
	}
	if !first.Ledger.Has("a2") {
		t.Error("the healthy action in the same batch did not land")
	}

	// The next run: the same queue is re-read, carrying the ledger, catalog and
	// flags the first run produced. Storage is healthy this time.
	store.failOn = ""
	second := in
	second.Ledger, second.Wines, second.Flags = first.Ledger, first.Wines, first.Flags
	second.Texts = &fakeTexts{}

	res, err := Apply(context.Background(), second)
	if err != nil {
		t.Fatalf("second Apply returned error: %v", err)
	}
	if res.Skipped != 1 {
		t.Errorf("res.Skipped = %d, want 1 — a2 already landed on the first run", res.Skipped)
	}
	if n := len(second.Texts.(*fakeTexts).notes); n != 0 {
		t.Errorf("the enricher was called %d times for the already-applied text action", n)
	}
	if len(res.Applied) != 1 || res.Applied[0].ID != "a1" {
		t.Errorf("res.Applied = %+v, want exactly the retried a1", res.Applied)
	}
	if !res.Ledger.Has("a1") {
		t.Error("the retried swap was not ledgered on the second run")
	}
	// The retry did the real work, provenance and all.
	w := find(t, res.Wines, "AB1201")
	if w.ImageSourceURL != "https://example-producer.fr/vins/" || w.ImageSource != model.ImageScrapedWeb {
		t.Errorf("the retried swap did not apply: %q / %q", w.ImageSourceURL, w.ImageSource)
	}
	if _, err := os.Stat(filepath.Join(in.ImgDir, "bart-marsannay-la-montagne-2019.jpg")); err != nil {
		t.Errorf("the retried swap wrote no image: %v", err)
	}
	// Only now, with nothing left failing, is the queue cleared.
	if len(store.deleted) != 1 || store.deleted[0] != "_review/queue.json" {
		t.Errorf("store.deleted = %v, want the queue cleared once the batch fully drained", store.deleted)
	}
}

// sourceUrl is REQUIRED on a real image-swap: it becomes the wine's
// ImageSourceURL, and the client's accepted copyright posture depends on that
// provenance being answerable from data/wines.json alone. A swap missing it must
// be rejected BEFORE it touches anything, and must NOT be ledgered — a ledgered
// swap could never be corrected, whereas a failure keeps the queue so the
// console can repost the same ID with the URL filled in.
func TestApply_ImageSwapWithoutASourceURLIsRejectedBeforeAnySideEffect(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{
		"_review/candidates/AB1201/cand-2.png": []byte("candidate-bytes"),
	}}
	in := baseInput(t, store, []Action{{
		ID: "a1", Reviewer: "barbara", SKU: "AB1201", Kind: ActionImageSwap,
		Payload: Payload{Candidate: "AB1201/cand-2.png"}, // no sourceUrl
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(res.Applied) != 0 || res.Ledger.Has("a1") {
		t.Errorf("a swap with no sourceUrl was applied/ledgered: %+v", res.Applied)
	}
	// Nothing on disk moved: no jpg written, the existing label still in place.
	if _, err := os.Stat(filepath.Join(in.ImgDir, "bart-marsannay-la-montagne-2019.jpg")); !os.IsNotExist(err) {
		t.Error("a rejected swap still wrote an image")
	}
	if _, err := os.Stat(filepath.Join(in.ImgDir, "bart-marsannay-la-montagne-2019.svg")); err != nil {
		t.Errorf("a rejected swap removed the existing label: %v", err)
	}
	if n := len(in.Norm.(*fakeNorm).calls); n != 0 {
		t.Errorf("the normalizer ran %d time(s) for a rejected swap", n)
	}
	// And the catalog row is untouched.
	w := find(t, res.Wines, "AB1201")
	if w.ImageSource != model.ImageGeneratedLabel || w.ImageSourceURL != "" ||
		w.ImagePath != "assets/img/wines/bart-marsannay-la-montagne-2019.svg" {
		t.Errorf("a rejected swap changed the catalog: %q / %q / %q", w.ImageSource, w.ImageSourceURL, w.ImagePath)
	}
	// It stays queued, so a corrected repost of the same action ID can land.
	if len(store.deleted) != 0 {
		t.Errorf("store.deleted = %v — a rejected swap must leave the queue for a corrected repost", store.deleted)
	}
}

// Clearing the queue happens ONCE, at the end, and only after the actions have
// been applied. Deleting it is safe despite the console possibly appending
// mid-drain: the console rewrites the whole file, so a re-appearing action is
// re-read next run and skipped by the ledger.
func TestApply_ClearsTheQueueExactlyOnce(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{ID: "a3", SKU: "MB5110", Reviewer: "george",
		Kind: ActionFlag, Payload: Payload{Reason: "duplicate"}}})

	if _, err := Apply(context.Background(), in); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(store.deleted) != 1 || store.deleted[0] != "_review/queue.json" {
		t.Errorf("store.deleted = %v, want exactly [_review/queue.json]", store.deleted)
	}
}

// An empty queue must not delete anything: Delete is a real API call, and a
// nightly run with nothing queued should be silent.
func TestApply_EmptyQueueTouchesNothing(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, nil)

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(store.deleted) != 0 {
		t.Errorf("store.deleted = %v, want nothing for an empty queue", store.deleted)
	}
	if len(res.Applied) != 0 || res.Skipped != 0 {
		t.Errorf("res = %+v, want an untouched result", res)
	}
}

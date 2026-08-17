package collectioneditorial

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
)

type recordingResearcher struct {
	assignments []Assignment
	draft       Draft
	err         error
}

func (r *recordingResearcher) Research(_ context.Context, assignment Assignment) (Draft, error) {
	r.assignments = append(r.assignments, assignment)
	return r.draft, r.err
}

func TestSyncPrioritizesNewCollectionsOverOldReviews(t *testing.T) {
	wines := []model.Wine{{Slug: "alpha-pinot-2022", Name: "Pinot", Producer: "Alpha Estate", Region: "Burgundy", Varietal: "Pinot Noir", Country: "France", StockQty: 12}}
	candidates := Discover(wines)
	library := Empty()
	for _, candidate := range candidates {
		if candidate.Kind == Producer {
			continue
		}
		entry := validGenerated(candidate.Kind, candidate.Slug, candidate.Name, candidate.Fingerprint)
		entry.ReviewedAt = "2020-01-01"
		library.put(entry)
	}
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	if err := Save(path, library); err != nil {
		t.Fatal(err)
	}
	researcher := &recordingResearcher{draft: usefulDraft()}
	report, err := Sync(context.Background(), path, wines, researcher, Options{Limit: 10, Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	if report.Attempted != 1 || len(researcher.assignments) != 1 || researcher.assignments[0].Reason != NewCollection || researcher.assignments[0].Candidate.Kind != Producer {
		t.Fatalf("report=%+v assignments=%+v", report, researcher.assignments)
	}
}

func TestSyncPrioritizesMaterialChangesWhenNoPageIsNew(t *testing.T) {
	wines := []model.Wine{{Slug: "alpha-pinot-2022", Name: "Pinot", Producer: "Alpha Estate", Region: "Burgundy", Varietal: "Pinot Noir", Country: "France", StockQty: 12}}
	library := Empty()
	for _, candidate := range Discover(wines) {
		fingerprint := candidate.Fingerprint
		if candidate.Kind == Region {
			fingerprint = "stale"
		}
		entry := validGenerated(candidate.Kind, candidate.Slug, candidate.Name, fingerprint)
		entry.ReviewedAt = "2020-01-01"
		library.put(entry)
	}
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	if err := Save(path, library); err != nil {
		t.Fatal(err)
	}
	researcher := &recordingResearcher{draft: usefulDraft()}
	_, err := Sync(context.Background(), path, wines, researcher, Options{Limit: 10, Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(researcher.assignments) != 1 || researcher.assignments[0].Reason != MaterialChange || researcher.assignments[0].Candidate.Kind != Region {
		t.Fatalf("assignments=%+v", researcher.assignments)
	}
}

func TestMaterialChangePublishesEvenWhenDraftChangedFlagIsFalse(t *testing.T) {
	wines := []model.Wine{{Slug: "alpha-pinot-2022", Name: "Pinot", Producer: "Alpha Estate", Region: "Burgundy", Varietal: "Pinot Noir", Country: "France", StockQty: 12}}
	library := Empty()
	for _, candidate := range Discover(wines) {
		entry := validGenerated(candidate.Kind, candidate.Slug, candidate.Name, candidate.Fingerprint)
		if candidate.Kind == Region {
			entry.Fingerprint = "stale"
		}
		library.put(entry)
	}
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	if err := Save(path, library); err != nil {
		t.Fatal(err)
	}
	draft := usefulDraft()
	draft.Changed = false
	researcher := &recordingResearcher{draft: draft}
	report, err := Sync(context.Background(), path, wines, researcher, Options{Limit: 10, Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := loaded.raw(Region, "burgundy")
	if report.Published != 1 || entry.Heading != draft.Heading {
		t.Fatalf("material change was incorrectly preserved: report=%+v entry=%+v", report, entry)
	}
}

func TestScheduledReviewCanPreserveGoodCopy(t *testing.T) {
	wines := []model.Wine{{Slug: "alpha-pinot-2022", Name: "Pinot", Producer: "Alpha Estate", Region: "Burgundy", Varietal: "Pinot Noir", Country: "France", StockQty: 12}}
	library := Empty()
	for _, candidate := range Discover(wines) {
		entry := validGenerated(candidate.Kind, candidate.Slug, candidate.Name, candidate.Fingerprint)
		entry.ReviewedAt = "2020-01-01"
		library.put(entry)
	}
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	if err := Save(path, library); err != nil {
		t.Fatal(err)
	}
	researcher := &recordingResearcher{draft: Draft{Publishable: true, Changed: false}}
	_, err := Sync(context.Background(), path, wines, researcher, Options{Limit: 1, Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	assignment := researcher.assignments[0]
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := loaded.raw(assignment.Candidate.Kind, assignment.Candidate.Slug)
	if entry.Heading != assignment.Previous.Heading || entry.ReviewedAt != "2026-08-15" {
		t.Fatalf("review changed good copy or failed to advance date: %+v", entry)
	}
}

func TestSyncCheckpointsFailureAndHonorsCooldown(t *testing.T) {
	wines := []model.Wine{{Slug: "alpha-pinot-2022", Name: "Pinot", Producer: "Alpha Estate", Region: "Burgundy", Varietal: "Pinot Noir", Country: "France", StockQty: 12}}
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	if err := Save(path, Empty()); err != nil {
		t.Fatal(err)
	}
	failing := &recordingResearcher{err: errors.New("temporary research failure")}
	report, err := Sync(context.Background(), path, wines, failing, Options{Limit: 1, Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	if report.Attempted != 1 || report.Failed != 1 {
		t.Fatalf("first report = %+v", report)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	failed := failing.assignments[0].Candidate
	entry, ok := loaded.raw(failed.Kind, failed.Slug)
	if !ok || entry.RetryAfter != "2026-09-14" || entry.RetryFingerprint != failed.Fingerprint || entry.LastError == "" {
		t.Fatalf("failure was not checkpointed: %+v", entry)
	}

	second := &recordingResearcher{draft: usefulDraft()}
	report, err = Sync(context.Background(), path, wines, second, Options{Limit: 1, Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.assignments) != 1 || second.assignments[0].Candidate.Slug == failed.Slug {
		t.Fatalf("cooling entry was retried: report=%+v assignments=%+v", report, second.assignments)
	}
}

func TestSyncCheckpointsInvalidDraftWithoutFailingTheRun(t *testing.T) {
	wines := []model.Wine{{Slug: "alpha-pinot-2022", Name: "Pinot", Producer: "Alpha Estate", Region: "Burgundy", Varietal: "Pinot Noir", Country: "France", StockQty: 12}}
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	if err := Save(path, Empty()); err != nil {
		t.Fatal(err)
	}
	draft := usefulDraft()
	draft.Paragraphs[0] = "Burgundy has a long history — and this draft must be deferred."
	researcher := &recordingResearcher{draft: draft}

	report, err := Sync(context.Background(), path, wines, researcher, Options{Limit: 1, Now: fixedNow})
	if err != nil {
		t.Fatalf("invalid research output should be checkpointed, not fail the run: %v", err)
	}
	if report.Attempted != 1 || report.Failed != 1 {
		t.Fatalf("report = %+v", report)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	failed := researcher.assignments[0].Candidate
	entry, ok := loaded.raw(failed.Kind, failed.Slug)
	if !ok || entry.Publishable() || entry.RetryAfter != "2026-09-14" || entry.LastError == "" {
		t.Fatalf("invalid draft was not saved as a retry-only checkpoint: %+v", entry)
	}
}

func usefulDraft() Draft {
	return Draft{
		Publishable: true, Changed: true, Eyebrow: "A closer look", Heading: "A useful heading",
		Paragraphs: []string{"The first factual paragraph gives a buyer useful context.", "The second connects that context to the current portfolio."},
		Sources:    []Source{{Label: "Authority", URL: "https://example.com/source"}},
	}
}

func fixedNow() time.Time { return time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC) }

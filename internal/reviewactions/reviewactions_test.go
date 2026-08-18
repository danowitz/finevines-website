package reviewactions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
)

type memoryStore struct {
	files  map[string][]byte
	events []string
}

func (store *memoryStore) List(_ context.Context, prefix string) ([]string, error) {
	var names []string
	for name := range store.files {
		if strings.HasPrefix(name, strings.TrimSuffix(prefix, "/")+"/") {
			rest := strings.TrimPrefix(name, strings.TrimSuffix(prefix, "/")+"/")
			if !strings.Contains(rest, "/") {
				names = append(names, rest)
			}
		}
	}
	sort.Strings(names)
	return names, nil
}
func (store *memoryStore) Download(_ context.Context, name string) ([]byte, error) {
	return append([]byte(nil), store.files[name]...), nil
}
func (store *memoryStore) Upload(_ context.Context, name string, data []byte) error {
	store.events = append(store.events, "upload:"+name)
	store.files[name] = append([]byte(nil), data...)
	return nil
}
func (store *memoryStore) Delete(_ context.Context, name string) error {
	store.events = append(store.events, "delete:"+name)
	delete(store.files, name)
	return nil
}

type copyNormalizer struct{}

func (copyNormalizer) Normalize(_ context.Context, source, destination string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, data, 0o644)
}

type failingNormalizer struct{}

func (failingNormalizer) Normalize(context.Context, string, string) error { return os.ErrInvalid }

type invalidImageNormalizer struct{}

func (invalidImageNormalizer) Normalize(context.Context, string, string) error {
	return &InvalidImageError{Err: errors.New("decode failed")}
}

type deadlineNormalizer struct{}

func (deadlineNormalizer) Normalize(ctx context.Context, _, _ string) error {
	<-ctx.Done()
	return ctx.Err()
}

type fetcherFunc func(context.Context, string) ([]byte, error)

func (fetcher fetcherFunc) Fetch(ctx context.Context, target string) ([]byte, error) {
	return fetcher(ctx, target)
}

func fixture(t *testing.T) (*memoryStore, []model.Wine, string) {
	t.Helper()
	wines := []model.Wine{{ID: "wine-1", SKU: "500740*", Slug: "producer-wine-2022", Producer: "Producer", Name: "Wine", Vintage: "2022", ImagePath: "assets/img/wines/producer-wine-2022.svg", ImageSource: model.ImageGeneratedLabel, SourceHash: "source"}}
	id := "00000000-0000-4000-8000-000000000001"
	bytes := []byte("candidate-image")
	sum := sha256.Sum256(bytes)
	action := Action{SchemaVersion: 1, ID: id, Environment: "test", Reviewer: "barb.fultz@finevines.com", SKU: "500740*", Kind: "image-select", PackageID: "pkg-1", TargetCatalogCommit: "abcdef1", WineRevision: WineRevision(wines[0]), CandidateID: "candidate-1", SubmittedAt: "2026-08-15T01:00:00Z", CSRFSessionID: "00000000-0000-4000-8000-000000000099"}
	manifest := Manifest{SchemaVersion: 1, PackageID: "pkg-1", Environment: "test", CatalogCommit: "abcdef1", CreatedAt: "2026-08-15T00:00:00Z", ExpiresAt: "2026-09-14T00:00:00Z", Reviewers: []Reviewer{{Name: "Barb Fultz", Email: "barb.fultz@finevines.com", Role: "Back Office"}}, Wines: []PackageWine{{SKU: "500740*", Slug: "producer-wine-2022", WineRevision: action.WineRevision, Candidates: []Candidate{{CandidateID: "candidate-1", StorageName: "candidate-1.png", SHA256: hex.EncodeToString(sum[:]), Bytes: len(bytes), MIME: "image/png", SourceURL: "https://producer.example/wine"}}}}}
	encode := func(value any) []byte {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	store := &memoryStore{files: map[string][]byte{
		"_review/test/pending/" + id + ".json":               encode(action),
		"_review/test/actions/" + id + ".json":               encode(action),
		"_review/test/packages/pkg-1/manifest.json":          encode(manifest),
		"_review/test/packages/pkg-1/images/candidate-1.png": bytes,
	}}
	return store, wines, id
}

func TestPrepareAppliesExactCandidateButKeepsPendingUntilFinalize(t *testing.T) {
	store, wines, id := fixture(t)
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Decisions) != 1 || result.Decisions[0].Status != "prepared" {
		t.Fatalf("decisions = %#v", result.Decisions)
	}
	if result.Wines[0].ImageSource != model.ImageScrapedWeb || result.Wines[0].ImageSourceURL != "https://producer.example/wine" {
		t.Fatalf("wine image = %#v", result.Wines[0])
	}
	if _, ok := store.files["_review/test/pending/"+id+".json"]; !ok {
		t.Fatal("pending pointer was deleted before deployment")
	}
	if result.Wines[0].ImageReviewActionID != id {
		t.Fatalf("image review action id = %q", result.Wines[0].ImageReviewActionID)
	}
	if result.Decisions[0].DeployedImagePath != "assets/img/wines/producer-wine-2022.jpg" ||
		result.Decisions[0].DeployedImageSHA256 == "" {
		t.Fatalf("deployment evidence = %#v", result.Decisions[0])
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(result.Wines[0].ImagePath), filepath.Base(result.Wines[0].ImagePath))); err != nil {
		t.Fatalf("normalized image missing: %v", err)
	}
}

func TestPrepareAppliesAnAcceptedImageToEveryRowForThePublicWine(t *testing.T) {
	store, wines, id := fixture(t)
	sibling := wines[0]
	sibling.ID = "wine-2"
	sibling.SKU = "500741*"
	sibling.ImageReviewStatus = model.ImageReviewRequired
	wines = append(wines, sibling)

	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	wantPath := result.Wines[0].ImagePath
	for _, wine := range result.Wines {
		if wine.Slug != wines[0].Slug {
			continue
		}
		if wine.ImageSource != model.ImageScrapedWeb || wine.ImageReviewStatus != "" {
			t.Fatalf("slug sibling did not receive the accepted public-wine image: %+v", wine)
		}
		if wine.ImagePath != wantPath {
			t.Fatalf("slug sibling image path = %q", wine.ImagePath)
		}
		if wine.SKU == "500740*" && wine.ImageReviewActionID != id {
			t.Fatalf("selected revision lost its action identity: %+v", wine)
		}
		if wine.SKU == "500741*" && (wine.ImageReviewActionID != "" || wine.ImageReviewedAt != "") {
			t.Fatalf("sibling revision inherited another revision's action identity: %+v", wine)
		}
	}
}

func TestPrepareDefersClaimedWorkAfterGracefulDeadline(t *testing.T) {
	store, wines, id := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := Prepare(ctx, PrepareInput{
		Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines,
		ImageDir: t.TempDir(), Now: time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Decisions) != 1 || result.Decisions[0].ID != id || result.Decisions[0].Status != "deferred" {
		t.Fatalf("decisions = %#v", result.Decisions)
	}
	if result.Wines[0].ImageReviewActionID != "" {
		t.Fatal("deferred work mutated the catalog")
	}
	if _, ok := store.files["_review/test/pending/"+id+".json"]; !ok {
		t.Fatal("deferred work lost its pending marker")
	}
}

func TestPrepareCancelsAndDefersAnActionThatStallsMidNormalization(t *testing.T) {
	store, wines, id := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	result, err := Prepare(ctx, PrepareInput{
		Store: store, Normalizer: deadlineNormalizer{}, Environment: "test", Wines: wines,
		ImageDir: t.TempDir(), Now: time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Decisions) != 1 || result.Decisions[0].ID != id || result.Decisions[0].Status != "deferred" {
		t.Fatalf("decisions = %#v", result.Decisions)
	}
	if result.Wines[0].ImageReviewActionID != "" {
		t.Fatal("cancelled normalization mutated the catalog")
	}
}

func TestPrepareOnlyProcessesClaimedActionIDs(t *testing.T) {
	store, wines, _ := fixture(t)
	result, err := Prepare(context.Background(), PrepareInput{
		Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines,
		ImageDir: t.TempDir(), Now: time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC),
		ActionIDs: map[string]struct{}{"00000000-0000-4000-8000-000000000099": {}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending != 0 || len(result.Decisions) != 0 {
		t.Fatalf("unclaimed action was processed: pending=%d decisions=%#v", result.Pending, result.Decisions)
	}
}

func TestPrepareAppliesReviewerSuppliedImageWithoutSourceProvenance(t *testing.T) {
	store, wines, id := fixture(t)
	var action Action
	if err := json.Unmarshal(store.files["_review/test/actions/"+id+".json"], &action); err != nil {
		t.Fatal(err)
	}
	bytes := []byte("reviewer-pasted-image")
	sum := sha256.Sum256(bytes)
	action.Kind, action.CandidateID = "reviewer-image", ""
	action.ImageStorageName = id + ".png"
	action.ImageSHA256 = hex.EncodeToString(sum[:])
	action.ImageBytes = len(bytes)
	action.ImageMIME = "image/png"
	data, _ := json.Marshal(action)
	store.files["_review/test/actions/"+id+".json"], store.files["_review/test/pending/"+id+".json"] = data, data
	store.files["_review/test/uploads/"+action.ImageStorageName] = bytes

	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if result.Decisions[0].Status != "prepared" || result.Decisions[0].ImageSHA256 != action.ImageSHA256 {
		t.Fatalf("decision = %#v", result.Decisions[0])
	}
	if result.Wines[0].ImageSource != model.ImageReviewerSupplied || result.Wines[0].ImageSourceURL != "" {
		t.Fatalf("wine image = %#v", result.Wines[0])
	}
}

func TestPrepareConflictsWhenWineRevisionChanged(t *testing.T) {
	store, wines, _ := fixture(t)
	wines[0].Name = "Changed wine"
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if result.Decisions[0].Status != "conflict" {
		t.Fatalf("decision = %#v", result.Decisions[0])
	}
	if result.Wines[0].ImageSource != model.ImageGeneratedLabel {
		t.Fatal("conflict mutated the catalog")
	}
}

func TestPrepareRejectsReviewerOutsidePackageRoster(t *testing.T) {
	store, wines, id := fixture(t)
	var action Action
	if err := json.Unmarshal(store.files["_review/test/actions/"+id+".json"], &action); err != nil {
		t.Fatal(err)
	}
	action.Reviewer = "Sales Person"
	data, _ := json.Marshal(action)
	store.files["_review/test/actions/"+id+".json"], store.files["_review/test/pending/"+id+".json"] = data, data
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if result.Decisions[0].Status != "rejected" || !strings.Contains(result.Decisions[0].Reason, "reviewer") {
		t.Fatalf("decision = %#v", result.Decisions[0])
	}
}

func TestPrepareFinishesExistingActionFromLegacyPackageWithoutRoster(t *testing.T) {
	store, wines, id := fixture(t)
	var manifest Manifest
	if err := json.Unmarshal(store.files["_review/test/packages/pkg-1/manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Reviewers = nil
	data, _ := json.Marshal(manifest)
	store.files["_review/test/packages/pkg-1/manifest.json"] = data
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if result.Decisions[0].ID != id || result.Decisions[0].Status != "prepared" {
		t.Fatalf("decision = %#v", result.Decisions[0])
	}
}

func TestPrepareRecognizesActionAlreadyCommittedBeforeReceiptRetry(t *testing.T) {
	store, wines, id := fixture(t)
	wines[0].ImageReviewActionID = id
	wines[0].ImagePath = "assets/img/wines/producer-wine-2022.jpg"
	wines[0].ImageSource = model.ImageScrapedWeb
	imageDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(imageDir, "producer-wine-2022.jpg"), []byte("already-deployed"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: imageDir, Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if result.Decisions[0].Status != "prepared" || !strings.Contains(result.Decisions[0].Reason, "already contains") ||
		result.Decisions[0].DeployedImagePath == "" || result.Decisions[0].DeployedImageSHA256 == "" {
		t.Fatalf("decision = %#v", result.Decisions[0])
	}
}

func TestPrepareRejectsCandidateHashMismatch(t *testing.T) {
	store, wines, _ := fixture(t)
	store.files["_review/test/packages/pkg-1/images/candidate-1.png"] = []byte("tampered")
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if result.Decisions[0].Status != "rejected" || !strings.Contains(result.Decisions[0].Reason, "integrity") {
		t.Fatalf("decision = %#v", result.Decisions[0])
	}
}

func TestPrepareRetriesOperationalNormalizationFailureAndRestoresInterruptedReplacementBackup(t *testing.T) {
	store, wines, _ := fixture(t)
	imageDir := t.TempDir()
	backup := filepath.Join(imageDir, wines[0].Slug+".jpg.review-backup")
	if err := os.WriteFile(backup, []byte("previous-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: failingNormalizer{}, Environment: "test", Wines: wines, ImageDir: imageDir, Now: time.Now()})
	if err == nil {
		t.Fatal("Prepare succeeded with an operational normalizer failure")
	}
	data, readErr := os.ReadFile(filepath.Join(imageDir, wines[0].Slug+".jpg"))
	if readErr != nil || string(data) != "previous-image" {
		t.Fatalf("restored destination = %q, err %v", data, readErr)
	}
}

func TestPrepareRejectsTypedInvalidImageWithoutPoisoningBatch(t *testing.T) {
	store, wines, _ := fixture(t)
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: invalidImageNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Decisions) != 1 || result.Decisions[0].Status != "rejected" || !strings.Contains(result.Decisions[0].Reason, "decoded") {
		t.Fatalf("decisions = %#v", result.Decisions)
	}
}

func TestPrepareSchedulesBroaderDiscoveryForCompleteRejectedSet(t *testing.T) {
	store, wines, id := fixture(t)
	var action Action
	if err := json.Unmarshal(store.files["_review/test/actions/"+id+".json"], &action); err != nil {
		t.Fatal(err)
	}
	action.Kind, action.CandidateID = "no-image", ""
	action.WineSlug = "producer-wine-2022"
	var manifest Manifest
	if err := json.Unmarshal(store.files["_review/test/packages/pkg-1/manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	action.RejectedCandidates = []Candidate{{CandidateID: manifest.Wines[0].Candidates[0].CandidateID, SHA256: manifest.Wines[0].Candidates[0].SHA256, SourceURL: manifest.Wines[0].Candidates[0].SourceURL}}
	data, _ := json.Marshal(action)
	store.files["_review/test/actions/"+id+".json"], store.files["_review/test/pending/"+id+".json"] = data, data
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if result.Wines[0].ImageReviewStatus != "" || result.Decisions[0].Status != "rediscover" {
		t.Fatalf("result = %#v", result)
	}
}

func TestFinalizeUploadsReceiptBeforeDeletingPending(t *testing.T) {
	store, _, id := fixture(t)
	deployed := []byte("normalized-deployed-image")
	sum := sha256.Sum256(deployed)
	decision := Decision{SchemaVersion: 1, ID: id, Environment: "test", Status: "prepared", Reviewer: "barb.fultz@finevines.com", SKU: "AB-1", Kind: "image-select", PackageID: "pkg-1", CandidateID: "candidate-1", SubmittedAt: "2026-08-15T01:00:00Z", PreparedAt: "2026-08-15T02:00:00Z", DeployedImagePath: "assets/img/wines/producer-wine-2022.jpg", DeployedImageSHA256: hex.EncodeToString(sum[:])}
	fetched := ""
	fetcher := fetcherFunc(func(_ context.Context, target string) ([]byte, error) { fetched = target; return deployed, nil })
	err := Finalize(context.Background(), FinalizeInput{Store: store, Environment: "test", Decisions: []Decision{decision}, CatalogCommit: strings.Repeat("a", 40), DeploymentTarget: "https://finevines.biz", RunID: "123", Now: time.Date(2026, 8, 15, 3, 0, 0, 0, time.UTC), Fetcher: fetcher})
	if err != nil {
		t.Fatal(err)
	}
	wantUpload := "upload:_review/test/receipts/" + id + ".json"
	wantDelete := "delete:_review/test/pending/" + id + ".json"
	if len(store.events) != 2 || store.events[0] != wantUpload || store.events[1] != wantDelete {
		t.Fatalf("events = %#v", store.events)
	}
	var receipt Receipt
	if err := json.Unmarshal(store.files["_review/test/receipts/"+id+".json"], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Status != "completed" {
		t.Fatalf("receipt status = %q", receipt.Status)
	}
	if receipt.VerifiedImageURL != fetched || !strings.Contains(fetched, "review-action="+id) {
		t.Fatalf("verified image URL = %q, fetched %q", receipt.VerifiedImageURL, fetched)
	}
}

func TestFinalizeRecordsRediscoveryHandoffAndDeletesPending(t *testing.T) {
	store, _, id := fixture(t)
	decision := Decision{SchemaVersion: 1, ID: id, Environment: "test", Status: "rediscover", Reviewer: "barb.fultz@finevines.com", SKU: "500740*", Kind: "no-image", PackageID: "pkg-1", SubmittedAt: "2026-08-15T01:00:00Z", PreparedAt: "2026-08-15T02:00:00Z"}
	err := Finalize(context.Background(), FinalizeInput{Store: store, Environment: "test", Decisions: []Decision{decision}, CatalogCommit: strings.Repeat("a", 40), DeploymentTarget: "https://finevines.biz", RunID: "123", Now: time.Date(2026, 8, 15, 3, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := store.files["_review/test/pending/"+id+".json"]; exists {
		t.Fatal("rediscovery pending pointer was not removed after durable handoff")
	}
	var receipt Receipt
	if err := json.Unmarshal(store.files["_review/test/receipts/"+id+".json"], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Status != "rediscover" || receipt.VerifiedImageURL != "" {
		t.Fatalf("receipt = %#v", receipt)
	}
}

func TestFinalizeHashMismatchPreservesPendingWork(t *testing.T) {
	store, _, id := fixture(t)
	decision := Decision{SchemaVersion: 1, ID: id, Environment: "test", Status: "prepared", Kind: "image-select", DeployedImagePath: "assets/img/wines/producer-wine-2022.jpg", DeployedImageSHA256: strings.Repeat("a", 64)}
	err := Finalize(context.Background(), FinalizeInput{Store: store, Environment: "test", Decisions: []Decision{decision}, CatalogCommit: strings.Repeat("a", 40), DeploymentTarget: "https://finevines.biz", RunID: "123", Now: time.Now(), Fetcher: fetcherFunc(func(context.Context, string) ([]byte, error) { return []byte("wrong"), nil })})
	if err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("Finalize error = %v", err)
	}
	if _, ok := store.files["_review/test/pending/"+id+".json"]; !ok {
		t.Fatal("hash mismatch deleted pending work")
	}
	if len(store.events) != 0 {
		t.Fatalf("hash mismatch wrote receipt events: %#v", store.events)
	}
}

func TestFinalizeRetryAcceptsTheExistingCompletionProof(t *testing.T) {
	store, _, id := fixture(t)
	deployed := []byte("normalized-deployed-image")
	sum := sha256.Sum256(deployed)
	decision := Decision{SchemaVersion: 1, ID: id, Environment: "test", Status: "prepared", Kind: "image-select", DeployedImagePath: "assets/img/wines/producer-wine-2022.jpg", DeployedImageSHA256: hex.EncodeToString(sum[:])}
	input := FinalizeInput{Store: store, Environment: "test", Decisions: []Decision{decision}, CatalogCommit: strings.Repeat("a", 40), DeploymentTarget: "https://finevines.biz", RunID: "first", Now: time.Date(2026, 8, 15, 3, 0, 0, 0, time.UTC), Fetcher: fetcherFunc(func(context.Context, string) ([]byte, error) { return deployed, nil })}
	if err := Finalize(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	input.RunID = "retry"
	input.CatalogCommit = strings.Repeat("b", 40)
	input.Now = input.Now.Add(time.Hour)
	if err := Finalize(context.Background(), input); err != nil {
		t.Fatalf("idempotent retry after a later catalog commit failed: %v", err)
	}
	uploads := 0
	for _, event := range store.events {
		if strings.HasPrefix(event, "upload:_review/test/receipts/") {
			uploads++
		}
	}
	if uploads != 1 {
		t.Fatalf("receipt uploads = %d, events %#v", uploads, store.events)
	}
}

func TestPrepareEmitsACompletionDecisionAfterReceiptSQLCrash(t *testing.T) {
	store, wines, id := fixture(t)
	deployed := []byte("normalized-deployed-image")
	sum := sha256.Sum256(deployed)
	decision := Decision{SchemaVersion: 1, ID: id, Environment: "test", Status: "prepared", Reviewer: "barb.fultz@finevines.com", SKU: "500740*", Kind: "image-select", PackageID: "pkg-1", CandidateID: "candidate-1", SubmittedAt: "2026-08-15T01:00:00Z", PreparedAt: "2026-08-15T02:00:00Z", DeployedImagePath: "assets/img/wines/producer-wine-2022.jpg", DeployedImageSHA256: hex.EncodeToString(sum[:])}
	if err := Finalize(context.Background(), FinalizeInput{Store: store, Environment: "test", Decisions: []Decision{decision}, CatalogCommit: strings.Repeat("a", 40), DeploymentTarget: "https://finevines.biz", RunID: "first", Now: time.Date(2026, 8, 15, 3, 0, 0, 0, time.UTC), Fetcher: fetcherFunc(func(context.Context, string) ([]byte, error) { return deployed, nil })}); err != nil {
		t.Fatal(err)
	}
	store.files["_review/test/pending/"+id+".json"] = append([]byte(nil), store.files["_review/test/actions/"+id+".json"]...)
	result, err := Prepare(context.Background(), PrepareInput{Store: store, Normalizer: copyNormalizer{}, Environment: "test", Wines: wines, ImageDir: t.TempDir(), Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Decisions) != 1 || result.Decisions[0].ID != id || result.Decisions[0].Status != "prepared" || result.Decisions[0].DeployedImageSHA256 != decision.DeployedImageSHA256 {
		t.Fatalf("recovery decisions = %#v", result.Decisions)
	}
	if _, ok := store.files["_review/test/pending/"+id+".json"]; ok {
		t.Fatal("receipt recovery retained the pending marker")
	}
	if err := Finalize(context.Background(), FinalizeInput{Store: store, Environment: "test", Decisions: result.Decisions, CatalogCommit: strings.Repeat("a", 40), DeploymentTarget: "https://finevines.biz", RunID: "retry", Now: time.Now(), Fetcher: fetcherFunc(func(context.Context, string) ([]byte, error) { return deployed, nil })}); err != nil {
		t.Fatalf("receipt recovery did not converge through finalization: %v", err)
	}
}

func TestWineRevisionContractFixture(t *testing.T) {
	wine := model.Wine{ID: "wine-1", SKU: "AB-1", Slug: "producer-wine-2022", Producer: "Producer", Name: "Wine", Vintage: "2022", ImagePath: "assets/img/wines/producer-wine-2022.svg", ImageSource: model.ImageGeneratedLabel, SourceHash: "source"}
	if got, want := WineRevision(wine), "56514dfc14df894df9dbb0f24ba5f6d3180fb28b8d3d4a36b0a30237a4c99e7b"; got != want {
		t.Fatalf("WineRevision = %s, want %s", got, want)
	}
}

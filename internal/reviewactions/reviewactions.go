// Package reviewactions validates and applies immutable selections submitted
// through the protected review console. Its interface is two operations:
// Prepare before the site build, then Finalize only after deployment and the
// catalog commit succeed. Storage, image normalization, and time are adapters.
package reviewactions

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
)

const schemaVersion = 1

var (
	uuidPattern         = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	hashPattern         = regexp.MustCompile(`^[a-f0-9]{64}$`)
	commitPattern       = regexp.MustCompile(`^[a-f0-9]{7,64}$`)
	deployedPathPattern = regexp.MustCompile(`^assets/img/wines/[A-Za-z0-9._-]+\.jpg$`)
)

type Store interface {
	List(context.Context, string) ([]string, error)
	Download(context.Context, string) ([]byte, error)
	Upload(context.Context, string, []byte) error
	Delete(context.Context, string) error
}

type Normalizer interface {
	Normalize(context.Context, string, string) error
}

type DeploymentFetcher interface {
	Fetch(context.Context, string) ([]byte, error)
}

// InvalidImageError marks bytes that the image decoder cannot read. Adapters
// must not use it for execution, filesystem, or other retryable failures.
type InvalidImageError struct{ Err error }

func (err *InvalidImageError) Error() string { return fmt.Sprintf("invalid image: %v", err.Err) }
func (err *InvalidImageError) Unwrap() error { return err.Err }

type Action struct {
	SchemaVersion       int    `json:"schemaVersion"`
	ID                  string `json:"id"`
	Environment         string `json:"environment"`
	Reviewer            string `json:"reviewer"`
	SKU                 string `json:"sku"`
	Kind                string `json:"kind"`
	PackageID           string `json:"packageId"`
	TargetCatalogCommit string `json:"targetCatalogCommit"`
	WineRevision        string `json:"wineRevision"`
	CandidateID         string `json:"candidateId"`
	ImageStorageName    string `json:"imageStorageName,omitempty"`
	ImageSHA256         string `json:"imageSHA256,omitempty"`
	ImageBytes          int    `json:"imageBytes,omitempty"`
	ImageMIME           string `json:"imageMIME,omitempty"`
	SubmittedAt         string `json:"submittedAt"`
	CSRFSessionID       string `json:"csrfSessionId"`
}

type Candidate struct {
	CandidateID    string   `json:"candidateId"`
	StorageName    string   `json:"storageName"`
	SHA256         string   `json:"sha256"`
	Bytes          int      `json:"bytes"`
	MIME           string   `json:"mime"`
	Width          int      `json:"width"`
	Height         int      `json:"height"`
	SourceURL      string   `json:"sourceUrl"`
	SourceImageURL string   `json:"sourceImageUrl"`
	SourceHost     string   `json:"sourceHost"`
	Reason         string   `json:"reason"`
	LabelRead      string   `json:"labelRead"`
	Badges         []string `json:"badges"`
}

type PackageWine struct {
	SKU             string      `json:"sku"`
	Slug            string      `json:"slug"`
	WineRevision    string      `json:"wineRevision"`
	DisplayIdentity string      `json:"displayIdentity"`
	SearchQuery     string      `json:"searchQuery"`
	CurrentImage    string      `json:"currentImage"`
	Candidates      []Candidate `json:"candidates"`
}

type Reviewer struct {
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
	Role  string `json:"role"`
}

type Manifest struct {
	SchemaVersion int           `json:"schemaVersion"`
	PackageID     string        `json:"packageId"`
	Environment   string        `json:"environment"`
	CatalogCommit string        `json:"catalogCommit"`
	CreatedAt     string        `json:"createdAt"`
	ExpiresAt     string        `json:"expiresAt"`
	Reviewers     []Reviewer    `json:"reviewers"`
	Wines         []PackageWine `json:"wines"`
}

type Decision struct {
	SchemaVersion       int    `json:"schemaVersion"`
	ID                  string `json:"id"`
	Environment         string `json:"environment"`
	Status              string `json:"status"`
	Reason              string `json:"reason,omitempty"`
	Reviewer            string `json:"reviewer"`
	SKU                 string `json:"sku"`
	Kind                string `json:"kind"`
	PackageID           string `json:"packageId"`
	CandidateID         string `json:"candidateId,omitempty"`
	ImageSHA256         string `json:"imageSha256,omitempty"`
	DeployedImagePath   string `json:"deployedImagePath,omitempty"`
	DeployedImageSHA256 string `json:"deployedImageSha256,omitempty"`
	SubmittedAt         string `json:"submittedAt"`
	PreparedAt          string `json:"preparedAt"`
}

type Receipt struct {
	Decision
	CatalogCommit    string `json:"catalogCommit"`
	DeploymentTarget string `json:"deploymentTarget"`
	RunID            string `json:"runId"`
	CompletedAt      string `json:"completedAt"`
	VerifiedImageURL string `json:"verifiedImageUrl,omitempty"`
}

type PrepareInput struct {
	Store       Store
	Normalizer  Normalizer
	Environment string
	Wines       []model.Wine
	ImageDir    string
	Now         time.Time
	Log         func(string, ...any)
	ActionIDs   map[string]struct{}
}

type PrepareResult struct {
	Wines     []model.Wine `json:"-"`
	Decisions []Decision   `json:"decisions"`
	Pending   int          `json:"pending"`
}

type FinalizeInput struct {
	Store            Store
	Environment      string
	Decisions        []Decision
	CatalogCommit    string
	DeploymentTarget string
	RunID            string
	Now              time.Time
	Fetcher          DeploymentFetcher
}

func revision(w model.Wine) string {
	values := []any{1, strings.TrimSpace(w.SKU), strings.TrimSpace(w.ID), strings.TrimSpace(w.Slug), strings.TrimSpace(w.Producer), strings.TrimSpace(w.Name), strings.TrimSpace(w.Vintage), strings.TrimSpace(w.Varietal), strings.TrimSpace(w.Region), strings.TrimSpace(w.Appellation), strings.TrimSpace(w.Country), strings.TrimSpace(w.Color), strings.TrimSpace(w.Style), strings.TrimSpace(w.BottleSize), strings.TrimSpace(w.ImagePath), strings.TrimSpace(w.ImageSource), strings.TrimSpace(w.ImageSourceURL), strings.TrimSpace(w.SourceHash), strings.TrimSpace(w.Status), strings.TrimSpace(w.ImageReviewStatus), strings.TrimSpace(w.ImageReviewedAt), strings.TrimSpace(w.ImageReviewActionID)}
	encoded, _ := json.Marshal(values)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func strictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return fmt.Errorf("trailing JSON: %w", err)
	}
	return nil
}

func validSegment(value string) bool {
	if value == "" || len(value) > 180 || strings.Contains(value, "..") || strings.ContainsAny(value, `/\\`) {
		return false
	}
	for _, char := range value {
		if !(char == '.' || char == '_' || char == '-' || char >= '0' && char <= '9' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z') {
			return false
		}
	}
	return true
}

func validSKU(value string) bool {
	if value == "" || len(value) > 80 || strings.Contains(value, "..") || strings.ContainsAny(value, `/\\`) {
		return false
	}
	for _, char := range value {
		if !(char == '.' || char == '_' || char == '-' || char == '*' || char >= '0' && char <= '9' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z') {
			return false
		}
	}
	return true
}

func validateAction(action Action, environment, fileID string) error {
	if action.SchemaVersion != schemaVersion || action.Environment != environment {
		return fmt.Errorf("wrong schema or environment")
	}
	if !uuidPattern.MatchString(action.ID) || action.ID != fileID {
		return fmt.Errorf("invalid action id")
	}
	if action.Kind != "image-select" && action.Kind != "no-image" && action.Kind != "reviewer-image" {
		return fmt.Errorf("invalid action kind")
	}
	if !validSegment(action.PackageID) || len(action.PackageID) > 160 || !validSKU(action.SKU) ||
		!hashPattern.MatchString(action.WineRevision) || !commitPattern.MatchString(action.TargetCatalogCommit) ||
		strings.TrimSpace(action.Reviewer) == "" || len(action.Reviewer) > 80 || !uuidPattern.MatchString(action.CSRFSessionID) {
		return fmt.Errorf("missing or unsafe action identity")
	}
	if action.Kind == "image-select" && !validSegment(action.CandidateID) {
		return fmt.Errorf("image selection has no candidate")
	}
	if action.Kind == "no-image" && action.CandidateID != "" {
		return fmt.Errorf("no-image action names a candidate")
	}
	if action.Kind == "reviewer-image" {
		validMIME := action.ImageMIME == "image/png" || action.ImageMIME == "image/jpeg" || action.ImageMIME == "image/webp"
		if action.CandidateID != "" || !validSegment(action.ImageStorageName) || !strings.HasPrefix(action.ImageStorageName, action.ID+".") ||
			!hashPattern.MatchString(action.ImageSHA256) || action.ImageBytes <= 0 || action.ImageBytes > 10*1024*1024 || !validMIME {
			return fmt.Errorf("reviewer image has invalid metadata")
		}
	} else if action.ImageStorageName != "" || action.ImageSHA256 != "" || action.ImageBytes != 0 || action.ImageMIME != "" {
		return fmt.Errorf("non-reviewer action has image metadata")
	}
	if _, err := time.Parse(time.RFC3339, action.SubmittedAt); err != nil {
		return fmt.Errorf("invalid submittedAt")
	}
	return nil
}

func validateManifest(manifest Manifest, action Action) (PackageWine, Candidate, error) {
	if manifest.SchemaVersion != schemaVersion || manifest.PackageID != action.PackageID || manifest.Environment != action.Environment || manifest.CatalogCommit != action.TargetCatalogCommit {
		return PackageWine{}, Candidate{}, fmt.Errorf("action does not match package")
	}
	reviewerAllowed := action.Reviewer == "joel@danowitz.com" || len(manifest.Reviewers) == 0 // Legacy packages predate roster enforcement.
	for _, reviewer := range manifest.Reviewers {
		identityMatches := reviewer.Email == action.Reviewer || (reviewer.Email == "" && reviewer.Name == action.Reviewer)
		if identityMatches && (reviewer.Role == "Executive" || reviewer.Role == "Back Office") {
			reviewerAllowed = true
			break
		}
	}
	if !reviewerAllowed {
		return PackageWine{}, Candidate{}, fmt.Errorf("reviewer is not authorized for package")
	}
	created, err := time.Parse(time.RFC3339, manifest.CreatedAt)
	if err != nil {
		return PackageWine{}, Candidate{}, fmt.Errorf("invalid package createdAt")
	}
	expires, err := time.Parse(time.RFC3339, manifest.ExpiresAt)
	if err != nil || !expires.After(created) {
		return PackageWine{}, Candidate{}, fmt.Errorf("invalid package expiry")
	}
	submitted, _ := time.Parse(time.RFC3339, action.SubmittedAt)
	if submitted.Before(created) || submitted.After(expires) {
		return PackageWine{}, Candidate{}, fmt.Errorf("action was submitted outside package lifetime")
	}
	for _, wine := range manifest.Wines {
		if wine.SKU != action.SKU {
			continue
		}
		if wine.WineRevision != action.WineRevision {
			return PackageWine{}, Candidate{}, fmt.Errorf("action does not match package wine revision")
		}
		if action.Kind == "no-image" || action.Kind == "reviewer-image" {
			return wine, Candidate{}, nil
		}
		for _, candidate := range wine.Candidates {
			if candidate.CandidateID == action.CandidateID {
				source, sourceErr := url.Parse(candidate.SourceURL)
				validMIME := candidate.MIME == "image/png" || candidate.MIME == "image/jpeg" || candidate.MIME == "image/webp"
				if !validSegment(candidate.CandidateID) || !validSegment(candidate.StorageName) || !strings.HasPrefix(candidate.StorageName, candidate.CandidateID+".") ||
					sourceErr != nil || (source.Scheme != "https" && source.Scheme != "http") || source.Hostname() == "" ||
					candidate.Bytes <= 0 || !validMIME || !hashPattern.MatchString(candidate.SHA256) {
					return PackageWine{}, Candidate{}, fmt.Errorf("invalid package candidate")
				}
				return wine, candidate, nil
			}
		}
		return PackageWine{}, Candidate{}, fmt.Errorf("candidate does not belong to package wine")
	}
	return PackageWine{}, Candidate{}, fmt.Errorf("package has no matching wine")
}

func Prepare(ctx context.Context, input PrepareInput) (PrepareResult, error) {
	if input.Environment != "test" && input.Environment != "production" {
		return PrepareResult{}, fmt.Errorf("reviewactions: invalid environment")
	}
	if input.Store == nil || input.Normalizer == nil {
		return PrepareResult{}, fmt.Errorf("reviewactions: missing adapter")
	}
	logf := input.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	result := PrepareResult{Wines: append([]model.Wine(nil), input.Wines...)}
	prefix := path.Join("_review", input.Environment)
	files, err := input.Store.List(ctx, path.Join(prefix, "pending"))
	if err != nil {
		return result, err
	}
	sort.Strings(files)
	bySKU := make(map[string]int, len(result.Wines))
	for i, wine := range result.Wines {
		bySKU[wine.SKU] = i
	}
	for _, name := range files {
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !uuidPattern.MatchString(id) {
			logf("reviewactions: ignoring unsafe pending object %q", name)
			continue
		}
		if len(input.ActionIDs) > 0 {
			if _, selected := input.ActionIDs[id]; !selected {
				continue
			}
		}
		result.Pending++
		receiptPath := path.Join(prefix, "receipts", name)
		if receipt, err := input.Store.Download(ctx, receiptPath); err != nil {
			return result, err
		} else if len(receipt) > 0 {
			if err := input.Store.Delete(ctx, path.Join(prefix, "pending", name)); err != nil {
				return result, err
			}
			continue
		}
		actionData, err := input.Store.Download(ctx, path.Join(prefix, "actions", name))
		if err != nil {
			return result, err
		}
		decision := Decision{SchemaVersion: 1, ID: id, Environment: input.Environment, Status: "rejected", Reason: "invalid action", PreparedAt: input.Now.UTC().Format(time.RFC3339)}
		var action Action
		if err := strictJSON(actionData, &action); err != nil || validateAction(action, input.Environment, id) != nil {
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		decision.Reviewer, decision.SKU, decision.Kind, decision.PackageID, decision.CandidateID, decision.SubmittedAt = action.Reviewer, action.SKU, action.Kind, action.PackageID, action.CandidateID, action.SubmittedAt
		manifestData, err := input.Store.Download(ctx, path.Join(prefix, "packages", action.PackageID, "manifest.json"))
		if err != nil {
			return result, err
		}
		var manifest Manifest
		if err := strictJSON(manifestData, &manifest); err != nil {
			decision.Reason = "invalid review package"
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		_, candidate, err := validateManifest(manifest, action)
		if err != nil {
			decision.Reason = err.Error()
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		index, ok := bySKU[action.SKU]
		if !ok {
			decision.Status, decision.Reason = "conflict", "the catalog wine changed after this review package was created"
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		if result.Wines[index].ImageReviewActionID == action.ID {
			decision.Status, decision.Reason = "prepared", "the catalog already contains this review action"
			decision.ImageSHA256 = candidate.SHA256
			if action.Kind == "reviewer-image" {
				decision.ImageSHA256 = action.ImageSHA256
			}
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		if revision(result.Wines[index]) != action.WineRevision {
			decision.Status, decision.Reason = "conflict", "the catalog wine changed after this review package was created"
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		if action.Kind == "no-image" {
			result.Wines[index].ImageReviewStatus = "no-match"
			result.Wines[index].ImageReviewedAt = input.Now.UTC().Format(time.RFC3339)
			result.Wines[index].ImageReviewActionID = action.ID
			decision.Status, decision.Reason = "prepared", "reviewer rejected every candidate"
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		candidatePath := path.Join(prefix, "packages", action.PackageID, "images", candidate.StorageName)
		imageSource := model.ImageScrapedWeb
		if action.Kind == "reviewer-image" {
			candidate = Candidate{StorageName: action.ImageStorageName, SHA256: action.ImageSHA256, Bytes: action.ImageBytes, MIME: action.ImageMIME}
			candidatePath = path.Join(prefix, "uploads", action.ImageStorageName)
			imageSource = model.ImageReviewerSupplied
		}
		candidateData, err := input.Store.Download(ctx, candidatePath)
		if err != nil {
			return result, err
		}
		sum := sha256.Sum256(candidateData)
		if len(candidateData) != candidate.Bytes || hex.EncodeToString(sum[:]) != candidate.SHA256 {
			decision.Reason = "candidate bytes failed the package integrity check"
			result.Decisions = append(result.Decisions, decision)
			continue
		}
		if err := applyImage(ctx, input, &result.Wines[index], candidateData, candidate, action.ID, imageSource); err != nil {
			var invalidImage *InvalidImageError
			if errors.As(err, &invalidImage) {
				decision.Reason = "selected image could not be decoded"
				logf("reviewactions: rejected action %s: %v", action.ID, err)
				result.Decisions = append(result.Decisions, decision)
				continue
			}
			return result, err
		}
		deployedPath := path.Join("assets/img/wines", result.Wines[index].Slug+".jpg")
		deployedData, err := os.ReadFile(filepath.Join(input.ImageDir, result.Wines[index].Slug+".jpg"))
		if err != nil {
			return result, fmt.Errorf("read normalized image: %w", err)
		}
		deployedSum := sha256.Sum256(deployedData)
		decision.Status, decision.Reason, decision.ImageSHA256 = "prepared", "selected image prepared for deployment", candidate.SHA256
		decision.DeployedImagePath = deployedPath
		decision.DeployedImageSHA256 = hex.EncodeToString(deployedSum[:])
		result.Decisions = append(result.Decisions, decision)
	}
	return result, nil
}

func applyImage(ctx context.Context, input PrepareInput, wine *model.Wine, data []byte, candidate Candidate, actionID, imageSource string) error {
	if err := os.MkdirAll(input.ImageDir, 0o755); err != nil {
		return err
	}
	destination := filepath.Join(input.ImageDir, wine.Slug+".jpg")
	backup := destination + ".review-backup"
	if _, destinationErr := os.Stat(destination); os.IsNotExist(destinationErr) {
		if _, backupErr := os.Stat(backup); backupErr == nil {
			if err := os.Rename(backup, destination); err != nil {
				return fmt.Errorf("restore interrupted image replacement: %w", err)
			}
		}
	} else if destinationErr != nil {
		return destinationErr
	} else if err := os.Remove(backup); err != nil && !os.IsNotExist(err) {
		return err
	}
	ext := ".img"
	if candidate.MIME == "image/png" {
		ext = ".png"
	} else if candidate.MIME == "image/webp" {
		ext = ".webp"
	} else if candidate.MIME == "image/jpeg" {
		ext = ".jpg"
	}
	source, err := os.CreateTemp("", "finevines-review-*"+ext)
	if err != nil {
		return err
	}
	sourceName := source.Name()
	defer os.Remove(sourceName)
	if _, err := source.Write(data); err != nil {
		source.Close()
		return err
	}
	if err := source.Close(); err != nil {
		return err
	}
	output, err := os.CreateTemp(input.ImageDir, ".review-*.jpg")
	if err != nil {
		return err
	}
	outputName := output.Name()
	output.Close()
	os.Remove(outputName)
	defer os.Remove(outputName)
	if err := input.Normalizer.Normalize(ctx, sourceName, outputName); err != nil {
		return fmt.Errorf("normalize candidate: %w", err)
	}
	if _, err := os.Stat(destination); err == nil {
		if err := os.Rename(destination, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(outputName, destination); err != nil {
		if _, statErr := os.Stat(backup); statErr == nil {
			_ = os.Rename(backup, destination)
		}
		return err
	}
	os.Remove(backup)
	os.Remove(filepath.Join(input.ImageDir, wine.Slug+".svg"))
	wine.ImagePath = path.Join(filepath.ToSlash(input.ImageDir), wine.Slug+".jpg")
	wine.ImageSource, wine.ImageSourceURL = imageSource, candidate.SourceURL
	wine.ImageReviewStatus = ""
	wine.ImageReviewedAt = input.Now.UTC().Format(time.RFC3339)
	wine.ImageReviewActionID = actionID
	if wine.Sources == nil {
		wine.Sources = map[string]model.FieldSource{}
	}
	wine.Sources["image"] = model.ImageFieldSource(wine.ImageSource)
	wine.MetadataScore = model.MetadataScore(wine.Sources)
	return nil
}

func Finalize(ctx context.Context, input FinalizeInput) error {
	if input.Environment != "test" && input.Environment != "production" {
		return fmt.Errorf("reviewactions: invalid environment")
	}
	if !commitPattern.MatchString(input.CatalogCommit) || input.DeploymentTarget == "" || input.RunID == "" {
		return fmt.Errorf("reviewactions: finalization evidence is incomplete")
	}
	prefix := path.Join("_review", input.Environment)
	verifiedURLs := make(map[string]string)
	for _, decision := range input.Decisions {
		if decision.Status != "prepared" || decision.Kind == "no-image" {
			continue
		}
		if input.Fetcher == nil || !deployedPathPattern.MatchString(decision.DeployedImagePath) || !hashPattern.MatchString(decision.DeployedImageSHA256) {
			return fmt.Errorf("reviewactions: action %s has incomplete deployed-image evidence", decision.ID)
		}
		imageURL := strings.TrimRight(input.DeploymentTarget, "/") + "/" + strings.TrimLeft(decision.DeployedImagePath, "/") + "?review-action=" + decision.ID
		deployed, err := input.Fetcher.Fetch(ctx, imageURL)
		if err != nil {
			return fmt.Errorf("reviewactions: fetch deployed image for %s: %w", decision.ID, err)
		}
		sum := sha256.Sum256(deployed)
		if hex.EncodeToString(sum[:]) != decision.DeployedImageSHA256 {
			return fmt.Errorf("reviewactions: deployed image hash mismatch for %s", decision.ID)
		}
		verifiedURLs[decision.ID] = imageURL
	}
	for _, decision := range input.Decisions {
		if decision.Status != "prepared" {
			continue
		}
		decision.Status = "completed"
		receipt := Receipt{Decision: decision, CatalogCommit: input.CatalogCommit, DeploymentTarget: input.DeploymentTarget, RunID: input.RunID, CompletedAt: input.Now.UTC().Format(time.RFC3339), VerifiedImageURL: verifiedURLs[decision.ID]}
		data, err := json.MarshalIndent(receipt, "", "  ")
		if err != nil {
			return err
		}
		data = append(data, '\n')
		receiptPath := path.Join(prefix, "receipts", decision.ID+".json")
		existing, err := input.Store.Download(ctx, receiptPath)
		if err != nil {
			return err
		}
		if len(existing) > 0 {
			var prior Receipt
			if err := strictJSON(existing, &prior); err != nil || prior.Decision != receipt.Decision ||
				prior.CatalogCommit != receipt.CatalogCommit || prior.DeploymentTarget != receipt.DeploymentTarget ||
				prior.VerifiedImageURL != receipt.VerifiedImageURL {
				return fmt.Errorf("reviewactions: receipt %s already exists with different evidence", decision.ID)
			}
		} else {
			if err := input.Store.Upload(ctx, receiptPath, data); err != nil {
				return err
			}
		}
		if err := input.Store.Delete(ctx, path.Join(prefix, "pending", decision.ID+".json")); err != nil {
			return err
		}
	}
	return nil
}

// WineRevision is exported only for the cross-language contract fixture and
// package tests; production callers use Prepare.
func WineRevision(w model.Wine) string { return revision(w) }

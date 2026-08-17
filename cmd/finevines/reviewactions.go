package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/deploy"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/notify"
	"github.com/gritautomation/finevines-website/internal/reviewactions"
)

const reviewCatalogPath = "data/wines.json"

var imgnormCandidates = []string{"imgnorm", "imgnorm.exe"}

type execNormalizer struct{ bin string }

func (normalizer execNormalizer) Normalize(ctx context.Context, source, destination string) error {
	output, err := exec.CommandContext(ctx, normalizer.bin, "-in", source, "-out", destination).CombinedOutput()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 3 {
			return &reviewactions.InvalidImageError{Err: fmt.Errorf("%s", strings.TrimSpace(string(output)))}
		}
		return fmt.Errorf("%s: %v: %s", normalizer.bin, err, output)
	}
	return nil
}

func findImgnorm() (string, error) {
	for _, candidate := range imgnormCandidates {
		if _, err := os.Stat(candidate); err != nil {
			continue
		}
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			return "", err
		}
		return absolute, nil
	}
	return "", fmt.Errorf("no imgnorm binary in the working directory; build it with: go build -o imgnorm ./tools/imgnorm")
}

func reviewStore(cfg config.Config) (*deploy.BunnyClient, error) {
	required := []struct{ name, value string }{
		{"FINEVINES_REVIEW_STORAGE_ZONE", cfg.ReviewStorageZone},
		{"FINEVINES_REVIEW_STORAGE_KEY", cfg.ReviewStorageKey},
	}
	for _, item := range required {
		if strings.TrimSpace(item.value) == "" {
			return nil, fmt.Errorf("set %s in .env (or the environment)", item.name)
		}
	}
	return deploy.NewBunnyClient(
		cfg.ReviewStorageEndpoint, cfg.ReviewStorageZone, cfg.ReviewStorageKey,
		cfg.BunnyAPIKey, cfg.BunnyPullZoneID, http.DefaultClient,
	), nil
}

// runReviewApply is the only catalog mutation seam for hosted-review actions.
// It validates immutable action, package, candidate, and catalog revisions,
// then prepares accepted images before build/deploy. Pending objects remain in
// Bunny until runReviewFinalize records proof that the deployment completed.
func runReviewApply(cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("reviewapply", flag.ContinueOnError)
	environment := fs.String("environment", envDefault("FINEVINES_REVIEW_ENVIRONMENT", "production"), "review environment: test or production")
	decisionsPath := fs.String("decisions", ".run/review-decisions.json", "run-local prepared decision log")
	appliedPath := fs.String("applied", ".run/queue-applied.json", "digest-compatible applied action log")
	if err := fs.Parse(args); err != nil {
		return err
	}
	store, err := reviewStore(cfg)
	if err != nil {
		return fmt.Errorf("reviewapply: %w", err)
	}
	wines, err := model.LoadWines(reviewCatalogPath)
	if err != nil {
		return fmt.Errorf("reviewapply: load catalog: %w", err)
	}
	normalizer, err := findImgnorm()
	if err != nil {
		return fmt.Errorf("reviewapply: %w", err)
	}
	result, err := reviewactions.Prepare(context.Background(), reviewactions.PrepareInput{
		Store: store, Normalizer: execNormalizer{bin: normalizer}, Environment: *environment,
		Wines: wines, ImageDir: "assets/img/wines", Now: time.Now().UTC(), Log: log.Printf,
	})
	if err != nil {
		return fmt.Errorf("reviewapply: %w", err)
	}
	if err := model.SaveWines(reviewCatalogPath, result.Wines); err != nil {
		return fmt.Errorf("reviewapply: save catalog: %w", err)
	}
	if err := writeReviewJSON(*decisionsPath, result.Decisions); err != nil {
		return fmt.Errorf("reviewapply: write decisions: %w", err)
	}
	applied := make([]notify.AppliedAction, 0, len(result.Decisions))
	for _, decision := range result.Decisions {
		if decision.Status != "prepared" {
			continue
		}
		applied = append(applied, notify.AppliedAction{
			ID: decision.ID, SKU: decision.SKU, Kind: decision.Kind, Reviewer: decision.Reviewer,
			AppliedAt: decision.PreparedAt, Outcome: decision.Reason,
		})
	}
	if err := writeRunLog(*appliedPath, applied); err != nil {
		return fmt.Errorf("reviewapply: write digest log: %w", err)
	}
	log.Printf("reviewapply: %d pending object(s), %d decision(s), %d catalog mutation(s)", result.Pending, len(result.Decisions), len(applied))
	return nil
}

// runReviewFinalize writes a durable receipt only after the workflow has built,
// deployed, and committed the prepared catalog. Upload-before-delete ordering
// means a failed receipt write leaves the pending pointer available to retry.
func runReviewFinalize(cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("reviewfinalize", flag.ContinueOnError)
	environment := fs.String("environment", envDefault("FINEVINES_REVIEW_ENVIRONMENT", "production"), "review environment: test or production")
	decisionsPath := fs.String("decisions", ".run/review-decisions.json", "run-local prepared decision log")
	target := fs.String("target", cfg.SiteBaseURL, "deployed site URL recorded in receipts")
	runID := fs.String("run-id", os.Getenv("GITHUB_RUN_ID"), "workflow run identifier recorded in receipts")
	preparedStatus := fs.String("prepared-status", "deployed", "receipt status for prepared actions: deployed or validated")
	if err := fs.Parse(args); err != nil {
		return err
	}
	decisions, err := loadReviewDecisions(*decisionsPath)
	if err != nil {
		return fmt.Errorf("reviewfinalize: %w", err)
	}
	if len(decisions) == 0 {
		log.Printf("reviewfinalize: no decisions to finalize")
		return nil
	}
	store, err := reviewStore(cfg)
	if err != nil {
		return fmt.Errorf("reviewfinalize: %w", err)
	}
	commit, err := gitHead()
	if err != nil {
		return fmt.Errorf("reviewfinalize: %w", err)
	}
	if err := reviewactions.Finalize(context.Background(), reviewactions.FinalizeInput{
		Store: store, Environment: *environment, Decisions: decisions, PreparedStatus: *preparedStatus, CatalogCommit: commit,
		DeploymentTarget: *target, RunID: *runID, Now: time.Now().UTC(),
	}); err != nil {
		return fmt.Errorf("reviewfinalize: %w", err)
	}
	log.Printf("reviewfinalize: wrote %d durable receipt(s) at catalog commit %s", len(decisions), commit[:12])
	return nil
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func writeReviewJSON(name string, value any) error {
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(name, append(data, '\n'), 0o644)
}

func writeRunLog(name string, applied []notify.AppliedAction) error {
	if applied == nil {
		applied = []notify.AppliedAction{}
	}
	return writeReviewJSON(name, applied)
}

func loadReviewDecisions(name string) ([]reviewactions.Decision, error) {
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, err
	}
	var decisions []reviewactions.Decision
	if err := json.Unmarshal(data, &decisions); err != nil {
		return nil, err
	}
	return decisions, nil
}

func gitHead() (string, error) {
	output, err := exec.Command("git", "rev-parse", "HEAD").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("read git HEAD: %v: %s", err, output)
	}
	return strings.TrimSpace(string(output)), nil
}

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/gritautomation/finevines-website/internal/build"
	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/deploy"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	var runErr error
	switch os.Args[1] {
	case "enrich":
		runErr = runEnrich(cfg)
	case "build":
		runErr = runBuild(cfg)
	case "redirects":
		runErr = runRedirects(cfg)
	case "deploy":
		runErr = runDeploy(cfg)
	default:
		usage()
		os.Exit(2)
	}
	if runErr != nil {
		fatal(runErr)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: finevines <enrich|build|redirects|deploy>")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "finevines:", err)
	os.Exit(1)
}

// runBuild renders data/*.json + assets/ + templates/*.tmpl into dist/ — see
// internal/build.Run for the actual page-generation logic.
func runBuild(cfg config.Config) error {
	return build.Run("data", "assets", "templates", "dist", cfg.SiteBaseURL)
}

// runEnrich wires the real Salesforce/Anthropic/Imagen clients together and
// runs one incremental enrich pass — see internal/enrich.Run for the actual
// orchestration logic (roster -> eligibility filter -> diff -> per-wine
// text+image enrichment -> checkpointed data/wines.json).
//
// ⚠ Before the first live run against the real Fine Vines org, confirm the
// SOQL field names against the org (client action item C1) — see the
// checkpoint comment on rosterSOQL in internal/salesforce/client.go — and
// consider adding a temporary "LIMIT 25" to that query to eyeball output
// before running against the full catalog.
func runEnrich(cfg config.Config) error {
	// requiredEnv is an ordered list (not a map — map iteration order is
	// randomized in Go, and we want a stable, deterministic "first missing"
	// error rather than a different one every run) of the env vars runEnrich
	// needs, paired with the .env key name to report.
	requiredEnv := []struct{ name, value string }{
		{"FINEVINES_SF_BASE_URL", cfg.SFBaseURL},
		{"FINEVINES_SF_CLIENT_ID", cfg.SFClientID},
		{"FINEVINES_SF_CLIENT_SECRET", cfg.SFClientSecret},
		{"ANTHROPIC_API_KEY", cfg.AnthropicAPIKey},
		{"FINEVINES_GEMINI_API_KEY", cfg.GeminiAPIKey},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("enrich: set %s in .env (or the environment) before running enrich", req.name)
		}
	}

	src := salesforce.NewClient(salesforce.Config{
		BaseURL:      cfg.SFBaseURL,
		ClientID:     cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret,
		APIVersion:   cfg.SFAPIVersion,
	}, http.DefaultClient)
	texts := enrich.NewTextEnricher(cfg.AnthropicAPIKey)
	imgs := enrich.NewImagenClient(cfg.GeminiAPIKey, cfg.ImageModel, "", http.DefaultClient)

	return enrich.Run(context.Background(), src, texts, imgs,
		"data/wines.json", "assets/img/wines", log.Printf)
}

// Stub — replaced by a later task (20).
func runRedirects(cfg config.Config) error { return fmt.Errorf("redirects: not implemented yet") }

// deployWorkers bounds concurrent uploads to Bunny.net's storage zone. See
// deploy.Run's doc comment for why this must be a bounded pool rather than
// one goroutine per file (spec §8: 10k files must not upload one-at-a-time).
const deployWorkers = 16

// runDeploy wires the real BunnyClient and calls deploy.Run to upload dist/
// to Bunny.net's storage zone — only files that changed since the last
// deploy (deploy.Plan's hash-diff) — then purge the Pull Zone's CDN cache.
// See deploy.Run's doc comment for the manifest-saved-only-after-every-
// upload-succeeds and purge-skipped-on-no-op-or-failure invariants: they're
// what make a `deploy` re-run after a partial failure safe to just retry.
func runDeploy(cfg config.Config) error {
	requiredEnv := []struct{ name, value string }{
		{"FINEVINES_BUNNY_STORAGE_ZONE", cfg.BunnyStorageZone},
		{"FINEVINES_BUNNY_STORAGE_KEY", cfg.BunnyStorageKey},
		{"FINEVINES_BUNNY_API_KEY", cfg.BunnyAPIKey},
		{"FINEVINES_BUNNY_PULL_ZONE_ID", cfg.BunnyPullZoneID},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("deploy: set %s in .env (or the environment) before running deploy", req.name)
		}
	}

	client := deploy.NewBunnyClient(
		cfg.BunnyStorageEndpoint, cfg.BunnyStorageZone, cfg.BunnyStorageKey,
		cfg.BunnyAPIKey, cfg.BunnyPullZoneID, http.DefaultClient)

	return deploy.Run(context.Background(), client, "dist", ".bunny-manifest.json", deployWorkers, log.Printf)
}

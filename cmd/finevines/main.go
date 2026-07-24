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
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/redirects"
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

// edgeRulesGateMax is the crawl-gate threshold (plan §"Redirect mechanism
// decision"): a discovered redirect map of at most this many entries
// publishes via Bunny Edge Rules (Task 20 Branch A); more than this
// publishes via Edge Scripting middleware (Task 20 Branch B) instead,
// since Bunny's per-zone Edge Rules count is capped.
const edgeRulesGateMax = 20

// runRedirects discovers every URL currently live on the OLD finevines.com
// (the site this rebuild replaces — cfg.SiteBaseURL, since Fine Vines keeps
// its domain) and maps each one to its new-site location, so launch can
// 301 the entire old footprint and Google's existing index carries over
// (design spec §7, plan Task 19/20).
//
// Only discovery + mapping + the redirects.json write happen here.
// PUBLISHING that map to Bunny.net — Edge Rules if the count is at most
// edgeRulesGateMax, Edge Scripting middleware otherwise — is Task 20 and is
// not implemented yet; this function prints the gate verdict so that
// decision is visible ahead of time, but takes no publishing action.
func runRedirects(cfg config.Config) error {
	oldPaths, err := redirects.Discover(context.Background(), cfg.SiteBaseURL, log.Printf)
	if err != nil {
		return fmt.Errorf("redirects: discover %s: %w", cfg.SiteBaseURL, err)
	}

	// A from-scratch checkout (no enrich run yet) has no data/wines.json —
	// model.LoadWines treats that as "no wines yet" rather than an error,
	// so redirects can still be discovered/mapped (everything wine-shaped
	// just falls through to the portfolio landing fallback or unmatched).
	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		return fmt.Errorf("redirects: load data/wines.json: %w", err)
	}

	overrides, err := redirects.LoadOverrides("redirect-overrides.json")
	if err != nil {
		return fmt.Errorf("redirects: load redirect-overrides.json: %w", err)
	}

	// News posts have no directory-scan loader outside build.Run's
	// internal one (data/news/<slug>.json, one file per post) — adding one
	// here is out of this task's scope. In its absence the news-matching
	// tier of MapURLs simply never fires: an old news URL either matches
	// nothing (lands in unmatched, listed below for a manual override) or,
	// if it happens to share a /news* etc. prefix pattern, is unaffected
	// either way since no such prefix tier exists for news. Revisit if a
	// live crawl turns up old news URLs worth auto-matching.
	var news []model.NewsPost

	mapped, unmatched := redirects.MapURLs(oldPaths, wines, news, overrides)

	if err := redirects.Save("redirects.json", mapped); err != nil {
		return fmt.Errorf("redirects: save redirects.json: %w", err)
	}

	if len(unmatched) > 0 {
		log.Printf("redirects: %d old URL(s) unmatched (no override, no well-known/heuristic match) — "+
			"add manual entries to redirect-overrides.json, or accept they'll 404 to the site's custom 404 page:",
			len(unmatched))
		for _, p := range unmatched {
			log.Printf("  %s", p)
		}
	}

	if len(mapped) <= edgeRulesGateMax {
		log.Printf("%d redirects → Edge Rules", len(mapped))
	} else {
		log.Printf("%d redirects → Edge Scripting", len(mapped))
	}

	// TODO(task 20): publish `mapped` to Bunny.net.
	//   - len(mapped) <= edgeRulesGateMax: Edge Rules — POST
	//     https://api.bunny.net/pullzone/{id}/edgerules/addOrUpdate per
	//     old path (301, deterministic GUID per old path for idempotent
	//     upserts on re-run).
	//   - otherwise: generate + deploy the Edge Scripting middleware
	//     (redirects.middleware.ts, a Record<string,string> lookup that
	//     301s a hit and passes through a miss).
	// See the implementation plan's Task 20 Branch A/B for the confirmed
	// API shapes.
	return nil
}

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

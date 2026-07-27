package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gritautomation/finevines-website/internal/build"
	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/deploy"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/redirects"
	"github.com/gritautomation/finevines-website/internal/report"
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
		runErr = runRedirects(cfg, os.Args[2:])
	case "deploy":
		runErr = runDeploy(cfg)
	case "report":
		runErr = runReport()
	default:
		usage()
		os.Exit(2)
	}
	if runErr != nil {
		fatal(runErr)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: finevines <enrich|build|redirects|deploy|report>")
}

// reportPath is where the enrichment coverage report is written — a LOCAL,
// gitignored file, deliberately never placed in dist/ so it is not published
// to the public CDN (see internal/report's package doc).
const reportPath = "reports/enrichment.html"

// runReport regenerates the enrichment coverage report from data/wines.json
// without re-enriching — cheap and deterministic, the same read-only
// relationship build has to the data. `enrich` also emits it at the end of a
// run; this subcommand is for refreshing it on demand.
func runReport() error {
	if err := report.Write("data/wines.json", reportPath); err != nil {
		return err
	}
	log.Printf("report: wrote %s", reportPath)
	return nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "finevines:", err)
	os.Exit(1)
}

// runBuild renders data/*.json + assets/ + templates/*.tmpl into dist/ — see
// internal/build.Run for the actual page-generation logic.
func runBuild(cfg config.Config) error {
	return build.Run("data", "assets", "templates", "dist", cfg.SiteBaseURL, cfg.GAID)
}

// runEnrich wires the real Salesforce/Anthropic/Imagen clients together and
// runs one incremental enrich pass — see internal/enrich.Run for the actual
// orchestration logic (roster -> eligibility filter -> diff -> per-wine
// text+image enrichment -> checkpointed data/wines.json).
//
// ⚠ Before the first live run against the real FineVines org, confirm the
// SOQL field names against the org (client action item C1) — see the
// checkpoint comment on rosterSOQL in internal/salesforce/client.go — and
// consider adding a temporary "LIMIT 25" to that query to eyeball output
// before running against the full catalog.
func runEnrich(cfg config.Config) error {
	// The generation APIs (text + image) are always required; the Salesforce
	// credentials are required only for a live roster pull. In mock mode
	// (FINEVINES_SF_MOCK) the roster comes from the embedded sample instead,
	// so those three SF vars are skipped — this is how the generation pipeline
	// is developed and exercised before the Connected App exists (issue #1).
	//
	// requiredEnv is an ordered slice (not a map — map iteration order is
	// randomized in Go, and we want a stable, deterministic "first missing"
	// error rather than a different one every run), paired with the .env key
	// name to report.
	requiredEnv := []struct{ name, value string }{
		{"ANTHROPIC_API_KEY", cfg.AnthropicAPIKey},
		{"FINEVINES_GEMINI_API_KEY", cfg.GeminiAPIKey},
	}
	if !cfg.SFMock {
		requiredEnv = append(requiredEnv,
			struct{ name, value string }{"FINEVINES_SF_BASE_URL", cfg.SFBaseURL},
			struct{ name, value string }{"FINEVINES_SF_CLIENT_ID", cfg.SFClientID},
			struct{ name, value string }{"FINEVINES_SF_CLIENT_SECRET", cfg.SFClientSecret},
		)
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("enrich: set %s in .env (or the environment) before running enrich", req.name)
		}
	}

	var src salesforce.Source
	if cfg.SFMock {
		mock, err := salesforce.NewMockSource()
		if err != nil {
			return fmt.Errorf("enrich: %w", err)
		}
		log.Printf("enrich: FINEVINES_SF_MOCK set — using the embedded sample roster instead of a live Salesforce org")
		src = mock
	} else {
		src = salesforce.NewClient(salesforce.Config{
			BaseURL:      cfg.SFBaseURL,
			ClientID:     cfg.SFClientID,
			ClientSecret: cfg.SFClientSecret,
			APIVersion:   cfg.SFAPIVersion,
		}, http.DefaultClient)
	}
	enr := enrich.NewSearchEnricher(cfg.AnthropicAPIKey)
	imgs := enrich.NewImagenClient(cfg.GeminiAPIKey, cfg.ImageModel, "", http.DefaultClient)

	if err := enrich.Run(context.Background(), src, enr, imgs,
		"data/wines.json", "assets/img/wines", log.Printf); err != nil {
		return err
	}

	// Emit the editor-facing coverage report from the freshly-written catalog.
	// A report failure must not fail the enrich run (the catalog is already
	// saved) — log and continue.
	if err := report.Write("data/wines.json", reportPath); err != nil {
		log.Printf("enrich: warning: could not write %s: %v", reportPath, err)
	} else {
		log.Printf("enrich: wrote coverage report %s", reportPath)
	}
	return nil
}

// edgeRulesGateMax is the crawl-gate threshold (plan §"Redirect mechanism
// decision"): a discovered redirect map of at most this many entries
// publishes via Bunny Edge Rules (Task 20 Branch A); more than this
// publishes via Edge Scripting middleware (Task 20 Branch B) instead,
// since Bunny's per-zone Edge Rules count is capped.
const edgeRulesGateMax = 20

// runRedirects discovers every URL currently live on the OLD finevines.com
// (the site this rebuild replaces — cfg.SiteBaseURL, since FineVines keeps
// its domain) and maps each one to its new-site location, so launch can
// 301 the entire old footprint and Google's existing index carries over
// (design spec §7, plan Task 19/20).
//
// Discovery + mapping + the redirects.json write always happen. PUBLISHING
// that map to Bunny.net only happens when args contains --publish — without
// it, runRedirects stays exactly the discovery+mapping+save behavior Task
// 19 left it as, so a plain `finevines redirects` run stays side-effect-free
// against the live Bunny account (safe to run repeatedly while iterating on
// redirect-overrides.json, e.g.).
//
// The map is 51,511 entries (>> Bunny's 20-Edge-Rule-per-zone cap), so the
// crawl-gate verdict is settled: publishing always uses Edge Scripting
// (internal/redirects.GenerateMiddleware + PublishMiddleware), never Edge
// Rules (internal/redirects/publish_rules.go is a documented-only stub). If
// a future run of Discover somehow shrinks the map to at most
// edgeRulesGateMax entries, --publish deliberately refuses rather than
// silently doing nothing useful — see the error below.
func runRedirects(cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("redirects", flag.ContinueOnError)
	publish := fs.Bool("publish", false,
		"after discovering and mapping, publish the redirect map to Bunny.net via Edge Scripting")
	if err := fs.Parse(args); err != nil {
		return err
	}

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

	if !*publish {
		log.Printf("redirects: --publish not set; discovery + mapping only (redirects.json written, nothing sent to Bunny.net)")
		return nil
	}

	if len(mapped) <= edgeRulesGateMax {
		return fmt.Errorf("redirects: --publish requested but the map has only %d entries (<=%d) — "+
			"Edge Rules publishing (Branch A) is a documented stub, not implemented; "+
			"see internal/redirects/publish_rules.go", len(mapped), edgeRulesGateMax)
	}

	// Edge Scripting (Branch B, plan Task 20). Needs a different set of
	// Bunny credentials than `deploy`'s storage-zone upload: the account
	// API key (shared with deploy's Purge) plus the target compute
	// script's ID, which is created and linked to the FineVines Pull
	// Zone once via the Bunny dashboard/Terraform (see ScriptClient's doc
	// comment) — that one-time setup is a launch step, client item C4.
	requiredEnv := []struct{ name, value string }{
		{"FINEVINES_BUNNY_API_KEY", cfg.BunnyAPIKey},
		{"FINEVINES_BUNNY_SCRIPT_ID", cfg.BunnyScriptID},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("redirects: --publish set but %s is not configured; "+
				"set it in .env (or the environment) before publishing", req.name)
		}
	}

	// FineVines keeps its domain, so cfg.SiteBaseURL doubles as both the
	// old-site crawl target (Discover, above) and — after cutover — the
	// new site's own host, which is where the deployed redirects.json the
	// middleware fetches at runtime will live.
	redirectsURL := strings.TrimRight(cfg.SiteBaseURL, "/") + "/redirects.json"

	script, err := redirects.GenerateMiddleware(redirectsURL)
	if err != nil {
		return fmt.Errorf("redirects: generate middleware: %w", err)
	}
	// Committed alongside the map's own JSON for reproducibility and as
	// the manual-dashboard-paste fallback if the API call below ever
	// proves awkward against the real Bunny account.
	if err := os.WriteFile("redirects.middleware.ts", script, 0o644); err != nil {
		return fmt.Errorf("redirects: write redirects.middleware.ts: %w", err)
	}

	scriptClient := redirects.NewScriptClient(cfg.BunnyAPIKey, cfg.BunnyScriptID, http.DefaultClient)
	if err := redirects.PublishMiddleware(context.Background(), scriptClient, script); err != nil {
		return fmt.Errorf("redirects: publish middleware: %w", err)
	}

	log.Printf("redirects: published %d-entry redirect map via Bunny Edge Scripting (script id %s)",
		len(mapped), cfg.BunnyScriptID)
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

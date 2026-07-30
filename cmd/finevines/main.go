package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

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
	case "applyqueue":
		runErr = runApplyQueue(cfg, os.Args[2:])
	case "notify":
		runErr = runNotify(cfg, os.Args[2:])
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
	fmt.Fprintln(os.Stderr, "usage: finevines <enrich|build|redirects|deploy|applyqueue|notify|report>")
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
	// The text-enrichment API is always required; the Salesforce
	// credentials are required only for a live roster pull. In mock mode
	// (FINEVINES_SF_MOCK) the roster comes from the embedded sample instead,
	// so those three SF vars are skipped — this is how the generation pipeline
	// is developed and exercised before the Connected App exists (issue #1).
	//
	// requiredEnv is an ordered slice (not a map — map iteration order is
	// randomized in Go, and we want a stable, deterministic "first missing"
	// error rather than a different one every run), paired with the .env key
	// name to report.
	// Manual mode (FINEVINES_MANUAL_ENRICH_DIR) enriches from hand-authored
	// <SKU>.json files and uses the SVG-label image floor, so neither the
	// OpenAI nor the image API key is needed — a stopgap while OpenAI billing
	// is being set up.
	var requiredEnv []struct{ name, value string }
	if cfg.ManualEnrichDir == "" {
		requiredEnv = append(requiredEnv,
			struct{ name, value string }{"OPENAI_API_KEY", cfg.OpenAIAPIKey},
		)
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
	var enr enrich.Enricher
	var imgs enrich.ImageProvider
	if cfg.ManualEnrichDir != "" {
		log.Printf("enrich: FINEVINES_MANUAL_ENRICH_DIR=%s — enriching from hand-authored files, SVG-label images (no OpenAI/image API)", cfg.ManualEnrichDir)
		enr = enrich.NewManualEnricher(cfg.ManualEnrichDir)
		imgs = enrich.LabelOnlyProvider{}
	} else {
		enr = enrich.NewOpenAIEnricher(cfg.OpenAIAPIKey, cfg.OpenAIModel, "", http.DefaultClient)
		// Image *generation* is optional: without FINEVINES_GEMINI_API_KEY the
		// chain still runs — kept real images, old-site photos, and web-found
		// images all work; only the generated-photo rung is skipped, and such
		// wines get the guaranteed SVG label instead (.env.example: Imagen is
		// being migrated to gpt-image-1, so the key is often absent).
		if cfg.GeminiAPIKey == "" {
			log.Printf("enrich: FINEVINES_GEMINI_API_KEY not set — skipping photo generation, wines without a real image get the SVG label")
			imgs = enrich.LabelOnlyProvider{}
		} else {
			imgs = enrich.NewImagenClient(cfg.GeminiAPIKey, cfg.ImageModel, "", http.DefaultClient)
		}
	}

	// Old-site image manifest (tools/oldimages): SKU -> FineVines' own photo,
	// the top rung of the image chain. Missing file is fine — no old-site rung.
	oldImages, err := enrich.LoadOldSiteImages("data/oldsite-images.json")
	if err != nil {
		return fmt.Errorf("enrich: %w", err)
	}
	if len(oldImages) > 0 {
		log.Printf("enrich: %d old-site image matches loaded", len(oldImages))
	}

	if err := enrich.Run(context.Background(), src, enr, imgs, oldImages,
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

	// Refresh the sales-driven homepage ranking (data/hot-sellers.json) from
	// the org's invoice ledger. Optional by design: it needs a live org (the
	// mock roster has no sales), and a failure must not fail the enrich run —
	// the catalog is already saved, and the homepage simply keeps (or omits)
	// its hot-sellers section. The stale-is-fine tradeoff is deliberate: a
	// day-old ranking of what's pouring beats no section.
	if client, ok := src.(*salesforce.Client); ok {
		if err := refreshHotSellers(client); err != nil {
			log.Printf("enrich: warning: hot-sellers refresh skipped: %v", err)
		}
		if err := refreshAccountsServed(client); err != nil {
			log.Printf("enrich: warning: accounts-served refresh skipped: %v", err)
		}
	} else {
		log.Printf("enrich: mock roster has no sales ledger — data/hot-sellers.json and data/accounts.json left as-is")
	}
	return nil
}

// hotSellerWindowDays is the sales window the homepage ranking looks back
// over. Thirty days matches the section's editorial copy ("this month") and is
// long enough that one big allocation drop doesn't own every slot.
const hotSellerWindowDays = 30

// hotSellerCount is how many wines the ranking keeps. The homepage renders at
// most four (one clean row of its four-up grid — see build.selectHotSellers);
// the extra entries are slack so the build can drop wines that sell out
// between enrich runs and still fill the row.
const hotSellerCount = 6

// refreshHotSellers pulls net cases sold per product over the trailing window
// and writes the top web-eligible, in-stock movers to data/hot-sellers.json
// (see enrich.RankHotSellers for the ranking rules). Only the ranking is ever
// rendered publicly — case volumes stay in this private repo file.
func refreshHotSellers(client *salesforce.Client) error {
	totals, err := client.SalesTotals(context.Background(), hotSellerWindowDays)
	if err != nil {
		return err
	}
	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		return err
	}
	hs := model.HotSellers{
		Updated:    time.Now().UTC().Format(time.RFC3339),
		WindowDays: hotSellerWindowDays,
		Wines:      enrich.RankHotSellers(wines, totals, hotSellerCount),
	}
	if err := model.SaveHotSellers("data/hot-sellers.json", hs); err != nil {
		return err
	}
	log.Printf("enrich: wrote data/hot-sellers.json — top %d of %d products with sales in the last %d days",
		len(hs.Wines), len(totals), hotSellerWindowDays)
	return nil
}

// accountsServedWindowDays is the accounts-served lookback: an account counts
// if it had at least one invoice in the trailing year (client definition,
// 2026-07-29). A year rides out seasonality — a steakhouse that orders its
// Bordeaux list twice a year is still very much an account.
const accountsServedWindowDays = 365

// refreshAccountsServed counts distinct invoiced accounts over the trailing
// year and writes data/accounts.json for the homepage credibility ledger.
// Same optional/stale-is-fine contract as refreshHotSellers; the exact count
// stays in the private repo file — the build renders a floored "400+".
func refreshAccountsServed(client *salesforce.Client) error {
	n, err := client.AccountsServed(context.Background(), accountsServedWindowDays)
	if err != nil {
		return err
	}
	as := model.AccountsServed{
		Updated:    time.Now().UTC().Format(time.RFC3339),
		WindowDays: accountsServedWindowDays,
		Accounts:   n,
	}
	if err := model.SaveAccountsServed("data/accounts.json", as); err != nil {
		return err
	}
	log.Printf("enrich: wrote data/accounts.json — %d distinct accounts invoiced in the last %d days",
		n, accountsServedWindowDays)
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

	// Crawl target and redirects.json host are DIFFERENT config values:
	// OldSiteURL is where the legacy pages live (always the real
	// finevines.com), SiteBaseURL is where the rebuilt site — and its
	// deployed redirects.json — is served. In production both are the same
	// domain (OldSiteURL defaults to SiteBaseURL), but while the new site
	// is staged on a test domain, crawling SiteBaseURL would map the NEW
	// site's own URLs onto themselves instead of discovering legacy ones.
	oldPaths, err := redirects.Discover(context.Background(), cfg.OldSiteURL, log.Printf)
	if err != nil {
		return fmt.Errorf("redirects: discover %s: %w", cfg.OldSiteURL, err)
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

	// The middleware fetches redirects.json from cfg.RedirectsMapURL at
	// runtime — deploy uploads it as an ordinary dist/ asset. This must be
	// the pull zone's *.b-cdn.net hostname, NOT the site's custom domain:
	// an edge script cannot fetch a custom hostname served by its own pull
	// zone (see the RedirectsMapURL field comment in internal/config for
	// the live-verified failure). The old-site crawl above used
	// cfg.OldSiteURL — a third, also distinct, URL.
	redirectsURL := cfg.RedirectsMapURL

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
	content, err := model.LoadSiteContent("data/site.json")
	if err != nil {
		return fmt.Errorf("deploy: load data/site.json: %w", err)
	}
	if err := validateClientContentForDeploy(cfg.SiteBaseURL, content); err != nil {
		return err
	}

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

// validateClientContentForDeploy prevents candidate contact details or team
// emails from reaching the production domain before the client has explicitly
// approved them. A staging build/deploy remains available by setting an
// explicit non-production FINEVINES_SITE_BASE_URL.
func validateClientContentForDeploy(baseURL string, content model.SiteContent) error {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return fmt.Errorf("deploy: FINEVINES_SITE_BASE_URL must be an absolute URL, got %q", baseURL)
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host != "finevines.com" && host != "www.finevines.com" {
		return nil
	}
	var pending []string
	if !content.ContactConfirmed {
		pending = append(pending, "contact details")
	}
	if !content.TeamEmailsConfirmed {
		pending = append(pending, "team email addresses")
	}
	if len(pending) > 0 {
		return fmt.Errorf(
			"deploy: production blocked until client confirms %s; then set the corresponding confirmation flags in data/site.json",
			strings.Join(pending, " and "),
		)
	}
	return nil
}

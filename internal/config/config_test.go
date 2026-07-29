package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReadsEnvFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_SF_BASE_URL=https://finevines.my.salesforce.com\n# comment\nFINEVINES_IMAGE_MODEL=imagen-4.0-generate-001\n"), 0o644)

	cfg, err := Load(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SFBaseURL != "https://finevines.my.salesforce.com" {
		t.Errorf("SFBaseURL = %q", cfg.SFBaseURL)
	}
	if cfg.ImageModel != "imagen-4.0-generate-001" {
		t.Errorf("ImageModel = %q", cfg.ImageModel)
	}
}

func TestEnvVarOverridesEnvFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_IMAGE_MODEL=from-file\n"), 0o644)
	t.Setenv("FINEVINES_IMAGE_MODEL", "from-env")

	cfg, _ := Load(envPath)
	if cfg.ImageModel != "from-env" {
		t.Errorf("ImageModel = %q, want from-env", cfg.ImageModel)
	}
}

// OldSiteURL exists so a staged test (new site on a test domain, old site
// still live on the real one) can crawl the old site while SiteBaseURL
// points at the staging host. In production the two are the same domain,
// which is why the default must track SiteBaseURL, not a constant.
func TestOldSiteURLDefaultsToSiteBaseURL(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_SITE_BASE_URL=https://staging.example\n"), 0o644)

	cfg, _ := Load(envPath)
	if cfg.OldSiteURL != "https://staging.example" {
		t.Errorf("OldSiteURL = %q, want SiteBaseURL fallback https://staging.example", cfg.OldSiteURL)
	}
}

func TestOldSiteURLOverridesSiteBaseURL(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_SITE_BASE_URL=https://staging.example\nFINEVINES_OLD_SITE_URL=https://finevines.com\n"), 0o644)

	cfg, _ := Load(envPath)
	if cfg.OldSiteURL != "https://finevines.com" {
		t.Errorf("OldSiteURL = %q, want https://finevines.com", cfg.OldSiteURL)
	}
	if cfg.SiteBaseURL != "https://staging.example" {
		t.Errorf("SiteBaseURL = %q, want https://staging.example (must not be touched by the old-site override)", cfg.SiteBaseURL)
	}
}

// RedirectsMapURL must be overridable independently of SiteBaseURL: the
// default (SiteBaseURL/redirects.json) is a custom hostname served by the
// middleware's own pull zone, which Bunny's edge runtime cannot fetch —
// the override is how deployments point it at the zone's *.b-cdn.net
// hostname instead.
func TestRedirectsMapURLDefaultsToSiteBaseURL(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_SITE_BASE_URL=https://staging.example/\n"), 0o644)

	cfg, _ := Load(envPath)
	if cfg.RedirectsMapURL != "https://staging.example/redirects.json" {
		t.Errorf("RedirectsMapURL = %q, want https://staging.example/redirects.json (trailing slash collapsed)", cfg.RedirectsMapURL)
	}
}

func TestRedirectsMapURLOverride(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_SITE_BASE_URL=https://staging.example\nFINEVINES_REDIRECTS_MAP_URL=https://zone.b-cdn.net/redirects.json\n"), 0o644)

	cfg, _ := Load(envPath)
	if cfg.RedirectsMapURL != "https://zone.b-cdn.net/redirects.json" {
		t.Errorf("RedirectsMapURL = %q, want https://zone.b-cdn.net/redirects.json", cfg.RedirectsMapURL)
	}
}

func TestLoadMissingFileIsNotAnError(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.env")); err != nil {
		t.Fatalf("missing .env should be fine (env-vars-only mode): %v", err)
	}
}

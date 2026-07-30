// Package config loads finevines settings from environment variables with an
// optional git-ignored .env file as fallback. Real env vars always win.
package config

import (
	"bufio"
	"os"
	"strings"
)

type Config struct {
	SFBaseURL, SFClientID, SFClientSecret, SFAPIVersion string
	OpenAIAPIKey, OpenAIModel                           string
	GeminiAPIKey, ImageModel                            string
	BunnyStorageZone, BunnyStorageKey                   string
	BunnyStorageEndpoint                                string // e.g. https://ny.storage.bunnycdn.com
	BunnyAPIKey, BunnyPullZoneID                        string
	BunnyScriptID                                       string // Edge Scripting compute script ID (redirect middleware)
	SiteBaseURL                                         string // e.g. https://finevines.com
	OldSiteURL                                          string // FINEVINES_OLD_SITE_URL: the legacy site redirects.Discover crawls; defaults to SiteBaseURL (identical in production, where FineVines keeps its domain — they only differ while the new site is staged on a test domain and the old site still lives on the real one)
	RedirectsMapURL                                     string // FINEVINES_REDIRECTS_MAP_URL: where the deployed Edge middleware fetches redirects.json at runtime. Defaults to SiteBaseURL+"/redirects.json", but that default DOES NOT WORK on Bunny: an edge script cannot fetch a custom hostname served by its own pull zone (the request loops back into the edge and dies in the TLS handshake — verified live 2026-07-29, error "received corrupt message of type InvalidContentType"). Set this to the pull zone's *.b-cdn.net default hostname (e.g. https://finevines-com.b-cdn.net/redirects.json), which the same probe confirmed works from inside the isolate.
	GAID                                                string // Google Analytics 4 measurement ID (G-XXXXXXXXXX); empty disables analytics
	PostmarkToken                                       string // POSTMARK_TOKEN: Postmark SERVER token the digest email is sent with
	NotifyTo                                            string // FINEVINES_NOTIFY_TO: comma-separated digest recipients (notify.Recipients splits it)
	NotifyFrom                                          string // FINEVINES_NOTIFY_FROM: the CONFIRMED Postmark sender signature the digest is sent from. No default: an unconfirmed sender is accepted with HTTP 200 and a non-zero ErrorCode, so guessing here would silently never deliver.
	SFMock                                              bool   // FINEVINES_SF_MOCK: read the embedded sample roster instead of a live Salesforce org
	ManualEnrichDir                                     string // FINEVINES_MANUAL_ENRICH_DIR: enrich from hand-authored <SKU>.json files instead of OpenAI (billing-pending stopgap)
}

func Load(envPath string) (Config, error) {
	fileVals := map[string]string{}
	if f, err := os.Open(envPath); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if k, v, ok := strings.Cut(line, "="); ok {
				fileVals[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
	}
	get := func(key string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return fileVals[key]
	}
	siteBaseURL := orDefault(get("FINEVINES_SITE_BASE_URL"), "https://finevines.com")
	return Config{
		SFBaseURL:            get("FINEVINES_SF_BASE_URL"),
		SFClientID:           get("FINEVINES_SF_CLIENT_ID"),
		SFClientSecret:       get("FINEVINES_SF_CLIENT_SECRET"),
		SFAPIVersion:         orDefault(get("FINEVINES_SF_API_VERSION"), "v61.0"),
		OpenAIAPIKey:         get("OPENAI_API_KEY"),
		OpenAIModel:          get("FINEVINES_OPENAI_MODEL"),
		GeminiAPIKey:         get("FINEVINES_GEMINI_API_KEY"),
		ImageModel:           orDefault(get("FINEVINES_IMAGE_MODEL"), "imagen-4.0-generate-001"),
		BunnyStorageZone:     get("FINEVINES_BUNNY_STORAGE_ZONE"),
		BunnyStorageKey:      get("FINEVINES_BUNNY_STORAGE_KEY"),
		BunnyStorageEndpoint: orDefault(get("FINEVINES_BUNNY_STORAGE_ENDPOINT"), "https://storage.bunnycdn.com"),
		BunnyAPIKey:          get("FINEVINES_BUNNY_API_KEY"),
		BunnyPullZoneID:      get("FINEVINES_BUNNY_PULL_ZONE_ID"),
		BunnyScriptID:        get("FINEVINES_BUNNY_SCRIPT_ID"),
		SiteBaseURL:          siteBaseURL,
		OldSiteURL:           orDefault(get("FINEVINES_OLD_SITE_URL"), siteBaseURL),
		RedirectsMapURL:      orDefault(get("FINEVINES_REDIRECTS_MAP_URL"), strings.TrimRight(siteBaseURL, "/")+"/redirects.json"),
		GAID:                 get("FINEVINES_GA_ID"),
		PostmarkToken:        get("POSTMARK_TOKEN"),
		NotifyTo:             get("FINEVINES_NOTIFY_TO"),
		NotifyFrom:           get("FINEVINES_NOTIFY_FROM"),
		SFMock:               truthy(get("FINEVINES_SF_MOCK")),
		ManualEnrichDir:      get("FINEVINES_MANUAL_ENRICH_DIR"),
	}, nil
}

// truthy reports whether an env value means "on". Accepts the usual set so a
// .env line like FINEVINES_SF_MOCK=true (or 1/yes/on) all work.
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

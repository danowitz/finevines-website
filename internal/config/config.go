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
	AnthropicAPIKey                                     string
	GeminiAPIKey, ImageModel                            string
	BunnyStorageZone, BunnyStorageKey                   string
	BunnyStorageEndpoint                                string // e.g. https://ny.storage.bunnycdn.com
	BunnyAPIKey, BunnyPullZoneID                        string
	BunnyScriptID                                       string // Edge Scripting compute script ID (redirect middleware)
	SiteBaseURL                                         string // e.g. https://finevines.com
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
	return Config{
		SFBaseURL:            get("FINEVINES_SF_BASE_URL"),
		SFClientID:           get("FINEVINES_SF_CLIENT_ID"),
		SFClientSecret:       get("FINEVINES_SF_CLIENT_SECRET"),
		SFAPIVersion:         orDefault(get("FINEVINES_SF_API_VERSION"), "v61.0"),
		AnthropicAPIKey:      get("ANTHROPIC_API_KEY"),
		GeminiAPIKey:         get("FINEVINES_GEMINI_API_KEY"),
		ImageModel:           orDefault(get("FINEVINES_IMAGE_MODEL"), "imagen-4.0-generate-001"),
		BunnyStorageZone:     get("FINEVINES_BUNNY_STORAGE_ZONE"),
		BunnyStorageKey:      get("FINEVINES_BUNNY_STORAGE_KEY"),
		BunnyStorageEndpoint: orDefault(get("FINEVINES_BUNNY_STORAGE_ENDPOINT"), "https://storage.bunnycdn.com"),
		BunnyAPIKey:          get("FINEVINES_BUNNY_API_KEY"),
		BunnyPullZoneID:      get("FINEVINES_BUNNY_PULL_ZONE_ID"),
		BunnyScriptID:        get("FINEVINES_BUNNY_SCRIPT_ID"),
		SiteBaseURL:          orDefault(get("FINEVINES_SITE_BASE_URL"), "https://finevines.com"),
	}, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

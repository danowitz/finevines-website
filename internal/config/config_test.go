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

func TestLoadMissingFileIsNotAnError(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.env")); err != nil {
		t.Fatalf("missing .env should be fine (env-vars-only mode): %v", err)
	}
}

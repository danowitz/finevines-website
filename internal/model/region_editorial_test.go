package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadRegionEditorialsRejectsEmDash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "regions.json")
	data := `{"burgundy":{"heading":"Burgundy — a mosaic","paragraphs":["Place comes first."],"images":[{"path":"assets/img/regions/burgundy.jpg","alt":"Vines","caption":"Clos Vougeot","credit":"Urban","sourceUrl":"https://commons.wikimedia.org/","license":"Public domain"}],"relatedRegions":[],"sources":[{"label":"UNESCO","url":"https://whc.unesco.org/"}]}}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := LoadRegionEditorials(path)
	if err == nil || !strings.Contains(err.Error(), "em dash") {
		t.Fatalf("LoadRegionEditorials error = %v, want em-dash rejection", err)
	}
}

func TestLoadRegionEditorialsAllowsMissingOptionalFile(t *testing.T) {
	regions, err := LoadRegionEditorials(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(regions) != 0 {
		t.Fatalf("regions = %+v, want empty", regions)
	}
}

func TestLoadRegionEditorialsAcceptsProvenancedContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "regions.json")
	data := `{"burgundy":{"eyebrow":"A closer look","heading":"Burgundy is a map of differences","paragraphs":["Place comes first."],"images":[{"path":"assets/img/regions/burgundy.jpg","alt":"Vines","caption":"Clos Vougeot","credit":"Urban","sourceUrl":"https://commons.wikimedia.org/","license":"Public domain"}],"relatedRegions":[{"slug":"chablis","label":"Chablis"}],"sources":[{"label":"UNESCO","url":"https://whc.unesco.org/"}]}}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	regions, err := LoadRegionEditorials(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := regions["burgundy"].Heading; got != "Burgundy is a map of differences" {
		t.Fatalf("heading = %q", got)
	}
}

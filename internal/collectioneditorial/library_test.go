package collectioneditorial

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratedEditorialRequiresHumanPromotion(t *testing.T) {
	library := Empty()
	library.put(Entry{Kind: Producer, Slug: "wrong-estate", Name: "Wrong Estate", Mode: "generated", Heading: "Plausible but unchecked", Paragraphs: []string{"Draft"}, Sources: []Source{{Label: "Source", URL: "https://example.com"}}})
	if _, ok := library.Lookup(Producer, "wrong-estate"); ok {
		t.Fatal("generated editorial published without human promotion")
	}
	library.put(Entry{Kind: Producer, Slug: "reviewed-estate", Name: "Reviewed Estate", Mode: "curated", Heading: "Reviewed Estate", Paragraphs: []string{"Approved"}})
	if _, ok := library.Lookup(Producer, "reviewed-estate"); !ok {
		t.Fatal("curated editorial was not published")
	}
}

func TestLegacyProducerProfilesMatchUniqueCanonicalIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.json")
	profiles := []legacyProducerProfile{
		{Name: "Domaine Sérol", Slug: "domaine-serol", Prose: "First paragraph.\n\nSecond paragraph.", ProseChars: 34},
		{Name: "JL Chave Sélection", Slug: "jl-chave-selection", Prose: "The Chave family history.", ProseChars: 25},
	}
	body, err := json.Marshal(profiles)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	library, err := Empty().WithLegacyProducerProfiles(path)
	if err != nil {
		t.Fatal(err)
	}
	serol, ok := library.Lookup(Producer, "serol")
	if !ok || serol.Heading != "Domaine Sérol" || len(serol.Paragraphs) != 2 {
		t.Fatalf("legacy Sérol profile = %#v, %v", serol, ok)
	}
	chave, ok := library.Lookup(Producer, "jean-louis-chave")
	if !ok || chave.Heading != "Jean-Louis Chave" {
		t.Fatalf("legacy Chave profile = %#v, %v", chave, ok)
	}
}

func TestLoadRejectsEmDashInPublishedCopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	data := `{"version":1,"entries":[{"kind":"region","slug":"burgundy","name":"Burgundy","mode":"curated","heading":"Burgundy — a mosaic","paragraphs":["Useful copy."],"sources":[]}]}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil || !strings.Contains(err.Error(), "prohibited dash") {
		t.Fatalf("Load error = %v", err)
	}
}

func TestSaveIsDeterministicAndLookupHidesRetryRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collection-editorial.json")
	library := Empty()
	library.put(validGenerated(Varietal, "pinot-noir", "Pinot Noir", "hash"))
	library.put(Entry{Kind: Producer, Slug: "unknown", Name: "Unknown", Mode: "generated", Fingerprint: "x", RetryAfter: "2027-01-01", LastError: "ambiguous"})
	if err := Save(path, library); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(path)
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := loaded.Lookup(Varietal, "pinot-noir"); ok {
		t.Fatal("generated draft must not publish before human promotion")
	}
	if _, ok := loaded.Lookup(Producer, "unknown"); ok {
		t.Fatal("retry record must not be publishable")
	}
	if err := Save(path, loaded); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if string(first) != string(second) {
		t.Fatal("second save changed deterministic file")
	}
}

func validGenerated(kind Kind, slug, name, fingerprint string) Entry {
	return Entry{
		Kind: kind, Slug: slug, Name: name, Mode: "generated", Fingerprint: fingerprint,
		Eyebrow: "A closer look", Heading: name + " in focus", Paragraphs: []string{"Useful original copy for a wine buyer."},
		Sources: []Source{{Label: "Authoritative source", URL: "https://example.com/source"}}, ReviewedAt: "2026-01-01",
	}
}

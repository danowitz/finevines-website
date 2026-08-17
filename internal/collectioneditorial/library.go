// Package collectioneditorial owns the durable editorial library for catalog
// collection pages. The build package asks the Library for an optional article;
// the enrichment workflow asks Sync to research only new or changed collection
// identities. Validation, retry state, deterministic storage, and provenance
// stay behind those two interfaces.
package collectioneditorial

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/gritautomation/finevines-website/internal/model"
)

const FileVersion = 1

type Kind string

const (
	Producer Kind = "producer"
	Region   Kind = "region"
	Varietal Kind = "varietal"
)

func (k Kind) Valid() bool {
	return k == Producer || k == Region || k == Varietal
}

type Source struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type Image struct {
	Path      string `json:"path"`
	Alt       string `json:"alt"`
	Caption   string `json:"caption"`
	Credit    string `json:"credit"`
	SourceURL string `json:"sourceUrl"`
	License   string `json:"license"`
}

type Link struct {
	Slug  string `json:"slug"`
	Label string `json:"label"`
}

// Entry is one researched or curated article. A failed first research attempt
// is also retained as an entry with no Heading and a RetryAfter date, which
// prevents an unavailable external dependency from being called every night.
type Entry struct {
	Kind             Kind     `json:"kind"`
	Slug             string   `json:"slug"`
	Name             string   `json:"name"`
	Mode             string   `json:"mode"` // curated or generated
	Fingerprint      string   `json:"fingerprint,omitempty"`
	RetryFingerprint string   `json:"retryFingerprint,omitempty"`
	Eyebrow          string   `json:"eyebrow,omitempty"`
	Heading          string   `json:"heading,omitempty"`
	Paragraphs       []string `json:"paragraphs,omitempty"`
	Images           []Image  `json:"images,omitempty"`
	Related          []Link   `json:"related,omitempty"`
	Sources          []Source `json:"sources,omitempty"`
	RetryAfter       string   `json:"retryAfter,omitempty"` // YYYY-MM-DD
	ReviewedAt       string   `json:"reviewedAt,omitempty"` // YYYY-MM-DD
	LastError        string   `json:"lastError,omitempty"`
}

func (e Entry) Publishable() bool { return strings.TrimSpace(e.Heading) != "" }

type diskFile struct {
	Version int     `json:"version"`
	Entries []Entry `json:"entries"`
}

// Library is immutable after loading. Its map is intentionally private so the
// on-disk representation can evolve without leaking storage mechanics into the
// static builder.
type Library struct {
	entries map[string]Entry
}

func Empty() Library { return Library{entries: map[string]Entry{}} }

func key(kind Kind, slug string) string { return string(kind) + "/" + slug }

func Load(path string) (Library, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Empty(), nil
		}
		return Library{}, err
	}
	var file diskFile
	if err := json.Unmarshal(data, &file); err != nil {
		return Library{}, err
	}
	if file.Version != FileVersion {
		return Library{}, fmt.Errorf("collection editorial version %d is unsupported", file.Version)
	}
	library := Empty()
	for _, entry := range file.Entries {
		if err := validateEntry(entry); err != nil {
			return Library{}, err
		}
		k := key(entry.Kind, entry.Slug)
		if _, exists := library.entries[k]; exists {
			return Library{}, fmt.Errorf("duplicate collection editorial %q", k)
		}
		library.entries[k] = entry
	}
	return library, nil
}

func (l Library) Lookup(kind Kind, slug string) (Entry, bool) {
	entry, ok := l.entries[key(kind, slug)]
	return entry, ok && entry.Publishable()
}

type ImageReference struct {
	Kind Kind
	Slug string
	Path string
}

// ImageReferences is the narrow build-time verification view. The builder can
// prove every curated asset exists without learning the library's storage map.
func (l Library) ImageReferences() []ImageReference {
	var references []ImageReference
	for _, entry := range l.entries {
		for _, image := range entry.Images {
			references = append(references, ImageReference{Kind: entry.Kind, Slug: entry.Slug, Path: image.Path})
		}
	}
	sort.Slice(references, func(i, j int) bool {
		if references[i].Kind != references[j].Kind {
			return references[i].Kind < references[j].Kind
		}
		if references[i].Slug != references[j].Slug {
			return references[i].Slug < references[j].Slug
		}
		return references[i].Path < references[j].Path
	})
	return references
}

func (l Library) raw(kind Kind, slug string) (Entry, bool) {
	entry, ok := l.entries[key(kind, slug)]
	return entry, ok
}

func (l *Library) put(entry Entry) { l.entries[key(entry.Kind, entry.Slug)] = entry }

func Save(path string, library Library) error {
	entries := make([]Entry, 0, len(library.entries))
	for _, entry := range library.entries {
		if err := validateEntry(entry); err != nil {
			return err
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind < entries[j].Kind
		}
		return entries[i].Slug < entries[j].Slug
	})
	data, err := json.MarshalIndent(diskFile{Version: FileVersion, Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".collection-editorial-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func validateEntry(entry Entry) error {
	label := key(entry.Kind, entry.Slug)
	if !entry.Kind.Valid() {
		return fmt.Errorf("collection editorial %q has invalid kind", label)
	}
	if entry.Slug == "" || model.Slugify(entry.Slug) != entry.Slug {
		return fmt.Errorf("collection editorial %q has a non-canonical slug", label)
	}
	if strings.TrimSpace(entry.Name) == "" {
		return fmt.Errorf("collection editorial %q requires a name", label)
	}
	if entry.Mode != "curated" && entry.Mode != "generated" {
		return fmt.Errorf("collection editorial %q mode must be curated or generated", label)
	}
	if !entry.Publishable() {
		if entry.Mode != "generated" || entry.RetryAfter == "" || entry.LastError == "" {
			return fmt.Errorf("collection editorial %q is neither publishable nor a retry record", label)
		}
		return nil
	}
	if len(entry.Paragraphs) == 0 || len(entry.Paragraphs) > 3 {
		return fmt.Errorf("collection editorial %q requires one to three paragraphs", label)
	}
	if entry.Mode == "generated" && len(entry.Sources) == 0 {
		return fmt.Errorf("generated collection editorial %q requires sources", label)
	}
	prose := append([]string{entry.Name, entry.Eyebrow, entry.Heading}, entry.Paragraphs...)
	for _, image := range entry.Images {
		prose = append(prose, image.Alt, image.Caption, image.Credit)
		clean := filepath.ToSlash(filepath.Clean(image.Path))
		if clean != image.Path || strings.Contains(clean, "..") ||
			(!strings.HasPrefix(clean, "assets/img/regions/") && !strings.HasPrefix(clean, "assets/img/collections/")) {
			return fmt.Errorf("collection editorial %q image %q must stay under an editorial image directory", label, image.Path)
		}
		if strings.TrimSpace(image.Alt) == "" || !strings.HasPrefix(image.SourceURL, "https://") || strings.TrimSpace(image.License) == "" {
			return fmt.Errorf("collection editorial %q image %q requires alt, sourceUrl, and license", label, image.Path)
		}
	}
	for _, value := range prose {
		if strings.ContainsAny(value, "\u2013\u2014") || !utf8.ValidString(value) {
			return fmt.Errorf("collection editorial %q contains a prohibited dash or invalid UTF-8", label)
		}
	}
	seenRelated := map[string]bool{}
	for _, related := range entry.Related {
		if related.Slug == "" || related.Slug == entry.Slug || model.Slugify(related.Slug) != related.Slug ||
			strings.TrimSpace(related.Label) == "" || seenRelated[related.Slug] {
			return fmt.Errorf("collection editorial %q has invalid related link %q", label, related.Slug)
		}
		seenRelated[related.Slug] = true
	}
	for _, source := range entry.Sources {
		if strings.TrimSpace(source.Label) == "" || !strings.HasPrefix(source.URL, "https://") {
			return fmt.Errorf("collection editorial %q has invalid source %q", label, source.Label)
		}
		if strings.ContainsAny(source.Label, "\u2013\u2014") || !utf8.ValidString(source.Label) {
			return fmt.Errorf("collection editorial %q source label contains a prohibited dash or invalid UTF-8", label)
		}
	}
	return nil
}

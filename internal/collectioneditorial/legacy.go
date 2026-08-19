package collectioneditorial

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/gritautomation/finevines-website/internal/model"
)

type legacyProducerProfile struct {
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	OldPath    string `json:"oldPath"`
	Prose      string `json:"prose"`
	ProseChars int    `json:"proseChars"`
}

// WithLegacyProducerProfiles overlays the producer biographies recovered
// from FineVines' own former website. These profiles are first-party archive
// content, not model research. Exact slugs and unique normalized identities
// are eligible; collisions are deliberately discarded.
func (l Library) WithLegacyProducerProfiles(path string) (Library, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return l, nil
		}
		return Library{}, err
	}
	var profiles []legacyProducerProfile
	if err := json.Unmarshal(body, &profiles); err != nil {
		return Library{}, fmt.Errorf("parse legacy producer profiles: %w", err)
	}

	if l.legacyProducerEntries == nil {
		l.legacyProducerEntries = map[string]Entry{}
	}
	ambiguous := map[string]bool{}
	for _, profile := range profiles {
		name := strings.TrimSpace(profile.Name)
		if name == "" || strings.TrimSpace(profile.Prose) == "" || !utf8.ValidString(profile.Prose) {
			continue
		}
		paragraphs := splitLegacyParagraphs(profile.Prose)
		if len(paragraphs) == 0 {
			continue
		}
		entry := Entry{
			Kind:       Producer,
			Slug:       model.Slugify(name),
			Name:       name,
			Mode:       "curated",
			Eyebrow:    "Meet the Producer",
			Heading:    name,
			Paragraphs: paragraphs,
		}
		identity := producerIdentity(name)
		if identity == "" {
			continue
		}
		if previous, exists := l.legacyProducerEntries[identity]; exists && previous.Slug != entry.Slug {
			delete(l.legacyProducerEntries, identity)
			ambiguous[identity] = true
			continue
		}
		if !ambiguous[identity] {
			l.legacyProducerEntries[identity] = entry
		}
	}

	// The former site filed the shared Chave family history under the Selection
	// label. The current catalog intentionally unifies estate and Selection
	// wines under Jean-Louis Chave, so carry that first-party profile forward.
	if entry, ok := l.legacyProducerEntries[producerIdentity("JL Chave Selection")]; ok {
		entry.Name = "Jean-Louis Chave"
		entry.Slug = model.Slugify(entry.Name)
		entry.Heading = entry.Name
		l.legacyProducerEntries[producerIdentity(entry.Name)] = entry
	}
	return l, nil
}

func splitLegacyParagraphs(prose string) []string {
	prose = strings.ReplaceAll(prose, "\r\n", "\n")
	var out []string
	for _, paragraph := range strings.Split(prose, "\n\n") {
		paragraph = strings.Join(strings.Fields(paragraph), " ")
		if paragraph != "" {
			out = append(out, paragraph)
		}
	}
	return out
}

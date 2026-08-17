package collectioneditorial

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/catalog"
	"github.com/gritautomation/finevines-website/internal/model"
)

type SampleWine struct {
	Producer    string `json:"producer"`
	Name        string `json:"name"`
	Vintage     string `json:"vintage,omitempty"`
	Region      string `json:"region,omitempty"`
	Varietal    string `json:"varietal,omitempty"`
	Appellation string `json:"appellation,omitempty"`
}

// Candidate is the complete, bounded research brief for one collection. It is
// derived only from the live catalog, so a Researcher never needs access to the
// much larger Wine model or to inventory data that does not belong in prose.
type Candidate struct {
	Kind        Kind         `json:"kind"`
	Name        string       `json:"name"`
	Slug        string       `json:"slug"`
	WineCount   int          `json:"wineCount"`
	Producers   []string     `json:"producers,omitempty"`
	Regions     []string     `json:"regions,omitempty"`
	Varietals   []string     `json:"varietals,omitempty"`
	Countries   []string     `json:"countries,omitempty"`
	Vintages    []string     `json:"vintages,omitempty"`
	SampleWines []SampleWine `json:"sampleWines"`
	Fingerprint string       `json:"-"`
}

type candidateAccumulator struct {
	kind      Kind
	slug      string
	names     map[string]int
	wines     []model.Wine
	producers map[string]int
	regions   map[string]int
	varietals map[string]int
	countries map[string]int
	vintages  map[string]int
}

// Discover returns one candidate per live region, producer, and varietal.
// Spelling variants that share a slug collapse deterministically, matching the
// static collection URL contract.
func Discover(wines []model.Wine) []Candidate {
	byKey := map[string]*candidateAccumulator{}
	for _, wine := range wines {
		if wine.Status != "" || catalog.OnHandCases(wine) < 1 || strings.TrimSpace(wine.Name) == "" || strings.TrimSpace(wine.Slug) == "" {
			continue
		}
		values := []struct {
			kind Kind
			name string
		}{{Producer, wine.Producer}, {Region, wine.Region}, {Varietal, wine.Varietal}}
		for _, value := range values {
			name := strings.TrimSpace(value.name)
			slug := model.Slugify(name)
			if slug == "" {
				continue
			}
			k := key(value.kind, slug)
			a := byKey[k]
			if a == nil {
				a = &candidateAccumulator{kind: value.kind, slug: slug, names: map[string]int{}, producers: map[string]int{}, regions: map[string]int{}, varietals: map[string]int{}, countries: map[string]int{}, vintages: map[string]int{}}
				byKey[k] = a
			}
			a.names[name]++
			a.wines = append(a.wines, wine)
			add(a.producers, wine.Producer)
			add(a.regions, wine.Region)
			add(a.varietals, wine.Varietal)
			add(a.countries, wine.Country)
			add(a.vintages, wine.Vintage)
		}
	}

	out := make([]Candidate, 0, len(byKey))
	for _, a := range byKey {
		name := ranked(a.names, 1)[0]
		sort.Slice(a.wines, func(i, j int) bool {
			left := strings.Join([]string{a.wines[i].Producer, a.wines[i].Name, a.wines[i].Vintage}, "\x00")
			right := strings.Join([]string{a.wines[j].Producer, a.wines[j].Name, a.wines[j].Vintage}, "\x00")
			return left < right
		})
		samples := make([]SampleWine, 0, 8)
		seenSamples := map[string]bool{}
		for _, wine := range a.wines {
			id := strings.Join([]string{wine.Producer, wine.Name, wine.Vintage}, "\x00")
			if seenSamples[id] {
				continue
			}
			seenSamples[id] = true
			samples = append(samples, SampleWine{Producer: wine.Producer, Name: wine.Name, Vintage: wine.Vintage, Region: wine.Region, Varietal: wine.Varietal, Appellation: wine.Appellation})
			if len(samples) == 8 {
				break
			}
		}
		// The fingerprint describes material editorial context, not inventory.
		// Adding bottles or another vintage does not trigger a rewrite; adding a
		// new producer, region, varietal, or country does.
		fingerprintParts := []string{string(a.kind), a.slug, name}
		for _, values := range []map[string]int{a.producers, a.regions, a.varietals, a.countries} {
			set := ranked(values, len(values))
			sort.Strings(set)
			fingerprintParts = append(fingerprintParts, strings.Join(set, "\x1f"))
		}
		fingerprintBytes := sha256.Sum256([]byte(strings.Join(fingerprintParts, "\x00")))
		out = append(out, Candidate{
			Kind: a.kind, Name: name, Slug: a.slug, WineCount: len(a.wines),
			Producers: ranked(a.producers, 12), Regions: ranked(a.regions, 12), Varietals: ranked(a.varietals, 12),
			Countries: ranked(a.countries, 8), Vintages: ranked(a.vintages, 12), SampleWines: samples,
			Fingerprint: hex.EncodeToString(fingerprintBytes[:]),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if kindPriority(out[i].Kind) != kindPriority(out[j].Kind) {
			return kindPriority(out[i].Kind) < kindPriority(out[j].Kind)
		}
		if out[i].WineCount != out[j].WineCount {
			return out[i].WineCount > out[j].WineCount
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func kindPriority(kind Kind) int {
	switch kind {
	case Region:
		return 0
	case Varietal:
		return 1
	default:
		return 2
	}
}

func add(counts map[string]int, value string) {
	if value = strings.TrimSpace(value); value != "" {
		counts[value]++
	}
}

func ranked(counts map[string]int, limit int) []string {
	type item struct {
		value string
		count int
	}
	items := make([]item, 0, len(counts))
	for value, count := range counts {
		items = append(items, item{value, count})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].count != items[j].count {
			return items[i].count > items[j].count
		}
		return items[i].value < items[j].value
	})
	if len(items) > limit {
		items = items[:limit]
	}
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = item.value
	}
	return out
}

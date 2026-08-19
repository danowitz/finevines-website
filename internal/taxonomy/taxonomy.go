// Package taxonomy converts source-system catalog labels into the canonical
// identities and geographic relationships published by the website. Source
// data stays untouched; all public consumers share this one normalization.
package taxonomy

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

const fileVersion = 1

type region struct {
	Name   string `json:"name"`
	Parent string `json:"parent,omitempty"`
}

type diskFile struct {
	Version          int                          `json:"version"`
	Aliases          map[string]map[string]string `json:"aliases"`
	ProducerPrefixes map[string]string            `json:"producerPrefixes,omitempty"`
	Regions          []region                     `json:"regions"`
}

type producerPrefix struct {
	prefix   string
	target   string
	explicit bool
}

// Catalog is the complete public taxonomy. Its interface deliberately exposes
// outcomes, not alias-map mechanics.
type Catalog struct {
	aliases          map[string]map[string]string
	producerPrefixes []producerPrefix
	parents          map[string]string
	children         map[string][]string
}

func Load(path string) (Catalog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Catalog{}, err
	}
	var file diskFile
	if err := json.Unmarshal(data, &file); err != nil {
		return Catalog{}, err
	}
	if file.Version != fileVersion {
		return Catalog{}, fmt.Errorf("taxonomy version %d is unsupported", file.Version)
	}
	c := Catalog{aliases: map[string]map[string]string{}, parents: map[string]string{}, children: map[string][]string{}}
	for _, kind := range []string{"region", "producer", "varietal"} {
		c.aliases[kind] = map[string]string{}
		for source, target := range file.Aliases[kind] {
			source, target = strings.TrimSpace(source), strings.TrimSpace(target)
			if source == "" || target == "" || strings.EqualFold(source, target) {
				return Catalog{}, fmt.Errorf("taxonomy %s alias %q -> %q is invalid", kind, source, target)
			}
			c.aliases[kind][strings.ToLower(source)] = target
		}
	}
	for source, target := range file.ProducerPrefixes {
		source, target = strings.TrimSpace(source), strings.TrimSpace(target)
		if source == "" || target == "" {
			return Catalog{}, fmt.Errorf("taxonomy producer prefix %q -> %q is invalid", source, target)
		}
		c.producerPrefixes = append(c.producerPrefixes, producerPrefix{
			prefix:   producerNameKey(source),
			target:   c.canonical("producer", target),
			explicit: true,
		})
	}
	sort.Slice(c.producerPrefixes, func(i, j int) bool {
		if len(c.producerPrefixes[i].prefix) != len(c.producerPrefixes[j].prefix) {
			return len(c.producerPrefixes[i].prefix) > len(c.producerPrefixes[j].prefix)
		}
		return c.producerPrefixes[i].explicit && !c.producerPrefixes[j].explicit
	})
	known := map[string]bool{}
	for _, item := range file.Regions {
		if item.Name == "" || known[item.Name] {
			return Catalog{}, fmt.Errorf("taxonomy has invalid or duplicate region %q", item.Name)
		}
		known[item.Name] = true
	}
	for _, item := range file.Regions {
		if item.Parent == "" {
			continue
		}
		if !known[item.Parent] || item.Parent == item.Name {
			return Catalog{}, fmt.Errorf("taxonomy region %q has invalid parent %q", item.Name, item.Parent)
		}
		c.parents[item.Name] = item.Parent
		c.children[item.Parent] = append(c.children[item.Parent], item.Name)
	}
	for parent := range c.children {
		sort.Strings(c.children[parent])
	}
	return c, nil
}

func (c Catalog) canonical(kind, value string) string {
	value = strings.TrimSpace(value)
	if target := c.aliases[kind][strings.ToLower(value)]; target != "" {
		return target
	}
	return value
}

// Normalize returns a copy with every public collection field canonicalized.
func (c Catalog) Normalize(wines []model.Wine) []model.Wine {
	out := append([]model.Wine(nil), wines...)
	for i := range out {
		out[i].Region = c.canonical("region", out[i].Region)
		out[i].Producer = c.canonical("producer", out[i].Producer)
		out[i].Varietal = c.canonical("varietal", out[i].Varietal)
	}

	// A blank Salesforce brand may safely inherit from another vintage only
	// when that exact normalized product name has one and only one canonical
	// producer. This joins known siblings without guessing from loose tokens.
	byName := map[string]map[string]bool{}
	byIdentity := map[string]map[string]bool{}
	currentPrefixes := map[string]map[string]bool{}
	for _, wine := range out {
		if strings.TrimSpace(wine.Producer) == "" {
			continue
		}
		name := producerNameKey(wine.Name)
		if name == "" {
			continue
		}
		if byName[name] == nil {
			byName[name] = map[string]bool{}
		}
		byName[name][wine.Producer] = true
		identity := producerIdentityKey(wine.Producer)
		if identity != "" {
			if byIdentity[identity] == nil {
				byIdentity[identity] = map[string]bool{}
			}
			byIdentity[identity][wine.Producer] = true
			if len(strings.Fields(identity)) >= 2 {
				if currentPrefixes[identity] == nil {
					currentPrefixes[identity] = map[string]bool{}
				}
				currentPrefixes[identity][wine.Producer] = true
			}
		}
	}
	type currentPrefix struct {
		prefix string
		target string
	}
	var trustedPrefixes []currentPrefix
	for prefix, producers := range currentPrefixes {
		if len(producers) != 1 {
			continue
		}
		for producer := range producers {
			trustedPrefixes = append(trustedPrefixes, currentPrefix{prefix: prefix, target: producer})
		}
	}
	sort.Slice(trustedPrefixes, func(i, j int) bool { return len(trustedPrefixes[i].prefix) > len(trustedPrefixes[j].prefix) })
	for i := range out {
		if strings.TrimSpace(out[i].Producer) != "" {
			continue
		}
		name := producerNameKey(out[i].Name)
		if target := c.producerForPrefix(name, byIdentity); target != "" {
			out[i].Producer = target
			continue
		}
		nameWithoutTradeWord := strings.TrimPrefix(name, "domaine ")
		nameWithoutTradeWord = strings.TrimPrefix(nameWithoutTradeWord, "chateau ")
		nameWithoutTradeWord = strings.TrimPrefix(nameWithoutTradeWord, "champagne ")
		nameWithoutTradeWord = strings.TrimPrefix(nameWithoutTradeWord, "weingut ")
		nameWithoutTradeWord = strings.TrimPrefix(nameWithoutTradeWord, "maison ")
		for _, rule := range trustedPrefixes {
			if name == rule.prefix || strings.HasPrefix(name, rule.prefix+" ") ||
				nameWithoutTradeWord == rule.prefix || strings.HasPrefix(nameWithoutTradeWord, rule.prefix+" ") {
				out[i].Producer = rule.target
				break
			}
		}
		if out[i].Producer != "" {
			continue
		}
		if producers := byName[name]; len(producers) == 1 {
			for producer := range producers {
				out[i].Producer = producer
			}
		}
	}
	return out
}

func producerNameKey(value string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(model.Slugify(value), "-", " ")), " ")
}

func producerIdentityKey(value string) string {
	parts := strings.Fields(producerNameKey(value))
	if len(parts) > 0 {
		switch parts[0] {
		case "domaine", "chateau", "champagne", "weingut", "maison", "the":
			parts = parts[1:]
		}
	}
	for len(parts) > 0 {
		switch parts[len(parts)-1] {
		case "wine", "wines", "winery", "vineyard", "vineyards", "cellars", "estate":
			parts = parts[:len(parts)-1]
		default:
			return strings.Join(parts, " ")
		}
	}
	return ""
}

func (c Catalog) producerForPrefix(name string, byIdentity map[string]map[string]bool) string {
	for _, rule := range c.producerPrefixes {
		if name == rule.prefix || strings.HasPrefix(name, rule.prefix+" ") {
			if current := byIdentity[producerIdentityKey(rule.target)]; len(current) == 1 {
				for target := range current {
					return target
				}
			}
			return rule.target
		}
	}
	return ""
}

type legacyProducerProfile struct {
	Name  string `json:"name"`
	Prose string `json:"prose"`
}

// WithLegacyProducerPrefixes adds only unique, multi-token producer headings
// from FineVines' own former site as conservative name-prefix rules. The
// current catalog's canonical spelling still wins when identities match.
func (c Catalog) WithLegacyProducerPrefixes(path string) (Catalog, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return Catalog{}, err
	}
	var profiles []legacyProducerProfile
	if err := json.Unmarshal(body, &profiles); err != nil {
		return Catalog{}, fmt.Errorf("parse legacy producer profiles: %w", err)
	}
	existing := map[string]bool{}
	for _, rule := range c.producerPrefixes {
		existing[rule.prefix] = true
	}
	for _, profile := range profiles {
		if strings.TrimSpace(profile.Prose) == "" {
			continue
		}
		name := strings.TrimSpace(profile.Name)
		prefix := producerNameKey(name)
		// One-word archive headings are too easy to confuse with a cuvee,
		// appellation, or family shared by more than one estate.
		if len(strings.Fields(producerIdentityKey(name))) < 2 || existing[prefix] {
			continue
		}
		c.producerPrefixes = append(c.producerPrefixes, producerPrefix{prefix: prefix, target: name})
		existing[prefix] = true
	}
	sort.SliceStable(c.producerPrefixes, func(i, j int) bool {
		if len(c.producerPrefixes[i].prefix) != len(c.producerPrefixes[j].prefix) {
			return len(c.producerPrefixes[i].prefix) > len(c.producerPrefixes[j].prefix)
		}
		return c.producerPrefixes[i].explicit && !c.producerPrefixes[j].explicit
	})
	return c, nil
}

// RegionTrail returns the canonical path from the broadest known region to
// name. Unknown regions simply return themselves.
func (c Catalog) RegionTrail(name string) []string {
	name = c.canonical("region", name)
	trail := []string{name}
	seen := map[string]bool{name: true}
	for c.parents[name] != "" {
		name = c.parents[name]
		if seen[name] {
			break
		}
		seen[name] = true
		trail = append(trail, name)
	}
	for i, j := 0, len(trail)-1; i < j; i, j = i+1, j-1 {
		trail[i], trail[j] = trail[j], trail[i]
	}
	return trail
}

func (c Catalog) RegionChildren(name string) []string {
	return append([]string(nil), c.children[c.canonical("region", name)]...)
}

// Redirects maps collection URLs for every alias to its canonical page.
func (c Catalog) Redirects() map[string]string {
	out := map[string]string{}
	segments := map[string]string{"region": "regions", "producer": "producers", "varietal": "varietals"}
	for kind, aliases := range c.aliases {
		for source, target := range aliases {
			from, to := model.Slugify(source), model.Slugify(target)
			if from != "" && to != "" && from != to {
				out["/"+segments[kind]+"/"+from+"/"] = "/" + segments[kind] + "/" + to + "/"
			}
		}
	}
	return out
}

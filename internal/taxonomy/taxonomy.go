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
	Version int                          `json:"version"`
	Aliases map[string]map[string]string `json:"aliases"`
	Regions []region                     `json:"regions"`
}

// Catalog is the complete public taxonomy. Its interface deliberately exposes
// outcomes, not alias-map mechanics.
type Catalog struct {
	aliases  map[string]map[string]string
	parents  map[string]string
	children map[string][]string
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
	return out
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

package model

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

type RegionEditorial struct {
	Eyebrow        string         `json:"eyebrow"`
	Heading        string         `json:"heading"`
	Paragraphs     []string       `json:"paragraphs"`
	Images         []RegionImage  `json:"images"`
	RelatedRegions []RegionLink   `json:"relatedRegions"`
	Sources        []RegionSource `json:"sources"`
}

type RegionImage struct {
	Path      string `json:"path"`
	Alt       string `json:"alt"`
	Caption   string `json:"caption"`
	Credit    string `json:"credit"`
	SourceURL string `json:"sourceUrl"`
	License   string `json:"license"`
}

type RegionSource struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type RegionLink struct {
	Slug  string `json:"slug"`
	Label string `json:"label"`
}

func LoadRegionEditorials(path string) (map[string]RegionEditorial, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]RegionEditorial{}, nil
		}
		return nil, err
	}
	var regions map[string]RegionEditorial
	if err := json.Unmarshal(data, &regions); err != nil {
		return nil, err
	}
	for slug, region := range regions {
		if Slugify(slug) != slug || slug == "" {
			return nil, fmt.Errorf("region editorial key %q must be a canonical slug", slug)
		}
		if err := validateRegionEditorial(slug, region); err != nil {
			return nil, err
		}
	}
	return regions, nil
}

func validateRegionEditorial(slug string, region RegionEditorial) error {
	if strings.TrimSpace(region.Heading) == "" || len(region.Paragraphs) == 0 || len(region.Images) == 0 || len(region.Sources) == 0 {
		return fmt.Errorf("region %q editorial requires a heading, paragraphs, images, and sources", slug)
	}
	prose := append([]string{region.Eyebrow, region.Heading}, region.Paragraphs...)
	for _, image := range region.Images {
		prose = append(prose, image.Alt, image.Caption, image.Credit)
		if !strings.HasPrefix(image.Path, "assets/img/regions/") || strings.Contains(image.Path, "..") {
			return fmt.Errorf("region %q image path %q must stay under assets/img/regions", slug, image.Path)
		}
		if image.Alt == "" || !strings.HasPrefix(image.SourceURL, "https://") || image.License == "" {
			return fmt.Errorf("region %q image %q requires alt, sourceUrl, and license", slug, image.Path)
		}
	}
	for _, value := range prose {
		if strings.ContainsRune(value, '—') {
			return fmt.Errorf("region %q editorial copy contains an em dash", slug)
		}
	}
	seen := map[string]bool{}
	for _, related := range region.RelatedRegions {
		if related.Slug == slug || related.Slug == "" || Slugify(related.Slug) != related.Slug || related.Label == "" || seen[related.Slug] {
			return fmt.Errorf("region %q has invalid related region %q", slug, related.Slug)
		}
		if strings.ContainsRune(related.Label, '—') {
			return fmt.Errorf("region %q editorial copy contains an em dash", slug)
		}
		seen[related.Slug] = true
	}
	for _, source := range region.Sources {
		if source.Label == "" || !strings.HasPrefix(source.URL, "https://") {
			return fmt.Errorf("region %q has invalid source %q", slug, source.Label)
		}
	}
	return nil
}

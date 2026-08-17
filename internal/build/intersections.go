package build

import (
	"fmt"
	"html/template"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

const (
	intersectionMinWines     = 6
	intersectionMinProducers = 2
)

// intersection is a deliberately selective region-and-varietal collection.
// It is published only when the live catalog has enough depth to be useful,
// preventing the facet matrix from turning into doorway pages.
type intersection struct {
	Region       string
	RegionSlug   string
	Varietal     string
	VarietalSlug string
	Cards        []cardWine
}

func (i intersection) URL(page int) string {
	base := fmt.Sprintf("/regions/%s/varietals/%s/", i.RegionSlug, i.VarietalSlug)
	if page <= 1 {
		return base
	}
	return fmt.Sprintf("%spage/%d/", base, page)
}

func buildIntersections(cards []cardWine) []intersection {
	type acc struct {
		cards     []cardWine
		producers map[string]bool
	}
	groups := map[string]*acc{}
	for _, card := range cards {
		region, varietal := strings.TrimSpace(card.Region), strings.TrimSpace(card.Varietal)
		regionSlug, varietalSlug := model.Slugify(region), model.Slugify(varietal)
		if regionSlug == "" || varietalSlug == "" {
			continue
		}
		key := regionSlug + "/" + varietalSlug
		if groups[key] == nil {
			groups[key] = &acc{producers: map[string]bool{}}
		}
		groups[key].cards = append(groups[key].cards, card)
		if card.Producer != "" {
			groups[key].producers[card.Producer] = true
		}
	}
	var out []intersection
	for _, group := range groups {
		if len(group.cards) < intersectionMinWines || len(group.producers) < intersectionMinProducers {
			continue
		}
		first := group.cards[0]
		out = append(out, intersection{Region: first.Region, RegionSlug: model.Slugify(first.Region), Varietal: first.Varietal, VarietalSlug: model.Slugify(first.Varietal), Cards: group.cards})
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].Cards) != len(out[j].Cards) {
			return len(out[i].Cards) > len(out[j].Cards)
		}
		return out[i].Region+"\x00"+out[i].Varietal < out[j].Region+"\x00"+out[j].Varietal
	})
	return out
}

func intersectionsForCollection(kind collectionKind, value collection, intersections []intersection) []collectionLink {
	var links []collectionLink
	for _, item := range intersections {
		label := ""
		switch kind.Key {
		case "region":
			if item.RegionSlug == value.Slug {
				label = item.Varietal
			}
		case "varietal":
			if item.VarietalSlug == value.Slug {
				label = item.Region
			}
		}
		if label != "" {
			links = append(links, collectionLink{Name: label, URL: item.URL(1), Count: len(item.Cards)})
		}
	}
	sort.Slice(links, func(i, j int) bool {
		if links[i].Count != links[j].Count {
			return links[i].Count > links[j].Count
		}
		return links[i].Name < links[j].Name
	})
	return links
}

type intersectionPage struct {
	page
	Intersection intersection
	Cards        []cardWine
	Images       []collectionEditorialImage
	PageNum      int
	PageCount    int
	PrevURL      string
	NextURL      string
	RegionURL    string
	VarietalURL  string
	Crumbs       []crumb
	Producers    []string
	VintageRange string
}

func intersectionFacts(item intersection) ([]string, string) {
	producerCounts := map[string]int{}
	vintages := map[string]bool{}
	for _, card := range item.Cards {
		if name := strings.TrimSpace(card.Producer); name != "" {
			producerCounts[name]++
		}
		if vintage := strings.TrimSpace(card.Vintage); vintage != "" {
			vintages[vintage] = true
		}
	}
	producers := make([]string, 0, len(producerCounts))
	for name := range producerCounts {
		producers = append(producers, name)
	}
	sort.Slice(producers, func(i, j int) bool {
		if producerCounts[producers[i]] != producerCounts[producers[j]] {
			return producerCounts[producers[i]] > producerCounts[producers[j]]
		}
		return producers[i] < producers[j]
	})
	if len(producers) > 3 {
		producers = producers[:3]
	}
	years := make([]string, 0, len(vintages))
	for year := range vintages {
		years = append(years, year)
	}
	sort.Strings(years)
	vintageRange := ""
	if len(years) == 1 {
		vintageRange = years[0]
	} else if len(years) > 1 {
		vintageRange = years[0] + " to " + years[len(years)-1]
	}
	return producers, vintageRange
}

func renderIntersections(tmpl *template.Template, distDir string, s *site, intersections []intersection, regions []collection) ([]string, error) {
	publishedRegions := map[string]bool{}
	for _, region := range regions {
		publishedRegions[region.Slug] = true
	}
	var paths []string
	for _, item := range intersections {
		producers, vintageRange := intersectionFacts(item)
		pageCount := (len(item.Cards) + portfolioPageSize - 1) / portfolioPageSize
		for n := 1; n <= pageCount; n++ {
			start, end := (n-1)*portfolioPageSize, n*portfolioPageSize
			if end > len(item.Cards) {
				end = len(item.Cards)
			}
			title := fmt.Sprintf("%s %s Wines - FineVines", item.Region, item.Varietal)
			if n > 1 {
				title = fmt.Sprintf("%s %s Wines - Page %d of %d - FineVines", item.Region, item.Varietal, n, pageCount)
			}
			prev, next := "", ""
			if n > 1 {
				prev = item.URL(n - 1)
			}
			if n < pageCount {
				next = item.URL(n + 1)
			}
			data := intersectionPage{
				page:         page{site: s, Title: title, Description: fmt.Sprintf("Explore %d %s wines from %s in the current FineVines wholesale portfolio, with producers, vintages, and bottle details.", len(item.Cards), item.Varietal, item.Region), Path: item.URL(n)},
				Intersection: item, Cards: item.Cards[start:end], PageNum: n, PageCount: pageCount, PrevURL: prev, NextURL: next,
				RegionURL: "/regions/" + item.RegionSlug + "/", VarietalURL: "/varietals/" + item.VarietalSlug + "/",
				Producers: producers, VintageRange: vintageRange,
			}
			data.Crumbs = []crumb{{Name: "Regions", URL: "/regions/"}}
			trail := s.Taxonomy.RegionTrail(item.Region)
			for _, name := range trail {
				slug := model.Slugify(name)
				if publishedRegions[slug] {
					data.Crumbs = append(data.Crumbs, crumb{Name: name, URL: "/regions/" + slug + "/"})
				}
			}
			data.Crumbs = append(data.Crumbs, crumb{Name: item.Varietal, URL: item.URL(n)})
			if n == 1 {
				data.Images = bottleEditorialImages(item.Cards, distDir, 3)
			}
			rel := fmt.Sprintf("regions/%s/varietals/%s", item.RegionSlug, item.VarietalSlug)
			if n > 1 {
				rel = fmt.Sprintf("%s/page/%d", rel, n)
			}
			if err := renderPage(tmpl, distDir, rel, "intersection", data); err != nil {
				return nil, err
			}
			paths = append(paths, data.Path)
		}
	}
	return paths, nil
}

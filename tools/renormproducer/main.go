// Command renormproducer re-applies normalize.Producer to the producer
// already stored on every wine in data/wines.json, and carries the correction
// through everything the producer seeds: the slug, the image path, the image
// file on disk, and a lifecycle redirect from the old URL to the new one.
//
// It exists because a normalization bug is discovered AFTER the catalog is
// enriched, and re-enriching to fix stored text costs a Salesforce pull and a
// round of OpenAI calls for wines whose descriptive data is already correct.
// The producer field is derived purely from the raw brand by a pure function,
// so re-deriving it locally is exact — no network, no model, no cost.
//
// The trigger (2026-08-09): Salesforce appends an internal lot code to the
// brand on the 2011 Burgundies — "LEROUX, BENJAMIN - BCL11" — which the
// "LAST, FIRST" reversal scattered mid-name into "Benjamin - BCL11 Leroux".
// It printed on every card, seeded 18 slugs, and split Benjamin Leroux across
// two producer collection pages. normalize.Producer now strips it; this
// carries that fix into the data already written.
//
//	go run ./tools/renormproducer           # dry run: report what would change
//	go run ./tools/renormproducer --apply   # rewrite wines.json, images, redirects
//
// Rerunning after a successful --apply is a no-op: normalize.Producer is
// idempotent, so a clean catalog reports zero changes.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/normalize"
)

func main() {
	apply := flag.Bool("apply", false, "write the corrections (default: dry run)")
	dataDir := flag.String("data", "data", "directory holding wines.json")
	assetsDir := flag.String("assets", "assets", "assets directory holding img/wines")
	flag.Parse()

	winesPath := filepath.Join(*dataDir, "wines.json")
	wines, err := model.LoadWines(winesPath)
	if err != nil {
		log.Fatalf("load wines: %v", err)
	}

	type change struct {
		oldProducer, newProducer string
		oldSlug, newSlug         string
		oldImage, newImage       string
	}
	var changes []change

	for i := range wines {
		w := &wines[i]
		fixed := normalize.Producer(w.Producer)
		if fixed == w.Producer {
			continue
		}
		c := change{oldProducer: w.Producer, newProducer: fixed, oldSlug: w.Slug, oldImage: w.ImagePath}

		// The slug is Slugify(producer, name, vintage) — the same join enrich
		// uses — so correcting the producer re-derives it exactly.
		c.newSlug = model.Slugify(fixed, w.Name, w.Vintage)
		// The image keeps its extension: a real photograph (.jpg) is renamed
		// beside the wine, while a generated .svg placeholder is regenerated
		// by the next build anyway.
		if w.ImagePath != "" {
			c.newImage = filepath.ToSlash(filepath.Join(filepath.Dir(w.ImagePath),
				c.newSlug+filepath.Ext(w.ImagePath)))
		}

		w.Producer = fixed
		w.Slug = c.newSlug
		if c.newImage != "" {
			w.ImagePath = c.newImage
		}
		changes = append(changes, c)
	}

	if len(changes) == 0 {
		fmt.Println("no producer needs re-normalizing — catalog is clean")
		return
	}

	for _, c := range changes {
		fmt.Printf("%-28q -> %q\n  slug  %s\n     -> %s\n", c.oldProducer, c.newProducer, c.oldSlug, c.newSlug)
	}
	fmt.Printf("\n%d wines affected\n", len(changes))
	if !*apply {
		fmt.Println("dry run — re-run with --apply to write")
		return
	}

	// Redirects first: if a later step fails, an old URL pointing at the new
	// page is harmless, whereas a renamed page with no redirect is a 404.
	redirPath := filepath.Join(*dataDir, "lifecycle-redirects.json")
	redirects := map[string]string{}
	if body, err := os.ReadFile(redirPath); err == nil {
		if err := json.Unmarshal(body, &redirects); err != nil {
			log.Fatalf("parse %s: %v", redirPath, err)
		}
	} else if !os.IsNotExist(err) {
		log.Fatalf("read %s: %v", redirPath, err)
	}
	added := 0
	for _, c := range changes {
		if c.oldSlug == c.newSlug {
			continue
		}
		from := "/wines/" + c.oldSlug + "/"
		if _, exists := redirects[from]; exists {
			continue // an earlier lifecycle event already claimed this URL
		}
		redirects[from] = "/wines/" + c.newSlug + "/"
		added++
	}
	if err := writeJSON(redirPath, redirects); err != nil {
		log.Fatalf("write redirects: %v", err)
	}

	// Then the photographs. Generated .svg placeholders are skipped: they are
	// gitignored build artifacts the next build rewrites under the new slug.
	renamed := 0
	for _, c := range changes {
		if c.oldImage == "" || c.oldImage == c.newImage || strings.EqualFold(filepath.Ext(c.oldImage), ".svg") {
			continue
		}
		from := filepath.FromSlash(c.oldImage)
		to := filepath.FromSlash(c.newImage)
		if _, err := os.Stat(from); err != nil {
			continue // nothing on disk to move
		}
		if err := os.Rename(from, to); err != nil {
			log.Fatalf("rename %s -> %s: %v", from, to, err)
		}
		renamed++
	}

	if err := model.SaveWines(winesPath, wines); err != nil {
		log.Fatalf("save wines: %v", err)
	}
	fmt.Printf("applied: %d wines rewritten, %d photographs renamed, %d redirects added\n",
		len(changes), renamed, added)
	_ = assetsDir
}

// writeJSON writes v as indented JSON with keys in a stable order, matching
// how the rest of the repo stores its small maps so diffs stay readable.
func writeJSON(path string, v map[string]string) error {
	keys := make([]string, 0, len(v))
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("{\n")
	for i, k := range keys {
		key, _ := json.Marshal(k)
		val, _ := json.Marshal(v[k])
		b.WriteString("  " + string(key) + ": " + string(val))
		if i < len(keys)-1 {
			b.WriteByte(',')
		}
		b.WriteByte('\n')
	}
	b.WriteString("}\n")
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

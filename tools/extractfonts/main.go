// Command extractfonts pulls the base64-embedded woff2 fonts out of the
// proposal index.html into assets/fonts/. The proposal (repo root) is the
// only surviving artifact carrying the licensed-for-self-hosting brand
// webfonts (Cormorant Garamond, EB Garamond, Archivo — all Google Fonts /
// OFL). Run with `go run ./tools/extractfonts` from the repo root; it's a
// throwaway tool kept in-tree only for reproducibility, not part of the
// build pipeline.
package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"regexp"
)

// The proposal's @font-face rules are minified onto a single line each, in
// the order font-family, font-style, font-weight, font-display, then the
// src: url(data:font/woff2;base64,...) payload, e.g.:
//
//	@font-face{font-family:'Archivo';font-style:normal;font-weight:500;
//	font-display:swap;src:url(data:font/woff2;base64,AAAA...) format('woff2');}
//
// font-style sits between font-family and font-weight, so it's captured too
// (used to disambiguate italic faces that would otherwise collide on
// family+weight, e.g. Cormorant Garamond italic 600 vs normal 600).
var faceRe = regexp.MustCompile(
	`font-family:\s*'([^']+)'[^}]*?font-style:\s*(\w+)[^}]*?font-weight:\s*(\d+)[^}]*?` +
		`url\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\)`)

func main() {
	src, err := os.ReadFile("index.html")
	if err != nil {
		panic(err)
	}
	if err := os.MkdirAll("assets/fonts", 0o755); err != nil {
		panic(err)
	}
	matches := faceRe.FindAllSubmatch(src, -1)
	if len(matches) == 0 {
		fmt.Println("no @font-face matches found")
		os.Exit(1)
	}
	collapseSpace := regexp.MustCompile(`\s+`)
	for _, m := range matches {
		family, style, weight, b64 := string(m[1]), string(m[2]), string(m[3]), m[4]
		raw, err := base64.StdEncoding.DecodeString(string(b64))
		if err != nil {
			panic(fmt.Errorf("%s/%s/%s: %w", family, style, weight, err))
		}
		nameFamily := collapseSpace.ReplaceAllString(family, "")
		suffix := weight
		if style == "italic" {
			suffix = weight + "italic"
		}
		name := fmt.Sprintf("assets/fonts/%s-%s.woff2", nameFamily, suffix)
		if err := os.WriteFile(name, raw, 0o644); err != nil {
			panic(err)
		}
		fmt.Println("wrote", name, len(raw), "bytes")
	}
}

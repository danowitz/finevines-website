// Package normalize turns the terse QuickBooks trade shorthand in Salesforce
// into presentable catalog text, so un-enriched wines don't show raw strings
// like "14 LAMY ST AUBIN ROUGE 1C DERRIERE CHEZ EDOUARD 12/750". It is
// deliberately conservative: it only touches values that LOOK like trade
// shorthand (a 2-digit vintage prefix or a case/bottle pack suffix, or an
// ALL-CAPS / "LAST, FIRST" brand), leaving already-clean text (enriched or
// mock data) untouched.
package normalize

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	vintagePrefix = regexp.MustCompile(`^L?\d{2}\s+`)          // "14 …", "L17 …"
	packSuffix    = regexp.MustCompile(`\s+\d+/[\d.]+\*?\s*$`) // "12/750", "1/3.0", "6/750*"
	trailingStar  = regexp.MustCompile(`[.*]+\s*$`)
	digitRe       = regexp.MustCompile(`\d`)
)

// small words stay lowercase unless first in the name.
var small = map[string]bool{
	"de": true, "du": true, "la": true, "le": true, "les": true, "des": true,
	"et": true, "chez": true, "en": true, "aux": true, "sur": true, "sous": true,
	"the": true, "of": true, "d": true, "a": true,
}

// abbrev expands common trade abbreviations (whole tokens, lower-cased key) to
// their properly-cased form. Conservative on purpose.
var abbrev = map[string]string{
	"st": "Saint", "ste": "Sainte", "mt": "Mont",
	"1c": "1er Cru", "gc": "Grand Cru", "grd": "Grand", "gd": "Grand",
	"vv": "Vieilles Vignes", "vieilles": "Vieilles",
	"res": "Réserve", "resv": "Réserve", "rsv": "Réserve",
	"cdr": "Côtes-du-Rhône", "cdp": "Châteauneuf-du-Pape",
	"ch": "Château", "dom": "Domaine",
}

// acronym tokens kept uppercase when title-casing (USA, DOCG, …).
var acronym = map[string]bool{
	"usa": true, "us": true, "uk": true, "gsm": true, "ava": true, "avr": true,
	"docg": true, "doc": true, "igt": true, "aoc": true, "nv": true, "us.": true,
}

// Text title-cases ALL-CAPS trade text (varietal, region, country) for display,
// preserving known acronyms and leaving already-mixed-case text untouched.
func Text(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || (hasLower(s) && hasUpper(s)) {
		return s
	}
	return titleCase(s)
}

// IsTradeName reports whether desc looks like Salesforce trade shorthand (and
// therefore should be normalized).
func IsTradeName(desc string) bool {
	return vintagePrefix.MatchString(desc) || packSuffix.MatchString(desc)
}

// WineName derives a presentable wine name from a terse trade description,
// dropping the vintage prefix, the pack/size suffix, and the leading brand
// tokens (which the description repeats), then expanding a few abbreviations
// and title-casing. Already-clean names are returned unchanged.
func WineName(desc, brand string) string {
	if !IsTradeName(desc) {
		return strings.TrimSpace(desc)
	}
	s := vintagePrefix.ReplaceAllString(desc, "")
	s = packSuffix.ReplaceAllString(s, "")
	s = trailingStar.ReplaceAllString(s, "")
	s = stripLeadingBrand(strings.TrimSpace(s), brand)
	if s == "" {
		s = vintagePrefix.ReplaceAllString(desc, "") // fall back rather than blank
		s = packSuffix.ReplaceAllString(s, "")
	}
	return titleCase(strings.TrimSpace(s))
}

// Producer normalizes a brand: "LAST, FIRST" → "First Last", ALL-CAPS or
// all-lower → Title Case. Already-mixed-case brands without a comma are left
// as-is.
func Producer(brand string) string {
	brand = strings.TrimSpace(brand)
	if brand == "" {
		return ""
	}
	if !strings.Contains(brand, ",") && hasLower(brand) && hasUpper(brand) {
		return brand
	}
	if i := strings.Index(brand, ","); i >= 0 {
		brand = strings.TrimSpace(brand[i+1:]) + " " + strings.TrimSpace(brand[:i])
	}
	return titleCase(brand)
}

// Vintage expands a 2-digit year to 4 digits (≤30 → 20xx, else 19xx). Anything
// else (already 4-digit, "NV", empty) is returned unchanged.
func Vintage(v string) string {
	v = strings.TrimSpace(v)
	if len(v) == 2 && isDigits(v) {
		n, _ := strconv.Atoi(v)
		if n <= 30 {
			return "20" + v
		}
		return "19" + v
	}
	return v
}

var connector = map[string]bool{"&": true, "and": true, "+": true}

func stripLeadingBrand(name, brand string) string {
	bt := map[string]bool{}
	for _, t := range strings.Fields(strings.ToLower(strings.ReplaceAll(brand, ",", " "))) {
		if len(t) >= 2 {
			bt[t] = true
		}
	}
	words := strings.Fields(name)
	i := 0
	for i < len(words) {
		w := strings.ToLower(strings.Trim(words[i], ".,'"))
		if bt[w] || connector[w] {
			i++
			continue
		}
		break
	}
	// Drop a dangling leading connector left behind (e.g. brand ended mid-strip).
	for i < len(words) && connector[strings.ToLower(words[i])] {
		i++
	}
	if i >= len(words) { // would strip everything — keep original
		return name
	}
	return strings.Join(words[i:], " ")
}

func titleCase(s string) string {
	words := strings.Fields(s)
	out := make([]string, 0, len(words))
	for i, w := range words {
		lw := strings.ToLower(w)
		if a, ok := abbrev[lw]; ok {
			out = append(out, strings.Fields(a)...)
			continue
		}
		if acronym[lw] {
			out = append(out, strings.ToUpper(w))
			continue
		}
		if digitRe.MatchString(w) || (hasLower(w) && hasUpper(w)) {
			out = append(out, w) // numeric token or already mixed — leave
			continue
		}
		if i > 0 && small[lw] {
			out = append(out, lw)
			continue
		}
		out = append(out, titleWord(w))
	}
	return strings.Join(out, " ")
}

func titleWord(w string) string {
	if w == "&" {
		return w
	}
	parts := strings.Split(strings.ToLower(w), "-")
	for j, p := range parts {
		parts[j] = upFirst(p)
	}
	return strings.Join(parts, "-")
}

func upFirst(s string) string {
	r := []rune(s)
	for i, c := range r {
		if c >= 'a' && c <= 'z' {
			r[i] = c - 32
			return string(r)
		}
		if c >= 'A' && c <= 'Z' || (c >= '0' && c <= '9') {
			return string(r) // starts with an already-upper letter or a digit
		}
	}
	return string(r)
}

func hasLower(s string) bool { return strings.ToUpper(s) != s }
func hasUpper(s string) bool { return strings.ToLower(s) != s }

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

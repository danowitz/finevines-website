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
	vintagePrefix = regexp.MustCompile(`^(?:L?\d{2}|NV)\s+`) // "14 …", "L17 …", "NV …"
	// A pack token is either preceded by whitespace ("… 12/750", "1/3.0",
	// "3/1.5L", "24/375 CANS") or glued to the last word ("GRAND CRU12/750",
	// "(100% PINOT NOIR)12/750" — both live data). Requiring a letter or ')'
	// before a glued token keeps a LEADING numeric run like the vertical
	// assortment "16/17/18 ROCCA …" from matching itself.
	packToken    = regexp.MustCompile(`(?:\s+|[A-Za-z)])\d+/[\d.]+`)
	trailingStar = regexp.MustCompile(`[.*]+\s*$`)
	digitRe      = regexp.MustCompile(`\d`)
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

// acronym tokens kept uppercase when title-casing (USA, DOCG, …). Multi-char
// roman numerals ("CUVEE XIV") stay uppercase too; single letters are excluded
// as too ambiguous with initials.
var acronym = map[string]bool{
	"usa": true, "us": true, "uk": true, "gsm": true, "ava": true, "avr": true,
	"docg": true, "doc": true, "igt": true, "aoc": true, "nv": true, "us.": true,
	"ii": true, "iii": true, "iv": true, "vi": true, "vii": true, "viii": true,
	"ix": true, "xi": true, "xii": true, "xiii": true, "xiv": true, "xv": true,
	"xvi": true, "xvii": true, "xviii": true, "xix": true, "xx": true,
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
	return vintagePrefix.MatchString(desc) || packToken.MatchString(desc)
}

// WineName derives a presentable wine name from a terse trade description,
// dropping the vintage prefix, the pack-size token and everything after it,
// and the leading brand tokens (which the description repeats), then expanding
// a few abbreviations and title-casing. Already-clean names are returned
// unchanged.
func WineName(desc, brand string) string {
	if !IsTradeName(desc) {
		return strings.TrimSpace(desc)
	}
	s := vintagePrefix.ReplaceAllString(desc, "")
	s = truncateAtPack(s)
	s = trailingStar.ReplaceAllString(s, "")
	s = stripLeadingBrand(strings.TrimSpace(s), brand)
	if s == "" {
		s = vintagePrefix.ReplaceAllString(desc, "") // fall back rather than blank
		s = truncateAtPack(s)
	}
	return titleCase(strings.TrimSpace(s))
}

// truncateAtPack cuts the name at the first pack-size token. Surveyed against
// the full live roster (2026-07-29): nothing after a pack token is ever
// wine-name content — only unit words ("L", "ML", "CANS", "LITER"),
// warehouse hold/ops notes ("HOLD FOR …", "GM HOLD"), asterisks, or a
// duplicated pack token.
func truncateAtPack(s string) string {
	loc := packToken.FindStringIndex(s)
	if loc == nil {
		return s
	}
	if s[loc[0]] == ' ' || s[loc[0]] == '\t' {
		return s[:loc[0]] // whitespace-led token: cut the whitespace too
	}
	return s[:loc[0]+1] // glued token: keep the word's final letter or ')'
}

// lotCode matches the internal warehouse reference Salesforce appends to some
// brands — "LEROUX, BENJAMIN - BCL11", "MOREY, PIERRE BLC 13" — along with the
// dash and spacing that introduce it. It is a stock reference, not part of an
// estate's name.
//
// Deliberately narrow: only the BCL/BLC prefixes actually seen in the roster,
// and only when followed by one to three digits. Real brands carry digits too
// (GEN5, ATOMIQUE3, 1+1=3) and none of them may be touched.
var lotCode = regexp.MustCompile(`(?i)\s*-?\s*\b(?:BCL|BLC)\s?\d{1,3}\b`)

// stripLotCode removes the reference wherever it sits and closes the gap it
// leaves. It has to handle two positions: at the END of a raw Salesforce brand
// ("AMBROISE - BCL11"), and in the MIDDLE of an already-normalized value
// ("Benjamin - BCL11 Leroux") — because the "LAST, FIRST" reversal below
// splits the raw string across the code, and stored catalog text needs
// repairing without a fresh Salesforce pull.
func stripLotCode(s string) string {
	return strings.Join(strings.Fields(lotCode.ReplaceAllString(s, " ")), " ")
}

// Producer normalizes a brand: "LAST, FIRST" → "First Last", ALL-CAPS or
// all-lower → Title Case. Already-mixed-case brands without a comma are left
// as-is. An internal lot code is stripped first, so it can never be carried
// into the reversal and scattered mid-name.
func Producer(brand string) string {
	brand = stripLotCode(strings.TrimSpace(brand))
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

// historyCue marks a year as ESTATE history rather than a vintage claim —
// when the estate was founded, when a winemaker took over, when a parcel was
// planted. Those years are facts about the domaine and belong on every
// vintage's page.
var historyCue = regexp.MustCompile(`(?i)\b(founded|established|since|began|start(?:ed)?|planted|replanted|acquired|bought|purchased|inherited|took over|taken over|joined|built|created|converted|certified)\b[^.;]{0,40}$`)

// drinkCue marks a year as DRINKING guidance rather than a vintage claim.
// A drink window can start close to the vintage ("2025–2036" on a 2022), so
// proximity alone cannot tell the two apart.
var drinkCue = regexp.MustCompile(`(?i)\b(drink|drinking|enjoy|cellar|ageing|aging|keep|hold|window|decant|decanting|revisit|broach)\b[^.;]{0,30}$`)

// forwardCue is the second class of drinking guidance: a preposition
// IMMEDIATELY before the year, as in "decanting after 2028" or "hold until
// 2030". Adjacency is required because the same words introduce plenty of
// non-guidance — "from Domaine Jouan 2020" and "from the 2022 vintage" are
// attributions, and treating them as drink windows left eight contaminated
// wines uncorrected. "from" and "between" are deliberately absent: in this
// catalog they precede a producer far more often than a drinking date, and
// real drinking guidance lives in the DrinkWindow field.
var forwardCue = regexp.MustCompile(`(?i)\b(after|before|beyond|past|post|through|until|towards|toward)\s+$`)

// yearRange matches a year that is one end of a span — "2025–2036",
// "2025-2036", "2025 to 2036" — which is always a drink window, never a
// vintage.
var yearRange = regexp.MustCompile(`(19|20)\d\d\s*(?:[-–—]|to)\s*(19|20)\d\d`)

// danglingPrep matches a preposition the year is the object of. Removing the
// year alone would leave "This Meursault from reveals refinement", so the
// preposition goes with it. No trailing \s here: foreignYear already consumes
// the space before the year, so the text handed to this pattern ends at the
// preposition itself.
var danglingPrep = regexp.MustCompile(`(?i)\s+\b(from|of|in)$`)

// headedNoun matches "the 2022 vintage" — a year sitting between a determiner
// and a noun it modifies. No token-level edit reads well here: dropping the
// year gives "from the vintage by Domaine X". These are left ALONE and
// reported instead, because mangling a sentence is worse than a wrong year a
// human can still see and fix.
var headedNounBefore = regexp.MustCompile(`(?i)\b(the|this|that)\s+$`)
var headedNounAfter = regexp.MustCompile(`(?i)^\s+(vintage|release|bottling|harvest)\b`)

// foreignYear matches a four-digit year with the spacing around it, so
// removing one does not leave a double space or a space before a comma.
var foreignYear = regexp.MustCompile(`\s*\b(19|20)\d\d\b`)

// StripForeignVintage removes a vintage year that is NOT this wine's from
// descriptive prose.
//
// It exists because prose is shared across vintages of one cuvée (the
// client's consolidation decision, 2026-08-04 — see tools/proseshare) and the
// donor's year travels inside the copied sentence. The result is a page for
// the 2023 that opens "This Moscato d'Asti 'Centive' 2024…": the tasting
// character is a deliberate share, but the year is simply wrong.
//
// The year is REMOVED, never swapped for the right one. Shared prose
// describes the cuvée, so omitting the year is honest, while rewriting "the
// 2012 unfolds" into "the 2018 unfolds" would manufacture a vintage-specific
// claim about a wine nobody tasted.
//
// Three things are deliberately left alone:
//   - the wine's own vintage, which is correct;
//   - a year introduced by an estate-history cue (founded, planted, took
//     over), which is a fact about the domaine and true on every page;
//   - a year that is drinking guidance — cued by "drink"/"through"/"until",
//     or written as one end of a span like "2025–2036".
//
// Only years within a decade either side of the vintage are considered at
// all. A tasting note does not reach further than that, so a distant year is
// describing something else entirely.
func StripForeignVintage(text, vintage string) string {
	own, err := strconv.Atoi(strings.TrimSpace(vintage))
	if err != nil || own < 1900 {
		return text // NV, or a row with no usable vintage: nothing to compare against
	}
	// Spans are drink windows wherever they appear; take them off the table
	// before looking at individual years.
	spans := yearRange.FindAllStringIndex(text, -1)
	inSpan := func(i int) bool {
		for _, s := range spans {
			if i >= s[0] && i < s[1] {
				return true
			}
		}
		return false
	}

	var b strings.Builder
	last := 0
	for _, loc := range foreignYear.FindAllStringIndex(text, -1) {
		match := text[loc[0]:loc[1]]
		year, err := strconv.Atoi(strings.TrimSpace(match))
		yearAt := loc[1] - 4 // where the digits themselves start
		keep := err != nil ||
			year == own ||
			year > own+10 || year < own-10 ||
			inSpan(yearAt) ||
			historyCue.MatchString(text[:yearAt]) ||
			drinkCue.MatchString(text[:yearAt]) ||
			forwardCue.MatchString(text[:yearAt])
		// A year modifying a noun ("the 2022 vintage") cannot be removed at
		// token level without wrecking the sentence — dropping it yields
		// "from the vintage by Domaine X". Leave it and let the caller report
		// it: a wrong year a human can see and rewrite beats mangled prose.
		if !keep && headedNounBefore.MatchString(text[:yearAt]) && headedNounAfter.MatchString(text[loc[1]:]) {
			keep = true
		}
		if keep {
			continue // leave the text untouched between last and this match
		}
		// Take the preposition the year was the object of, so "Meursault from
		// 2023 reveals" reads "Meursault reveals", not "Meursault from reveals".
		cut := loc[0]
		if p := danglingPrep.FindStringIndex(text[last:loc[0]]); p != nil && last+p[1] == loc[0] {
			cut = last + p[0]
		}
		b.WriteString(text[last:cut])
		last = loc[1]
	}
	if last == 0 {
		return text // nothing removed; return the original untouched
	}
	b.WriteString(text[last:])
	return strings.TrimSpace(b.String())
}

// citation matches a source the enrichment model left in the prose: a
// markdown link, optionally wrapped in its own parentheses and optionally
// glued to the preceding word — "([bourgognewine.dk](https://…))". The
// leading \s* takes the space with it so nothing is left floating before the
// sentence's own punctuation.
var citation = regexp.MustCompile(`\s*\(?\[[^\]]*\]\(\s*https?://[^)\s]*\s*\)\)?`)

// bareURL matches a naked link left in prose without markdown around it.
var bareURL = regexp.MustCompile(`\s*\bhttps?://\S+`)

// spaceBeforePunct tidies the gap a removal can leave in front of the
// sentence's own punctuation ("soils ." → "soils.").
var spaceBeforePunct = regexp.MustCompile(`\s+([.,;:!?])`)

// doubleSpace collapses the gap left when a citation is removed from the
// middle of a sentence.
var doubleSpace = regexp.MustCompile(`[ \t]{2,}`)

// StripCitations removes source links the enrichment model wrote into
// descriptive prose.
//
// Eleven fields across six wines shipped with "([bourgognewine.dk](https://
// bourgognewine.dk/…?utm_source=openai))" rendered literally on the wine's
// public page. Provenance is real and worth keeping — the catalog already
// keeps it, per field, in model.Wine.Sources — but a tasting note is not
// where it belongs.
//
// A sentence that ends up without terminal punctuation gets a full stop,
// since a citation frequently WAS the end of the sentence.
func StripCitations(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	out := citation.ReplaceAllString(text, "")
	out = bareURL.ReplaceAllString(out, "")
	if out == text {
		return text
	}
	out = spaceBeforePunct.ReplaceAllString(out, "$1")
	out = doubleSpace.ReplaceAllString(out, " ")
	out = strings.TrimSpace(out)
	if out != "" && !strings.ContainsAny(out[len(out)-1:], ".!?;:,") {
		out += "."
	}
	return out
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

// Package label renders a deterministic château-style bottle SVG for wines
// where photo generation failed or is unavailable. Visual system re-created
// from the approved proposal's rendered labels (the original JS generator no
// longer exists — see repo CLAUDE.md). Zero cost, always succeeds — the
// guaranteed image floor consumed by Task 15's image-generation provider
// chain as the last (never-fails) fallback.
package label

import (
	"bytes"
	"fmt"
	"hash/fnv"
	"strings"
	"text/template"
	"unicode"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// Taxonomy — five frame treatments, five crest ornaments, ten palettes.
// Selection is a deterministic function of the SKU (see Generate), so the
// same wine always renders the same way and different wines spread across
// the full visual range.
var frames = []string{"double", "single", "oval", "deco", "minimal"}

var crests = []string{"ring", "medallion", "shield", "fleuron", "fan"}

// palette holds the colors for one label treatment, transcribed from the
// ten rendered variants in the approved proposal (index.html, "Ten looks
// from one name"). Bg/Ink/Muted trace to specific swatches there; they stay
// tonally within the brand's bordeaux/brass/parchment/ink system
// (assets/css/site.css) without being literal copies of the site palette.
// Ink is deliberately distinct from Accent in every row so double/oval/deco
// frames always render two-tone, never a single flat color repeated.
type palette struct {
	Bg     string // label background
	Accent string // brass ornament color (crest, dividers, corner marks)
	Ink    string // primary text + secondary frame stroke
	Muted  string // secondary text color (appellation, footer)
}

var palettes = [10]palette{
	{Bg: "#faf6ee", Accent: "#a9853d", Ink: "#6b1630", Muted: "#6e5d4e"}, // classic Bordeaux
	{Bg: "#17110d", Accent: "#c2a14e", Ink: "#f1e6c9", Muted: "#c4ad88"}, // noir prestige
	{Bg: "#0e2c26", Accent: "#c9a24a", Ink: "#e9e2c9", Muted: "#9fb08a"}, // deep-green estate
	{Bg: "#fbf8f2", Accent: "#8a6a2f", Ink: "#2c211a", Muted: "#9c8c7c"}, // minimalist ivory
	{Bg: "#f4ece0", Accent: "#a9853d", Ink: "#531427", Muted: "#6e5d4e"}, // domaine parchment
	{Bg: "#23282e", Accent: "#c2a14e", Ink: "#eee7da", Muted: "#aab0b6"}, // modern charcoal
	{Bg: "#f7eceb", Accent: "#cf93a6", Ink: "#8a2a48", Muted: "#9c6b78"}, // rosé blush
	{Bg: "#f1e6c9", Accent: "#9c2a68", Ink: "#4d0530", Muted: "#8a6a2f"}, // grand cru gold
	{Bg: "#f3ead9", Accent: "#a9853d", Ink: "#5a3a2a", Muted: "#8a6a2f"}, // victorian sand
	{Bg: "#12100c", Accent: "#caa64e", Ink: "#e9d9a8", Muted: "#c4ad88"}, // champagne noir
}

// Label geometry within the 480×720 canvas. The label sits on the bottle
// body; its width matches the body so the frame reads as wrapped around
// the glass. Height grows to fit long wine names (see Generate).
const (
	canvasW = 480
	canvasH = 720
	labelX  = 140
	labelY  = 380
	labelW  = 200
	minH    = 240
	maxLine = 6 // defensive cap on wrapped name lines
)

// fnv64 hashes s for deterministic-but-well-spread variant selection.
func fnv64(s string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(s))
	return h.Sum64()
}

// xmlEscape escapes the five predefined XML entities. text/template does
// not auto-escape (unlike html/template, which would mangle raw SVG), so
// every wine-derived string must be run through this before it reaches
// the template.
func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	return s
}

// wordWrap greedily packs words onto lines of at most width characters.
// It is intentionally simple (no hyphenation, no font-metrics awareness) —
// good enough for a fallback label, not a typesetting engine.
func wordWrap(s string, width int) []string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return []string{""}
	}
	lines := make([]string, 0, 4)
	cur := words[0]
	for _, w := range words[1:] {
		if len(cur)+1+len(w) <= width {
			cur += " " + w
			continue
		}
		lines = append(lines, cur)
		cur = w
	}
	lines = append(lines, cur)
	if len(lines) > maxLine {
		lines = lines[:maxLine]
	}
	return lines
}

// initials returns up to two uppercase initials from producer, for use in
// the ring/medallion/shield crests. Falls back to "?" for an empty name.
func initials(producer string) string {
	var out []rune
	for _, f := range strings.Fields(producer) {
		r := []rune(f)
		if len(r) == 0 {
			continue
		}
		out = append(out, unicode.ToUpper(r[0]))
		if len(out) == 2 {
			break
		}
	}
	if len(out) == 0 {
		return "?"
	}
	return string(out)
}

// nameLine is one wrapped, XML-escaped line of the wine name, positioned
// in the label's local coordinate space (origin at labelX,labelY).
type nameLine struct {
	Text string
	Y    int
}

// viewModel is what the SVG template renders. All wine-derived strings
// arrive pre-escaped; FrameSVG/CrestSVG are trusted static geometry
// (numbers and hex colors only, picked from the taxonomy — never wine
// data) and are inserted verbatim.
type viewModel struct {
	AriaLabel   string
	Pal         palette
	FrameSVG    string
	CrestSVG    string
	Producer    string
	EyebrowY    int
	NameLines   []nameLine
	Appellation string
	ApY         int
	Vintage     string
	VintageY    int
	DividerTopY int
	DividerBotY int
	Footer      string
	HasFooter   bool
	FooterY     int
	LabelX      int
	LabelY      int
	LabelW      int
	LabelH      int
	CanvasW     int
	CanvasH     int
}

// Generate renders a complete standalone château-style bottle SVG for w.
// It always succeeds (no external calls, no fallible parsing) and is
// deterministic: the same WineRaw byte-for-byte reproduces the same SVG,
// while a different SKU picks a different frame/crest/palette combination.
// The label always carries the wine's own producer/name/appellation/
// vintage — never FineVines' branding (spec §5).
func Generate(w salesforce.WineRaw) []byte {
	seed := fnv64(w.SKU)
	frame := frames[seed%uint64(len(frames))]
	crest := crests[(seed/5)%uint64(len(crests))]
	pal := palettes[(seed/25)%uint64(len(palettes))]

	appellation := w.Appellation
	if appellation == "" {
		appellation = w.Region
	}

	rawLines := wordWrap(w.Name, 22)
	const nameStartY = 92
	const nameLineHeight = 20
	lines := make([]nameLine, len(rawLines))
	for i, l := range rawLines {
		lines[i] = nameLine{Text: xmlEscape(l), Y: nameStartY + i*nameLineHeight}
	}
	nameEndY := nameStartY + (len(lines)-1)*nameLineHeight

	dividerTopY := nameEndY + 26
	apY := dividerTopY + 22
	vintageY := apY + 50
	dividerBotY := vintageY + 22
	footerY := dividerBotY + 20

	labelH := footerY + 18
	if labelH < minH {
		labelH = minH
	}

	vm := viewModel{
		AriaLabel:   xmlEscape(fmt.Sprintf("%s — %s", w.Producer, w.Name)),
		Pal:         pal,
		FrameSVG:    frameSVG(frame, labelW, labelH, pal),
		CrestSVG:    crestSVG(crest, labelW/2, 58, xmlEscape(initials(w.Producer)), pal),
		Producer:    xmlEscape(strings.ToUpper(w.Producer)),
		EyebrowY:    26,
		NameLines:   lines,
		Appellation: xmlEscape(strings.ToUpper(appellation)),
		ApY:         apY,
		Vintage:     xmlEscape(w.Vintage),
		VintageY:    vintageY,
		DividerTopY: dividerTopY,
		DividerBotY: dividerBotY,
		Footer:      xmlEscape(strings.ToUpper(w.Style)),
		HasFooter:   w.Style != "",
		FooterY:     footerY,
		LabelX:      labelX,
		LabelY:      labelY,
		LabelW:      labelW,
		LabelH:      labelH,
		CanvasW:     canvasW,
		CanvasH:     canvasH,
	}

	var buf bytes.Buffer
	if err := svgTemplate.Execute(&buf, vm); err != nil {
		// The template is a fixed constant and vm's fields are all simple
		// scalars/slices — execution cannot fail at runtime.
		panic(fmt.Sprintf("label: template execute: %v", err))
	}
	return buf.Bytes()
}

// frameSVG returns the border ornament for one frame variant, drawn in the
// label's local 0,0..w,h coordinate space. Geometry only — no wine data,
// so no escaping is needed.
func frameSVG(variant string, w, h int, pal palette) string {
	switch variant {
	case "double":
		return fmt.Sprintf(
			`<rect x="7" y="7" width="%d" height="%d" fill="none" stroke="%s" stroke-width="1.4"/>`+
				`<rect x="13" y="13" width="%d" height="%d" fill="none" stroke="%s" stroke-width="0.7"/>`+
				`<rect x="3.5" y="3.5" width="7" height="7" fill="%s" transform="rotate(45 7 7)"/>`+
				`<rect x="%d.5" y="3.5" width="7" height="7" fill="%s" transform="rotate(45 %d 7)"/>`+
				`<rect x="3.5" y="%d.5" width="7" height="7" fill="%s" transform="rotate(45 7 %d)"/>`+
				`<rect x="%d.5" y="%d.5" width="7" height="7" fill="%s" transform="rotate(45 %d %d)"/>`,
			w-14, h-14, pal.Ink,
			w-26, h-26, pal.Accent,
			pal.Accent,
			w-7, pal.Accent, w-7,
			h-7, pal.Accent, h-7,
			w-7, h-7, pal.Accent, w-7, h-7,
		)
	case "oval":
		// Two-tone like the proposal's rosé/champagne variants: a quiet
		// ink-colored outer rule with a brighter accent ellipse inset.
		return fmt.Sprintf(
			`<rect x="6" y="6" width="%d" height="%d" fill="none" stroke="%s" stroke-width="0.6"/>`+
				`<ellipse cx="%d" cy="%d" rx="%d" ry="%d" fill="none" stroke="%s" stroke-width="1.1"/>`,
			w-12, h-12, pal.Ink,
			w/2, h/2, w/2-9, h/2-9, pal.Accent,
		)
	case "deco":
		// Corner marks in the brass accent, center rules in the ink tone —
		// the gold/ivory pairing the art-deco proposal variant used.
		return fmt.Sprintf(
			`<rect x="6" y="6" width="%d" height="%d" fill="none" stroke="%s" stroke-width="1.1"/>`+
				`<rect x="6" y="6" width="10" height="10" fill="%s"/>`+
				`<rect x="%d" y="6" width="10" height="10" fill="%s"/>`+
				`<rect x="6" y="%d" width="10" height="10" fill="%s"/>`+
				`<rect x="%d" y="%d" width="10" height="10" fill="%s"/>`+
				`<line x1="%d" y1="6" x2="%d" y2="6" stroke="%s" stroke-width="3"/>`+
				`<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="3"/>`,
			w-12, h-12, pal.Ink,
			pal.Accent,
			w-16, pal.Accent,
			h-16, pal.Accent,
			w-16, h-16, pal.Accent,
			w/2-16, w/2+16, pal.Ink,
			w/2-16, h, w/2+16, h, pal.Ink,
		)
	case "minimal":
		return fmt.Sprintf(
			`<line x1="30" y1="16" x2="%d" y2="16" stroke="%s" stroke-width="1"/>`+
				`<line x1="30" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="1"/>`,
			w-30, pal.Ink,
			h-16, w-30, h-16, pal.Ink,
		)
	default: // "single"
		return fmt.Sprintf(
			`<rect x="8" y="8" width="%d" height="%d" fill="none" stroke="%s" stroke-width="1.1"/>`,
			w-16, h-16, pal.Ink,
		)
	}
}

// crestSVG returns the ornament above the producer eyebrow for one crest
// variant, centered at (cx,cy). monogram is already XML-escaped.
func crestSVG(variant string, cx, cy int, monogram string, pal palette) string {
	switch variant {
	case "medallion":
		return fmt.Sprintf(
			`<circle cx="%d" cy="%d" r="16" fill="%s"/>`+
				`<circle cx="%d" cy="%d" r="13" fill="none" stroke="%s" stroke-width="0.6" opacity="0.6"/>`+
				`<text x="%d" y="%d" text-anchor="middle" font-family="'Cormorant Garamond',Georgia,serif" font-size="15" font-weight="600" font-style="italic" fill="%s">%s</text>`,
			cx, cy, pal.Accent,
			cx, cy, pal.Bg,
			cx, cy+5, pal.Bg, monogram,
		)
	case "shield":
		x0, x1 := cx-18, cx+18
		top, mid, bot := cy-16, cy+2, cy+22
		return fmt.Sprintf(
			`<path d="M%d %d L%d %d L%d %d Q%d %d %d %d Q%d %d %d %d Z" fill="none" stroke="%s" stroke-width="1.1"/>`+
				`<text x="%d" y="%d" text-anchor="middle" font-family="'Cormorant Garamond',Georgia,serif" font-size="14" font-weight="600" font-style="italic" fill="%s">%s</text>`,
			x0, top, x1, top, x1, mid, x1, bot, cx, bot, x0, bot, x0, mid, pal.Accent,
			cx, cy+6, pal.Ink, monogram,
		)
	case "fleuron":
		return fmt.Sprintf(
			`<g fill="none" stroke="%s" stroke-width="1">`+
				`<path d="M%d %d C %d %d, %d %d, %d %d"/>`+
				`<path d="M%d %d C %d %d, %d %d, %d %d"/>`+
				`</g>`+
				`<circle cx="%d" cy="%d" r="2.2" fill="%s"/>`+
				`<circle cx="%d" cy="%d" r="1.5" fill="%s"/>`+
				`<circle cx="%d" cy="%d" r="1.5" fill="%s"/>`,
			pal.Accent,
			cx, cy, cx-14, cy-9, cx-22, cy+5, cx-30, cy,
			cx, cy, cx+14, cy-9, cx+22, cy+5, cx+30, cy,
			cx, cy, pal.Accent,
			cx-30, cy, pal.Accent,
			cx+30, cy, pal.Accent,
		)
	case "fan":
		var rays strings.Builder
		for i := -3; i <= 3; i++ {
			x := cx + i*7
			fmt.Fprintf(&rays, `<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="0.8"/>`,
				cx, cy+14, x, cy-14, pal.Accent)
		}
		return fmt.Sprintf(`<g>%s</g><circle cx="%d" cy="%d" r="2" fill="%s"/>`, rays.String(), cx, cy+14, pal.Accent)
	default: // "ring"
		return fmt.Sprintf(
			`<circle cx="%d" cy="%d" r="17" fill="none" stroke="%s" stroke-width="1.1"/>`+
				`<circle cx="%d" cy="%d" r="13.5" fill="none" stroke="%s" stroke-width="0.5"/>`+
				`<text x="%d" y="%d" text-anchor="middle" font-family="'Cormorant Garamond',Georgia,serif" font-size="16" font-weight="600" font-style="italic" fill="%s">%s</text>`,
			cx, cy, pal.Accent,
			cx, cy, pal.Ink,
			cx, cy+5, pal.Ink, monogram,
		)
	}
}

// svgTemplate assembles the final document. text/template is used (not
// html/template, which would mangle SVG); every {{.Field}} that carries
// wine-derived text is pre-escaped by the caller before Execute.
var svgTemplate = template.Must(template.New("label").Parse(`<svg viewBox="0 0 {{.CanvasW}} {{.CanvasH}}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{{.AriaLabel}}">
<defs>
<linearGradient id="glass" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#0a140d"/>
<stop offset="0.5" stop-color="#1d3527"/>
<stop offset="1" stop-color="#08110b"/>
</linearGradient>
</defs>
<path d="M220 30 L260 30 L260 130 C260 152 324 158 324 195 L324 655 Q324 690 289 690 L191 690 Q156 690 156 655 L156 195 C156 158 220 152 220 130 Z" fill="url(#glass)" stroke="#050a07" stroke-width="1"/>
<path d="M220 30 L260 30 L260 68 L220 68 Z" fill="{{.Pal.Accent}}"/>
<line x1="220" y1="76" x2="260" y2="76" stroke="#050a07" stroke-width="0.8" opacity="0.5"/>
<g transform="translate({{.LabelX}},{{.LabelY}})">
<rect width="{{.LabelW}}" height="{{.LabelH}}" fill="{{.Pal.Bg}}"/>
{{.FrameSVG}}
<text x="100" y="{{.EyebrowY}}" text-anchor="middle" font-family="'Archivo','Inter',system-ui,sans-serif" font-size="8" font-weight="600" letter-spacing="2.5" fill="{{.Pal.Accent}}">{{.Producer}}</text>
{{.CrestSVG}}
{{range .NameLines}}<text x="100" y="{{.Y}}" text-anchor="middle" font-family="'Cormorant Garamond',Georgia,serif" font-size="15" font-weight="600" letter-spacing="1" fill="{{$.Pal.Ink}}">{{.Text}}</text>
{{end}}<g stroke="{{.Pal.Accent}}" stroke-width="0.8"><line x1="70" y1="{{.DividerTopY}}" x2="88" y2="{{.DividerTopY}}"/><line x1="112" y1="{{.DividerTopY}}" x2="130" y2="{{.DividerTopY}}"/></g>
<rect x="96.5" y="{{.DividerTopY}}" width="7" height="7" fill="{{.Pal.Accent}}" transform="translate(-3.5,-3.5) rotate(45 100 {{.DividerTopY}})"/>
<text x="100" y="{{.ApY}}" text-anchor="middle" font-family="'Cormorant Garamond',Georgia,serif" font-style="italic" font-size="10.5" letter-spacing="0.8" fill="{{.Pal.Muted}}">{{.Appellation}}</text>
<text x="100" y="{{.VintageY}}" text-anchor="middle" font-family="'Cormorant Garamond',Georgia,serif" font-size="30" font-weight="600" letter-spacing="1.5" fill="{{.Pal.Ink}}">{{.Vintage}}</text>
<g stroke="{{.Pal.Accent}}" stroke-width="0.8"><line x1="76" y1="{{.DividerBotY}}" x2="94" y2="{{.DividerBotY}}"/><line x1="106" y1="{{.DividerBotY}}" x2="124" y2="{{.DividerBotY}}"/></g>
<rect x="96.5" y="{{.DividerBotY}}" width="7" height="7" fill="{{.Pal.Accent}}" transform="translate(-3.5,-3.5) rotate(45 100 {{.DividerBotY}})"/>
{{if .HasFooter}}<text x="100" y="{{.FooterY}}" text-anchor="middle" font-family="'Archivo','Inter',system-ui,sans-serif" font-size="7.5" font-weight="500" letter-spacing="1.6" fill="{{.Pal.Muted}}">{{.Footer}}</text>
{{end}}</g>
</svg>
`))

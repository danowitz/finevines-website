package notify

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"
)

// Message is one rendered digest. Both bodies are always produced: they go out
// as a multipart/alternative so the reader's client displays whichever it can,
// and the plain-text version is also what shows in a notification preview.
type Message struct {
	Subject  string
	HTMLBody string
	TextBody string
}

// Render turns a RunDiff into the email.
//
// Voice: elegant and plain, the same register as the site — this lands in the
// founder's inbox, not a developer's. Two standing client rules are enforced by
// test rather than by care (see TestRender_ObeysTheClientCopyRules): the word
// "trade" never appears, and no address of any kind does.
//
// Deterministic by construction — no clock, no map iteration — so the same run
// always renders the same bytes.
func Render(d RunDiff, siteBaseURL string) Message {
	root := strings.TrimRight(siteBaseURL, "/")
	return Message{
		Subject:  subject(d),
		HTMLBody: renderHTML(d, root),
		TextBody: renderText(d, root),
	}
}

// subject names only the categories that have something in them, so a run that
// only imported photographs does not read as a wine-list change.
func subject(d RunDiff) string {
	var parts []string
	add := func(n int, one, many string) {
		switch {
		case n == 1:
			parts = append(parts, "1 "+one)
		case n > 1:
			parts = append(parts, fmt.Sprintf("%d %s", n, many))
		}
	}
	add(len(d.NewWines), "new wine", "new wines")
	add(len(d.Delisted), "delisting", "delistings")
	add(len(d.NewImages), "new photograph", "new photographs")
	add(len(d.TextRefreshed), "rewritten note", "rewritten notes")
	add(len(d.QueueActions), "review fix applied", "review fixes applied")
	if len(parts) == 0 {
		// Unreachable in practice: runNotify checks Changed() first. Kept honest
		// rather than clever, so a future caller that forgets gets a sane line.
		return "FineVines catalog: no changes"
	}
	return "FineVines catalog: " + strings.Join(parts, ", ")
}

// digestTmpl is the HTML body. Deliberately table-free, inline-styled and
// image-optional: it has to survive Outlook, and a reader on a phone must be
// able to tap through to a wine page.
var digestTmpl = template.Must(template.New("digest").Funcs(template.FuncMap{"comma": commaInt}).Parse(`
<div style="font-family:Georgia,'Times New Roman',serif;color:#2b2b2b;max-width:640px">
<p style="font-size:15px;line-height:1.6">Last night's catalog run has finished. Here is what changed on the website, and what is worth a look.</p>
{{if .D.NewWines}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">New wines</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.NewWines}}
<li><a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a> <span style="color:#7a7168">({{.SKU}})</span></li>{{end}}
</ul>
{{end}}
{{if .D.NewImages}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">New bottle photographs</h2>
<p style="font-size:13px;color:#7a7168;line-height:1.6">These published automatically after passing the label check and the watermark sweep. If one shows the wrong bottle, reply and it will be replaced.</p>
{{range .D.NewImages}}
<div style="margin:14px 0">
{{if .ImageURL}}<img src="{{.ImageURL}}" alt="{{.Producer}} {{.Name}}" width="72" style="vertical-align:middle;margin-right:12px;border:1px solid #e4ddd2">{{end}}
<a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a>
{{if .Note}}<div style="font-size:12px;color:#7a7168;margin-top:4px">source: {{.Note}}</div>{{end}}
</div>{{end}}
{{end}}
{{if .D.TextRefreshed}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">Rewritten tasting notes</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.TextRefreshed}}
<li><a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a></li>{{end}}
</ul>
{{end}}
{{if .D.Delisted}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">No longer offered</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.Delisted}}
<li><a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a> <span style="color:#7a7168">— {{.Note}}</span></li>{{end}}
</ul>
{{end}}
{{if .D.QueueActions}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">Corrections applied</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.QueueActions}}
<li>{{.SKU}} — {{.Outcome}} <span style="color:#7a7168">(requested by {{.Reviewer}})</span></li>{{end}}
</ul>
{{end}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">The portfolio today</h2>
<p style="font-size:15px;line-height:1.7">{{comma .D.Coverage.Wines}} wines published. {{comma .D.Coverage.RealImages}} of them ({{.D.Coverage.RealImagePct}}%) show a real bottle photograph; the rest show a printed label until a photograph is found. Descriptive detail — grape, region, and tasting notes — is sourced automatically and deepens with every run.</p>
<p style="font-size:13px;color:#7a7168;line-height:1.6">Sent automatically after a catalog run that changed something. <a href="{{.Root}}/portfolio/" style="color:#6b1f2a">Browse the portfolio</a></p>
</div>
`))

func renderHTML(d RunDiff, root string) string {
	var buf bytes.Buffer
	// The template is a compile-time constant and the data is plain strings, so
	// Execute cannot fail for any reason a caller could act on.
	_ = digestTmpl.Execute(&buf, struct {
		D    RunDiff
		Root string
	}{D: d, Root: root})
	return buf.String()
}

func commaInt(n int) string {
	s := fmt.Sprintf("%d", n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// renderText is the plain-text alternative. Written by hand rather than stripped
// from the HTML: a reader on a text-only client should get something composed,
// not something salvaged.
func renderText(d RunDiff, root string) string {
	var b strings.Builder
	b.WriteString("Last night's catalog run has finished. Here is what changed on the website.\n")

	list := func(heading string, refs []WineRef, withNote bool) {
		if len(refs) == 0 {
			return
		}
		fmt.Fprintf(&b, "\n%s\n%s\n", heading, strings.Repeat("-", len(heading)))
		for _, r := range refs {
			fmt.Fprintf(&b, "  %s, %s", r.Producer, r.Name)
			if r.Vintage != "" {
				fmt.Fprintf(&b, " %s", r.Vintage)
			}
			fmt.Fprintf(&b, " (%s)\n    %s\n", r.SKU, r.URL)
			if withNote && r.Note != "" {
				fmt.Fprintf(&b, "    %s\n", r.Note)
			}
		}
	}
	list("NEW WINES", d.NewWines, false)
	list("NEW BOTTLE PHOTOGRAPHS", d.NewImages, true)
	list("REWRITTEN TASTING NOTES", d.TextRefreshed, false)
	list("NO LONGER OFFERED", d.Delisted, true)

	if len(d.QueueActions) > 0 {
		b.WriteString("\nCORRECTIONS APPLIED\n-------------------\n")
		for _, a := range d.QueueActions {
			fmt.Fprintf(&b, "  %s — %s (requested by %s)\n", a.SKU, a.Outcome, a.Reviewer)
		}
	}

	fmt.Fprintf(&b, "\nTHE PORTFOLIO TODAY\n-------------------\n"+
		"  %s wines published.\n"+
		"  %s of them (%d%%) show a real bottle photograph; the rest show a printed label.\n"+
		"  Descriptive detail — grape, region, and tasting notes — is sourced automatically and deepens with every run.\n",
		commaInt(d.Coverage.Wines), commaInt(d.Coverage.RealImages), d.Coverage.RealImagePct)
	fmt.Fprintf(&b, "\nSent automatically after a catalog run that changed something.\n%s/portfolio/\n", root)
	return b.String()
}

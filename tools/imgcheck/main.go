// Command imgcheck decides whether a candidate photograph may be used for a
// given wine, in two stages and in this order:
//
//  1. Is it ONE bottle on a clean background? Cheap, local, no OCR.
//  2. Does the label actually say what this wine is called?
//
// Order matters. Stage 1 is arithmetic over pixels and discards gift sets,
// cartons and lifestyle shots for nothing; stage 2 costs an OCR pass, so it
// only ever runs on images that already look like a product shot.
//
// Stage 2 is the one that catches the failure a page-text check cannot. Search
// engines rank by relevance and substitute silently: asking for FX Pichler's
// Kellerberg returns Max Ferd. Richter Mosels, and the listing text around
// them is perfectly consistent — it is genuinely a Richter listing. Only the
// bottle's own label settles whether the picture is the wine.
//
//	go run ./tools/imgcheck -img bottle.png -name "Domaine Anne Gros Clos Vougeot 2022"
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gritautomation/finevines-website/internal/imgcheck"
)

func main() {
	imgPath := flag.String("img", "", "candidate image (required)")
	name := flag.String("name", "", "the wine's name, as the catalog has it (required)")
	keep := flag.Bool("keep-crop", false, "keep the cropped label band for inspection")
	asJSON := flag.Bool("json", false, "emit a machine-readable verdict on stdout")
	indexPath := flag.String("index", "data/token-index.json", "token index from tools/tokenindex")
	// -label supplies label text read elsewhere (a vision model) and skips the
	// local OCR. The identity rules stay here either way, so both paths are
	// judged by one tested implementation rather than two.
	givenLabel := flag.String("label", "", "label text already read; skips local OCR")
	// A caller that has independently established this is one bottle — a vision
	// model reporting single_bottle — may say so. The local shape check is a
	// heuristic over pixels and refuses gradients and unusual sweeps; without
	// this flag it re-refuses everything the caller was trying to recover, and
	// the second opinion can never be heard.
	givenSingle := flag.Bool("single-bottle", false, "caller confirms one bottle; skips the local shape gate")
	producer := flag.String("producer", "", "the wine's producer; when given, only its words are required")
	flag.Parse()
	if *imgPath == "" || *name == "" {
		fmt.Fprintln(os.Stderr, "need -img and -name")
		os.Exit(2)
	}

	img, err := load(*imgPath)
	if err != nil {
		// An undecodable candidate is a rejection, not a crash. Retailers serve
		// AVIF, SVG and the occasional truncated file, and a pipeline driving
		// thousands of these needs a verdict it can record — not a dead
		// subprocess it has to special-case.
		emit(verdict{Stage: "decode", Reason: "cannot decode image: " + err.Error()}, *asJSON)
		os.Exit(1)
	}

	// --- stage 1 -------------------------------------------------------------
	rep := imgcheck.Analyze(img, imgcheck.Defaults())
	out := verdict{
		Subjects: rep.Subjects, Slimness: rep.Slimness,
		Fill: rep.Fill, CleanBackground: rep.CleanBackground,
	}
	if !*asJSON {
		fmt.Printf("shape     subjects=%d slim=%.2f fill=%.2f cleanBg=%v\n",
			rep.Subjects, rep.Slimness, rep.Fill, rep.CleanBackground)
	}
	if !rep.SingleBottle && !*givenSingle {
		out.Stage, out.Reason = "shape", rep.Reason
		emit(out, *asJSON)
		os.Exit(1)
	}

	// --- stage 2 -------------------------------------------------------------
	// Crop to the label band before reading. The capsule carries foil lettering
	// (often the producer's initials) and the punt catches background print;
	// both add words that are not the label's.
	box := rep.Box
	if box.Empty() {
		box = img.Bounds()
	}
	band := imgcheck.LabelBand(box)

	// Read the band at MORE THAN ONE SCALE and pool the words.
	//
	// Upscaling helps small crops: a 263px-wide band read as "CLOS-VOUC,EOT
	// DOMAINE GROS" at native size and "CLOS-VOUGEOT ... ANNE" enlarged, which
	// is the difference between rejecting and accepting a correct wine. But it
	// is not uniformly better — the same change broke a Lafarge that had
	// matched at native size. Resampling shifts which glyphs survive rather
	// than improving all of them.
	//
	// Since a word only has to be found ONCE to count, the scales need not
	// agree. Pooling both passes takes each one's successes without inheriting
	// its failures, and OCR here is local and fast enough that a second read
	// costs little.
	scales := []int{1}
	if band.Dx() < 500 {
		scales = append(scales, 3)
	}
	var texts []string
	if *givenLabel != "" {
		texts = append(texts, *givenLabel)
		scales = nil
	}
	for _, scale := range scales {
		crop := image.NewRGBA(image.Rect(0, 0, band.Dx()*scale, band.Dy()*scale))
		for y := 0; y < crop.Bounds().Dy(); y++ {
			for x := 0; x < crop.Bounds().Dx(); x++ {
				crop.Set(x, y, img.At(band.Min.X+x/scale, band.Min.Y+y/scale))
			}
		}
		tmp := filepath.Join(os.TempDir(), fmt.Sprintf("imgcheck-band-%d.png", scale))
		f, err := os.Create(tmp)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := png.Encode(f, crop); err != nil {
			f.Close()
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		f.Close()
		if !*keep {
			defer os.Remove(tmp)
		}
		t, err := ocr(tmp)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ocr: %v\n", err)
			os.Exit(1)
		}
		texts = append(texts, t)
	}
	text := strings.Join(texts, " ")
	out.Label = strings.Join(strings.Fields(text), " ")
	if !*asJSON {
		fmt.Printf("label     %q\n", truncate(out.Label, 90))
	}

	// A source watermark is not a wine word — and republishing another
	// company's branded image is its own problem, so surface it explicitly
	// rather than letting it quietly pass as unmatched noise.
	// Read from a strip along the FRAME's bottom edge, not the label band —
	// cropping to the label deliberately excludes exactly the region a source
	// brand occupies, so checking `text` here would never find one.
	if wm := watermarkOf(img); wm != "" {
		out.Watermark = wm
		if !*asJSON {
			fmt.Printf("WARNING   image carries a %q watermark\n", wm)
		}
	}

	m := matchWithProducer(*name, *producer, text, LoadIndex(*indexPath))
	out.Want, out.Found, out.Missing = m.identifying, m.found, m.missing
	out.Stage = "label"
	if !*asJSON {
		fmt.Printf("match     %d/%d identifying words found: %v", len(m.found), len(m.identifying), m.found)
		if len(m.missing) > 0 {
			fmt.Printf("   MISSING: %v", m.missing)
		}
		fmt.Println()
	}
	if m.ok {
		out.Accept = true
		emit(out, *asJSON)
		return
	}
	out.Reason = "the label does not name this wine"
	emit(out, *asJSON)
	os.Exit(1)
}

// verdict is the machine-readable result. The pipeline driving this is
// JavaScript (it owns the browser); the image analysis is Go. JSON is the seam.
type verdict struct {
	Accept          bool     `json:"accept"`
	Stage           string   `json:"stage"` // where it stopped: shape | label
	Reason          string   `json:"reason,omitempty"`
	Subjects        int      `json:"subjects"`
	Slimness        float64  `json:"slimness"`
	Fill            float64  `json:"fill"`
	CleanBackground bool     `json:"cleanBackground"`
	Label           string   `json:"label,omitempty"`
	Want            []string `json:"want,omitempty"`
	Found           []string `json:"found,omitempty"`
	Missing         []string `json:"missing,omitempty"`
	Watermark       string   `json:"watermark,omitempty"`
}

func emit(v verdict, asJSON bool) {
	if asJSON {
		b, _ := json.Marshal(v)
		fmt.Println(string(b))
		return
	}
	if v.Accept {
		fmt.Println("VERDICT   accept")
		return
	}
	fmt.Printf("VERDICT   reject — %s\n", v.Reason)
}

func load(p string) (image.Image, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

// ocr shells out to the Windows OCR engine (see ocr.ps1) — local, free, and
// needs no key, which matters across thousands of candidates.
func ocr(path string) (string, error) {
	script := filepath.Join("tools", "imgcheck", "ocr.ps1")
	out, err := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-File", script, "-Path", path, "-Json").Output()
	if err != nil {
		return "", err
	}
	var r struct {
		Text  string   `json:"text"`
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(out, &r); err != nil {
		return string(out), nil // fall back to the raw text form
	}
	return r.Text, nil
}

// watermarkOf reads the bottom eighth of the frame and looks for a known
// source brand there.
func watermarkOf(img image.Image) string {
	b := img.Bounds()
	strip := image.Rect(b.Min.X, b.Max.Y-b.Dy()/8, b.Max.X, b.Max.Y)
	c := image.NewRGBA(image.Rect(0, 0, strip.Dx(), strip.Dy()))
	for y := 0; y < strip.Dy(); y++ {
		for x := 0; x < strip.Dx(); x++ {
			c.Set(x, y, img.At(strip.Min.X+x, strip.Min.Y+y))
		}
	}
	p := filepath.Join(os.TempDir(), "imgcheck-wm.png")
	f, err := os.Create(p)
	if err != nil {
		return ""
	}
	if err := png.Encode(f, c); err != nil {
		f.Close()
		return ""
	}
	f.Close()
	defer os.Remove(p)
	txt, err := ocr(p)
	if err != nil {
		return ""
	}
	return watermark(txt)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

var watermarks = []string{"vivino", "wine-searcher", "winesearcher", "getty", "alamy", "shutterstock"}

// watermark looks for a known source brand in OCR output. It is a BACKSTOP,
// not the primary check — see WatermarkedHost.
//
// Reading a watermark is the hardest OCR in the frame: it is small,
// semi-transparent and laid over the glass. Vivino's mark came back as "vvlno"
// and "vlvlno" from real images, and neither survives the structural test that
// makes producer matching trustworthy — "vivino"/"vlvlno" keeps an intact run
// of two characters, where five is required. Loosening the rule far enough to
// catch them also matches "vino", which appears on most Italian labels, so
// every Chianti in the catalog would be discarded as branded.
//
// A clean read is still worth catching, so the literal check stays.
func watermark(text string) string {
	l := strings.ToLower(text)
	for _, w := range watermarks {
		if strings.Contains(l, w) {
			return w
		}
	}
	return ""
}

// WatermarkedHost reports whether images served by host are known to carry a
// source watermark.
//
// This is the reliable check, and it needs no pixels: we know where the file
// was downloaded from. Provenance is not damaged by JPEG artefacts, does not
// depend on the mark being legible, and cannot be confused by a word on the
// label. OCR only ever gets a look at a mark it may or may not be able to read;
// the host is certain.
func WatermarkedHost(host string) string {
	h := strings.ToLower(host)
	for _, w := range watermarks {
		if strings.Contains(h, w) {
			return w
		}
	}
	return ""
}

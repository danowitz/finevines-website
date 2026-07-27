package enrich

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png" // register PNG decoding for downloaded bottle shots
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/label"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// imageHTTPClient fetches candidate bottle images (old-site + found URLs). A
// package var, not threaded through every signature, so tests can point it at
// an httptest.Server.
var imageHTTPClient = &http.Client{Timeout: 30 * time.Second}

// maxImageBytes caps a downloaded image so a mislinked huge file can't blow up
// memory; real bottle shots are well under this.
const maxImageBytes = 12 << 20 // 12 MiB

// downloadImage fetches url, validates it is a real image, and returns it
// re-encoded as JPEG (compositing any transparency onto white, so PNG bottle
// shots don't get a black background). It errors — rather than saving junk —
// on a non-image, an undecodable body, an HTTP error, or an oversize file, so
// the caller cleanly falls through to the next rung of the image chain.
func downloadImage(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (FineVines catalog image fetch)")
	resp, err := imageHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download image %s: HTTP %d", url, resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "image/") {
		return nil, fmt.Errorf("download image %s: not an image (%s)", url, ct)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
	if err != nil {
		return nil, fmt.Errorf("download image %s: %w", url, err)
	}
	if len(raw) > maxImageBytes {
		return nil, fmt.Errorf("download image %s: exceeds %d bytes", url, maxImageBytes)
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("download image %s: decode: %w", url, err)
	}
	b := img.Bounds()
	rgba := image.NewRGBA(b)
	draw.Draw(rgba, b, image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(rgba, b, img, b.Min, draw.Over)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, rgba, &jpeg.Options{Quality: 85}); err != nil {
		return nil, fmt.Errorf("download image %s: encode: %w", url, err)
	}
	return buf.Bytes(), nil
}

// LoadOldSiteImages reads the old-site match manifest (tools/oldimages output)
// into a SKU->image-URL map. A missing file is not an error — it just means no
// old-site rung is available.
func LoadOldSiteImages(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var entries []struct {
		SKU      string `json:"sku"`
		ImageURL string `json:"imageUrl"`
	}
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("load old-site images %s: %w", path, err)
	}
	m := make(map[string]string, len(entries))
	for _, e := range entries {
		if e.ImageURL != "" {
			m[e.SKU] = e.ImageURL
		}
	}
	return m, nil
}

// imageCandidate picks the best real-image URL for a wine and the ImageSource
// to record if it downloads: FineVines' own old-site photo first (best, zero
// copyright), then a found web image. Empty means no real candidate — resolve
// via generation/label.
func imageCandidate(sku, foundURL string, oldImages map[string]string) (url, source string) {
	if u := oldImages[sku]; u != "" {
		return u, model.ImageOldSite
	}
	if foundURL != "" {
		return foundURL, model.ImageScrapedWeb
	}
	return "", ""
}

// ResolveImage resolves the bottle image for one wine via a first-success-
// wins chain (design spec §5):
//
//  1. Producer-supplied guard: if prev already carries a producer-supplied
//     image, it is returned untouched and provider is never invoked — enrich
//     must never overwrite an image the producer gave FineVines directly.
//  2. Generated photo: provider.GenerateJPEG renders a photorealistic bottle
//     photo, written to <imgDir>/<slug>.jpg (source model.ImageGeneratedPhoto).
//  3. Label floor: ANY provider error — the ErrImageRejected sentinel or an
//     ordinary transport/network error — falls back to the deterministic
//     label.Generate SVG, written to <imgDir>/<slug>.svg (source
//     model.ImageGeneratedLabel). label.Generate never fails, so this step is
//     the guaranteed floor: a run must never die mid-catalog because one
//     generation call was flaky or content-rejected. A warning is emitted via
//     log so an operator can see the fallback rate across a run.
//
// ResolveImage returns a non-nil error only for filesystem failures
// (MkdirAll/WriteFile/Remove) — image-generation failures are handled by
// falling back, never propagated as an error.
//
// Files are named by the wine's SEO slug (producer-wine-vintage), matching its
// page URL. Whichever branch writes a file also deletes the sibling extension
// for that slug (<slug>.svg when a .jpg is written, and vice versa), so a wine
// that flips photo<->label between runs never leaves a stale file behind next
// to the new one.
//
// The returned imagePath is always forward-slash form with no leading slash
// (e.g. "assets/img/wines/hubert-lamy-puligny-montrachet-2019.jpg"), regardless of host OS path
// separators — the site-relative form templates/wine.html.tmpl and
// portfolio.html.tmpl prepend "/" to, and build.go's search-index "img"
// field builds the same way.
func ResolveImage(ctx context.Context, provider ImageProvider, w salesforce.WineRaw, prompt, imgDir string, prev *model.Wine, log func(string, ...any)) (imagePath, imageSource string, err error) {
	if prev != nil && prev.ImageSource == model.ImageProducerSupplied {
		return prev.ImagePath, prev.ImageSource, nil
	}

	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		return "", "", fmt.Errorf("resolve image: mkdir %s: %w", imgDir, err)
	}

	// Image files are named by the wine's SEO slug (producer-wine-vintage),
	// the same string as its page URL /wines/<slug>/ — descriptive, keyword-
	// rich filenames are what image search ranks on, far better than an opaque
	// SKU. The slug is deterministic, so re-running enrich reuses the same name.
	base := model.Slugify(w.Producer, w.Name, w.Vintage)

	if data, genErr := provider.GenerateJPEG(ctx, prompt); genErr == nil {
		p, err := writeImageFile(imgDir, base, "jpg", "svg", data)
		if err != nil {
			return "", "", err
		}
		return p, model.ImageGeneratedPhoto, nil
	} else if log != nil {
		log("image generation failed for SKU %s, falling back to label: %v", w.SKU, genErr)
	}

	p, err := writeImageFile(imgDir, base, "svg", "jpg", label.Generate(w))
	if err != nil {
		return "", "", err
	}
	return p, model.ImageGeneratedLabel, nil
}

// writeImageFile writes data to <imgDir>/<base>.<ext> and removes the sibling
// <imgDir>/<base>.<siblingExt> if present (a no-op, not an error, if that
// file doesn't exist). base is the wine's SEO slug. It returns the forward-
// slash, no-leading-slash site-relative path for the written file.
func writeImageFile(imgDir, base, ext, siblingExt string, data []byte) (string, error) {
	diskPath := filepath.Join(imgDir, base+"."+ext)
	if err := os.WriteFile(diskPath, data, 0o644); err != nil {
		return "", fmt.Errorf("resolve image: write %s: %w", diskPath, err)
	}

	sibling := filepath.Join(imgDir, base+"."+siblingExt)
	if err := os.Remove(sibling); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("resolve image: remove stale %s: %w", sibling, err)
	}

	return path.Join(filepath.ToSlash(imgDir), base+"."+ext), nil
}

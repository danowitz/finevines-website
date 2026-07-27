package enrich

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"

	"github.com/gritautomation/finevines-website/internal/label"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

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

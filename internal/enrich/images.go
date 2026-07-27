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
//  2. Imagen photo: provider.GenerateJPEG renders a photorealistic bottle
//     photo, written to <imgDir>/<SKU>.jpg (source model.ImageGeneratedPhoto).
//  3. Label floor: ANY provider error — the ErrImageRejected sentinel or an
//     ordinary transport/network error — falls back to the deterministic
//     label.Generate SVG, written to <imgDir>/<SKU>.svg (source
//     model.ImageGeneratedLabel). label.Generate never fails, so this step is
//     the guaranteed floor: a run must never die mid-catalog because one
//     Imagen call was flaky or content-rejected. A warning is emitted via log
//     so an operator can see the fallback rate across a run.
//
// ResolveImage returns a non-nil error only for filesystem failures
// (MkdirAll/WriteFile/Remove) — image-generation failures are handled by
// falling back, never propagated as an error.
//
// Whichever branch writes a file also deletes the sibling extension for that
// SKU (<SKU>.svg when a .jpg is written, and vice versa), so a wine that
// flips photo<->label between runs never leaves a stale file behind next to
// the new one.
//
// The returned imagePath is always forward-slash form with no leading slash
// (e.g. "assets/img/wines/AB1234.jpg"), regardless of host OS path
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

	if data, genErr := provider.GenerateJPEG(ctx, prompt); genErr == nil {
		p, err := writeImageFile(imgDir, w.SKU, "jpg", "svg", data)
		if err != nil {
			return "", "", err
		}
		return p, model.ImageGeneratedPhoto, nil
	} else if log != nil {
		log("image generation failed for SKU %s, falling back to label: %v", w.SKU, genErr)
	}

	p, err := writeImageFile(imgDir, w.SKU, "svg", "jpg", label.Generate(w))
	if err != nil {
		return "", "", err
	}
	return p, model.ImageGeneratedLabel, nil
}

// writeImageFile writes data to <imgDir>/<sku>.<ext> and removes the sibling
// <imgDir>/<sku>.<siblingExt> if present (a no-op, not an error, if that
// file doesn't exist). It returns the forward-slash, no-leading-slash
// site-relative path for the written file.
func writeImageFile(imgDir, sku, ext, siblingExt string, data []byte) (string, error) {
	diskPath := filepath.Join(imgDir, sku+"."+ext)
	if err := os.WriteFile(diskPath, data, 0o644); err != nil {
		return "", fmt.Errorf("resolve image: write %s: %w", diskPath, err)
	}

	sibling := filepath.Join(imgDir, sku+"."+siblingExt)
	if err := os.Remove(sibling); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("resolve image: remove stale %s: %w", sibling, err)
	}

	return path.Join(filepath.ToSlash(imgDir), sku+"."+ext), nil
}

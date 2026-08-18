package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/gritautomation/finevines-website/internal/label"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// runReviewReset records a review recovery action for one exact public wine.
// Replacing the wrong photograph with the neutral fallback makes discovery
// immediately due; the next package publishes only fresh reviewable candidates.
func runReviewReset(args []string) error {
	return runReviewResetWithRemove(args, os.Remove)
}

func runReviewResetWithRemove(args []string, removeStaged func(string) error) error {
	fs := flag.NewFlagSet("reviewreset", flag.ContinueOnError)
	sku := fs.String("sku", "", "exact catalog SKU to return to image review")
	slug := fs.String("slug", "", "exact catalog slug to return to image review")
	catalogPath := fs.String("catalog", reviewCatalogPath, "catalog JSON path")
	imageDirectory := fs.String("image-dir", "assets/img/wines", "directory containing catalog wine images")
	stagingDirectory := fs.String("staging-dir", ".run/reviewreset", "non-deployable staging directory for recoverable image removal")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("reviewreset: unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if (*sku == "") == (*slug == "") {
		return fmt.Errorf("reviewreset: provide exactly one of -sku or -slug")
	}

	wines, err := model.LoadWines(*catalogPath)
	if err != nil {
		return fmt.Errorf("reviewreset: load catalog: %w", err)
	}
	targetSlug := strings.TrimSpace(*slug)
	if *sku != "" {
		for index := range wines {
			if wines[index].SKU != *sku {
				continue
			}
			if targetSlug != "" && targetSlug != wines[index].Slug {
				return fmt.Errorf("reviewreset: SKU %q identifies more than one public wine", *sku)
			}
			targetSlug = wines[index].Slug
		}
	}
	if targetSlug == "" {
		if *sku != "" {
			return fmt.Errorf("reviewreset: SKU %q was not found", *sku)
		}
		return fmt.Errorf("reviewreset: slug %q was not found", *slug)
	}
	targets := make(map[int]bool)
	representative := -1
	for index := range wines {
		if wines[index].Slug == targetSlug {
			targets[index] = true
			representative = index
		}
	}
	if representative < 0 {
		return fmt.Errorf("reviewreset: slug %q was not found", targetSlug)
	}

	imagesToRemove := make(map[string]string)
	for index := range targets {
		oldImage := strings.TrimSpace(wines[index].ImagePath)
		if oldImage == "" || imagePathUsedOutside(wines, targets, oldImage) {
			continue
		}
		imageToRemove, err := imagePathWithin(oldImage, *imageDirectory)
		if err != nil {
			return fmt.Errorf("reviewreset: refusing unsafe old image path: %w", err)
		}
		imagesToRemove[filepath.Clean(imageToRemove)] = imageToRemove
	}
	fallbackPath := filepath.Join(*imageDirectory, targetSlug+".svg")
	if imagePathUsedOutside(wines, targets, fallbackPath) {
		return fmt.Errorf("reviewreset: neutral fallback path %q is referenced by another public wine", fallbackPath)
	}
	for index := range targets {
		wines[index].ReopenImageReview(filepath.ToSlash(fallbackPath))
	}
	type stagedFile struct{ source, staged string }
	stagedImages := make([]stagedFile, 0, len(imagesToRemove))
	rollbackStaged := func() error {
		for index := len(stagedImages) - 1; index >= 0; index-- {
			if err := os.Rename(stagedImages[index].staged, stagedImages[index].source); err != nil {
				return err
			}
		}
		return nil
	}
	if len(imagesToRemove) > 0 {
		if err := stagingDirectoryOutsideImages(*stagingDirectory, *imageDirectory); err != nil {
			return fmt.Errorf("reviewreset: %w", err)
		}
		if err := os.MkdirAll(*stagingDirectory, 0o755); err != nil {
			return fmt.Errorf("reviewreset: create staging directory: %w", err)
		}
		stagingIndex := 0
		for _, imageToRemove := range imagesToRemove {
			stagedImage := filepath.Join(*stagingDirectory, fmt.Sprintf("%d-%s", stagingIndex, filepath.Base(imageToRemove)))
			stagingIndex++
			if _, err := os.Stat(stagedImage); err == nil {
				_ = rollbackStaged()
				return fmt.Errorf("reviewreset: recover or remove existing staged image %q before retrying", stagedImage)
			} else if !os.IsNotExist(err) {
				_ = rollbackStaged()
				return fmt.Errorf("reviewreset: inspect staged image: %w", err)
			}
			if err := os.Rename(imageToRemove, stagedImage); err != nil {
				if !os.IsNotExist(err) {
					_ = rollbackStaged()
					return fmt.Errorf("reviewreset: stage old image: %w", err)
				}
				continue
			}
			stagedImages = append(stagedImages, stagedFile{source: imageToRemove, staged: stagedImage})
		}
	}
	if err := os.MkdirAll(*imageDirectory, 0o755); err != nil {
		_ = rollbackStaged()
		return fmt.Errorf("reviewreset: create image directory: %w", err)
	}
	fallback := label.Generate(salesforce.WineRaw{
		SKU: wines[representative].SKU, Producer: wines[representative].Producer, Name: wines[representative].Name,
		Vintage: wines[representative].Vintage, Varietal: wines[representative].Varietal, Region: wines[representative].Region,
		Country: wines[representative].Country, Appellation: wines[representative].Appellation, Style: wines[representative].Style,
	})
	if err := os.WriteFile(fallbackPath, fallback, 0o644); err != nil {
		_ = rollbackStaged()
		return fmt.Errorf("reviewreset: write neutral fallback: %w", err)
	}
	if err := model.SaveWines(*catalogPath, wines); err != nil {
		_ = os.Remove(fallbackPath)
		if rollbackErr := rollbackStaged(); rollbackErr != nil {
			return fmt.Errorf("reviewreset: save catalog: %v; restore old image: %w", err, rollbackErr)
		}
		return fmt.Errorf("reviewreset: save catalog: %w", err)
	}

	removed := 0
	for _, stagedImage := range stagedImages {
		if err := removeStaged(stagedImage.staged); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("reviewreset: review recovery is saved and the old images are no longer deployable, but cleanup failed; remove files under %q before retrying: %w", *stagingDirectory, err)
		}
		removed++
	}
	_ = os.Remove(*stagingDirectory)
	log.Printf("reviewreset: review recovery reopened %s (%d catalog row(s)) for fresh human image review; old image files removed=%d", targetSlug, len(targets), removed)
	return nil
}

func stagingDirectoryOutsideImages(stagingDirectory, imageDirectory string) error {
	root, err := filepath.Abs(imageDirectory)
	if err != nil {
		return err
	}
	staging, err := filepath.Abs(stagingDirectory)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(root, staging)
	if err != nil {
		return err
	}
	if relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("staging directory %q must be outside wine-image directory %q", stagingDirectory, imageDirectory)
	}
	return nil
}

func imagePathUsedOutside(wines []model.Wine, targets map[int]bool, imagePath string) bool {
	target, err := filepath.Abs(filepath.FromSlash(imagePath))
	if err != nil {
		return true
	}
	for index, wine := range wines {
		if targets[index] {
			continue
		}
		if strings.TrimSpace(wine.ImagePath) == "" {
			continue
		}
		candidate, err := filepath.Abs(filepath.FromSlash(wine.ImagePath))
		if err == nil && filepath.Clean(candidate) == filepath.Clean(target) {
			return true
		}
	}
	return false
}

func imagePathWithin(imagePath, imageDirectory string) (string, error) {
	root, err := filepath.Abs(imageDirectory)
	if err != nil {
		return "", err
	}
	target, err := filepath.Abs(filepath.FromSlash(imagePath))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return "", err
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("image %q is outside %q", imagePath, imageDirectory)
	}
	return target, nil
}

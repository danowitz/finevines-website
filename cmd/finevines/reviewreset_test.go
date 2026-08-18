package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func TestRunReviewResetClearsOneExactWineAndRemovesItsImage(t *testing.T) {
	root := t.TempDir()
	imageDir := filepath.Join(root, "assets", "img", "wines")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(imageDir, "producer-wrong-wine-2022.jpg")
	if err := os.WriteFile(imagePath, []byte("wrong image"), 0o644); err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(root, "wines.json")
	stagingDir := filepath.Join(root, ".run", "reviewreset")
	wines := []model.Wine{
		{
			SKU: "500740*", Slug: "producer-wrong-wine-2022", Name: "Wrong Wine", ImagePath: filepath.ToSlash(imagePath),
			ImageSource: model.ImageScrapedWeb, ImageSourceURL: "https://wrong.example/image.jpg",
			ImageReviewStatus: model.ImageReviewNoMatch, ImageReviewedAt: "2026-08-10T00:00:00Z", ImageReviewActionID: "00000000-0000-4000-8000-000000000001",
		},
		{SKU: "500741*", Slug: "producer-other-wine-2022", Name: "Other Wine", ImagePath: "assets/img/wines/other.jpg", ImageSource: model.ImageScrapedWeb},
	}
	if err := model.SaveWines(catalogPath, wines); err != nil {
		t.Fatal(err)
	}

	if err := runReviewReset([]string{"-catalog", catalogPath, "-image-dir", imageDir, "-staging-dir", stagingDir, "-sku", "500740*"}); err != nil {
		t.Fatal(err)
	}

	got, err := model.LoadWines(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	bySKU := map[string]model.Wine{}
	for _, wine := range got {
		bySKU[wine.SKU] = wine
	}
	reset := bySKU["500740*"]
	fallbackPath := filepath.Join(imageDir, "producer-wrong-wine-2022.svg")
	if reset.ImagePath != filepath.ToSlash(fallbackPath) || reset.ImageSource != model.ImageGeneratedLabel || reset.ImageSourceURL != "" {
		t.Fatalf("wrong image metadata was not cleared: %+v", reset)
	}
	if reset.ImageReviewStatus != model.ImageReviewRequired || reset.ImageReviewedAt != "" || reset.ImageReviewActionID != "" {
		t.Fatalf("wine was not reopened for a fresh human decision: %+v", reset)
	}
	if !reflect.DeepEqual(bySKU["500741*"], wines[1]) {
		t.Fatalf("unrelated wine changed: got %+v want %+v", bySKU["500741*"], wines[1])
	}
	if _, err := os.Stat(imagePath); !os.IsNotExist(err) {
		t.Fatalf("wrong image still exists or stat failed: %v", err)
	}
	if info, err := os.Stat(fallbackPath); err != nil || info.Size() == 0 {
		t.Fatalf("neutral fallback was not created: info=%v err=%v", info, err)
	}
	if entries, err := os.ReadDir(stagingDir); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	} else if len(entries) != 0 {
		t.Fatalf("successful reset left staged files: %v", entries)
	}
}

func TestRunReviewResetKeepsAnImageStillUsedByAnotherWine(t *testing.T) {
	root := t.TempDir()
	imageDir := filepath.Join(root, "assets", "img", "wines")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(imageDir, "shared.jpg")
	if err := os.WriteFile(imagePath, []byte("shared image"), 0o644); err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(root, "wines.json")
	wines := []model.Wine{
		{SKU: "A", Slug: "wine-a", ImagePath: filepath.ToSlash(imagePath), ImageSource: model.ImageScrapedWeb},
		{SKU: "B", Slug: "wine-b", ImagePath: filepath.ToSlash(imagePath), ImageSource: model.ImageScrapedWeb},
	}
	if err := model.SaveWines(catalogPath, wines); err != nil {
		t.Fatal(err)
	}

	if err := runReviewReset([]string{"-catalog", catalogPath, "-image-dir", imageDir, "-slug", "wine-a"}); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(imagePath); err != nil {
		t.Fatalf("shared image was removed: %v", err)
	}
	got, err := model.LoadWines(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, wine := range got {
		if wine.SKU == "A" && wine.ImagePath != filepath.ToSlash(filepath.Join(imageDir, "wine-a.svg")) {
			t.Fatalf("target wine was not reset: %+v", wine)
		}
		if wine.SKU == "B" && wine.ImagePath != filepath.ToSlash(imagePath) {
			t.Fatalf("other wine lost its shared image: %+v", wine)
		}
	}
}

func TestRunReviewResetReopensEveryCatalogRowForTheExactPublicWine(t *testing.T) {
	root := t.TempDir()
	imageDir := filepath.Join(root, "assets", "img", "wines")
	stagingDir := filepath.Join(root, ".run", "reviewreset")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(imageDir, "wrong.jpg")
	if err := os.WriteFile(imagePath, []byte("wrong image"), 0o644); err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(root, "wines.json")
	wines := []model.Wine{
		{SKU: "A-1", Slug: "same-public-wine", ImagePath: filepath.ToSlash(imagePath), ImageSource: model.ImageScrapedWeb},
		{SKU: "A-2", Slug: "same-public-wine", ImagePath: filepath.ToSlash(imagePath), ImageSource: model.ImageScrapedWeb},
		{SKU: "B", Slug: "other-wine", ImagePath: "assets/img/wines/other.jpg", ImageSource: model.ImageScrapedWeb},
	}
	if err := model.SaveWines(catalogPath, wines); err != nil {
		t.Fatal(err)
	}

	if err := runReviewReset([]string{"-catalog", catalogPath, "-image-dir", imageDir, "-staging-dir", stagingDir, "-sku", "A-1"}); err != nil {
		t.Fatal(err)
	}

	got, err := model.LoadWines(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	fallbackPath := filepath.ToSlash(filepath.Join(imageDir, "same-public-wine.svg"))
	for _, wine := range got {
		if wine.Slug == "same-public-wine" && (wine.ImagePath != fallbackPath || wine.ImageReviewStatus != model.ImageReviewRequired) {
			t.Fatalf("slug sibling was not reopened with the public wine: %+v", wine)
		}
		if wine.Slug == "other-wine" && !reflect.DeepEqual(wine, wines[2]) {
			t.Fatalf("unrelated wine changed: got %+v want %+v", wine, wines[2])
		}
	}
	if _, err := os.Stat(imagePath); !os.IsNotExist(err) {
		t.Fatalf("wrong shared-within-wine image was not removed: %v", err)
	}
}

func TestRunReviewResetLeavesARecoverableNonDeployableFileWhenFinalRemovalFails(t *testing.T) {
	root := t.TempDir()
	imageDir := filepath.Join(root, "assets", "img", "wines")
	stagingDir := filepath.Join(root, ".run", "reviewreset")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(imageDir, "wrong.jpg")
	if err := os.WriteFile(imagePath, []byte("wrong image"), 0o644); err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(root, "wines.json")
	if err := model.SaveWines(catalogPath, []model.Wine{{
		SKU: "A", Slug: "wine-a", ImagePath: filepath.ToSlash(imagePath), ImageSource: model.ImageScrapedWeb,
	}}); err != nil {
		t.Fatal(err)
	}

	err := runReviewResetWithRemove(
		[]string{"-catalog", catalogPath, "-image-dir", imageDir, "-staging-dir", stagingDir, "-sku", "A"},
		func(string) error { return errors.New("simulated cleanup failure") },
	)
	if err == nil {
		t.Fatal("expected staged-file cleanup failure")
	}
	if _, statErr := os.Stat(imagePath); !os.IsNotExist(statErr) {
		t.Fatalf("wrong image remained at its deployable path: %v", statErr)
	}
	stagedPath := filepath.Join(stagingDir, "0-"+filepath.Base(imagePath))
	if _, statErr := os.Stat(stagedPath); statErr != nil {
		t.Fatalf("recoverable staged image is missing: %v", statErr)
	}
	got, loadErr := model.LoadWines(catalogPath)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if len(got) != 1 || got[0].ImagePath != filepath.ToSlash(filepath.Join(imageDir, "wine-a.svg")) || got[0].ImageReviewStatus != model.ImageReviewRequired {
		t.Fatalf("catalog recovery action was not preserved: %+v", got)
	}
}

func TestRunReviewResetRefusesAnImageOutsideTheWineImageDirectoryWithoutChangingCatalog(t *testing.T) {
	root := t.TempDir()
	imageDir := filepath.Join(root, "assets", "img", "wines")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(root, "do-not-remove.jpg")
	if err := os.WriteFile(outsidePath, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(root, "wines.json")
	wine := model.Wine{SKU: "A", Slug: "wine-a", ImagePath: filepath.ToSlash(outsidePath), ImageSource: model.ImageScrapedWeb}
	if err := model.SaveWines(catalogPath, []model.Wine{wine}); err != nil {
		t.Fatal(err)
	}

	err := runReviewReset([]string{"-catalog", catalogPath, "-image-dir", imageDir, "-sku", "A"})
	if err == nil {
		t.Fatal("expected unsafe image path to be refused")
	}
	got, loadErr := model.LoadWines(catalogPath)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if len(got) != 1 || !reflect.DeepEqual(got[0], wine) {
		t.Fatalf("catalog changed after refusal: got %+v want %+v", got, wine)
	}
	if _, statErr := os.Stat(outsidePath); statErr != nil {
		t.Fatalf("outside image changed: %v", statErr)
	}
}

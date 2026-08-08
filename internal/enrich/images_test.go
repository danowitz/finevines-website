package enrich

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

type countingImageProvider struct{ calls int }

func (p *countingImageProvider) GenerateJPEG(context.Context, string) ([]byte, error) {
	p.calls++
	return []byte("invented bottle"), nil
}

// fakeImageProvider is shared with parse_test.go, where the provider is kept
// only to exercise enrichOne's legacy-compatible signature.
type fakeImageProvider struct {
	fn    func(context.Context, string) ([]byte, error)
	calls int
}

func (p *fakeImageProvider) GenerateJPEG(ctx context.Context, prompt string) ([]byte, error) {
	p.calls++
	return p.fn(ctx, prompt)
}

var resolveImageWine = salesforce.WineRaw{
	ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", Name: "Puligny-Montrachet",
	Vintage: "2019", Region: "Burgundy",
}

var resolveImageBase = model.Slugify(resolveImageWine.Producer, resolveImageWine.Name, resolveImageWine.Vintage)

func TestResolveImageNeverInvokesImageGeneration(t *testing.T) {
	imgDir := t.TempDir()
	provider := &countingImageProvider{}
	gotPath, gotSource, err := ResolveImage(context.Background(), provider, resolveImageWine, "invent it", imgDir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if provider.calls != 0 {
		t.Fatalf("image provider called %d times; invented packaging is disabled", provider.calls)
	}
	if gotSource != model.ImageGeneratedLabel || !strings.HasSuffix(gotPath, resolveImageBase+".svg") {
		t.Fatalf("got (%q, %q), want neutral SVG fallback", gotPath, gotSource)
	}
	data, err := os.ReadFile(filepath.Join(imgDir, resolveImageBase+".svg"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "Product image unavailable") || strings.Contains(string(data), resolveImageWine.Producer) {
		t.Fatal("fallback is not the product-neutral unavailable-image artwork")
	}
}

func TestResolveImageReplacesGeneratedPhotoAndRemovesJPEG(t *testing.T) {
	imgDir := t.TempDir()
	stale := filepath.Join(imgDir, resolveImageBase+".jpg")
	if err := os.WriteFile(stale, []byte("invented bottle"), 0o644); err != nil {
		t.Fatal(err)
	}
	prev := &model.Wine{ImagePath: filepath.ToSlash(stale), ImageSource: model.ImageGeneratedPhoto}
	if _, source, err := ResolveImage(context.Background(), &countingImageProvider{}, resolveImageWine, "", imgDir, prev, nil); err != nil {
		t.Fatal(err)
	} else if source != model.ImageGeneratedLabel {
		t.Fatalf("source = %q, want neutral fallback", source)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("generated JPEG was not removed: %v", err)
	}
}

func TestResolveImagePreservesRealPhotoAndAuthenticLabelScan(t *testing.T) {
	for _, source := range []string{model.ImageScrapedWeb, model.ImageOldSite, model.ImageProducerSupplied, model.ImageLabelScan} {
		provider := &countingImageProvider{}
		prev := &model.Wine{ImagePath: "assets/img/wines/real.jpg", ImageSource: source}
		path, gotSource, err := ResolveImage(context.Background(), provider, resolveImageWine, "", t.TempDir(), prev, nil)
		if err != nil || path != prev.ImagePath || gotSource != source || provider.calls != 0 {
			t.Fatalf("[%s] real source was not preserved: path=%q source=%q err=%v calls=%d", source, path, gotSource, err, provider.calls)
		}
	}
}

func TestResolveImagePathIsSiteRelative(t *testing.T) {
	t.Chdir(t.TempDir())
	path, _, err := ResolveImage(context.Background(), &countingImageProvider{}, resolveImageWine, "", filepath.Join("assets", "img", "wines"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(path, "\\") || strings.HasPrefix(path, "/") {
		t.Fatalf("imagePath = %q, want forward-slash site-relative form", path)
	}
}

func TestResolveImageFilesystemFailurePropagates(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ResolveImage(context.Background(), &countingImageProvider{}, resolveImageWine, "", filepath.Join(blocker, "wines"), nil, nil); err == nil {
		t.Fatal("want filesystem error")
	}
}

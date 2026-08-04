package enrich

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// fakeImageProvider adapts a plain function to ImageProvider and counts
// calls, so tests can assert the producer-supplied guard never invokes the
// provider at all (step (d) of the brief).
type fakeImageProvider struct {
	fn    func(ctx context.Context, prompt string) ([]byte, error)
	calls int
}

func (f *fakeImageProvider) GenerateJPEG(ctx context.Context, prompt string) ([]byte, error) {
	f.calls++
	return f.fn(ctx, prompt)
}

// resolveImageWine is a representative WineRaw used across ResolveImage tests.
var resolveImageWine = salesforce.WineRaw{
	ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", Name: "Puligny-Montrachet",
	Vintage: "2019", Region: "Burgundy",
}

// resolveImageBase is resolveImageWine's SEO slug — the basename ResolveImage
// writes image files under (matching the wine's /wines/<slug>/ page URL).
var resolveImageBase = model.Slugify(resolveImageWine.Producer, resolveImageWine.Name, resolveImageWine.Vintage)

func collectLogs(t *testing.T) (logFn func(string, ...any), get func() []string) {
	t.Helper()
	var logs []string
	return func(format string, args ...any) {
			logs = append(logs, fmt.Sprintf(format, args...))
		}, func() []string {
			return logs
		}
}

// A generated photo or a label scan is a STAND-IN the import pipeline
// replaces with a real photograph; re-enrichment must keep it, not downgrade
// it to the SVG label. Without this, the 2026-08-04 catalog-wide re-enrichment
// would have wiped 46 verified gpt-image bottles and ~510 label scans.
func TestResolveImage_StandInImagesSurviveReenrichment(t *testing.T) {
	for _, source := range []string{model.ImageGeneratedPhoto, model.ImageLabelScan} {
		imgDir := t.TempDir()
		provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
			t.Errorf("provider must not be invoked when prev wears a %s stand-in", source)
			return nil, nil
		}}
		prev := &model.Wine{
			ImagePath:   "assets/img/wines/" + resolveImageBase + ".jpg",
			ImageSource: source,
		}
		logFn, _ := collectLogs(t)
		gotPath, gotSource, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, prev, logFn)
		if err != nil {
			t.Fatalf("[%s] ResolveImage returned error: %v", source, err)
		}
		if gotPath != prev.ImagePath || gotSource != source {
			t.Errorf("[%s] = (%q, %q), want the stand-in kept (%q, %q)", source, gotPath, gotSource, prev.ImagePath, source)
		}
	}
}

func TestResolveImage_ProviderSuccessWritesJPEGAndReturnsPhotoSource(t *testing.T) {
	imgDir := t.TempDir()
	wantBytes := []byte("fake jpeg bytes from provider")
	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		return wantBytes, nil
	}}
	logFn, _ := collectLogs(t)

	gotPath, gotSource, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn)
	if err != nil {
		t.Fatalf("ResolveImage returned error: %v", err)
	}
	if gotSource != model.ImageGeneratedPhoto {
		t.Errorf("imageSource = %q, want %q", gotSource, model.ImageGeneratedPhoto)
	}
	if provider.calls != 1 {
		t.Errorf("provider called %d times, want 1", provider.calls)
	}

	diskPath := filepath.Join(imgDir, resolveImageBase+".jpg")
	got, err := os.ReadFile(diskPath)
	if err != nil {
		t.Fatalf("expected %s to exist on disk: %v", diskPath, err)
	}
	if !bytes.Equal(got, wantBytes) {
		t.Errorf("written bytes = %q, want %q", got, wantBytes)
	}
	if !strings.HasSuffix(gotPath, resolveImageBase+".jpg") {
		t.Errorf("imagePath = %q, want it to end with AB1234.jpg", gotPath)
	}
}

func TestResolveImage_ProviderRejectionFallsBackToLabel(t *testing.T) {
	imgDir := t.TempDir()
	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		return nil, fmt.Errorf("imagen: rejected: %w", ErrImageRejected)
	}}
	logFn, getLogs := collectLogs(t)

	gotPath, gotSource, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn)
	if err != nil {
		t.Fatalf("ResolveImage returned error: %v", err)
	}
	if gotSource != model.ImageGeneratedLabel {
		t.Errorf("imageSource = %q, want %q", gotSource, model.ImageGeneratedLabel)
	}
	if !strings.HasSuffix(gotPath, resolveImageBase+".svg") {
		t.Errorf("imagePath = %q, want it to end with AB1234.svg", gotPath)
	}

	diskPath := filepath.Join(imgDir, resolveImageBase+".svg")
	data, err := os.ReadFile(diskPath)
	if err != nil {
		t.Fatalf("expected %s to exist on disk: %v", diskPath, err)
	}
	if !bytes.Contains(data, []byte("<svg")) {
		t.Errorf("written label file does not look like an SVG: %q", data[:min(len(data), 80)])
	}

	if len(getLogs()) == 0 { // want a warning logged on fallback
		t.Error("want a warning logged on fallback, got none")
	}
}

func TestResolveImage_PlainNetworkErrorStillFallsBackToLabelWithoutFailingRun(t *testing.T) {
	imgDir := t.TempDir()
	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		return nil, errors.New("dial tcp: connection refused")
	}}
	logFn, getLogs := collectLogs(t)

	gotPath, gotSource, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn)
	if err != nil {
		t.Fatalf("ResolveImage returned error for a flaky provider call: %v", err)
	}
	if gotSource != model.ImageGeneratedLabel {
		t.Errorf("imageSource = %q, want %q", gotSource, model.ImageGeneratedLabel)
	}
	if _, err := os.Stat(filepath.Join(imgDir, resolveImageBase+".svg")); err != nil {
		t.Errorf("expected label svg on disk: %v", err)
	}
	if !strings.HasSuffix(gotPath, resolveImageBase+".svg") {
		t.Errorf("imagePath = %q, want it to end with AB1234.svg", gotPath)
	}
	if len(getLogs()) == 0 {
		t.Error("want a warning logged on fallback, got none")
	}
}

func TestResolveImage_ProducerSuppliedGuardNeverCallsProvider(t *testing.T) {
	imgDir := t.TempDir()
	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		t.Fatal("provider must not be called when prev is producer-supplied")
		return nil, nil
	}}
	logFn, _ := collectLogs(t)

	prev := &model.Wine{
		ImagePath:   "assets/img/wines/AB1234-producer-original.png",
		ImageSource: model.ImageProducerSupplied,
	}

	gotPath, gotSource, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, prev, logFn)
	if err != nil {
		t.Fatalf("ResolveImage returned error: %v", err)
	}
	if provider.calls != 0 {
		t.Errorf("provider called %d times, want 0 (producer-supplied guard)", provider.calls)
	}
	if gotPath != prev.ImagePath {
		t.Errorf("imagePath = %q, want unchanged prev.ImagePath %q", gotPath, prev.ImagePath)
	}
	if gotSource != model.ImageProducerSupplied {
		t.Errorf("imageSource = %q, want %q", gotSource, model.ImageProducerSupplied)
	}

	entries, _ := os.ReadDir(imgDir)
	if len(entries) != 0 {
		t.Errorf("expected no files written to imgDir, got %v", entries)
	}
}

func TestResolveImage_SiblingCleanup_LabelToPhotoRemovesStaleSVG(t *testing.T) {
	imgDir := t.TempDir()
	stale := filepath.Join(imgDir, resolveImageBase+".svg")
	if err := os.WriteFile(stale, []byte("<svg>stale label</svg>"), 0o644); err != nil {
		t.Fatalf("seed stale svg: %v", err)
	}

	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		return []byte("new jpeg bytes"), nil
	}}
	logFn, _ := collectLogs(t)

	if _, _, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn); err != nil {
		t.Fatalf("ResolveImage returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(imgDir, resolveImageBase+".jpg")); err != nil {
		t.Errorf("expected new jpg to exist: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("expected stale svg to be removed, stat err = %v", err)
	}
}

func TestResolveImage_SiblingCleanup_PhotoToLabelRemovesStaleJPEG(t *testing.T) {
	imgDir := t.TempDir()
	stale := filepath.Join(imgDir, resolveImageBase+".jpg")
	if err := os.WriteFile(stale, []byte("stale jpeg bytes"), 0o644); err != nil {
		t.Fatalf("seed stale jpg: %v", err)
	}

	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		return nil, ErrImageRejected
	}}
	logFn, _ := collectLogs(t)

	if _, _, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn); err != nil {
		t.Fatalf("ResolveImage returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(imgDir, resolveImageBase+".svg")); err != nil {
		t.Errorf("expected new svg to exist: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("expected stale jpg to be removed, stat err = %v", err)
	}
}

// TestResolveImage_ImagePathIsSiteRelativeFormEvenOnWindows mirrors the
// production call shape (imgDir = "assets/img/wines", relative to the
// process's cwd — see cmd/finevines/main.go's enrich.Run call) and asserts
// the returned imagePath is forward-slash form with no leading slash,
// matching how templates/wine.html.tmpl and build.go's search-index build
// the <img src> ("/" + w.ImagePath) and "img" fields.
//
// t.Chdir into a scratch dir first: writeImageFile returns imgDir itself
// (slash-converted), not a path relative to some site root, so the
// no-leading-slash assertion only holds when imgDir is relative like real
// callers pass it. An imgDir built by joining onto t.TempDir() (absolute)
// used to pass here by accident on Windows only, because an absolute
// Windows path starts with a drive letter, not "/" — so it doesn't fail
// the "no leading slash" check even though it's not a site-relative path.
// The same absolute imgDir on Linux starts with "/" and correctly fails,
// which is what caught this: ubuntu-latest CI run
// https://github.com/danowitz/finevines-website/actions/runs/30515039066.
func TestResolveImage_ImagePathIsSiteRelativeFormEvenOnWindows(t *testing.T) {
	t.Chdir(t.TempDir())
	imgDir := filepath.Join("assets", "img", "wines")
	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		return []byte("jpeg bytes"), nil
	}}
	logFn, _ := collectLogs(t)

	gotPath, _, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn)
	if err != nil {
		t.Fatalf("ResolveImage returned error: %v", err)
	}
	if strings.Contains(gotPath, "\\") {
		t.Errorf("imagePath = %q, must not contain backslashes", gotPath)
	}
	if !strings.HasSuffix(gotPath, "assets/img/wines/"+resolveImageBase+".jpg") {
		t.Errorf("imagePath = %q, want it to end with assets/img/wines/AB1234.jpg", gotPath)
	}
	if strings.HasPrefix(gotPath, "/") {
		t.Errorf("imagePath = %q, must not have a leading slash (templates add it)", gotPath)
	}
}

func TestResolveImage_MkdirCreatesImgDirWhenMissing(t *testing.T) {
	imgDir := filepath.Join(t.TempDir(), "not-yet-created")
	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		return []byte("jpeg bytes"), nil
	}}
	logFn, _ := collectLogs(t)

	if _, _, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn); err != nil {
		t.Fatalf("ResolveImage returned error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(imgDir, resolveImageBase+".jpg")); err != nil {
		t.Errorf("expected imgDir to be created and jpg written: %v", err)
	}
}

// TestResolveImage_FilesystemFailurePropagatesAsError confirms the one
// class of error ResolveImage is allowed to return: MkdirAll failing
// because imgDir's parent is a regular file, not a directory (deterministic
// on both Windows and Unix, unlike simulating a permissions failure). This
// must surface as a real error — unlike a provider failure, a filesystem
// failure means the image genuinely was not written anywhere.
func TestResolveImage_FilesystemFailurePropagatesAsError(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "blocker-file")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("seed blocker file: %v", err)
	}
	imgDir := filepath.Join(blocker, "wines") // parent is a file: MkdirAll must fail

	provider := &fakeImageProvider{fn: func(ctx context.Context, prompt string) ([]byte, error) {
		t.Fatal("provider must not be called if mkdir fails first")
		return nil, nil
	}}
	logFn, _ := collectLogs(t)

	_, _, err := ResolveImage(context.Background(), provider, resolveImageWine, "a prompt", imgDir, nil, logFn)
	if err == nil {
		t.Fatal("want a non-nil error for an unwritable imgDir, got nil")
	}
}

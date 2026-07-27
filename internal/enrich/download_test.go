package enrich

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func TestDownloadImage(t *testing.T) {
	// A tiny PNG to serve.
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ok.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(pngBuf.Bytes())
	})
	mux.HandleFunc("/notimage", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html>nope</html>"))
	})
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	orig := imageHTTPClient
	imageHTTPClient = srv.Client()
	defer func() { imageHTTPClient = orig }()

	// Success: a PNG comes back re-encoded as JPEG.
	data, err := downloadImage(context.Background(), srv.URL+"/ok.png")
	if err != nil {
		t.Fatalf("downloadImage ok: %v", err)
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		t.Errorf("output is not valid JPEG: %v", err)
	}

	// A non-image response is rejected (so we fall through, not save junk).
	if _, err := downloadImage(context.Background(), srv.URL+"/notimage"); err == nil {
		t.Error("want error for non-image content-type")
	}
	// An HTTP error is rejected.
	if _, err := downloadImage(context.Background(), srv.URL+"/missing"); err == nil {
		t.Error("want error for HTTP 404")
	}
}

func TestImageCandidate(t *testing.T) {
	old := map[string]string{"SKU1": "http://old/img.jpg"}

	if u, s := imageCandidate("SKU1", "http://found/x.jpg", old); u != "http://old/img.jpg" || s != model.ImageOldSite {
		t.Errorf("own old-site image must win: got %q/%q", u, s)
	}
	if u, s := imageCandidate("SKU2", "http://found/x.jpg", old); u != "http://found/x.jpg" || s != model.ImageScrapedWeb {
		t.Errorf("found URL should be the fallback: got %q/%q", u, s)
	}
	if u, _ := imageCandidate("SKU3", "", old); u != "" {
		t.Errorf("no candidate expected, got %q", u)
	}
}

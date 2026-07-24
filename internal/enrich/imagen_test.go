package enrich

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// onePixelPNGBase64 renders a genuine 1x1 PNG in-process (rather than
// hardcoding a hand-typed blob) and returns it base64-encoded, mirroring
// exactly what Imagen's bytesBase64Encoded field carries on the wire.
func onePixelPNGBase64(t *testing.T) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.RGBA{R: 128, G: 32, B: 48, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode fixture png: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestGenerateJPEGSendsAuthAndPromptReturnsDecodableJPEG(t *testing.T) {
	const wantPrompt = "Photorealistic studio product photograph of a tall Burgundy bottle."
	const wantAPIKey = "test-gemini-key"

	pngB64 := onePixelPNGBase64(t)

	var gotAuthHeader string
	var gotBody map[string]any
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthHeader = r.Header.Get("x-goog-api-key")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"predictions": []map[string]any{
				{"bytesBase64Encoded": pngB64, "mimeType": "image/png"},
			},
		})
	}))
	defer server.Close()

	client := NewImagenClient(wantAPIKey, "imagen-4.0-generate-001", server.URL, server.Client())
	got, err := client.GenerateJPEG(t.Context(), wantPrompt)
	if err != nil {
		t.Fatalf("GenerateJPEG returned error: %v", err)
	}

	if gotAuthHeader != wantAPIKey {
		t.Errorf("x-goog-api-key header = %q, want %q", gotAuthHeader, wantAPIKey)
	}
	if gotPath != "/v1beta/models/imagen-4.0-generate-001:predict" {
		t.Errorf("request path = %q, want the model :predict path", gotPath)
	}

	instances, _ := gotBody["instances"].([]any)
	if len(instances) == 0 {
		t.Fatal("request body had no instances")
	}
	first, _ := instances[0].(map[string]any)
	if prompt, _ := first["prompt"].(string); prompt != wantPrompt {
		t.Errorf("request prompt = %q, want %q", prompt, wantPrompt)
	}

	if _, err := jpeg.Decode(bytes.NewReader(got)); err != nil {
		t.Fatalf("GenerateJPEG output does not decode as JPEG: %v", err)
	}
}

func TestGenerateJPEGSafetyRejectionReturnsSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"code":    400,
				"message": "Image generation blocked by safety filters.",
				"status":  "INVALID_ARGUMENT",
			},
		})
	}))
	defer server.Close()

	client := NewImagenClient("test-key", "imagen-4.0-generate-001", server.URL, server.Client())
	_, err := client.GenerateJPEG(t.Context(), "a prompt that trips the safety filter")
	if err == nil {
		t.Fatal("want error for safety-rejected generation, got nil")
	}
	if !errors.Is(err, ErrImageRejected) {
		t.Fatalf("want errors.Is(err, ErrImageRejected), got: %v", err)
	}
}

func TestGenerateJPEGEmptyPredictionsReturnsSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"predictions": []map[string]any{}})
	}))
	defer server.Close()

	client := NewImagenClient("test-key", "imagen-4.0-generate-001", server.URL, server.Client())
	_, err := client.GenerateJPEG(t.Context(), "a fine prompt")
	if !errors.Is(err, ErrImageRejected) {
		t.Fatalf("want errors.Is(err, ErrImageRejected) for empty predictions, got: %v", err)
	}
}

func TestGenerateJPEGNetworkErrorIsNotTheSentinel(t *testing.T) {
	// A server that closes the connection immediately simulates a transport
	// failure — this must surface as an ordinary error, never as
	// ErrImageRejected, since it is a run failure, not a content rejection.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("test server does not support hijacking")
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		conn.Close()
	}))
	defer server.Close()

	client := NewImagenClient("test-key", "imagen-4.0-generate-001", server.URL, server.Client())
	_, err := client.GenerateJPEG(t.Context(), "a fine prompt")
	if err == nil {
		t.Fatal("want error for a dropped connection, got nil")
	}
	if errors.Is(err, ErrImageRejected) {
		t.Fatalf("network/transport error must not match ErrImageRejected, got: %v", err)
	}
}

func TestNewImagenClientDefaultsBaseURLToRealGeminiHost(t *testing.T) {
	client := NewImagenClient("k", "m", "", http.DefaultClient)
	if !strings.HasPrefix(client.baseURL, "https://generativelanguage.googleapis.com") {
		t.Fatalf("baseURL = %q, want the real Gemini API host as default", client.baseURL)
	}
}

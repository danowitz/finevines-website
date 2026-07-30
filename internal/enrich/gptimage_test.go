package enrich

import (
	"bytes"
	"encoding/json"
	"errors"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGPTImageGenerateJPEGSendsAuthAndPromptReturnsDecodableJPEG(t *testing.T) {
	const wantPrompt = "Photorealistic studio product photograph of a tall Burgundy bottle."
	const wantAPIKey = "test-openai-key"

	pngB64 := onePixelPNGBase64(t)

	var gotAuthHeader string
	var gotBody map[string]any
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthHeader = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"b64_json": pngB64},
			},
		})
	}))
	defer server.Close()

	client := NewGPTImageClient(wantAPIKey, "gpt-image-1", "medium", server.URL, server.Client())
	got, err := client.GenerateJPEG(t.Context(), wantPrompt)
	if err != nil {
		t.Fatalf("GenerateJPEG returned error: %v", err)
	}

	if gotAuthHeader != "Bearer "+wantAPIKey {
		t.Errorf("Authorization header = %q, want %q", gotAuthHeader, "Bearer "+wantAPIKey)
	}
	if gotPath != "/v1/images/generations" {
		t.Errorf("request path = %q, want /v1/images/generations", gotPath)
	}

	if model, _ := gotBody["model"].(string); model != "gpt-image-1" {
		t.Errorf("request model = %q, want gpt-image-1", model)
	}
	if prompt, _ := gotBody["prompt"].(string); prompt != wantPrompt {
		t.Errorf("request prompt = %q, want %q", prompt, wantPrompt)
	}
	if size, _ := gotBody["size"].(string); size != "1024x1536" {
		t.Errorf("request size = %q, want the portrait 1024x1536", size)
	}
	if quality, _ := gotBody["quality"].(string); quality != "medium" {
		t.Errorf("request quality = %q, want %q", quality, "medium")
	}

	if _, err := jpeg.Decode(bytes.NewReader(got)); err != nil {
		t.Fatalf("GenerateJPEG output does not decode as JPEG: %v", err)
	}
}

func TestGPTImageGenerateJPEGModerationRejectionReturnsSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "Your request was rejected by the safety system.",
				"type":    "invalid_request_error",
				"code":    "moderation_blocked",
			},
		})
	}))
	defer server.Close()

	client := NewGPTImageClient("test-key", "gpt-image-1", "medium", server.URL, server.Client())
	_, err := client.GenerateJPEG(t.Context(), "a prompt that trips the safety system")
	if err == nil {
		t.Fatal("want error for moderation-rejected generation, got nil")
	}
	if !errors.Is(err, ErrImageRejected) {
		t.Fatalf("want errors.Is(err, ErrImageRejected), got: %v", err)
	}
}

func TestGPTImageGenerateJPEGEmptyDataReturnsSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{}})
	}))
	defer server.Close()

	client := NewGPTImageClient("test-key", "gpt-image-1", "medium", server.URL, server.Client())
	_, err := client.GenerateJPEG(t.Context(), "a fine prompt")
	if !errors.Is(err, ErrImageRejected) {
		t.Fatalf("want errors.Is(err, ErrImageRejected) for empty data, got: %v", err)
	}
}

func TestGPTImageGenerateJPEGNetworkErrorIsNotTheSentinel(t *testing.T) {
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

	client := NewGPTImageClient("test-key", "gpt-image-1", "medium", server.URL, server.Client())
	_, err := client.GenerateJPEG(t.Context(), "a fine prompt")
	if err == nil {
		t.Fatal("want error for a dropped connection, got nil")
	}
	if errors.Is(err, ErrImageRejected) {
		t.Fatalf("network/transport error must not match ErrImageRejected, got: %v", err)
	}
}

func TestGPTImageGenerateJPEGRetriesRateLimitThenSucceeds(t *testing.T) {
	pngB64 := onePixelPNGBase64(t)

	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if requests <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"message": "Rate limit reached for gpt-image-1: Limit 5, Used 5. Please try again in 12s.",
					"code":    "rate_limit_exceeded",
				},
			})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"b64_json": pngB64}},
		})
	}))
	defer server.Close()

	client := NewGPTImageClient("test-key", "gpt-image-1", "medium", server.URL, server.Client())
	var slept []time.Duration
	client.sleep = func(d time.Duration) { slept = append(slept, d) }

	got, err := client.GenerateJPEG(t.Context(), "a fine prompt")
	if err != nil {
		t.Fatalf("GenerateJPEG should retry through 429s, got error: %v", err)
	}
	if requests != 3 {
		t.Errorf("server saw %d requests, want 3 (two 429s then success)", requests)
	}
	if len(slept) != 2 {
		t.Errorf("client slept %d times, want 2 (once per 429)", len(slept))
	}
	if _, err := jpeg.Decode(bytes.NewReader(got)); err != nil {
		t.Fatalf("GenerateJPEG output does not decode as JPEG: %v", err)
	}
}

func TestGPTImageGenerateJPEGExhaustedRateLimitIsNotTheSentinel(t *testing.T) {
	// A rate limit is a transient throughput problem, never a content
	// rejection: even after retries run out it must surface as an ordinary
	// error, not ErrImageRejected.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "rate_limit_exceeded"},
		})
	}))
	defer server.Close()

	client := NewGPTImageClient("test-key", "gpt-image-1", "medium", server.URL, server.Client())
	client.sleep = func(time.Duration) {}

	_, err := client.GenerateJPEG(t.Context(), "a fine prompt")
	if err == nil {
		t.Fatal("want error once retries are exhausted, got nil")
	}
	if errors.Is(err, ErrImageRejected) {
		t.Fatalf("exhausted rate limit must not match ErrImageRejected, got: %v", err)
	}
}

func TestNewGPTImageClientDefaultsBaseURLAndQuality(t *testing.T) {
	client := NewGPTImageClient("k", "gpt-image-1", "", "", http.DefaultClient)
	if !strings.HasPrefix(client.baseURL, "https://api.openai.com") {
		t.Fatalf("baseURL = %q, want the real OpenAI API host as default", client.baseURL)
	}
	if client.quality != "medium" {
		t.Fatalf("quality = %q, want %q as default", client.quality, "medium")
	}
}

package enrich

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
)

// ErrImageRejected is the sentinel GenerateJPEG wraps whenever Imagen
// declines to produce a photo: a non-2xx response (the shape a safety/policy
// rejection takes on this endpoint) or a 200 with an empty predictions
// array. The enrich pipeline (Task 15) treats this as "fall back to the
// deterministic label", not a run failure — only transport/network errors
// and malformed responses (ordinary errors, not this sentinel) should abort
// a run.
var ErrImageRejected = errors.New("imagen: image generation rejected")

// ImageProvider turns one Claude-authored image prompt into a photorealistic
// bottle photo. ImagenClient is the only implementation today; the
// interface exists so pipeline orchestration (Task 15) can be tested
// against a fake, and so a future provider swap stays local to one file.
type ImageProvider interface {
	GenerateJPEG(ctx context.Context, prompt string) ([]byte, error)
}

// defaultImagenBaseURL is the real Gemini API host. Endpoint shape verified
// 2026-07-24 against https://ai.google.dev/gemini-api/docs/imagen: POST
// {host}/v1beta/models/{model}:predict, auth header x-goog-api-key.
const defaultImagenBaseURL = "https://generativelanguage.googleapis.com"

// ImagenClient calls Google's Imagen model through the Gemini API's
// :predict endpoint to generate a bottle photo, then re-encodes the
// response (PNG) as JPEG — see GenerateJPEG.
type ImagenClient struct {
	apiKey  string
	model   string
	baseURL string
	http    *http.Client
}

// ImagenClient must satisfy ImageProvider so pipeline orchestration never
// depends on Imagen-specific types.
var _ ImageProvider = (*ImagenClient)(nil)

// NewImagenClient builds an ImagenClient. model is always supplied by the
// caller (from config's FINEVINES_IMAGE_MODEL, default
// "imagen-4.0-generate-001") and never hardcoded here — this is the newest,
// most-likely-to-change external dependency in the pipeline (design spec
// §5), and a config value is what lets an operator move to a new model
// without a code change. baseURL is normally "" (defaults to the real
// Gemini API host); tests pass an httptest.Server URL instead. hc is
// injected so tests and production callers each supply their own (e.g. one
// configured with a timeout) rather than relying on http.DefaultClient.
func NewImagenClient(apiKey, model, baseURL string, hc *http.Client) *ImagenClient {
	if baseURL == "" {
		baseURL = defaultImagenBaseURL
	}
	return &ImagenClient{
		apiKey:  apiKey,
		model:   model,
		baseURL: strings.TrimSuffix(baseURL, "/"),
		http:    hc,
	}
}

// imagenRequest/imagenResponse mirror the wire format documented at
// https://ai.google.dev/gemini-api/docs/imagen (confirmed 2026-07-24):
//
//	POST {baseURL}/v1beta/models/{model}:predict
//	header: x-goog-api-key: <key>
//	body:   {"instances":[{"prompt":"..."}],
//	         "parameters":{"sampleCount":1,"aspectRatio":"3:4"}}
//	resp:   {"predictions":[{"bytesBase64Encoded":"...","mimeType":"image/png"}]}
type imagenRequest struct {
	Instances  []imagenInstance `json:"instances"`
	Parameters imagenParameters `json:"parameters"`
}

type imagenInstance struct {
	Prompt string `json:"prompt"`
}

type imagenParameters struct {
	SampleCount int    `json:"sampleCount"`
	AspectRatio string `json:"aspectRatio"`
}

type imagenResponse struct {
	Predictions []struct {
		BytesBase64Encoded string `json:"bytesBase64Encoded"`
		MimeType           string `json:"mimeType"`
	} `json:"predictions"`
}

// GenerateJPEG asks Imagen for one 3:4 product photo of prompt and returns
// it as JPEG bytes at quality 85. The Gemini API returns PNG; Go's standard
// library has no WebP encoder (design spec deviation #1), so every
// generated bottle photo is decoded from PNG and re-encoded as JPEG before
// it ever reaches disk — callers never see the intermediate PNG.
//
// A non-2xx response or a 200 with no usable prediction (both are how this
// endpoint surfaces a safety/policy rejection) return an error wrapping
// ErrImageRejected, so callers can fall back to the deterministic label
// instead of failing the whole enrich run. Network/transport failures and
// malformed response bodies are returned as ordinary errors — those are
// real run failures, not content rejections, and must not satisfy
// errors.Is(err, ErrImageRejected).
func (c *ImagenClient) GenerateJPEG(ctx context.Context, prompt string) ([]byte, error) {
	reqBody, err := json.Marshal(imagenRequest{
		Instances:  []imagenInstance{{Prompt: prompt}},
		Parameters: imagenParameters{SampleCount: 1, AspectRatio: "3:4"},
	})
	if err != nil {
		return nil, fmt.Errorf("imagen: encode request: %w", err)
	}

	url := fmt.Sprintf("%s/v1beta/models/%s:predict", c.baseURL, c.model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("imagen: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("imagen: request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("imagen: read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: HTTP %d: %s", ErrImageRejected, resp.StatusCode, string(body))
	}

	var out imagenResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("imagen: decode response: %w", err)
	}
	if len(out.Predictions) == 0 || out.Predictions[0].BytesBase64Encoded == "" {
		return nil, fmt.Errorf("%w: no predictions returned", ErrImageRejected)
	}

	pngBytes, err := base64.StdEncoding.DecodeString(out.Predictions[0].BytesBase64Encoded)
	if err != nil {
		return nil, fmt.Errorf("imagen: decode base64 image: %w", err)
	}

	img, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return nil, fmt.Errorf("imagen: decode png: %w", err)
	}

	var jpegBuf bytes.Buffer
	if err := jpeg.Encode(&jpegBuf, img, &jpeg.Options{Quality: 85}); err != nil {
		return nil, fmt.Errorf("imagen: encode jpeg: %w", err)
	}
	return jpegBuf.Bytes(), nil
}

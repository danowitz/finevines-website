package enrich

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"time"
)

// defaultOpenAIImageBaseURL is the real OpenAI API host. Endpoint shape
// verified 2026-07-29 against https://platform.openai.com/docs/api-reference/images:
// POST {host}/v1/images/generations, auth header Authorization: Bearer <key>.
const defaultOpenAIImageBaseURL = "https://api.openai.com"

// defaultGPTImageQuality balances cost against fidelity for a catalog-scale
// run: at 1024x1536, low/medium/high cost roughly $0.016/$0.063/$0.25 per
// image (output tokens at $40/1M).
const defaultGPTImageQuality = "medium"

// GPTImageClient calls OpenAI's gpt-image-1 model through the Images API's
// /v1/images/generations endpoint to generate a bottle photo, then re-encodes
// the response (PNG) as JPEG — see GenerateJPEG. It is the replacement for
// ImagenClient (the pipeline is all-OpenAI, decided 2026-07-27).
type GPTImageClient struct {
	apiKey  string
	model   string
	quality string
	baseURL string
	http    *http.Client
	// sleep is time.Sleep, injectable so retry tests don't wait wall-clock
	// time. It backs the HTTP 429 retry loop in GenerateJPEG.
	sleep func(time.Duration)
}

// gptImageMaxAttempts bounds the HTTP 429 retry loop: OpenAI orgs commonly
// carry a per-minute image cap (5/min observed live 2026-07-29), so a batch
// run WILL hit 429s in normal operation — they mean "wait", not "failed".
const gptImageMaxAttempts = 4

// gptImageRetryDelay is the base wait after a 429; attempt N waits N×this
// (15s, 30s, 45s), comfortably clearing a per-minute limit window.
const gptImageRetryDelay = 15 * time.Second

// GPTImageClient must satisfy ImageProvider so pipeline orchestration never
// depends on OpenAI-specific types.
var _ ImageProvider = (*GPTImageClient)(nil)

// NewGPTImageClient builds a GPTImageClient. model is supplied by the caller
// (from config's FINEVINES_IMAGE_MODEL) and never hardcoded here, for the
// same reason as NewImagenClient: image models are the newest, most-likely-
// to-change external dependency in the pipeline. quality is gpt-image-1's
// rendering tier ("low"/"medium"/"high"; "" defaults to "medium") — it is
// the pipeline's cost dial, so it is a constructor input rather than a
// constant. baseURL is normally "" (defaults to the real OpenAI host); tests
// pass an httptest.Server URL instead. hc is injected so tests and
// production callers each supply their own.
func NewGPTImageClient(apiKey, model, quality, baseURL string, hc *http.Client) *GPTImageClient {
	if quality == "" {
		quality = defaultGPTImageQuality
	}
	if baseURL == "" {
		baseURL = defaultOpenAIImageBaseURL
	}
	return &GPTImageClient{
		apiKey:  apiKey,
		model:   model,
		quality: quality,
		baseURL: strings.TrimSuffix(baseURL, "/"),
		http:    hc,
		sleep:   time.Sleep,
	}
}

// gptImageRequest/gptImageResponse mirror the wire format documented at
// https://platform.openai.com/docs/api-reference/images/create:
//
//	POST {baseURL}/v1/images/generations
//	header: Authorization: Bearer <key>
//	body:   {"model":"gpt-image-1","prompt":"...","size":"1024x1536","quality":"medium"}
//	resp:   {"data":[{"b64_json":"..."}]}
//
// gpt-image-1 always returns base64 (never a URL), and its default
// output_format is PNG — the request deliberately omits output_format so the
// decode path below stays identical to ImagenClient's PNG→JPEG re-encode.
type gptImageRequest struct {
	Model   string `json:"model"`
	Prompt  string `json:"prompt"`
	Size    string `json:"size"`
	Quality string `json:"quality"`
}

type gptImageResponse struct {
	Data []struct {
		B64JSON string `json:"b64_json"`
	} `json:"data"`
}

// GenerateJPEG asks gpt-image-1 for one portrait (1024x1536, the closest the
// API offers to the catalog's 3:4 crop) product photo of prompt and returns
// it as JPEG bytes at quality 85, matching ImagenClient's contract byte-for-
// byte from the caller's perspective.
//
// A non-2xx response (the shape a moderation/safety rejection takes on this
// endpoint) or a 200 with no usable data entry return an error wrapping
// ErrImageRejected. Network/transport failures and malformed response bodies
// are returned as ordinary errors instead, and must not satisfy
// errors.Is(err, ErrImageRejected) — same semantics as ImagenClient, and for
// the same reason: ResolveImage falls back to the deterministic label on
// either kind of error and never aborts the enrich run because of it.
func (c *GPTImageClient) GenerateJPEG(ctx context.Context, prompt string) ([]byte, error) {
	reqBody, err := json.Marshal(gptImageRequest{
		Model:   c.model,
		Prompt:  prompt,
		Size:    "1024x1536",
		Quality: c.quality,
	})
	if err != nil {
		return nil, fmt.Errorf("gptimage: encode request: %w", err)
	}

	url := c.baseURL + "/v1/images/generations"

	// Retry loop for HTTP 429 only: per-minute org rate limits make 429s a
	// routine part of a batch run, and mapping them to ErrImageRejected would
	// make ResolveImage silently downgrade rate-limited wines to the SVG
	// label. Every other outcome (success, rejection, transport error) exits
	// on the first attempt.
	var body []byte
	var status int
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
		if err != nil {
			return nil, fmt.Errorf("gptimage: build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.apiKey)

		resp, err := c.http.Do(req)
		if err != nil {
			return nil, fmt.Errorf("gptimage: request: %w", err)
		}
		body, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("gptimage: read response: %w", err)
		}
		status = resp.StatusCode

		if status != http.StatusTooManyRequests {
			break
		}
		if attempt == gptImageMaxAttempts {
			// Exhausted: an ordinary error, deliberately NOT the sentinel — a
			// rate limit is a throughput problem, never a content rejection.
			return nil, fmt.Errorf("gptimage: rate limited after %d attempts: HTTP 429: %s", attempt, string(body))
		}
		c.sleep(time.Duration(attempt) * gptImageRetryDelay)
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("gptimage: request: %w", err)
		}
	}

	if status != http.StatusOK {
		return nil, fmt.Errorf("%w: HTTP %d: %s", ErrImageRejected, status, string(body))
	}

	var out gptImageResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("gptimage: decode response: %w", err)
	}
	if len(out.Data) == 0 || out.Data[0].B64JSON == "" {
		return nil, fmt.Errorf("%w: no image data returned", ErrImageRejected)
	}

	pngBytes, err := base64.StdEncoding.DecodeString(out.Data[0].B64JSON)
	if err != nil {
		return nil, fmt.Errorf("gptimage: decode base64 image: %w", err)
	}

	img, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return nil, fmt.Errorf("gptimage: decode png: %w", err)
	}

	var jpegBuf bytes.Buffer
	if err := jpeg.Encode(&jpegBuf, img, &jpeg.Options{Quality: 85}); err != nil {
		return nil, fmt.Errorf("gptimage: encode jpeg: %w", err)
	}
	return jpegBuf.Bytes(), nil
}

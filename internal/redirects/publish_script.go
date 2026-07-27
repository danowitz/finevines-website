// Package redirects (this file): generating and publishing the Bunny.net
// Edge Scripting middleware that performs the finevines.com old-site ->
// new-site 301 redirects (plan Task 20 Branch B). See publish_rules.go for
// why Branch A (Edge Rules) is a stub, not an implementation.
package redirects

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"text/template"
	"time"
)

//go:embed middleware.ts.tmpl
var middlewareTemplateSrc string

var middlewareTemplate = template.Must(template.New("middleware.ts").Parse(middlewareTemplateSrc))

// middlewareTemplateData is middleware.ts.tmpl's only input. Kept small and
// derived (OriginURL comes from RedirectsURL, not a separate caller-supplied
// value) so GenerateMiddleware's signature stays a single string.
type middlewareTemplateData struct {
	RedirectsURL string
	OriginURL    string
}

// GenerateMiddleware renders the fixed Bunny Edge Scripting middleware
// script that performs the finevines.com redirect map's 301s at the edge.
// redirectsURL is where the deployed redirects.json lives at runtime — the
// new (post-migration) site's own copy, e.g.
// "https://www.finevines.com/redirects.json" (FineVines keeps its domain,
// so the same host serves both the old-site crawl target during `redirects`
// discovery and the new site's assets after cutover), or a Bunny storage
// zone URL if serving it through the pull zone itself proves awkward.
//
// DESIGN DECISION (plan Task 20, verified against docs.bunny.net/scripting/
// limits): the old finevines.com site has 51,511 discovered URLs, which
// serialize to ~5.4MB of JSON. Bunny's confirmed Edge Scripting script-size
// cap is 10MB, so an inlined `const REDIRECTS = {...51k entries...}` would
// technically still fit — but Bunny's confirmed "startup time" cap is only
// 500ms (the maximum time allowed to evaluate the script's module-level
// code before it can serve a single request), and this script gates EVERY
// request to the pull zone, not just the ones being redirected. Parsing a
// 5+MB object literal with 51,511 properties at module scope on every cold
// isolate start is a real, direct risk of blowing that budget — which would
// degrade or break ordinary site traffic, not just SEO redirects. The map
// also only grows over time (new legacy URLs get manually mapped), leaving
// less and less headroom under the 10MB cap the longer the site runs.
//
// So GenerateMiddleware does NOT take the redirect map at all: the emitted
// script is small and fixed regardless of how many redirects exist. It
// fetches redirectsURL lazily on the first request an isolate serves (never
// at module scope, so it never counts against the startup-time budget),
// parses it into a Map once, and reuses that Map for the isolate's
// remaining requests. See middleware.ts.tmpl's header comment for the full
// design writeup (kept there too, since that's the file whoever's debugging
// a live redirect will actually be reading).
func GenerateMiddleware(redirectsURL string) ([]byte, error) {
	if redirectsURL == "" {
		return nil, fmt.Errorf("redirects: GenerateMiddleware: redirectsURL must not be empty")
	}
	parsed, err := url.Parse(redirectsURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("redirects: GenerateMiddleware: redirectsURL %q is not an absolute URL", redirectsURL)
	}
	origin := parsed.Scheme + "://" + parsed.Host

	var buf bytes.Buffer
	if err := middlewareTemplate.Execute(&buf, middlewareTemplateData{
		RedirectsURL: redirectsURL,
		OriginURL:    origin,
	}); err != nil {
		return nil, fmt.Errorf("redirects: rendering middleware.ts.tmpl: %w", err)
	}
	return buf.Bytes(), nil
}

// --- Publishing ------------------------------------------------------

// defaultScriptAPIBaseURL is Bunny.net's account-level API host, confirmed
// against Bunny's published Edge Scripting OpenAPI spec
// (docs.bunny.net/openapi/edge-scripting-api.json → servers[0].url).
const defaultScriptAPIBaseURL = "https://api.bunny.net"

// ScriptClient talks to Bunny.net's Edge Scripting API to push a new
// version of an EXISTING compute script's code and publish it live.
//
// It deliberately does NOT create the script or attach it to a Pull Zone —
// per Bunny's docs (docs.bunny.net/integrations/terraform/edgescript-
// pullzone), a middleware script's attachment to a Pull Zone is a property
// of the Pull Zone's own origin config (a "middleware_script" field), set
// up once via the Bunny dashboard or Terraform, not through the scripting
// API's code/publish endpoints. That one-time setup is a launch step
// (client item C4 — no Bunny account yet); ScriptClient only handles the
// repeatable part this package needs: pushing a fresh script body whenever
// middleware.ts.tmpl's design changes (the redirect MAP itself,
// redirects.json, is a separate deployed asset and does not require a
// script republish at all — that's the whole point of the fetch-from-
// storage design, see GenerateMiddleware's doc comment).
type ScriptClient struct {
	// BaseURL defaults to https://api.bunny.net via NewScriptClient;
	// overridable so tests can point it at an httptest server.
	BaseURL string
	// APIKey is the Bunny.net account-level API key, sent as the
	// AccessKey header — the same credential and header Bunny's core API
	// uses for Pull Zone purge (see internal/deploy.BunnyClient.Purge).
	APIKey string
	// ScriptID is the target compute script's numeric ID (as a string),
	// already created and linked to the FineVines Pull Zone.
	ScriptID string

	HTTPClient *http.Client
}

// NewScriptClient builds a ScriptClient from config values. httpClient may
// be nil, in which case http.DefaultClient is used; tests should pass an
// httptest server's client to avoid any real network calls.
func NewScriptClient(apiKey, scriptID string, httpClient *http.Client) *ScriptClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &ScriptClient{
		BaseURL:    defaultScriptAPIBaseURL,
		APIKey:     apiKey,
		ScriptID:   scriptID,
		HTTPClient: httpClient,
	}
}

// PublishMiddleware uploads script as ScriptID's new code (POST
// /compute/script/{id}/code — "Set Code") and, only if that succeeds,
// publishes it live (POST /compute/script/{id}/publish — "Publish
// Release"). Both endpoint shapes are confirmed against Bunny's published
// Edge Scripting OpenAPI spec (docs.bunny.net/openapi/edge-scripting-
// api.json). A non-2xx response from either step is a hard error naming
// the step and status; the publish step is skipped entirely if the code
// upload failed, so a bad deploy never "publishes" stale code.
//
// If this call proves awkward against a real Bunny account (untested
// against the live API — no account yet, client item C4), the documented
// manual fallback is pasting the generated script into the Bunny
// dashboard's script editor and clicking Publish
// (docs.bunny.net/scripting/deployments) — which is exactly why the
// generated script is also committed at redirects.middleware.ts.
func PublishMiddleware(ctx context.Context, client *ScriptClient, script []byte) error {
	if err := client.setCode(ctx, script); err != nil {
		return err
	}
	return client.publish(ctx)
}

func (c *ScriptClient) setCode(ctx context.Context, script []byte) error {
	body, err := json.Marshal(struct {
		Code string
	}{Code: string(script)})
	if err != nil {
		return fmt.Errorf("bunny set code: encoding request: %w", err)
	}
	reqURL := fmt.Sprintf("%s/compute/script/%s/code", strings.TrimRight(c.BaseURL, "/"), c.ScriptID)
	return c.post(ctx, reqURL, body, "set code")
}

func (c *ScriptClient) publish(ctx context.Context) error {
	body, err := json.Marshal(struct {
		Note string
	}{Note: fmt.Sprintf("finevines redirects publish %s", time.Now().UTC().Format(time.RFC3339))})
	if err != nil {
		return fmt.Errorf("bunny publish release: encoding request: %w", err)
	}
	reqURL := fmt.Sprintf("%s/compute/script/%s/publish", strings.TrimRight(c.BaseURL, "/"), c.ScriptID)
	return c.post(ctx, reqURL, body, "publish release")
}

func (c *ScriptClient) post(ctx context.Context, reqURL string, body []byte, step string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("bunny %s: building request: %w", step, err)
	}
	req.Header.Set("AccessKey", c.APIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("bunny %s: %w", step, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("bunny %s: status %d: %s", step, resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}

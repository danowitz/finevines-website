package deploy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// defaultPurgeBaseURL is Bunny.net's account-level API host. Purge always
// targets this host (it is not regional like the storage endpoint), but the
// value is stored on BunnyClient rather than hardcoded into Purge so tests
// can point it at an httptest server.
const defaultPurgeBaseURL = "https://api.bunny.net"

// BunnyClient talks to Bunny.net's Storage Zone API (file upload/delete)
// and Pull Zone API (cache purge). It holds no state beyond configuration
// and an *http.Client, so it's cheap to construct and safe to reuse across
// a deploy run.
type BunnyClient struct {
	// StorageEndpoint is the storage zone's regional host, e.g.
	// "https://storage.bunnycdn.com" or a region-specific host such as
	// "https://ny.storage.bunnycdn.com". No trailing slash required.
	StorageEndpoint string
	// StorageZone is the Bunny.net Storage Zone name.
	StorageZone string
	// StorageKey is the storage zone's password/API key, sent as the
	// AccessKey header on Upload/Delete requests.
	StorageKey string
	// AccountAPIKey is the Bunny.net account-level API key, sent as the
	// AccessKey header on Purge requests. This is a different credential
	// from StorageKey.
	AccountAPIKey string
	// PullZoneID identifies which Pull Zone's cache Purge clears.
	PullZoneID string
	// PurgeBaseURL is the host Purge posts to. Defaults to Bunny's public
	// API (https://api.bunny.net) via NewBunnyClient; overridable so tests
	// can redirect it at an httptest server.
	PurgeBaseURL string

	HTTPClient *http.Client
}

// NewBunnyClient builds a BunnyClient from config values. httpClient may be
// nil, in which case http.DefaultClient is used; tests should pass an
// httptest server's client to avoid any real network calls.
func NewBunnyClient(storageEndpoint, storageZone, storageKey, accountAPIKey, pullZoneID string, httpClient *http.Client) *BunnyClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &BunnyClient{
		StorageEndpoint: strings.TrimRight(storageEndpoint, "/"),
		StorageZone:     storageZone,
		StorageKey:      storageKey,
		AccountAPIKey:   accountAPIKey,
		PullZoneID:      pullZoneID,
		PurgeBaseURL:    defaultPurgeBaseURL,
		HTTPClient:      httpClient,
	}
}

// storageURL builds the per-file URL: {StorageEndpoint}/{StorageZone}/{relPath}.
func (c *BunnyClient) storageURL(relPath string) string {
	return fmt.Sprintf("%s/%s/%s", c.StorageEndpoint, c.StorageZone, relPath)
}

// Upload PUTs data to the storage zone at relPath, creating any missing
// intermediate "directories" as Bunny's storage API does automatically. A
// non-2xx response is returned as an error naming both the status and the
// path, so a failed deploy's log points straight at the offending file.
func (c *BunnyClient) Upload(ctx context.Context, relPath string, data []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.storageURL(relPath), bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("bunny upload %s: building request: %w", relPath, err)
	}
	req.Header.Set("AccessKey", c.StorageKey)
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("bunny upload %s: %w", relPath, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("bunny upload %s: status %d: %s", relPath, resp.StatusCode, readBody(resp))
	}
	return nil
}

// Delete removes relPath from the storage zone. A 404 is treated as
// success rather than an error: the desired end state (the file is absent
// from the zone) already holds, which matters for deploys re-run after a
// partial failure or a manifest that's slightly stale.
func (c *BunnyClient) Delete(ctx context.Context, relPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.storageURL(relPath), nil)
	if err != nil {
		return fmt.Errorf("bunny delete %s: building request: %w", relPath, err)
	}
	req.Header.Set("AccessKey", c.StorageKey)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("bunny delete %s: %w", relPath, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("bunny delete %s: status %d: %s", relPath, resp.StatusCode, readBody(resp))
	}
	return nil
}

// Purge clears the configured Pull Zone's CDN cache. Call this once, after
// all Upload/Delete calls for a deploy have completed, so stale edge copies
// of changed files are evicted.
func (c *BunnyClient) Purge(ctx context.Context) error {
	url := fmt.Sprintf("%s/pullzone/%s/purgeCache", strings.TrimRight(c.PurgeBaseURL, "/"), c.PullZoneID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return fmt.Errorf("bunny purge: building request: %w", err)
	}
	req.Header.Set("AccessKey", c.AccountAPIKey)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("bunny purge: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("bunny purge: status %d: %s", resp.StatusCode, readBody(resp))
	}
	return nil
}

// readBody best-effort reads a response body for inclusion in an error
// message; failures reading it are swallowed since the status code alone
// is already the actionable part of the error.
func readBody(resp *http.Response) string {
	body, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(body))
}

package redirects

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// --- GenerateMiddleware -----------------------------------------------

// TestGenerateMiddleware_EmitsFetchFromStorageAndRedirectLogic is the core
// scenario for the fetch-from-storage design (Task 20 Branch B — see the
// design-decision doc comment on GenerateMiddleware): at 51,511 entries the
// finevines.com redirect map serializes to ~5.4MB, and Bunny's confirmed
// Edge Scripting "Startup time" limit (500ms to evaluate the script's
// module-level code, docs.bunny.net/scripting/limits) makes an inlined
// `const REDIRECTS = {...51k keys}` a real risk on every cold isolate.
// So the generated script is a small FIXED script with no embedded map: it
// fetches redirectsURL once per isolate (memoized), builds a Map, and does
// O(1) lookups per request.
func TestGenerateMiddleware_EmitsFetchFromStorageAndRedirectLogic(t *testing.T) {
	script, err := GenerateMiddleware("https://www.finevines.com/redirects.json")
	if err != nil {
		t.Fatalf("GenerateMiddleware() error = %v", err)
	}
	got := string(script)

	for _, want := range []string{
		"https://www.finevines.com/redirects.json", // the storage URL, embedded
		"fetch(",            // cold-start fetch of the map
		"servePullZone",     // Bunny middleware attachment
		"onOriginRequest",   // Bunny middleware request-interception hook
		"status: 301",       // 301 on hit
		"Location",          // Location header on hit
		"redirects.get(",    // O(1) map lookup, not embedded literal scan
		"url.search",        // query string read for the pathname+query lookup key
		"?? redirects.get(", // pathname-alone fallback when pathname+query misses
	} {
		if !strings.Contains(got, want) {
			t.Errorf("GenerateMiddleware() output missing %q; full output:\n%s", want, got)
		}
	}

	// Design B means NO embedded map literal — the whole point is that the
	// script's size and content are independent of how many redirects
	// exist. A `const REDIRECTS = {` (design A's shape) must not appear.
	if strings.Contains(got, "const REDIRECTS") {
		t.Errorf("GenerateMiddleware() emitted an inlined REDIRECTS const — design B must not embed the map:\n%s", got)
	}
}

// TestGenerateMiddleware_PassesThroughOnFetchFailure pins the FULL fail-open
// contract, not just "a catch exists" — a regression that removed the
// redirectsPromise reset (leaving the isolate permanently stuck with an
// empty map after one transient fetch failure) would still contain the
// word "catch" and wrongly pass a looser assertion.
func TestGenerateMiddleware_PassesThroughOnFetchFailure(t *testing.T) {
	script, err := GenerateMiddleware("https://www.finevines.com/redirects.json")
	if err != nil {
		t.Fatalf("GenerateMiddleware() error = %v", err)
	}
	got := string(script)

	for _, want := range []string{
		"catch",                   // a catch/error path exists around the fetch
		"redirectsPromise = null", // failure is NOT cached — next request retries
		"new Map",                 // the catch body hands back an empty map (fail open)
	} {
		if !strings.Contains(got, want) {
			t.Errorf("GenerateMiddleware() output missing %q (fail-open contract); full output:\n%s", want, got)
		}
	}
}

// TestGenerateMiddleware_GuardsAgainstSelfFetchReentry covers the resilience
// fix from code review: loadRedirects() fetches the map through the SAME
// pull zone this middleware is attached to. If that subrequest is ever
// re-entrant on the same isolate, awaiting redirectsPromise from within the
// nested call would deadlock forever (the promise can't resolve until the
// nested call — which is itself waiting on it — returns). The guard must
// compare the incoming request's path against the map's own path and
// return BEFORE loadRedirects() is ever called.
func TestGenerateMiddleware_GuardsAgainstSelfFetchReentry(t *testing.T) {
	script, err := GenerateMiddleware("https://www.finevines.com/redirects.json")
	if err != nil {
		t.Fatalf("GenerateMiddleware() error = %v", err)
	}
	got := string(script)

	for _, want := range []string{
		"MAP_PATH",
		"url.pathname === MAP_PATH",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("GenerateMiddleware() output missing %q (reentry guard); full output:\n%s", want, got)
		}
	}

	guardIdx := strings.Index(got, "url.pathname === MAP_PATH")
	loadIdx := strings.Index(got, "await loadRedirects()")
	if guardIdx == -1 || loadIdx == -1 {
		t.Fatalf("could not locate guard (%d) or loadRedirects call (%d) in output", guardIdx, loadIdx)
	}
	if guardIdx > loadIdx {
		t.Errorf("reentry guard (offset %d) must appear BEFORE the loadRedirects() call (offset %d) — "+
			"otherwise the deadlock it's meant to prevent can still occur", guardIdx, loadIdx)
	}
}

// TestGenerateMiddleware_NeverRedirectsToSelf pins the runtime self-target
// guard: MapURLs drops identity pairs at generation time, but the map the
// script fetches is a separately-deployed asset that can be stale or
// hand-edited. A map entry whose value equals the request's own path would
// 301 the page to itself in an infinite loop, so the emitted script must
// check the target against the current path before redirecting.
func TestGenerateMiddleware_NeverRedirectsToSelf(t *testing.T) {
	script, err := GenerateMiddleware("https://www.finevines.com/redirects.json")
	if err != nil {
		t.Fatalf("GenerateMiddleware() error = %v", err)
	}
	got := string(script)

	for _, want := range []string{
		"target !== withQuery",
		"target !== url.pathname",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("GenerateMiddleware() output missing %q (self-redirect guard); full output:\n%s", want, got)
		}
	}
}

func TestGenerateMiddleware_EmptyRedirectsURLIsError(t *testing.T) {
	if _, err := GenerateMiddleware(""); err == nil {
		t.Fatal("GenerateMiddleware(\"\") error = nil, want an error for an empty redirects URL")
	}
}

func TestGenerateMiddleware_DeterministicForSameInput(t *testing.T) {
	a, err1 := GenerateMiddleware("https://x.example/redirects.json")
	b, err2 := GenerateMiddleware("https://x.example/redirects.json")
	if err1 != nil || err2 != nil {
		t.Fatalf("unexpected errors: %v / %v", err1, err2)
	}
	if string(a) != string(b) {
		t.Error("GenerateMiddleware output is not deterministic for identical input — " +
			"it must not embed a timestamp or other run-to-run noise, since the generated " +
			"file is committed to the repo for reproducibility")
	}
}

// --- PublishMiddleware ---------------------------------------------------

func TestPublishMiddleware_UploadsCodeThenPublishesRelease(t *testing.T) {
	type call struct {
		method, path, accessKey string
		body                    map[string]string
	}
	var mu sync.Mutex
	var calls []call

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)

		mu.Lock()
		calls = append(calls, call{
			method:    r.Method,
			path:      r.URL.Path,
			accessKey: r.Header.Get("AccessKey"),
			body:      body,
		})
		mu.Unlock()

		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := NewScriptClient("test-account-api-key", "98765", srv.Client())
	client.BaseURL = srv.URL

	script := []byte("// generated middleware\n")
	if err := PublishMiddleware(context.Background(), client, script); err != nil {
		t.Fatalf("PublishMiddleware() error = %v", err)
	}

	if len(calls) != 2 {
		t.Fatalf("got %d requests, want 2 (set code, then publish release): %+v", len(calls), calls)
	}

	setCode := calls[0]
	if setCode.method != http.MethodPost {
		t.Errorf("set-code request method = %q, want POST", setCode.method)
	}
	if setCode.path != "/compute/script/98765/code" {
		t.Errorf("set-code request path = %q, want /compute/script/98765/code", setCode.path)
	}
	if setCode.accessKey != "test-account-api-key" {
		t.Errorf("set-code AccessKey header = %q, want test-account-api-key", setCode.accessKey)
	}
	if setCode.body["Code"] != string(script) {
		t.Errorf("set-code request body Code = %q, want %q", setCode.body["Code"], string(script))
	}

	publish := calls[1]
	if publish.method != http.MethodPost {
		t.Errorf("publish request method = %q, want POST", publish.method)
	}
	if publish.path != "/compute/script/98765/publish" {
		t.Errorf("publish request path = %q, want /compute/script/98765/publish", publish.path)
	}
	if publish.accessKey != "test-account-api-key" {
		t.Errorf("publish AccessKey header = %q, want test-account-api-key", publish.accessKey)
	}
}

func TestPublishMiddleware_SetCodeNon2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("bad key"))
	}))
	defer srv.Close()

	client := NewScriptClient("bad-key", "1", srv.Client())
	client.BaseURL = srv.URL

	err := PublishMiddleware(context.Background(), client, []byte("x"))
	if err == nil {
		t.Fatal("PublishMiddleware() error = nil, want error on non-2xx set-code response")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error = %v, want it to mention status 401", err)
	}
}

func TestPublishMiddleware_PublishNon2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/code") {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer srv.Close()

	client := NewScriptClient("k", "1", srv.Client())
	client.BaseURL = srv.URL

	err := PublishMiddleware(context.Background(), client, []byte("x"))
	if err == nil {
		t.Fatal("PublishMiddleware() error = nil, want error on non-2xx publish response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error = %v, want it to mention status 500", err)
	}
}

func TestPublishMiddleware_PublishNotCalledWhenSetCodeFails(t *testing.T) {
	var publishCalled bool
	var mu sync.Mutex

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/publish") {
			mu.Lock()
			publishCalled = true
			mu.Unlock()
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := NewScriptClient("k", "1", srv.Client())
	client.BaseURL = srv.URL

	_ = PublishMiddleware(context.Background(), client, []byte("x"))

	mu.Lock()
	defer mu.Unlock()
	if publishCalled {
		t.Error("publish endpoint was called even though the set-code step failed")
	}
}

func TestNewScriptClient_DefaultBaseURLIsBunnyAPI(t *testing.T) {
	c := NewScriptClient("key", "1", nil)
	if c.BaseURL != "https://api.bunny.net" {
		t.Errorf("default BaseURL = %q, want https://api.bunny.net", c.BaseURL)
	}
}

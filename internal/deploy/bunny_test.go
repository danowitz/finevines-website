package deploy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testStorageZone   = "finevines-zone"
	testStorageKey    = "storage-secret-key"
	testAccountAPIKey = "account-secret-key"
	testPullZoneID    = "12345"
)

func newTestClient(t *testing.T, srv *httptest.Server) *BunnyClient {
	t.Helper()
	return NewBunnyClient(srv.URL, testStorageZone, testStorageKey, testAccountAPIKey, testPullZoneID, srv.Client())
}

func TestBunnyClient_UploadSendsCorrectRequest(t *testing.T) {
	var gotMethod, gotPath, gotAccessKey string
	var gotBody []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAccessKey = r.Header.Get("AccessKey")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.Upload(context.Background(), "css/site.css", []byte("body{}"))
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}

	wantPath := "/" + testStorageZone + "/css/site.css"
	if gotMethod != http.MethodPut {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotPath != wantPath {
		t.Errorf("path = %q, want %q", gotPath, wantPath)
	}
	if gotAccessKey != testStorageKey {
		t.Errorf("AccessKey header = %q, want %q", gotAccessKey, testStorageKey)
	}
	if string(gotBody) != "body{}" {
		t.Errorf("body = %q, want %q", string(gotBody), "body{}")
	}
}

func TestBunnyClient_UploadNon2xxReturnsErrorWithStatusAndPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte("bad key"))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.Upload(context.Background(), "wines/foo.html", []byte("x"))
	if err == nil {
		t.Fatal("expected error for 401 response, got nil")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error = %q, want it to contain status 401", err.Error())
	}
	if !strings.Contains(err.Error(), "wines/foo.html") {
		t.Errorf("error = %q, want it to contain the path", err.Error())
	}
}

func TestBunnyClient_DeleteSendsCorrectRequest(t *testing.T) {
	var gotMethod, gotPath, gotAccessKey string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAccessKey = r.Header.Get("AccessKey")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.Delete(context.Background(), "old/page.html")
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}

	wantPath := "/" + testStorageZone + "/old/page.html"
	if gotMethod != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", gotMethod)
	}
	if gotPath != wantPath {
		t.Errorf("path = %q, want %q", gotPath, wantPath)
	}
	if gotAccessKey != testStorageKey {
		t.Errorf("AccessKey header = %q, want %q", gotAccessKey, testStorageKey)
	}
}

func TestBunnyClient_DeleteNon2xxReturnsErrorWithStatusAndPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("boom"))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.Delete(context.Background(), "old/page.html")
	if err == nil {
		t.Fatal("expected error for 500 response, got nil")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error = %q, want it to contain status 500", err.Error())
	}
	if !strings.Contains(err.Error(), "old/page.html") {
		t.Errorf("error = %q, want it to contain the path", err.Error())
	}
}

// Delete treats 404 as success: the desired end state (file absent from the
// storage zone) is already true, so a stale manifest entry pointing at an
// already-deleted file shouldn't fail the deploy.
func TestBunnyClient_Delete404IsTreatedAsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	if err := c.Delete(context.Background(), "already/gone.html"); err != nil {
		t.Errorf("Delete on 404 should be treated as success, got error: %v", err)
	}
}

func TestBunnyClient_PurgeSendsCorrectRequest(t *testing.T) {
	var gotMethod, gotPath, gotAccessKey string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAccessKey = r.Header.Get("AccessKey")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Purge always targets https://api.bunny.net, not the injected storage
	// endpoint, so this test only verifies method/path/header via a client
	// pointed at the test server through a swapped base -- see NewBunnyClient
	// doc comment: PurgeBaseURL is overridable for exactly this reason.
	c := NewBunnyClient(srv.URL, testStorageZone, testStorageKey, testAccountAPIKey, testPullZoneID, srv.Client())
	c.PurgeBaseURL = srv.URL

	err := c.Purge(context.Background())
	if err != nil {
		t.Fatalf("Purge returned error: %v", err)
	}

	wantPath := "/pullzone/" + testPullZoneID + "/purgeCache"
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != wantPath {
		t.Errorf("path = %q, want %q", gotPath, wantPath)
	}
	if gotAccessKey != testAccountAPIKey {
		t.Errorf("AccessKey header = %q, want %q", gotAccessKey, testAccountAPIKey)
	}
}

func TestBunnyClient_PurgeNon2xxReturnsErrorWithStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte("no access"))
	}))
	defer srv.Close()

	c := NewBunnyClient(srv.URL, testStorageZone, testStorageKey, testAccountAPIKey, testPullZoneID, srv.Client())
	c.PurgeBaseURL = srv.URL

	err := c.Purge(context.Background())
	if err == nil {
		t.Fatal("expected error for 403 response, got nil")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error = %q, want it to contain status 403", err.Error())
	}
}

// One storage zone is fronted by TWO pull zones (finevines-com for the
// b-cdn.net preview, finevines-biz for finevines.biz), so PullZoneID accepts
// comma-separated IDs and Purge must clear every one — purging only the
// first left finevines.biz serving stale HTML for its full TTL (live
// incident 2026-07-29).
func TestBunnyClient_PurgeClearsEveryCommaSeparatedZone(t *testing.T) {
	var gotPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := NewBunnyClient(srv.URL, testStorageZone, testStorageKey, testAccountAPIKey, "6207738, 6234793", srv.Client())
	c.PurgeBaseURL = srv.URL

	if err := c.Purge(context.Background()); err != nil {
		t.Fatalf("Purge returned error: %v", err)
	}
	want := []string{"/pullzone/6207738/purgeCache", "/pullzone/6234793/purgeCache"}
	if len(gotPaths) != 2 || gotPaths[0] != want[0] || gotPaths[1] != want[1] {
		t.Errorf("purge paths = %v, want %v", gotPaths, want)
	}
}

func TestBunnyClient_DefaultPurgeBaseURLIsBunnyAPI(t *testing.T) {
	c := NewBunnyClient("https://storage.bunnycdn.com", testStorageZone, testStorageKey, testAccountAPIKey, testPullZoneID, nil)
	if c.PurgeBaseURL != "https://api.bunny.net" {
		t.Errorf("default PurgeBaseURL = %q, want https://api.bunny.net", c.PurgeBaseURL)
	}
}

// Download is the read side of the same storage zone Upload writes to. The
// hosted review processor uses it for immutable actions and package objects.
func TestBunnyClient_DownloadReturnsBodyAndSendsAccessKey(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotKey = r.URL.Path, r.Header.Get("AccessKey")
		w.Write([]byte(`[{"id":"a1"}]`))
	}))
	defer srv.Close()

	c := NewBunnyClient(srv.URL, "finevines", "storage-key", "acct-key", "1", srv.Client())
	got, err := c.Download(context.Background(), "_review/production/actions/action.json")
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if string(got) != `[{"id":"a1"}]` {
		t.Errorf("Download body = %q", got)
	}
	if gotPath != "/finevines/_review/production/actions/action.json" {
		t.Errorf("Download path = %q, want protected action path", gotPath)
	}
	if gotKey != "storage-key" {
		t.Errorf("Download AccessKey = %q, want the storage key", gotKey)
	}
}

// A 404 is an ordinary absent protected object. Return empty bytes, no error.
func TestBunnyClient_DownloadMissingIsEmptyNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewBunnyClient(srv.URL, "finevines", "k", "a", "1", srv.Client())
	got, err := c.Download(context.Background(), "_review/production/actions/action.json")
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("Download of a missing file = %q, want empty", got)
	}
}

func TestBunnyClient_ListReturnsOnlyDirectFiles(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotKey = r.URL.Path, r.Header.Get("AccessKey")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"ObjectName":"one.json","IsDirectory":false},{"ObjectName":"nested","IsDirectory":true},{"ObjectName":"two.json","IsDirectory":false}]`))
	}))
	defer srv.Close()

	c := NewBunnyClient(srv.URL, "finevines", "storage-key", "acct-key", "1", srv.Client())
	got, err := c.List(context.Background(), "_review/production/pending")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if gotPath != "/finevines/_review/production/pending/" || gotKey != "storage-key" {
		t.Fatalf("List request = %s key %q", gotPath, gotKey)
	}
	if len(got) != 2 || got[0] != "one.json" || got[1] != "two.json" {
		t.Fatalf("List = %#v", got)
	}
}

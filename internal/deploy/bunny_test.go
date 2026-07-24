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

func TestBunnyClient_DefaultPurgeBaseURLIsBunnyAPI(t *testing.T) {
	c := NewBunnyClient("https://storage.bunnycdn.com", testStorageZone, testStorageKey, testAccountAPIKey, testPullZoneID, nil)
	if c.PurgeBaseURL != "https://api.bunny.net" {
		t.Errorf("default PurgeBaseURL = %q, want https://api.bunny.net", c.PurgeBaseURL)
	}
}

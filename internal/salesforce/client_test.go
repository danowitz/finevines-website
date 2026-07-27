package salesforce

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// TestRosterAuthenticatesAndPaginates drives Client against an httptest
// server that plays the role of a Salesforce org: a token endpoint for the
// Client Credentials Flow, and a two-page SOQL query result (page 1
// done:false + nextRecordsUrl, page 2 done:true). It asserts the token
// request body, the Bearer auth header on every query call, and that
// Roster stitches both pages into one ordered slice of WineRaw.
func TestRosterAuthenticatesAndPaginates(t *testing.T) {
	const wantToken = "tok123"
	const wantClientID = "id-abc-123"
	const wantClientSecret = "secret-xyz-789"

	var queryPaths []string

	mux := http.NewServeMux()

	mux.HandleFunc("/services/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("token request method = %s, want POST", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
			t.Errorf("token request Content-Type = %q, want application/x-www-form-urlencoded", ct)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse token request form: %v", err)
		}
		if got := r.PostForm.Get("grant_type"); got != "client_credentials" {
			t.Errorf("grant_type = %q, want client_credentials", got)
		}
		if got := r.PostForm.Get("client_id"); got != wantClientID {
			t.Errorf("client_id = %q, want %q", got, wantClientID)
		}
		if got := r.PostForm.Get("client_secret"); got != wantClientSecret {
			t.Errorf("client_secret = %q, want %q", got, wantClientSecret)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"access_token": wantToken,
			"instance_url": "http://example.invalid",
			"token_type":   "Bearer",
		})
	})

	mux.HandleFunc("/services/data/v61.0/query", func(w http.ResponseWriter, r *http.Request) {
		queryPaths = append(queryPaths, r.URL.String())
		if got := r.Header.Get("Authorization"); got != "Bearer "+wantToken {
			t.Errorf("page 1 Authorization = %q, want %q", got, "Bearer "+wantToken)
		}
		if q := r.URL.Query().Get("q"); q == "" {
			t.Errorf("page 1 request missing SOQL query string")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize":      3,
			"done":           false,
			"nextRecordsUrl": "/services/data/v61.0/query/01g-2",
			"records": []map[string]any{
				{
					"Id": "01t000000001AAA", "StockKeepingUnit": "AB1001",
					"FV_Brand__c": "Chateau Alpha", "Name": "Alpha Reserve",
					"FV_Vintage_Year__c": "2019", "FV_Varietal__c": "Cabernet Sauvignon",
					"FV_Region__c": "Napa Valley", "FV_OnHand_Qty__c": 12,
				},
				{
					"Id": "01t000000002BBB", "StockKeepingUnit": "AB1002",
					"FV_Brand__c": "Chateau Beta", "Name": "Beta Blanc",
					"FV_Vintage_Year__c": "2021", "FV_Varietal__c": "Chardonnay",
					"FV_Region__c": "Sonoma Coast", "FV_OnHand_Qty__c": 0,
				},
			},
		})
	})

	mux.HandleFunc("/services/data/v61.0/query/01g-2", func(w http.ResponseWriter, r *http.Request) {
		queryPaths = append(queryPaths, r.URL.String())
		if got := r.Header.Get("Authorization"); got != "Bearer "+wantToken {
			t.Errorf("page 2 Authorization = %q, want %q", got, "Bearer "+wantToken)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize":      3,
			"done":           true,
			"nextRecordsUrl": "",
			"records": []map[string]any{
				{
					"Id": "01t000000003CCC", "StockKeepingUnit": "9X9999",
					"FV_Brand__c": "Chateau Gamma", "Name": "Gamma Noir",
					"FV_Vintage_Year__c": "2018", "FV_Varietal__c": "Pinot Noir",
					"FV_Region__c": "Willamette Valley", "FV_OnHand_Qty__c": 4,
				},
			},
		})
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	cfg := Config{
		BaseURL:      server.URL,
		ClientID:     wantClientID,
		ClientSecret: wantClientSecret,
		APIVersion:   "v61.0",
	}
	client := NewClient(cfg, server.Client())

	got, err := client.Roster(context.Background())
	if err != nil {
		t.Fatalf("Roster() error = %v", err)
	}

	// Appellation and Style are intentionally absent: Product2 has no field
	// for them, so Roster leaves them empty and the search-scrape enrichment
	// step fills them later.
	want := []WineRaw{
		{
			ID: "01t000000001AAA", SKU: "AB1001", Producer: "Chateau Alpha",
			Name: "Alpha Reserve", Vintage: "2019", Varietal: "Cabernet Sauvignon",
			Region: "Napa Valley", StockQty: 12,
		},
		{
			ID: "01t000000002BBB", SKU: "AB1002", Producer: "Chateau Beta",
			Name: "Beta Blanc", Vintage: "2021", Varietal: "Chardonnay",
			Region: "Sonoma Coast", StockQty: 0,
		},
		{
			ID: "01t000000003CCC", SKU: "9X9999", Producer: "Chateau Gamma",
			Name: "Gamma Noir", Vintage: "2018", Varietal: "Pinot Noir",
			Region: "Willamette Valley", StockQty: 4,
		},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Roster() = %#v, want %#v", got, want)
	}

	if len(queryPaths) != 2 {
		t.Fatalf("expected 2 query calls (page 1 + follow-up page), got %d: %v", len(queryPaths), queryPaths)
	}
}

// TestAuthenticateFailureIsActionable ensures a non-200 token response
// produces an error that points at the connected-app setup rather than a
// bare status code.
func TestAuthenticateFailureIsActionable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL, ClientID: "id", ClientSecret: "secret", APIVersion: "v61.0"}
	client := NewClient(cfg, server.Client())

	_, err := client.Roster(context.Background())
	if err == nil {
		t.Fatal("Roster() error = nil, want error for HTTP 401 from token endpoint")
	}
	if !strings.Contains(err.Error(), "JWT Bearer") {
		t.Errorf("auth error = %q, want it to mention the JWT Bearer fallback (pinning the actionable "+
			"guidance so a future edit can't silently regress it)", err.Error())
	}
}

// TestRosterErrorsOnTruncatedPagination ensures a contract-violating
// response (done:false with no nextRecordsUrl to follow) fails loudly
// instead of silently returning a truncated roster. This pipeline decides
// which wines are shown on the public catalog, so a silently dropped page
// of inventory would be worse than an explicit error.
func TestRosterErrorsOnTruncatedPagination(t *testing.T) {
	mux := http.NewServeMux()

	mux.HandleFunc("/services/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"access_token": "tok123",
			"instance_url": "http://example.invalid",
			"token_type":   "Bearer",
		})
	})

	mux.HandleFunc("/services/data/v61.0/query", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize":      3,
			"done":           false,
			"nextRecordsUrl": "",
			"records": []map[string]any{
				{
					"Id": "01t000000001AAA", "StockKeepingUnit": "AB1001",
					"Producer__c": "Chateau Alpha", "Name": "Alpha Reserve",
					"Vintage__c": "2019", "Varietal__c": "Cabernet Sauvignon",
					"Region__c": "Napa Valley", "Appellation__c": "Oakville",
					"Style__c": "Red", "Stock_Qty__c": 12,
				},
			},
		})
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	cfg := Config{BaseURL: server.URL, ClientID: "id", ClientSecret: "secret", APIVersion: "v61.0"}
	client := NewClient(cfg, server.Client())

	_, err := client.Roster(context.Background())
	if err == nil {
		t.Fatal("Roster() error = nil, want error for done:false with empty nextRecordsUrl")
	}
	if !strings.Contains(err.Error(), "nextRecordsUrl") && !strings.Contains(err.Error(), "truncat") {
		t.Errorf("truncation error = %q, want it to mention nextRecordsUrl or truncation", err.Error())
	}
}

// compile-time check kept alongside the tests: Client must satisfy Source.
var _ Source = (*Client)(nil)

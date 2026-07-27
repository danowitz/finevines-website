package salesforce

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Config holds the connected-app credentials and org endpoint needed to
// authenticate and query Salesforce. BaseURL is the org's My Domain URL
// (e.g. "https://finevines.my.salesforce.com"), delivered by the Salesforce
// admin together with ClientID/ClientSecret (see plan action item C1).
// APIVersion is a REST API version string like "v61.0".
type Config struct {
	BaseURL, ClientID, ClientSecret, APIVersion string
}

// Client is a Source backed by a live Salesforce org, reached via the
// OAuth 2.0 Client Credentials Flow and the REST API's SOQL query endpoint.
type Client struct {
	cfg  Config
	http *http.Client
	tok  string
}

// Client must satisfy Source so enrich orchestration never depends on
// Salesforce-specific types.
var _ Source = (*Client)(nil)

// NewClient builds a Client for the given org config. hc is injected
// (rather than hardcoded to http.DefaultClient) so tests can point it at an
// httptest.Server; production wiring should pass http.DefaultClient or an
// *http.Client configured with a sane timeout.
//
// cfg.BaseURL has any trailing slash trimmed so a copy-pasted My Domain URL
// like "https://finevines.my.salesforce.com/" doesn't produce a doubled
// slash ("//services/...") once path suffixes are appended.
func NewClient(cfg Config, hc *http.Client) *Client {
	cfg.BaseURL = strings.TrimSuffix(cfg.BaseURL, "/")
	return &Client{cfg: cfg, http: hc}
}

// rosterSOQL pulls every candidate wine row in one paginated query.
//
// Field mapping RESOLVED 2026-07-27 from the org's Enterprise WSDL
// (docs/salesforce/enterprise.wsdl, gitignored): the wine catalog lives on the
// standard Product2 object with FineVines custom fields (FV_ prefix). SKU is
// the standard StockKeepingUnit; stock-on-hand is FV_OnHand_Qty__c (an
// xsd:double). There is NO Salesforce field for appellation or style — those
// stay empty here and are filled by the search-scrape enrichment step.
//
// ⚠ THREE mappings still await a one-word client confirmation (raised via
// AskUserQuestion in the 2026-07-27 session); each is a single-token edit here
// plus its line in the Roster mapping below:
//   1. producer -> FV_Brand__c  (alt: FV_Supplier__c, the importer/vendor)
//   2. stock    -> FV_OnHand_Qty__c  (alt: AVSFQB__OnHand__c, raw QB-connector)
//   3. whether FV_Ready_To_Sell__c should additionally gate web-eligibility on
//      top of the confirmed `stockQty > 0 AND !SKU^"9"` rule (enrich.Eligible).
// The field->WineRaw mapping in Roster is the one other place that must change
// in lockstep — keeping both in this one file is deliberate.
//
// Additional authoritative Product2 fields exist and will be pulled in once
// WineRaw/model.Wine expand for the scraped schema: FV_Country__c, FV_Color__c,
// FV_ALC_Percent__c, FV_Bottle_Size__c, FV_Bottles_Per_Case__c, FV_List_Price__c,
// FV_Net_Price__c, FV_BTG_Price__c, FV_Category__c, FV_Rating__c.
const rosterSOQL = `SELECT Id, StockKeepingUnit, Name, FV_Brand__c,
 FV_Vintage_Year__c, FV_Varietal__c, FV_Region__c, FV_OnHand_Qty__c
 FROM Product2`

// Roster authenticates and runs rosterSOQL, following nextRecordsUrl until
// Salesforce reports done:true, mapping every record into a WineRaw in API
// order. Eligibility (stock/SKU filtering) is applied by the caller.
func (c *Client) Roster(ctx context.Context) ([]WineRaw, error) {
	if err := c.authenticate(ctx); err != nil {
		return nil, err
	}

	var out []WineRaw
	next := fmt.Sprintf("/services/data/%s/query?q=%s", c.cfg.APIVersion,
		url.QueryEscape(strings.Join(strings.Fields(rosterSOQL), " ")))

	for next != "" {
		var page struct {
			Done           bool             `json:"done"`
			NextRecordsURL string           `json:"nextRecordsUrl"`
			Records        []map[string]any `json:"records"`
		}
		if err := c.getJSON(ctx, next, &page); err != nil {
			return nil, err
		}

		// ⚠ This mapping must move in lockstep with rosterSOQL's SELECT list
		// above (see its doc comment for the three field choices still
		// awaiting client confirmation).
		for _, r := range page.Records {
			out = append(out, WineRaw{
				ID:       str(r["Id"]),
				SKU:      str(r["StockKeepingUnit"]),
				Producer: str(r["FV_Brand__c"]),
				Name:     str(r["Name"]),
				Vintage:  str(r["FV_Vintage_Year__c"]),
				Varietal: str(r["FV_Varietal__c"]),
				Region:   str(r["FV_Region__c"]),
				StockQty: intval(r["FV_OnHand_Qty__c"]),
				// Appellation and Style have no Product2 field — both are
				// populated later by the search-scrape enrichment step.
			})
		}

		next = ""
		if !page.Done {
			// A contract violation (done:false but no nextRecordsUrl to
			// follow) must fail loudly rather than silently truncate the
			// roster: this pipeline decides which wines ship to the public
			// catalog, and dropping inventory silently is worse than
			// erroring out.
			if page.NextRecordsURL == "" {
				return nil, fmt.Errorf("salesforce query: server reported done=false with no " +
					"nextRecordsUrl (roster would be truncated)")
			}
			next = page.NextRecordsURL
		}
	}
	return out, nil
}

// authenticate runs the OAuth 2.0 Client Credentials Flow against the org's
// token endpoint (POST {BaseURL}/services/oauth2/token) and stores the
// resulting access token on c for use by subsequent query calls.
//
// Fallback: some org editions/security policies block the Client
// Credentials Flow outright (or require network-range restrictions that
// don't fit an automated pipeline like this one). If that happens, switch
// to the JWT Bearer Flow instead: cert-based, grant_type
// "urn:ietf:params:oauth:grant-type:jwt-bearer", with a signed JWT
// assertion in place of client_secret. That swap is an isolated change
// confined to this one function — Roster, getJSON, and the rest of Client
// are unaffected either way.
func (c *Client) authenticate(ctx context.Context) error {
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {c.cfg.ClientID},
		"client_secret": {c.cfg.ClientSecret},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.cfg.BaseURL+"/services/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("salesforce auth: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("salesforce auth: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("salesforce auth: HTTP %d (check the connected app's Client Credentials Flow "+
			"setup and the run-as integration user's permissions; if the org's edition or policy blocks "+
			"client credentials, fall back to the JWT Bearer flow — see the doc comment on authenticate)",
			resp.StatusCode)
	}

	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return fmt.Errorf("salesforce auth: decode token response: %w", err)
	}
	if body.AccessToken == "" {
		return fmt.Errorf("salesforce auth: token response had no access_token")
	}
	c.tok = body.AccessToken
	return nil
}

// getJSON issues an authenticated GET against path (relative to BaseURL)
// and decodes the JSON response into v.
func (c *Client) getJSON(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+path, nil)
	if err != nil {
		return fmt.Errorf("salesforce query %s: build request: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.tok)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("salesforce query %s: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("salesforce query %s: HTTP %d", path, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		return fmt.Errorf("salesforce query %s: decode response: %w", path, err)
	}
	return nil
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func intval(v any) int {
	f, _ := v.(float64) // Salesforce numbers arrive as JSON numbers (float64).
	return int(f)
}

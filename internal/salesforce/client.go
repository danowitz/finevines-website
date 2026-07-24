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
// ⚠ CHECKPOINT (client action item C1): the object name (Product2) and every
// field API name below (StockKeepingUnit, Producer__c, Vintage__c,
// Varietal__c, Region__c, Appellation__c, Style__c, Stock_Qty__c) are
// PROVISIONAL GUESSES against a standard Product2 layout — they have NOT
// been confirmed against the real Fine Vines org. Before the first live
// run, pull the real object/field API names (Workbench "Data > Query" or
// `sf sobject describe --sobject Product2`), in particular which field
// actually carries the QuickBooks-synced stock quantity, and correct the
// SOQL text below. The field->WineRaw mapping in Roster, just below this
// query, is the one other place that must change in lockstep — keeping
// both in one function is deliberate so the fix is a single, obvious edit.
const rosterSOQL = `SELECT Id, StockKeepingUnit, Producer__c, Name, Vintage__c,
 Varietal__c, Region__c, Appellation__c, Style__c, Stock_Qty__c FROM Product2`

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

		// ⚠ See the CHECKPOINT comment on rosterSOQL above: this mapping
		// must be corrected in lockstep with the SOQL field list once the
		// real org's field names are known.
		for _, r := range page.Records {
			out = append(out, WineRaw{
				ID:          str(r["Id"]),
				SKU:         str(r["StockKeepingUnit"]),
				Producer:    str(r["Producer__c"]),
				Name:        str(r["Name"]),
				Vintage:     str(r["Vintage__c"]),
				Varietal:    str(r["Varietal__c"]),
				Region:      str(r["Region__c"]),
				Appellation: str(r["Appellation__c"]),
				Style:       str(r["Style__c"]),
				StockQty:    intval(r["Stock_Qty__c"]),
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

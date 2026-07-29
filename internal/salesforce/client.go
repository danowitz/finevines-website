package salesforce

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
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
	cfg         Config
	http        *http.Client
	tok         string
	identityURL string // "id" URL from the token response — reveals the run-as user
}

// RunningUserID returns the Salesforce user ID the access token was issued for
// (the trailing segment of the token response's identity URL), or "" if not yet
// authenticated. Diagnostic aid: confirms WHICH run-as user the Client
// Credentials Flow is actually executing as.
func (c *Client) RunningUserID() string {
	if i := strings.LastIndex(c.identityURL, "/"); i >= 0 {
		return c.identityURL[i+1:]
	}
	return ""
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
// Field mapping VERIFIED against LIVE org data 2026-07-27 (28,953 Product2
// rows). The WSDL gave the field NAMES but not their real contents; the live
// data is raw QuickBooks-synced trade shorthand, so the clean consumer catalog
// comes from the search-enrichment step, NOT these fields directly:
//   - SKU        <- Name              (the item number, e.g. "710908";
//     StockKeepingUnit is EMPTY in this org)
//   - Name (raw) <- Description        (terse "14 LAMY ST AUBIN ROUGE 1C ...
//     12/750"; enrichment produces the clean
//     wine name — there is no clean-name field)
//   - Producer   <- FV_Brand__c        ("LAMY, HUBERT" — Last, First; enrichment
//     normalizes)
//   - Vintage    <- FV_Vintage_Year__c ("14" — two-digit; enrichment expands)
//   - Varietal   <- FV_Varietal__c, Region <- FV_Region__c, Country <- FV_Country__c
//   - StockQty   <- FV_OnHand_Qty__c    (FRACTIONAL cases, e.g. 0.66 — see
//     ceilStock; truncation would drop it)
//   - ReadyToSell<- FV_Ready_To_Sell__c
//
// Pricing fields (FV_Net_Price__c/FV_List_Price__c/COGS/…) are deliberately NOT
// pulled — the public catalog shows no prices (client decision). Appellation,
// Style, ABV, colour, etc. are filled by enrichment. The field->WineRaw mapping
// in Roster must move in lockstep with this SELECT list.
const rosterSOQL = `SELECT Id, Name, Description, FV_Brand__c, FV_Vintage_Year__c,
 FV_Varietal__c, FV_Region__c, FV_Country__c, FV_OnHand_Qty__c, FV_Ready_To_Sell__c
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
				ID:          str(r["Id"]),
				SKU:         str(r["Name"]),        // item number; StockKeepingUnit is empty in this org
				Producer:    str(r["FV_Brand__c"]), // "LAST, FIRST" — enrichment normalizes
				Name:        str(r["Description"]), // terse trade description; enrichment produces the clean name
				Vintage:     str(r["FV_Vintage_Year__c"]),
				Varietal:    str(r["FV_Varietal__c"]),
				Region:      str(r["FV_Region__c"]),
				Country:     str(r["FV_Country__c"]),
				StockQty:    ceilStock(r["FV_OnHand_Qty__c"]), // fractional cases -> ceil
				ReadyToSell: boolval(r["FV_Ready_To_Sell__c"]),
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

// Query runs an arbitrary SOQL string and returns the raw records, following
// pagination. It's a diagnostic/discovery helper (used by tools/sfquery) — the
// production roster pull is Roster. It authenticates on first use.
func (c *Client) Query(ctx context.Context, soql string) ([]map[string]any, error) {
	if c.tok == "" {
		if err := c.authenticate(ctx); err != nil {
			return nil, err
		}
	}
	var out []map[string]any
	next := fmt.Sprintf("/services/data/%s/query?q=%s", c.cfg.APIVersion, url.QueryEscape(soql))
	for next != "" {
		var page struct {
			Done           bool             `json:"done"`
			NextRecordsURL string           `json:"nextRecordsUrl"`
			Records        []map[string]any `json:"records"`
		}
		if err := c.getJSON(ctx, next, &page); err != nil {
			return out, err
		}
		out = append(out, page.Records...)
		next = ""
		if !page.Done {
			next = page.NextRecordsURL
		}
	}
	return out, nil
}

// SalesTotals returns NET cases sold per Product2 Id over the trailing `days`
// days, read from the org's invoice ledger: QuickBooks invoices sync into
// Salesforce as Opportunities (AVSFQB connector, verified live 2026-07-29), so
// OpportunityLineItem IS the sales ledger. Quantity is in CASES and fractional
// (0.08 ≈ one bottle of a 12-pack — same convention as FV_OnHand_Qty__c), and
// credit/return lines carry negative quantities, so a plain sum yields net
// movement.
//
// Aggregated in Go rather than with SOQL GROUP BY: aggregate queries cap at
// 2,000 result rows and cannot be paginated past it, while this raw line pull
// rides Query's nextRecordsUrl loop, so no sales volume silently truncates.
func (c *Client) SalesTotals(ctx context.Context, days int) (map[string]float64, error) {
	soql := fmt.Sprintf("SELECT Product2Id, Quantity FROM OpportunityLineItem "+
		"WHERE CreatedDate = LAST_N_DAYS:%d", days)
	rows, err := c.Query(ctx, soql)
	if err != nil {
		return nil, fmt.Errorf("salesforce sales totals: %w", err)
	}
	totals := make(map[string]float64)
	for _, r := range rows {
		id, _ := r["Product2Id"].(string)
		if id == "" {
			continue
		}
		q, _ := r["Quantity"].(float64)
		totals[id] += q
	}
	return totals, nil
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
		ID          string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return fmt.Errorf("salesforce auth: decode token response: %w", err)
	}
	if body.AccessToken == "" {
		return fmt.Errorf("salesforce auth: token response had no access_token")
	}
	c.tok = body.AccessToken
	c.identityURL = body.ID
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
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
		return fmt.Errorf("salesforce query %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
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

// ceilStock converts FV_OnHand_Qty__c to an int, rounding UP. That field is
// fractional (cases, e.g. 0.66), and a plain int() truncation would turn a
// genuinely in-stock 0.66 into 0 — silently dropping the wine from the web
// catalog. Ceil preserves the ">0" eligibility test; the exact count is never
// shown publicly. Zero/negative stays 0.
func ceilStock(v any) int {
	f, _ := v.(float64)
	if f <= 0 {
		return 0
	}
	return int(math.Ceil(f))
}

func boolval(v any) bool {
	b, _ := v.(bool) // Salesforce checkbox fields arrive as JSON true/false.
	return b
}

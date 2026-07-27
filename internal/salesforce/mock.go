package salesforce

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
)

// mockRosterJSON is a representative sample roster — a realistic spread of
// producers, regions, varietals, styles, and stock levels (plus a few
// deliberately web-INELIGIBLE rows: SKUs beginning "9" and stock-0 lines) so
// the eligibility filter, diff, build, and portfolio UI can all be exercised
// end-to-end WITHOUT a live Salesforce org. It is shaped exactly like the rows
// Client.Roster maps out of the real REST/SOQL response, so swapping MockSource
// for the live Client is a one-line change in runEnrich and nothing downstream
// can tell the difference.
//
//go:embed testdata/mock_roster.json
var mockRosterJSON []byte

// MockSource is a Source backed by the embedded sample roster instead of a
// live org. It exists so the enrich → build → preview pipeline (and the
// demoseed tool) can run with zero Salesforce credentials while the real
// Connected App is being provisioned (see GitHub issue #1). Selected at
// runtime by FINEVINES_SF_MOCK — see cmd/finevines/main.go's runEnrich.
type MockSource struct {
	roster []WineRaw
}

// MockSource must satisfy Source so enrich orchestration treats it
// identically to the live Client.
var _ Source = (*MockSource)(nil)

// NewMockSource parses the embedded sample roster once and returns a ready
// MockSource. It returns an error only if the embedded JSON is malformed,
// which would be a build-time authoring mistake in mock_roster.json rather
// than anything that can happen at runtime.
func NewMockSource() (*MockSource, error) {
	var roster []WineRaw
	if err := json.Unmarshal(mockRosterJSON, &roster); err != nil {
		return nil, fmt.Errorf("salesforce: parse embedded mock roster: %w", err)
	}
	return &MockSource{roster: roster}, nil
}

// Roster returns a fresh copy of the sample roster in file order. The copy
// keeps callers from mutating MockSource's shared backing slice, matching the
// live Client's semantics where every call yields independent rows.
func (m *MockSource) Roster(context.Context) ([]WineRaw, error) {
	out := make([]WineRaw, len(m.roster))
	copy(out, m.roster)
	return out, nil
}

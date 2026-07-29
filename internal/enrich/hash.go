package enrich

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// sourceHashInput is the subset of WineRaw that participates in SourceHash:
// the identity and descriptive fields that actually feed enrichment. The
// volatile operational fields — StockQty, ReadyToSell — are deliberately
// excluded: stock moves with every sale, and hashing it would re-enrich (and
// re-bill OpenAI for) wines whose descriptive data never changed. Both still
// gate eligibility upstream (enrich.Eligible), so stock-outs and ready-to-sell
// flips still add/remove wines from the site — they just don't re-enrich them.
// Kept wines get their StockQty refreshed by DiffRoster instead.
type sourceHashInput struct {
	ID, SKU, Producer, Name, Vintage, Varietal, Region, Country, Appellation, Style string
}

// SourceHash fingerprints the descriptive Salesforce fields for roster-diffing.
// json.Marshal of a struct emits fields in declaration order, so the hash
// is deterministic for a given WineRaw value.
func SourceHash(w salesforce.WineRaw) string {
	payload, _ := json.Marshal(sourceHashInput{
		ID: w.ID, SKU: w.SKU, Producer: w.Producer, Name: w.Name, Vintage: w.Vintage,
		Varietal: w.Varietal, Region: w.Region, Country: w.Country,
		Appellation: w.Appellation, Style: w.Style,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

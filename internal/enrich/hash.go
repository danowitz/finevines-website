package enrich

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// SourceHash fingerprints the raw Salesforce fields for roster-diffing.
// json.Marshal of a struct emits fields in declaration order, so the hash
// is deterministic for a given WineRaw value.
func SourceHash(w salesforce.WineRaw) string {
	payload, _ := json.Marshal(w)
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

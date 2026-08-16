package notify

// AppliedAction is the digest-safe summary of one hosted-review decision that
// mutated the catalog in this run. The durable, authoritative receipt remains
// in protected Bunny storage; this smaller record exists only for the email.
type AppliedAction struct {
	ID        string `json:"id"`
	SKU       string `json:"sku"`
	Kind      string `json:"action"`
	Reviewer  string `json:"reviewer"`
	AppliedAt string `json:"appliedAt"`
	Outcome   string `json:"outcome"`
}

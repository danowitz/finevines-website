package redirects

// Branch A — Bunny.net Edge Rules — NOT USED.
//
// The finevines.com redirect map has 51,511 entries (internal/redirects
// Discover/MapURLs against the live old site — see the plan's Task 19/20
// crawl-gate). Bunny caps Edge Rules at 20 per pull zone
// (POST https://api.bunny.net/pullzone/{id}/edgerules/addOrUpdate), so
// Edge Rules cannot represent this map at all — the mechanism used is Edge
// Scripting middleware instead (publish_script.go: GenerateMiddleware +
// PublishMiddleware), which has no such per-entry cap (the map lives in a
// fetched redirects.json, not in per-rule config).
//
// This file intentionally contains no implementation. It documents the
// alternative for a HYPOTHETICAL future site (or a future Fine Vines
// sub-property) whose old-URL inventory is small enough — at most 20
// entries — that Edge Rules would be the simpler mechanism:
//
//   - PublishRules(ctx, client, mapped map[string]string) error would POST
//     one addOrUpdate call per old path to
//     https://api.bunny.net/pullzone/{id}/edgerules/addOrUpdate, with
//     ActionType = 301 (Redirect), TriggerMatchingType = MatchAny, and a
//     single trigger of type PatternMatches on RequestUrl equal to the old
//     path.
//   - Each rule's Guid would be deterministic (derived from the old path,
//     e.g. a stable hash), so Bunny upserts by Guid on every re-run
//     instead of accumulating duplicate rules — the same idempotency
//     property Task 19/20's brief called for.
//   - Before ever implementing this for real, re-confirm the exact request
//     shape and the current per-zone rule limit against
//     https://docs.bunny.net/ — the plan's Step A1 — since Bunny's API
//     surface can change between now and whenever a ≤20-entry site
//     actually needs this.
//
// Do not build this speculatively. If a future project needs it, treat
// this comment as the starting design, not a promise it still matches
// Bunny's current API.

// Package queue drains the review console's change queue: the corrections
// non-technical reviewers (George, Barbara) make in the Sub-project B console,
// parked as a JSON file in the Bunny storage zone that the console and this
// pipeline share.
//
// The console never writes to the repo and the pipeline never serves a request.
// That asymmetry is the whole design: a reviewer's fix arrives as data in a
// storage bucket, and the only thing that ever edits data/wines.json is a
// pipeline run, which lands as an auditable bot commit. Nothing here talks to
// the network directly — the storage zone arrives as a Store, the text
// regeneration as a TextEnricher, and imgnorm as a Normalizer, all interfaces
// declared here because this is where they are consumed (the same pattern
// internal/deploy.Uploader uses).
package queue

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Action kinds. These strings are the wire contract with the console's Edge
// Script; the console writes them and this package reads them.
const (
	// ActionImageSwap replaces the wine's photograph with a candidate the
	// reviewer picked, or drops back to the SVG label (Payload.Candidate ==
	// CandidateNone).
	ActionImageSwap = "image-swap"
	// ActionTextFeedback re-runs the wine's text generation with the reviewer's
	// note appended to the prompt.
	ActionTextFeedback = "text-feedback"
	// ActionFlag records a wine for human attention and takes NO automatic
	// action: "wrong producer" or "duplicate" is a delist/rename call, and that
	// call is Joel's, not the pipeline's.
	ActionFlag = "flag"
)

// CandidateNone is the Payload.Candidate sentinel for "none of these images —
// use the SVG label fallback", the last option the console offers on an image
// pick.
const CandidateNone = "none"

// Action is one reviewer decision, exactly as the console appends it to
// _review/queue.json. The JSON tags are the contract (design spec §B "Write
// path"): do not rename them without changing the Edge Script in the same
// commit. Kind is `action` on the wire because "action" reads better in the
// console's own code and Go already calls the whole struct an Action.
type Action struct {
	ID       string  `json:"id"`
	Reviewer string  `json:"reviewer"`
	SKU      string  `json:"sku"`
	Kind     string  `json:"action"`
	Payload  Payload `json:"payload"`
	TS       string  `json:"ts"`
}

// Payload is the per-kind detail. One flat struct rather than a
// json.RawMessage per kind: there are three kinds, five fields between them,
// and a flat struct keeps the whole contract legible on one screen for whoever
// writes the Edge Script.
type Payload struct {
	// Candidate is the storage-relative path, under the candidate directory, of
	// the image an image-swap selects (e.g. "AB1201/cand-2.png"). The sentinel
	// CandidateNone means the reviewer rejected every candidate.
	Candidate string `json:"candidate,omitempty"`
	// SourceURL is where that candidate came from. It exists so a swap keeps
	// the same provenance guarantee a nightly import does — months from now,
	// "where did this picture come from" has to be answerable from
	// data/wines.json alone.
	SourceURL string `json:"sourceUrl,omitempty"`
	// Note is the reviewer's free text for a text-feedback action, fed VERBATIM
	// into the regeneration prompt.
	Note string `json:"note,omitempty"`
	// Reason is the reviewer's free text for a flag action.
	Reason string `json:"reason,omitempty"`
}

// ParseQueue decodes _review/queue.json: a bare JSON array of Action.
//
// An empty or whitespace-only body is NOT an error — a nightly run where nobody
// reviewed anything is the normal case, and Bunny serves a zero-length body for
// a file the console has emptied. Malformed JSON, by contrast, is a hard error:
// treating it as "nothing queued" would discard a reviewer's work and then
// clear the queue on top of it.
func ParseQueue(data []byte) ([]Action, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}
	var actions []Action
	if err := json.Unmarshal(data, &actions); err != nil {
		return nil, fmt.Errorf("queue: parse queue.json: %w", err)
	}
	return actions, nil
}

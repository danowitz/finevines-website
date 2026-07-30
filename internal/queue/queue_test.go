package queue

import (
	"reflect"
	"testing"
)

// The queue file's shape is the contract with the console's Edge Script. This
// fixture is written the way the script appends it — a bare JSON array — so a
// change on either side breaks this test rather than a nightly run.
const queueFixture = `[
 {"id":"a1","reviewer":"barbara","sku":"AB1201","action":"image-swap",
  "payload":{"candidate":"AB1201/cand-2.png","sourceUrl":"https://example-producer.fr/vins/"},
  "ts":"2026-07-29T14:02:11Z"},
 {"id":"a2","reviewer":"george","sku":"MB5110","action":"text-feedback",
  "payload":{"note":"says oaked; this wine is unoaked"},"ts":"2026-07-29T14:04:00Z"},
 {"id":"a3","reviewer":"george","sku":"PM5030","action":"flag",
  "payload":{"reason":"wrong producer, this is not Brezza"},"ts":"2026-07-29T14:05:30Z"}
]`

func TestParseQueue_DecodesEveryActionKind(t *testing.T) {
	got, err := ParseQueue([]byte(queueFixture))
	if err != nil {
		t.Fatalf("ParseQueue returned error: %v", err)
	}
	want := []Action{
		{ID: "a1", Reviewer: "barbara", SKU: "AB1201", Kind: ActionImageSwap,
			Payload: Payload{Candidate: "AB1201/cand-2.png", SourceURL: "https://example-producer.fr/vins/"},
			TS:      "2026-07-29T14:02:11Z"},
		{ID: "a2", Reviewer: "george", SKU: "MB5110", Kind: ActionTextFeedback,
			Payload: Payload{Note: "says oaked; this wine is unoaked"},
			TS:      "2026-07-29T14:04:00Z"},
		{ID: "a3", Reviewer: "george", SKU: "PM5030", Kind: ActionFlag,
			Payload: Payload{Reason: "wrong producer, this is not Brezza"},
			TS:      "2026-07-29T14:05:30Z"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParseQueue mismatch:\n got %+v\nwant %+v", got, want)
	}
}

// A nightly run with nobody having reviewed anything is the NORMAL case, and it
// must not look like a failure. Bunny returns an empty body for a zero-length
// object, and the console writes "[]" when it clears its own view.
func TestParseQueue_EmptyIsNotAnError(t *testing.T) {
	for _, body := range []string{"", "   ", "[]", "\n"} {
		got, err := ParseQueue([]byte(body))
		if err != nil {
			t.Errorf("ParseQueue(%q) returned error: %v", body, err)
		}
		if len(got) != 0 {
			t.Errorf("ParseQueue(%q) = %d actions, want 0", body, len(got))
		}
	}
}

// Malformed JSON is a real error: silently treating it as "nothing queued" would
// discard a reviewer's work and then clear the queue on top of it.
func TestParseQueue_MalformedIsAnError(t *testing.T) {
	if _, err := ParseQueue([]byte(`[{"id":`)); err == nil {
		t.Fatal("ParseQueue accepted truncated JSON, want an error")
	}
}

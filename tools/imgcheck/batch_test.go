package main

import (
	"strings"
	"testing"
)

// Batch judging exists because the per-pairing cost is dominated by SETUP, not
// by the decision: every process start re-parses a 2,600-wine catalog to
// rebuild the sibling index. The old-site re-matcher makes thousands of
// pairings, and paying that once instead of once per pairing is the difference
// between minutes and hours.
//
// The format is deliberately dumb — TAB-separated name/producer/label in, one
// verdict line out, in order — so a caller in any language can stream through
// it without a protocol.

func TestBatchJudgesEachLineInOrder(t *testing.T) {
	sib := testSiblings()
	in := strings.Join([]string{
		"Altocedro Malbec Gran Reserva\tAltocedro\tAltocedro Malbec Reserva",
		"Altocedro Malbec Gran Reserva\tAltocedro\tALTOCEDRO GRAN RESERVA MALBEC",
		"Ambroise Clos Vougeot Grand Cru\tAmbroise\tEchezeaux Grand Cru Maison Ambroise",
	}, "\n")

	var out strings.Builder
	if err := runBatch(strings.NewReader(in), &out, nil, sib); err != nil {
		t.Fatal(err)
	}
	got := strings.Fields(strings.TrimSpace(out.String()))
	want := []string{"0", "1", "0"}
	if len(got) != len(want) {
		t.Fatalf("want %d verdicts, got %d: %q", len(want), len(got), out.String())
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d: got %q, want %q", i+1, got[i], want[i])
		}
	}
}

func TestBatchSkipsBlankAndMalformedLines(t *testing.T) {
	// A blank line or one missing its fields must not shift every later verdict
	// onto the wrong pairing — it emits its own "0" and keeps the count exact.
	in := "\nAltocedro Malbec Gran Reserva\tAltocedro\tALTOCEDRO GRAN RESERVA MALBEC\nno-tabs-here\n"
	var out strings.Builder
	if err := runBatch(strings.NewReader(in), &out, nil, testSiblings()); err != nil {
		t.Fatal(err)
	}
	got := strings.Fields(strings.TrimSpace(out.String()))
	if len(got) != 3 {
		t.Fatalf("want one verdict per input line (3), got %d: %q", len(got), out.String())
	}
	if got[1] != "1" {
		t.Errorf("the well-formed middle line should still be judged: got %q", got[1])
	}
}

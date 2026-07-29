package enrich

import "testing"

func TestEligible(t *testing.T) {
	cases := []struct {
		qty   int
		sku   string
		ready bool
		want  bool
	}{
		{14, "AB1234", true, true},
		{0, "AB1234", true, false},   // out of stock
		{-2, "AB1234", true, false},  // negative stock
		{14, "9X1234", true, false},  // SKU starts with 9 → never on the web
		{14, "A91234", true, true},   // 9 elsewhere is fine
		{1, "", true, true},          // empty SKU doesn't start with 9
		{14, "AB1234", false, false}, // in stock, good SKU, but not ready to sell
		{0, "9X1234", false, false},  // fails every clause
		{5, "SBTL", true, false},     // the QuickBooks-sync placeholder row (client: never show it)
		{5, "SBTL2", true, true},     // only the exact placeholder SKU is excluded
	}
	for _, c := range cases {
		if got := Eligible(c.qty, c.sku, c.ready); got != c.want {
			t.Errorf("Eligible(%d, %q, ready=%v) = %v, want %v", c.qty, c.sku, c.ready, got, c.want)
		}
	}
}

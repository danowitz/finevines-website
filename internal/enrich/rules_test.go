package enrich

import "testing"

func TestEligible(t *testing.T) {
	cases := []struct {
		qty  int
		sku  string
		want bool
	}{
		{14, "AB1234", true},
		{0, "AB1234", false},  // out of stock
		{-2, "AB1234", false}, // negative stock
		{14, "9X1234", false}, // SKU starts with 9 → never on the web
		{14, "A91234", true},  // 9 elsewhere is fine
		{1, "", true},         // empty SKU doesn't start with 9
	}
	for _, c := range cases {
		if got := Eligible(c.qty, c.sku); got != c.want {
			t.Errorf("Eligible(%d, %q) = %v, want %v", c.qty, c.sku, got, c.want)
		}
	}
}

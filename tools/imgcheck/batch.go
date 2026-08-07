package main

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

// runBatch judges many name/label pairings against one already-loaded catalog.
//
// Judging a pairing is cheap; getting ready to judge is not. Every process
// start re-reads the token index and the whole catalog to rebuild the sibling
// map, so a caller making thousands of pairings — the old-site re-matcher makes
// roughly one per candidate wine per page — spends nearly all its time on
// setup. This pays it once.
//
// One line in, one line out, in order: "name<TAB>producer<TAB>label" becomes
// "1" (this label names this wine) or "0". A blank or malformed line still
// emits a verdict, so the caller can pair results to inputs positionally
// without tracking which lines were skipped.
func runBatch(r io.Reader, w io.Writer, ix Index, sib Siblings) error {
	in := bufio.NewScanner(r)
	// Catalog names and OCR'd labels are short, but a pathological line must not
	// abort the run; give the scanner room well past anything real.
	in.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	out := bufio.NewWriter(w)
	defer out.Flush()

	for in.Scan() {
		f := strings.Split(strings.TrimRight(in.Text(), "\r"), "\t")
		if len(f) < 3 || strings.TrimSpace(f[0]) == "" {
			fmt.Fprintln(out, "0")
			continue
		}
		verdict := "0"
		if matchWithSiblings(f[0], f[1], f[2], ix, sib).ok {
			verdict = "1"
		}
		fmt.Fprintln(out, verdict)
	}
	return in.Err()
}

package main

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
)

// Telling one of a producer's wines from another.
//
// matchWithProducer asks only "is this the right estate?", because a bottle
// prints less than a catalog row does and demanding every word rejected
// correct images. The cost of that leniency was measured on 2026-08-06: with
// the estate confirmed, ANY of its bottles satisfied ANY of its wines. A
// full-resolution audit of the live site found 551 published photographs
// showing the wrong wine — François Mikulski's plain Meursault standing in for
// his Limozin and his Tillets, Maison Ambroise's Échezeaux for their Clos
// Vougeot, Altocedro Reserva for Gran Reserva.
//
// The question that separates those cases is not "is every word present" but
// "could this label be a DIFFERENT wine by the same producer?" That is
// answerable from the catalog itself, and it costs nothing when the producer
// makes one wine — which is why this rule does not re-break the shorter-label
// case the producer rule was introduced to fix.

// NameProducer is one catalog row reduced to what this rule needs.
type NameProducer struct {
	Name     string `json:"name"`
	Producer string `json:"producer"`
}

// Siblings maps a producer key to the wines that producer makes, each reduced
// to its set of name words.
type Siblings map[string][]map[string]bool

// BuildSiblings groups the catalog by producer. A row whose producer is blank
// is keyed by its own name's leading words, matching producerKey's treatment
// elsewhere, so producer-in-the-name rows still group.
func BuildSiblings(rows []NameProducer) Siblings {
	s := Siblings{}
	for _, r := range rows {
		key := producerKey(r.Producer)
		if key == "" {
			key = producerKey(r.Name)
		}
		if key == "" {
			continue
		}
		set := map[string]bool{}
		for _, w := range words(r.Name) {
			set[w] = true
		}
		if len(set) == 0 {
			continue
		}
		s[key] = append(s[key], set)
	}
	return s
}

// LoadSiblings reads a catalog JSON array of {name, producer} objects. An
// unreadable file yields nil, which disables the rule rather than failing the
// run — the verifier must keep working when the index is missing.
func LoadSiblings(path string) Siblings {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var rows []NameProducer
	if json.Unmarshal(b, &rows) != nil {
		return nil
	}
	return BuildSiblings(rows)
}

// discriminators returns, for each of the producer's OTHER wines, the words
// that tell this wine apart from that ONE sibling.
//
// Per sibling, not pooled: pooling lets a word that separates us from wine A
// stand in as proof against wine B. Maison Ambroise's Échezeaux label carries
// "grand cru", which distinguishes their Clos Vougeot from their Nuits-Saint-
// Georges — and on a pooled test that was enough to accept the Échezeaux as
// the Clos Vougeot. Against the Échezeaux itself the only separators are
// "clos" and "vougeot", and the label has neither.
//
// An empty result means the rule stands down: one wine from this producer, no
// sibling index, or a sibling this wine cannot be told apart from on words
// alone (where refusing would be a guess, not a finding).
func (s Siblings) discriminators(name, producer string) [][]string {
	if s == nil {
		return nil
	}
	key := producerKey(producer)
	if key == "" {
		key = producerKey(name)
	}
	family := s[key]
	if len(family) < 2 {
		return nil
	}
	mine := map[string]bool{}
	for _, w := range words(name) {
		mine[w] = true
	}
	var out [][]string
	for _, sib := range family {
		// The same wine in another vintage is not a sibling to be told apart.
		if sameWordSet(sib, mine) {
			continue
		}
		var sep []string
		for w := range mine {
			if !sib[w] {
				sep = append(sep, w)
			}
		}
		if len(sep) == 0 {
			continue // nothing in the name separates them; not this rule's call
		}
		sort.Strings(sep)
		out = append(out, sep)
	}
	return out
}

func sameWordSet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for w := range a {
		if !b[w] {
			return false
		}
	}
	return true
}

// matchWithSiblings is matchWithProducer plus the sibling test: the producer
// must be on the label AND the label must carry something that tells this wine
// apart from the producer's others.
//
// Deliberately "at least one" discriminator, not all of them. A label prints
// the cuvée, not the catalog's full description — demanding every
// distinguishing word would refuse "Meursault Limozin" against a label reading
// only "LIMOZIN". One is enough to know WHICH wine this is; zero means the
// label could be any of the estate's bottles, which is exactly the case that
// published 551 wrong photographs.
func matchWithSiblings(name, producer, labelText string, ix Index, sib Siblings) matchResult {
	r := matchWithProducer(name, producer, labelText, ix)
	if !r.ok {
		return r
	}
	perSibling := sib.discriminators(name, producer)
	if len(perSibling) == 0 {
		return r // one wine from this producer, or no sibling index: nothing to confuse
	}
	got := words(labelText)
	for _, sep := range perSibling {
		// Fresh `used` per sibling: one label word may legitimately be what
		// separates this wine from several of its siblings.
		used := make([]bool, len(got))
		found := false
		for _, w := range sep {
			if findIn(w, got, used) >= 0 {
				found = true
				break
			}
		}
		if !found {
			r.ok = false
			r.conflict = "label does not tell this apart from another " +
				strings.TrimSpace(producer) + " wine (looked for: " + strings.Join(sep, ", ") + ")"
			return r
		}
	}
	return r
}

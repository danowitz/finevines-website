package main

import "testing"

// The same-producer/wrong-cuvée blind spot, measured 2026-08-06.
//
// matchWithProducer demands only the PRODUCER's words, on the reasoning that a
// bottle prints less than a catalog row does. True — but it means any bottle
// from the right estate satisfies any of that estate's wines. A full-resolution
// audit of every live photograph found 551 wrong bottles published this way:
// 22% of scraped photos, 47% of label scans. Every case below is real.
//
// The fix must not re-break what the producer rule was introduced to fix: a
// label that is simply SHORTER than the catalog row must still pass. That is
// what TestShorterLabelStillPasses guards, and it is why the rule keys on
// SIBLINGS — the other wines this producer makes. With no sibling to be
// confused with, nothing is demanded beyond the producer.

// siblingIndex is the catalog knowledge the rule needs: every wine name, keyed
// by producer, so "which of this estate's wines is this?" can be asked.
func testSiblings() Siblings {
	return BuildSiblings([]NameProducer{
		{Name: "Meursault Limozin", Producer: "Francois Mikulski"},
		{Name: "Meursault Tillets", Producer: "Francois Mikulski"},
		{Name: "Meursault 1er Cru Les Goutte d'Or", Producer: "Francois Mikulski"},
		{Name: "Clos Vougeot Grand Cru", Producer: "Ambroise"},
		{Name: "Echezeaux Grand Cru", Producer: "Ambroise"},
		{Name: "Nuits Saint Georges 1er Cru les Vaucrains", Producer: "Ambroise"},
		{Name: "Malbec Gran Reserva", Producer: "Altocedro"},
		{Name: "Malbec Reserva", Producer: "Altocedro"},
		{Name: "Napa Valley Cabernet Sauvignon", Producer: "Kerr Cellars"},
		{Name: "Sonoma Coast Chardonnay", Producer: "Kerr Cellars"},
		// A producer with exactly one wine in the book: nothing to confuse.
		{Name: "Isaac Fernandez Seleccion Acentor Garnacha Do Calatayud", Producer: "Acentor"},
	})
}

func TestWrongCuveeFromTheRightProducerIsRefused(t *testing.T) {
	sib := testSiblings()
	for _, c := range []struct {
		what, name, producer, label string
	}{
		{
			what:     "a plain Meursault standing in for the Limozin",
			name:     "Meursault Limozin",
			producer: "Francois Mikulski",
			label:    "Meursault 2024 Francois Mikulski",
		},
		{
			what:     "the Echezeaux standing in for the Clos Vougeot",
			name:     "Clos Vougeot Grand Cru",
			producer: "Ambroise",
			label:    "Echezeaux Grand Cru Appellation Echezeaux Controlee Maison Ambroise",
		},
		{
			what:     "Reserva standing in for Gran Reserva",
			name:     "Malbec Gran Reserva",
			producer: "Altocedro",
			label:    "ALTOCEDRO RESERVA MALBEC La Consulta Valle de Uco Mendoza",
		},
		{
			what:     "a Sonoma Pinot standing in for the Napa Cabernet",
			name:     "Napa Valley Cabernet Sauvignon",
			producer: "Kerr Cellars",
			label:    "Kerr 2018 Manzanita Vineyard Sonoma Coast Pinot Noir",
		},
	} {
		r := matchWithSiblings(c.name, c.producer, c.label, nil, sib)
		if r.ok {
			t.Errorf("%s: accepted, but the label names a different wine by this producer", c.what)
		}
	}
}

func TestJeanRoyerTraditionCannotStandInForPrestige(t *testing.T) {
	sib := BuildSiblings([]NameProducer{
		{Name: "Domaine Jean Royer Chateauneuf du Pape Cuvee Prestige"},
		{Name: "Domaine Jean Royer Chateauneuf du Pape Tradition"},
		{Name: "Domaine Jean Royer Chateauneuf du Pape Sables de la Crau"},
	})
	r := matchWithSiblings(
		"Domaine Jean Royer Chateauneuf du Pape Cuvee Prestige",
		"Jean Royer",
		"Domaine Jean Royer Cuvee Tradition Chateauneuf du Pape",
		nil,
		sib,
	)
	if r.ok {
		t.Fatal("Jean Royer Tradition was accepted for Cuvee Prestige")
	}
}

func TestTheRightCuveeStillPasses(t *testing.T) {
	sib := testSiblings()
	for _, c := range []struct{ what, name, producer, label string }{
		{
			what:     "the Limozin's own label",
			name:     "Meursault Limozin",
			producer: "Francois Mikulski",
			label:    "Meursault Limozin 2024 Francois Mikulski",
		},
		{
			what:     "the Clos Vougeot's own label",
			name:     "Clos Vougeot Grand Cru",
			producer: "Ambroise",
			label:    "Clos Vougeot Grand Cru Maison Ambroise Premeaux Prissey",
		},
		{
			what:     "OCR damage on the distinguishing word",
			name:     "Meursault Limozin",
			producer: "Francois Mikulski",
			label:    "Meursault Limozln 2024 Francois Mikulski",
		},
	} {
		r := matchWithSiblings(c.name, c.producer, c.label, nil, sib)
		if !r.ok {
			t.Errorf("%s: refused (missing %v, conflict %q)", c.what, r.missing, r.conflict)
		}
	}
}

func TestShorterLabelStillPasses(t *testing.T) {
	// The regression the producer-only rule exists to prevent. This producer
	// makes ONE wine in the book, so no cuvée can be confused with another and
	// the shorter label must still be accepted.
	r := matchWithSiblings(
		"Isaac Fernandez Seleccion Acentor Garnacha Do Calatayud",
		"Acentor",
		"ACENTOR GARNACHA",
		nil, testSiblings(),
	)
	if !r.ok {
		t.Errorf("a label shorter than the catalog row must still pass: missing %v", r.missing)
	}
}

// The pipeline passes a PRODUCER-LED name ("Altocedro Malbec Gran Reserva"),
// while catalog rows store the name alone ("Malbec Reserva"). That asymmetry
// made the producer's own word look like a discriminator — present in the
// wine's words, absent from every sibling's — so any label bearing the estate
// name satisfied the rule and the whole check silently did nothing. The
// discriminator must be about the CUVEE; the estate is already required
// separately by the producer rule.
func TestProducerNameIsNotADiscriminator(t *testing.T) {
	sib := testSiblings()
	r := matchWithSiblings("Altocedro Malbec Gran Reserva", "Altocedro",
		"Altocedro Malbec Reserva", nil, sib)
	if r.ok {
		t.Error("the Reserva label was accepted for the Gran Reserva: the estate name is not a discriminator")
	}
	// ...and the correct label still passes with the same producer-led name.
	if ok := matchWithSiblings("Altocedro Malbec Gran Reserva", "Altocedro",
		"ALTOCEDRO GRAN RESERVA MALBEC", nil, sib).ok; !ok {
		t.Error("the Gran Reserva's own label must still pass")
	}
}

func TestNoSiblingIndexKeepsOldBehaviour(t *testing.T) {
	// With no sibling knowledge (an absent index) the rule cannot ask its
	// question, and must fall back to the producer rule rather than refuse
	// everything.
	r := matchWithSiblings("Meursault Limozin", "Francois Mikulski",
		"Meursault 2024 Francois Mikulski", nil, nil)
	if !r.ok {
		t.Error("without a sibling index the producer rule must still apply")
	}
}

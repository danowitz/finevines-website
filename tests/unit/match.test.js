// Tests for the search-result verification gate.
//
// Built from real Vivino results captured during the spot check, including the
// two that silently substituted a different producer. Those are the cases that
// matter: an engine that ranks by relevance never returns nothing, so "took the
// top result" and "found the wine" are completely different claims.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verify, pick, tokens, normalize } from '../../tools/labelfetch/match.mjs';

describe('normalisation', () => {
  test('folds accents, case and punctuation', () => {
    assert.equal(normalize('Château Clos-Vougeot'), 'chateau clos vougeot');
    assert.equal(normalize('Spätlese, Mosel'), 'spatlese mosel');
  });

  test('drops generic wine vocabulary that matches everything', () => {
    // Nearly every Burgundy is a "domaine" and a third are "1er cru"; matching
    // on those matches the whole region. What must SURVIVE is the producer —
    // "anne gros" is the entire reason a Roche de Bellene Clos de la Roche
    // gets rejected for a Benjamin Leroux one.
    assert.deepEqual(tokens('Domaine Anne Gros Clos Vougeot Grand Cru 2022'), ['anne', 'gros', 'vougeot']);
    assert.equal(tokens('Domaine Grand Cru Rouge 2019').length, 0);
  });

  test('drops bare vintages', () => {
    assert.ok(!tokens('Meursault 2022').includes('2022'));
  });
});

describe('rejecting the wrong producer', () => {
  test('FX Pichler Kellerberg does not match a Max Ferd. Richter Mosel', () => {
    // Real result: the query returned four Richter wines and zero Pichler.
    const r = verify(
      'Weingut Fx Pichler Riesling Kellerberg 2022',
      'Weingut Max Ferd. Richter Richter Estate Riesling 2022 Mosel, Germany'
    );
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes('pichler'), `expected pichler missing, got ${r.missing}`);
    assert.ok(r.missing.includes('kellerberg'));
  });

  test('Benjamin Leroux does not match another grower on the same vineyard', () => {
    // The hardest case: the APPELLATION matches exactly, only the producer
    // differs. A similarity score would wave this through.
    const r = verify(
      'Benjamin Leroux Clos de la Roche Grand Cru 2018',
      'Maison Roche de Bellene Clos De La Roche Grand Cru 2019 Clos de la Roche Grand Cru, France'
    );
    assert.equal(r.ok, false, 'a different producer on the same vineyard must be rejected');
    assert.ok(r.missing.includes('benjamin') || r.missing.includes('leroux'));
  });

  test('rejects every candidate when the wine is simply absent', () => {
    const { hit } = pick('Benjamin Leroux Clos de la Roche Grand Cru 2018', [
      { text: 'Maison Roche de Bellene Clos De La Roche Grand Cru 2019' },
      { text: 'Domaine Leroy Clos de la Roche Grand Cru 2013' },
      { text: 'Domaine Castagnier Clos de la Roche Grand Cru 2018' },
    ]);
    assert.equal(hit, null, 'no result is the right wine, so the answer is "not found"');
  });
});

describe('accepting the right wine', () => {
  test('matches the correct producer and cuvée', () => {
    const r = verify(
      'Domaine Anne Gros Clos Vougeot Grand Cru 2022',
      'Domaine Anne Gros Clos-Vougeot Grand Cru Le Grand Maupertui 2022, France'
    );
    assert.equal(r.ok, true, `expected a match, missing: ${r.missing}`);
    assert.equal(r.vintageMatch, true);
  });

  test('matches across the hyphen and accent differences', () => {
    assert.equal(verify('Château Marjosse Bordeaux Rouge 2022', 'Chateau Marjosse Bordeaux 2022').ok, true);
  });

  test('tolerates truncated trade shorthand', () => {
    // Salesforce clips long names; the candidate carries the full one.
    assert.equal(
      verify('Virgile Lignier Morey Saint Denis 2021', 'Virgile Lignier-Michelot Morey-Saint-Denis 2021').ok,
      true
    );
  });

  test('a different vintage of the same wine is flagged, not rejected', () => {
    // Bottle artwork rarely changes by vintage, so this stays the caller's call.
    const r = verify('Domaine Michel Lafarge Meursault 2022', 'Domaine Michel Lafarge Meursault 2020');
    assert.equal(r.ok, true);
    assert.equal(r.vintageMatch, false);
    // ...unless the caller insists.
    assert.equal(verify('Domaine Michel Lafarge Meursault 2022', 'Domaine Michel Lafarge Meursault 2020', { requireVintage: true }).ok, false);
  });

  test('prefers the exact vintage when several candidates verify', () => {
    const { hit } = pick('Domaine Michel Lafarge Meursault 2022', [
      { text: 'Domaine Michel Lafarge Meursault 2019', id: 'a' },
      { text: 'Domaine Michel Lafarge Meursault 2022', id: 'b' },
    ]);
    assert.equal(hit.id, 'b');
  });
});

describe('refusing to guess', () => {
  test('a query with no distinctive words never matches', () => {
    // "Domaine Grand Cru Rouge" identifies nothing; accepting anything for it
    // would be the silent-substitution failure in its purest form.
    assert.equal(verify('Domaine Grand Cru Rouge 2019', 'Domaine Leroy Clos de la Roche Grand Cru').ok, false);
  });

  test('empty candidate text never matches', () => {
    assert.equal(verify('Domaine Anne Gros Clos Vougeot', '').ok, false);
  });
});

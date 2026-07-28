// Decides whether a candidate search result is actually the wine we asked for.
//
// This is the difference between a 90% hit rate and a 90% CORRECT rate. Wine
// search engines rank by relevance and never return nothing: query FX Pichler's
// Kellerberg and you get four Max Ferd. Richter Mosels; query Benjamin Leroux's
// Clos de la Roche and you get Roche de Bellene, Leroy and Castagnier. Taking
// result zero on faith put the wrong producer's bottle on 2 of 6 wines in a
// spot check — and a wholesale customer seeing a Mosel Riesling under an
// Austrian Wachau listing is worse served than by a plain generated label.
//
// The rule: the wine's DISTINCTIVE words must all be present in the candidate's
// own text. Not a similarity score with a tuned threshold — a hard requirement,
// because the failure being prevented is silent substitution, and a scorer
// tuned to admit near-misses admits exactly that.

// Words that carry no identifying information. Nearly every Burgundy is a
// "domaine" and half are "1er cru", so matching on those matches everything.
const NOISE = new Set([
  'domaine', 'domaines', 'chateau', 'château', 'weingut', 'maison', 'tenuta',
  'azienda', 'agricola', 'bodegas', 'bodega', 'cave', 'caves', 'clos', 'quinta',
  'estate', 'winery', 'wines', 'wine', 'vineyard', 'vineyards', 'cellars',
  'grand', 'cru', 'premier', '1er', 'the', 'and', 'les', 'des', 'del', 'della',
  'aux', 'aoc', 'appellation', 'controlee', 'contrôlée', 'rouge', 'blanc',
  'red', 'white', 'nv', 'vieilles', 'vignes', 'reserve', 'reserva', 'riserva',
  'cuvee', 'cuvée', 'selection', 'sélection', 'villages', 'village',
]);

// strip accents, punctuation and case so "Château" matches "Chateau" and
// "Clos-Vougeot" matches "Clos Vougeot".
export function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// tokens returns the words worth matching on: long enough to be meaningful,
// not generic wine vocabulary, not a bare vintage year.
export function tokens(s) {
  return normalize(s)
    .split(' ')
    .filter((t) => t.length >= 4 && !NOISE.has(t) && !/^(19|20)\d\d$/.test(t));
}

// verify reports whether `candidateText` describes the wine in `query`.
//
// Returns { ok, missing, matched, vintageMatch }. `missing` is what let it
// down, which matters: a run that rejects 40% of the catalog needs to show why
// so the queries can be improved rather than the gate loosened.
export function verify(query, candidateText, opts = {}) {
  const want = tokens(query);
  const gotSet = new Set(normalize(candidateText).split(' '));

  // Accept a token if it appears, or if the candidate holds a word that starts
  // with it — Salesforce truncates ("Lignier-Michelot" vs "Lignier"), and
  // trade shorthand drops suffixes.
  const got = normalize(candidateText).split(' ');
  const present = (t) => gotSet.has(t) || got.some((g) => g.startsWith(t) || t.startsWith(g) && g.length >= 4);

  const missing = want.filter((t) => !present(t));
  const matched = want.filter((t) => present(t));

  // Every distinctive word must land. Requiring "most" is what lets
  // "Clos de la Roche" match a different producer's Clos de la Roche.
  const ok = want.length > 0 && missing.length === 0;

  const qv = (query.match(/\b(19|20)\d\d\b/) || [])[0];
  const cv = (candidateText.match(/\b(19|20)\d\d\b/) || [])[0];

  return {
    ok: opts.requireVintage ? ok && qv === cv : ok,
    missing,
    matched,
    // A different vintage of the same wine is usually the same bottle design,
    // so it is reported rather than rejected — the caller decides.
    vintageMatch: qv && cv ? qv === cv : null,
    queryVintage: qv || null,
    candidateVintage: cv || null,
  };
}

// pick chooses the best verified candidate from a result list, or null if none
// passes. Order is respected only among candidates that already verify.
export function pick(query, candidates, opts = {}) {
  const checked = candidates.map((c) => ({ ...c, v: verify(query, c.text, opts) }));
  const passing = checked.filter((c) => c.v.ok);
  if (!passing.length) return { hit: null, checked };
  // Prefer an exact vintage among those that verify.
  const exact = passing.find((c) => c.v.vintageMatch === true);
  return { hit: exact || passing[0], checked };
}

// Derives a producer from a catalog NAME, for the 929 wines whose Salesforce
// producer field is empty (FV_Brand__c mapping still open — spec issue #2).
// The name nearly always leads with the producer; what follows is appellation,
// grape, style or classification. The guess is used ONLY as imgcheck's
// -producer argument at match time — it is never written into the catalog,
// because producer feeds Slugify and a backfill there would rename pages.
//
// The boundary list is words that essentially never appear INSIDE a producer
// name. Saint/Château/Domaine deliberately absent: "Domaine Saint Damien" is
// a producer, and the boundary that ends it is "Gigondas", not "Saint".

const BOUNDARY = new Set([
  // Burgundy & French appellations
  'bourgogne', 'chablis', 'pommard', 'meursault', 'volnay', 'gevrey', 'chambertin',
  'chassagne', 'puligny', 'montrachet', 'marsannay', 'fixin', 'vosne', 'romanee',
  'nuits', 'morey', 'chambolle', 'musigny', 'corton', 'savigny', 'beaune', 'auxey',
  'santenay', 'maranges', 'givry', 'rully', 'mercurey', 'pernand', 'aloxe', 'ladoix',
  'sancerre', 'chinon', 'saumur', 'vouvray', 'muscadet', 'bourgueil', 'touraine',
  'bordeaux', 'margaux', 'pauillac', 'sauternes', 'pomerol', 'medoc', 'moulis',
  'graves', 'pessac', 'barsac', 'bergerac', 'cahors', 'jurancon', 'gaillac',
  'gigondas', 'vacqueyras', 'tavel', 'rasteau', 'cairanne', 'chateauneuf',
  'cotes', 'cote', 'beaujolais', 'morgon', 'fleurie', 'chiroubles', 'julienas',
  'brouilly', 'alsace', 'arbois', 'wachau', 'mosel', 'rheingau',
  // Italian / Spanish / other appellations
  'rioja', 'chianti', 'barolo', 'barbaresco', 'brunello', 'ghemme', 'gattinara',
  'valpolicella', 'soave', 'etna', 'carmignano', 'montepulciano', 'ribera',
  'rias', 'priorat', 'penedes', 'calatayud', 'tokaji',
  // types & grapes ('champagne' is special-cased: producer lead at position 0,
  // boundary anywhere else — "Champagne Leclerc Briant" vs "Denis Chaput Champagne")
  'cava', 'prosecco', 'champagne', 'pinot', 'chardonnay', 'cabernet', 'merlot',
  'syrah', 'shiraz', 'grenache', 'garnacha', 'riesling', 'sauvignon', 'macabeo',
  'tempranillo', 'sangiovese', 'nebbiolo', 'malbec', 'zinfandel', 'gamay',
  'aligote', 'viognier', 'vermentino', 'albarino', 'verdejo', 'godello', 'chenin',
  'gewurztraminer', 'moscatel', 'moscato', 'furmint', 'gruner', 'veltliner',
  // style, color, classification, trade
  'rouge', 'blanc', 'rose', 'rosé', 'tinto', 'bianco', 'rosso', 'branco',
  'brut', 'sec', 'demi', 'extra', 'dolce', 'dry', 'sweet',
  'red', 'white', 'sparkling', 'still', 'sweetwine',
  'gran', 'grand', 'premier', '1er', 'reserve', 'reserva', 'riserva', 'crianza',
  'vieilles', 'cuvee', 'cuvée', 'vintage', 'docg', 'doc', 'igt', 'igp', 'aoc', 'aop',
  'bourbon', 'whisky', 'whiskey', 'gin', 'vodka', 'rum', 'brandy', 'cognac', 'cidre',
  'cider', 'sake', 'vermouth',
  'valley', 'hills', 'estate', 'vineyard', 'vineyards',
]);

const looksLikeYear = (t) => /^(19|20)\d{2}$/.test(t);
const GENERIC_STEM_END = new Set([
  'de', 'la', 'le', 'du', 'des', 'del', 'della', 'di', 'da', 'do', 'dos', 'of',
  'domaine', 'chateau', 'maison', 'weingut', 'estate',
]);

// deriveProducer returns the leading producer words of name, or '' when no
// safe guess exists. allNames (optional) lets a sibling wine sharing the
// prefix confirm the cut — same producer, different cuvée.
export function deriveProducer(name, allNames = []) {
  const raw = (name || '')
    .replace(/\*+/g, ' ')
    .replace(/\b\d+\/\d+\b/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // Leading vintage / NV tokens are not part of anyone's name.
  while (raw.length && (looksLikeYear(raw[0]) || /^nv$/i.test(raw[0]))) raw.shift();
  if (!raw.length) return '';

  const isBoundary = (t, i) => {
    const k = t.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, '');
    if (k === 'champagne') return i > 0;
    // A bare number ("3 Year", pack counts) never sits inside a producer name.
    return BOUNDARY.has(k) || looksLikeYear(t) || /^\d+$/.test(t);
  };

  let cut = raw.findIndex(isBoundary);
  if (cut === -1) cut = Math.min(raw.length, 5);
  if (cut === 0) return ''; // the name STARTS with a wine term — no producer here
  cut = Math.min(cut, 5);

  let guess = raw.slice(0, cut);

  // A sibling wine sharing a shorter word-prefix suggests the true producer is
  // that shared stem (the rest differs per cuvée). Only shrink, never grow.
  if (allNames.length) {
    const mine = raw.map((t) => t.toLowerCase());
    const genericLead = ['domaine', 'chateau', 'maison', 'weingut', 'estate'].includes(mine[0]);
    const minimumStem = genericLead ? 3 : 2;
    for (let len = cut - 1; len >= minimumStem; len--) {
      const stem = mine.slice(0, len).join(' ');
      // "Domaine de la Villaudiere" and "Domaine de la Grosse Pierre"
      // share a grammar prefix, not a producer. Never shrink a verified name
      // to a connector or bare trade word that carries no identity.
      const stemEnd = mine[len - 1].replace(/[^a-zà-ÿ0-9]/g, '');
      if (GENERIC_STEM_END.has(stemEnd)) continue;
      const sibling = allNames.some((n) => {
        if (n === name) return false;
        const toks = (n || '').trim().split(/\s+/).map((t) => t.toLowerCase());
        return toks.slice(0, len).join(' ') === stem && toks[len] !== mine[len];
      });
      if (sibling) {
        guess = raw.slice(0, len);
        break;
      }
    }
  }

  const joined = guess.join(' ');
  // A one-token or tiny guess is too generic to gate identity on.
  if (guess.length < 2 || joined.length < 5) return '';
  return joined;
}

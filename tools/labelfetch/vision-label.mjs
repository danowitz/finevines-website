export function parseVisionFields(content) {
  try {
    const value = JSON.parse(String(content || '').replace(/^```(?:json)?|```$/gm, '').trim());
    if (!value?.single_bottle) return null;
    const parts = [
      value.producer_brand,
      value.product_cuvee,
      value.appellation,
      value.vintage,
    ]
      .filter((part) => typeof part === 'string' && part.trim())
      .map((part) => part.trim());
    const text = parts.join(' ');
    if (!text) return null;
    const vintage = String(value.vintage || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
    const match = value.matches_requested_identity;
    return {
      text,
      vintage,
      identityMatch: match === true ? true : match === false ? false : null,
      producerBrand: String(value.producer_brand || '').trim(),
      productCuvee: String(value.product_cuvee || '').trim(),
      appellation: String(value.appellation || '').trim(),
      wineStyle: ['red', 'white', 'rose'].includes(String(value.wine_style || '').toLowerCase())
        ? String(value.wine_style).toLowerCase()
        : 'unknown',
    };
  } catch {
    return null;
  }
}

export function parseVisionIdentity(content) {
  return parseVisionFields(content)?.text || null;
}

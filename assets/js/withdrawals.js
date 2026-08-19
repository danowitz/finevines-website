const WITHDRAWALS_URL = 'https://review.finevines.com/api/public/withdrawals';
const PLACEHOLDER_URL = '/assets/img/wine-image-under-review.svg';
const PUBLIC_ORIGIN = 'https://finevines.com';
const WINE_IMAGE_PATH = /^assets\/img\/wines\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

export function canonicalImagePath(value, base = `${PUBLIC_ORIGIN}/`) {
  try {
    const url = new URL(value, base);
    if (url.origin !== PUBLIC_ORIGIN) return '';
    const path = url.pathname.replace(/^\/+/, '');
    return WINE_IMAGE_PATH.test(path) && !path.split('/').includes('..') ? path : '';
  } catch {
    return '';
  }
}

export function normalizeWithdrawnPaths(values) {
  const paths = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const path = String(value || '').replace(/^\/+/, '');
    if (WINE_IMAGE_PATH.test(path) && !path.split('/').includes('..')) paths.add(path);
  }
  return paths;
}

export function isPublicCatalogOrigin(origin) {
  return origin === PUBLIC_ORIGIN;
}

export function maskWithdrawnImages(root, paths) {
  const images = [];
  if (root?.matches?.('img[src]')) images.push(root);
  if (root?.querySelectorAll) images.push(...root.querySelectorAll('img[src]'));
  for (const image of images) {
    if (image.dataset.withdrawnImage === 'true') continue;
    if (!paths.has(canonicalImagePath(image.getAttribute('src'), window.location.href))) continue;
    image.src = PLACEHOLDER_URL;
    image.alt = 'Image under review';
    image.dataset.withdrawnImage = 'true';
  }
}

export async function applyImageWithdrawals() {
  try {
    const response = await fetch(WITHDRAWALS_URL, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.schemaVersion !== 1) return;
    const paths = normalizeWithdrawnPaths(payload.imagePaths);
    if (!paths.size) return;
    maskWithdrawnImages(document, paths);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) maskWithdrawnImages(node, paths);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    // The durable catalog workflow remains authoritative if this optional,
    // immediate visual withdrawal cannot reach the review service.
  }
}

if (typeof document !== 'undefined' && isPublicCatalogOrigin(window.location.origin)) applyImageWithdrawals();

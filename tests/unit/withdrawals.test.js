import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalImagePath, isPublicCatalogOrigin, maskWithdrawnImages, normalizeWithdrawnPaths } from '../../assets/js/withdrawals.js';

describe('public catalog image withdrawals', () => {
  it('contacts the review service only from the canonical production site', () => {
    assert.equal(isPublicCatalogOrigin('https://finevines.com'), true);
    assert.equal(isPublicCatalogOrigin('http://127.0.0.1:8080'), false);
    assert.equal(isPublicCatalogOrigin('https://preview.example'), false);
  });

  it('recognizes only same-origin catalog image URLs', () => {
    assert.equal(canonicalImagePath('/assets/img/wines/example.jpg'), 'assets/img/wines/example.jpg');
    assert.equal(canonicalImagePath('https://finevines.com/assets/img/wines/example.jpg?version=old'), 'assets/img/wines/example.jpg');
    assert.equal(canonicalImagePath('https://attacker.example/assets/img/wines/example.jpg'), '');
    assert.equal(canonicalImagePath('not a URL'), '');
  });

  it('accepts only normalized wine image paths from the public endpoint', () => {
    assert.deepEqual([...normalizeWithdrawnPaths([
      'assets/img/wines/example.jpg',
      '/assets/img/wines/example.jpg',
      '../private/action.json',
      'assets/img/team/example.jpg',
    ])], ['assets/img/wines/example.jpg']);
  });

  it('replaces a withdrawn catalog image with the neutral review image', () => {
    globalThis.window = { location: { href: 'https://finevines.com/portfolio/' } };
    const image = {
      dataset: {},
      source: '/assets/img/wines/example.jpg',
      getAttribute(name) { return name === 'src' ? this.source : null; },
      set src(value) { this.source = value; },
      set alt(value) { this.altText = value; },
    };
    const root = { querySelectorAll: () => [image] };

    maskWithdrawnImages(root, new Set(['assets/img/wines/example.jpg']));

    assert.equal(image.source, '/assets/img/wine-image-under-review.svg');
    assert.equal(image.altText, 'Image under review');
    assert.equal(image.dataset.withdrawnImage, 'true');
    delete globalThis.window;
  });
});

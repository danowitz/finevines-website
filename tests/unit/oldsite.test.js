// Unit tests for the old-site re-matcher's pure parts.
//
// The old finevines.com is still live and internally correct: every product
// page is titled for the wine it shows, and its images are still served. What
// went wrong on 4 August was our matcher pairing those pages to catalog rows on
// the producer alone — Anne Parent's "Pommard La Croix Blanche" page ended up
// on our Pommard 1er Cru Croix Noires. 223 of the images the full-resolution
// audit pulled came from that matcher.
//
// The re-matcher therefore takes the page TITLE as the authority for what a
// page depicts, and defers the actual identity judgement to imgcheck — the one
// tested implementation — rather than re-inventing matching here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle, productImage, productPages } from '../../tools/labelfetch/oldsite.mjs';

describe('pageTitle', () => {
  test('takes the wine name and drops the site suffix', () => {
    assert.equal(
      pageTitle('<title>Domaine Anne Parent Pommard La Croix Blanche | Fine Vines</title>'),
      'Domaine Anne Parent Pommard La Croix Blanche'
    );
  });

  test('decodes entities and collapses whitespace', () => {
    assert.equal(
      pageTitle('<title>\n  Ch&acirc;teau  Gruaud &amp; Larose | Fine Vines\n</title>'),
      'Château Gruaud & Larose'
    );
  });

  test('a page with no title yields null rather than an empty match', () => {
    assert.equal(pageTitle('<html><body>no title here</body></html>'), null);
  });

  test('a Page Not Found title is not a wine', () => {
    assert.equal(pageTitle('<title>Page Not Found | Fine Vines</title>'), null);
  });
});

describe('productImage', () => {
  test('finds the product image under sites/default/files/product', () => {
    const html = '<img src="/sites/default/files/product/2020-01/Anne%20Parent.jpg" alt="x">';
    assert.equal(
      productImage(html, 'https://www.finevines.com'),
      'https://www.finevines.com/sites/default/files/product/2020-01/Anne%20Parent.jpg'
    );
  });

  test('ignores logos and icons elsewhere on the page', () => {
    const html = '<img src="/themes/logo.svg"><img src="/sites/default/files/icons/cart.png">';
    assert.equal(productImage(html, 'https://www.finevines.com'), null);
  });

  test('keeps an already-absolute URL as-is', () => {
    const html = '<img src="https://cdn.example.com/sites/default/files/product/a.jpg">';
    assert.equal(productImage(html, 'https://www.finevines.com'),
      'https://cdn.example.com/sites/default/files/product/a.jpg');
  });

  test('resolves a Drupal image-style derivative back to the original file', () => {
    // What the pages actually serve: a 555px derivative with a cache token.
    // The original behind it is larger and is what we want to import.
    const html = '<img src="/sites/default/files/styles/product_555/public/product/' +
      '2018-12/Labels_Altocedro_MalbecReserva.png?itok=eWJZ9s2e" alt="Altocedro Malbec Reserva" />';
    assert.equal(
      productImage(html, 'https://www.finevines.com'),
      'https://www.finevines.com/sites/default/files/product/2018-12/Labels_Altocedro_MalbecReserva.png'
    );
  });

  test('the theme logo before the product image does not win', () => {
    const html = '<img src="/themes/custom/cork/logo.png" alt="Fine Vines" />' +
      '<img src="/sites/default/files/styles/product_555/public/product/2020-01/A.jpg?itok=x" />';
    assert.equal(productImage(html, 'https://www.finevines.com'),
      'https://www.finevines.com/sites/default/files/product/2020-01/A.jpg');
  });
});

describe('productPages', () => {
  test('keeps only /portfolio/<producer>/<wine> paths', () => {
    const map = {
      '/portfolio/altocedro/altocedro-malbec-reserva': '/wines/x/',
      '/portfolio/altocedro': '/portfolio/',            // producer index, not a product
      '/portfolio/': '/portfolio/',                      // the listing itself
      '/portfolio/a/b/c': '/wines/y/',                   // too deep
      '/news/some-post': '/news/',
    };
    assert.deepEqual(productPages(map), ['/portfolio/altocedro/altocedro-malbec-reserva']);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  googleImagesURL,
  renderImageDiagnosticHtml,
} from '../../tools/labelfetch/image-diagnostic-report.mjs';

test('diagnostic dossier renders every decision stage and the exact external evidence', () => {
  const trace = {
    catalogInput: { name: 'TOR Kenward Family Wines Cabernet Sauvignon Oakville', vintage: '2022' },
    query: 'Tor Kenward Family Wines Cabernet Sauvignon Oakville 2022',
    discovery: {
      provider: 'brave', status: 'ok', searched: true, returned: 1, blocked: 0,
      results: [{ index: 1, outcome: 'permitted', title: 'TOR Oakville 2022', image: 'https://cdn.example/tor.png', context: 'https://shop.example/tor' }],
    },
    downloads: [{ index: 1, outcome: 'downloaded', status: 200, bytes: 118869, file: 'candidate-01.png' }],
    selector: {
      groups: [['candidate-1']], representatives: ['candidate-1'], reason: 'no repeated bottle design',
      reader: { model: 'gpt-4.1-mini', prompt: 'transcribe', response: '[{"producer_brand":"TOR"}]', candidateIds: ['candidate-1'] },
    },
    final: { ok: false, failureStage: 'visual-consensus', funnel: { downloaded: 1 } },
  };
  const html = renderImageDiagnosticHtml({
    trace,
    images: [{ id: 'candidate-1', src: 'assets/candidate-01.png' }],
    googleCapture: { status: 429, finalUrl: 'https://www.google.com/sorry/', screenshot: 'google-images.png' },
  });

  assert.match(html, /Catalog input/);
  assert.match(html, /Brave discovery/);
  assert.match(html, /TOR Oakville 2022/);
  assert.match(html, /118869/);
  assert.match(html, /gpt-4\.1-mini/);
  assert.match(html, /producer_brand/);
  assert.match(html, /google-images\.png/);
  assert.match(html, /HTTP 429/);
  assert.match(html, /assets\/candidate-01\.png/);
  assert.match(html, /visual-consensus/);
});

test('Google Images diagnostic URL preserves the exact one-shot query', () => {
  assert.equal(
    googleImagesURL('Tor Kenward Family Wines Cabernet Sauvignon Oakville 2022'),
    'https://www.google.com/search?udm=2&q=Tor%20Kenward%20Family%20Wines%20Cabernet%20Sauvignon%20Oakville%202022',
  );
});

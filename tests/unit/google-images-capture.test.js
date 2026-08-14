import test from 'node:test';
import assert from 'node:assert/strict';
import { captureGoogleImagesPage } from '../../tools/labelfetch/google-images-capture.mjs';

test('Google page capture records an automated block instead of pretending it saw results', async () => {
  let captured = '';
  const page = {
    setViewport: async () => {},
    goto: async () => ({ status: () => 429 }),
    url: () => 'https://www.google.com/sorry/',
    title: async () => 'Google automated traffic',
    $eval: async () => 'Our systems have detected unusual traffic',
    screenshot: async ({ path }) => { captured = path; },
    close: async () => {},
  };
  const result = await captureGoogleImagesPage('TOR Oakville 2022', {
    browser: { newPage: async () => page },
    screenshotPath: 'capture.png',
  });
  assert.equal(captured, 'capture.png');
  assert.equal(result.status, 429);
  assert.equal(result.blocked, true);
  assert.equal(result.finalUrl, 'https://www.google.com/sorry/');
});

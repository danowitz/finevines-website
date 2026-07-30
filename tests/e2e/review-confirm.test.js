// The review sheet's confirm interaction, in a real Chrome. Exists because
// the first implementation shipped a toggle that fired twice per click (the
// label's synthetic click on its radio bubbled to the same handler) and so
// visibly did nothing — found by the reviewer, not the tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBrowser } from '../helpers/browser.js';

const SHEET = resolve('out-bottle/review.html');

let browser, page;
before(async () => {
  browser = await openBrowser();
  page = await browser.newPage();
});
after(async () => {
  if (browser) await browser.close();
});

test('clicking the proposed picture toggles confirmed on, off, and counts decisions', { skip: !existsSync(SHEET) && 'no generated review sheet — run tools/labelfetch/review.mjs first' }, async () => {
  await page.goto('file://' + SHEET.replace(/\\/g, '/'));
  await page.waitForSelector('.opt.proposed img');

  await page.click('.opt.proposed img');
  assert.equal(
    await page.$eval('.opt.proposed', (el) => el.classList.contains('confirmed')),
    true,
    'first click must mark the card confirmed'
  );
  assert.equal(await page.$eval('#n', (el) => el.textContent), '1', 'one decision recorded');

  await page.click('.opt.proposed img');
  assert.equal(
    await page.$eval('.opt.proposed', (el) => el.classList.contains('confirmed')),
    false,
    'second click must undo the confirmation'
  );
  assert.equal(await page.$eval('#n', (el) => el.textContent), '0', 'decision withdrawn');
});

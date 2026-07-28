// Real-Chrome driver for the browser tests.
//
// puppeteer-core (NOT puppeteer) on purpose: puppeteer downloads and pins its
// own ~120MB Chromium on every install, which is a lot of weight for a static
// marketing site and drifts from the browser the client's customers actually
// run. puppeteer-core ships no browser and drives the Chrome already installed
// on the machine, so the tests exercise a real, current Chrome.
//
// Set CHROME_PATH to override the search below (CI, or a non-standard install).
import { launch } from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function chromePath() {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'No Chrome found. Set CHROME_PATH to a Chrome/Edge executable.\nSearched:\n  ' +
        CANDIDATES.join('\n  ')
    );
  }
  return found;
}

// openBrowser launches headless Chrome. HEADFUL=1 opens a visible window with
// devtools — the switch to flip when a test fails and you want to watch it.
export async function openBrowser() {
  const headful = process.env.HEADFUL === '1';
  return launch({
    executablePath: chromePath(),
    headless: !headful,
    devtools: headful,
    // A DESKTOP viewport by default. This is not cosmetic: at ≤1024px the CSS
    // turns .facets into an off-canvas drawer (transform: translateX(-100%)),
    // so at Puppeteer's 800x600 default every click on the filter rail lands
    // on a panel that is off screen. Tests that want the drawer must ask for a
    // narrow viewport explicitly — see MOBILE below.
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

// openPage returns a page that FAILS LOUDLY. A silent console error or a
// rejected fetch is exactly how a progressive-enhancement bug hides: the
// server-rendered page still looks fine, so an assertion on visible content
// passes while the JS that was supposed to take over never ran. Every page
// error is collected, and assertNoPageErrors() turns them into a test failure.
export async function openPage(browser) {
  const page = await browser.newPage();
  const errors = [];

  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    errors.push(`requestfailed: ${req.url()} — ${req.failure()?.errorText}`);
  });

  page.assertNoPageErrors = () => {
    if (errors.length) {
      throw new Error('page reported errors:\n  ' + errors.join('\n  '));
    }
  };
  page.pageErrors = errors;
  return page;
}

// MOBILE is the viewport at which the portfolio's filter rail becomes an
// off-canvas drawer (the CSS breakpoint is max-width: 1024px). Pass it to
// page.setViewport() in tests that exercise the drawer.
export const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true };

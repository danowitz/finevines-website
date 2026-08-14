import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../tests/helpers/browser.js';
import { googleImagesURL } from './image-diagnostic-report.mjs';

export async function captureGoogleImagesPage(query, { browser, screenshotPath }) {
  const requestedURL = googleImagesURL(query);
  const page = await browser.newPage();
  let status = 0;
  let error = '';
  try {
    await page.setViewport({ width: 1600, height: 1000 });
    const response = await page.goto(requestedURL, { waitUntil: 'networkidle2', timeout: 30_000 });
    status = response?.status() || 0;
  } catch (caught) {
    error = String(caught?.message || caught).split('\n')[0];
  }
  let bodyExcerpt = '';
  try { bodyExcerpt = String(await page.$eval('body', (element) => element.innerText.slice(0, 1000))).replace(/\s+/g, ' '); } catch {}
  try { await page.screenshot({ path: screenshotPath, fullPage: false }); } catch (caught) { error ||= String(caught?.message || caught).split('\n')[0]; }
  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  await page.close();
  return {
    requestedURL,
    finalUrl,
    status,
    title,
    error,
    bodyExcerpt,
    blocked: status === 429 || /\/sorry\//.test(finalUrl) || /unusual traffic/i.test(bodyExcerpt),
  };
}

async function main() {
  const traceRoot = process.argv[2] || 'out-bottle/image-traces';
  const entries = await readdir(traceRoot, { withFileTypes: true });
  let browser;
  try { browser = await openBrowser(); } catch (error) {
    console.warn(`Google Images capture unavailable: ${error.message}`);
    return;
  }
  try {
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const directory = join(traceRoot, entry.name);
      let trace;
      try { trace = JSON.parse(await readFile(join(directory, 'trace.json'), 'utf8')); } catch { continue; }
      const result = await captureGoogleImagesPage(trace.query, {
        browser,
        screenshotPath: join(directory, 'google-images.png'),
      });
      await writeFile(join(directory, 'google-images.json'), JSON.stringify(result, null, 2) + '\n');
      console.log(`Google Images capture ${entry.name}: HTTP ${result.status}${result.blocked ? ' (blocked)' : ''}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

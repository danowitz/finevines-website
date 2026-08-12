import { access } from 'node:fs/promises';

const failures = [];

try {
  await import('puppeteer-core');
} catch {
  failures.push('Node test dependencies are missing. Run: npm ci --ignore-scripts');
}

if (process.argv.includes('--e2e')) {
  try {
    await access('dist/portfolio/index.html');
  } catch {
    failures.push('The browser-test site is missing. Run: go run ./cmd/finevines build');
  }
}

if (failures.length) {
  console.error(`Test preflight failed:\n- ${failures.join('\n- ')}`);
  process.exit(2);
}

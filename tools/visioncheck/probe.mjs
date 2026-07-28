// Probes which models will actually accept an image, and what a single
// verification call costs in tokens.
//
// Nothing here is taken from documentation or memory: every model is sent a
// real request with a real bottle photograph, and what comes back — or the
// error that comes back instead — is the answer. Capability lists drift, and a
// model that is visible on /v1/models is not necessarily one that takes image
// input on this account.
//
//   node tools/visioncheck/probe.mjs
import { readFile } from 'node:fs/promises';

const key = (await readFile('.env', 'utf8')).match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim();
if (!key) {
  console.error('no OPENAI_API_KEY in .env');
  process.exit(2);
}

const CANDIDATES = [
  'gpt-5.4-nano',
  'gpt-5-nano',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gpt-4.1',
];

const img = await readFile('data/fetched-images/domaine-bruno-clair-gevrey-chambertin-1er-cru-petite-chapelle-2023.png');
const dataUrl = 'data:image/png;base64,' + img.toString('base64');

// Deliberately minimal: this measures whether image input works and what the
// floor cost of one call is, not how good the answer is.
const body = (model) => ({
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Reply with only the producer name printed on this wine label.' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
      ],
    },
  ],
  max_completion_tokens: 400,
});

console.log(`image ${Math.round(img.length / 1024)}KB, detail=low\n`);
console.log('model            ok    in    out   ms    answer / error');
console.log('---------------------------------------------------------------------');

for (const model of CANDIDATES) {
  const t0 = Date.now();
  let line = model.padEnd(16);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body(model)),
    });
    const ms = Date.now() - t0;
    const j = await r.json();
    if (!r.ok) {
      console.log(line + `FAIL  -     -     ${String(ms).padEnd(5)} ${(j.error?.message || '').slice(0, 60)}`);
      continue;
    }
    const u = j.usage || {};
    const answer = (j.choices?.[0]?.message?.content || '').replace(/\s+/g, ' ').trim();
    console.log(
      line +
        `ok    ${String(u.prompt_tokens ?? '?').padEnd(5)} ${String(u.completion_tokens ?? '?').padEnd(5)} ${String(ms).padEnd(5)} ${answer.slice(0, 50) || '(empty)'}`
    );
  } catch (e) {
    console.log(line + `ERR   -     -     -     ${String(e.message).slice(0, 55)}`);
  }
}

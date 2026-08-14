import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoundedLabelReader,
  createLocalBottleAdapters,
  ReaderUnavailableError,
} from '../../tools/labelfetch/bottle-selector-runtime.mjs';

const candidates = Array.from({ length: 5 }, (_, index) => ({ id: String(index), file: `${index}.png` }));

test('visual comparison failures preserve the useful stderr detail', async () => {
  const local = createLocalBottleAdapters({
    verifier: 'imgcheck',
    runImpl: async () => { throw Object.assign(new Error('command failed'), {
      stderr: 'Traceback\ncv2.error: image has incorrect depth',
    }); },
  });
  await assert.rejects(
    () => local.compare(candidates.slice(0, 2)),
    /visual similarity failed: cv2\.error: image has incorrect depth/,
  );
});

test('bounded reader sends one nano request containing at most three images', async () => {
  let body;
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify([
          { single_bottle: true, producer_brand: 'Exact', product_cuvee: 'Wine', appellation: '', vintage: '2022', matches_requested_identity: true },
          { single_bottle: true, producer_brand: 'Sibling', product_cuvee: 'Other', appellation: '', vintage: '2019', matches_requested_identity: false },
          { single_bottle: false, producer_brand: '', product_cuvee: '', appellation: '', vintage: '' },
        ]) } }] }),
      };
    },
    verifyIdentity: async (_wine, _candidate, text) =>
      text.includes('Exact') ? { accept: true } : { accept: false, conflict: 'other cuvee' },
  });

  const evidence = await reader({ name: 'Exact Wine', vintage: '2022' }, candidates);
  assert.equal(body.model, 'gpt-4.1-nano');
  assert.equal(body.messages[0].content.filter((item) => item.type === 'image_url').length, 3);
  assert.equal(evidence.length, 3);
  assert.equal(evidence[0].anchor, true);
  assert.equal(evidence[1].explicitConflict, true);
});

test('bounded reader exposes a sanitized diagnostic transcript beside its evidence', async () => {
  const rawResponse = JSON.stringify([{
    single_bottle: true,
    producer_brand: 'TOR',
    product_cuvee: 'Cabernet Sauvignon',
    appellation: 'Oakville',
    vintage: '',
    wine_style: 'red',
  }]);
  const reader = createBoundedLabelReader({
    apiKey: 'secret-that-must-not-appear',
    model: 'gpt-4.1-mini',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawResponse } }] }),
    }),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });

  const evidence = await reader(
    { name: 'TOR Kenward Family Wines Cabernet Sauvignon Oakville', producer: 'TOR', vintage: '2022' },
    [{ id: 'candidate-1', file: 'one.png' }],
  );

  assert.deepEqual(evidence.readerTrace.candidateIds, ['candidate-1']);
  assert.equal(evidence.readerTrace.model, 'gpt-4.1-mini');
  assert.equal(evidence.readerTrace.response, rawResponse);
  assert.match(evidence.readerTrace.prompt, /transcribe the product identity/i);
  assert.doesNotMatch(JSON.stringify(evidence.readerTrace), /secret-that-must-not-appear/);
});

test('bounded reader sends an explicit reasoning effort only for a configured reasoning model', async () => {
  let body;
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[]' } }] }) };
    },
    verifyIdentity: async () => ({ accept: false }),
  });
  await reader({ name: 'Test Wine' }, candidates.slice(0, 1));
  assert.equal(body.model, 'gpt-5.6-sol');
  assert.equal(body.reasoning_effort, 'medium');
  assert.equal(body.max_completion_tokens, 4000);
});

test('a wrong source-title vintage does not veto an exact vintage-neutral bottle', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([
      { single_bottle: true, producer_brand: 'Exact', product_cuvee: 'Wine', appellation: '', vintage: '' },
    ]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Exact Wine', vintage: '2012' },
    [{ id: 'wrong-source', file: 'wine.png', title: 'Exact Wine 2018' }],
  );
  assert.equal(evidence.anchor, true);
  assert.equal(evidence.productAnchor, true);
  assert.equal(evidence.vintageStatus, 'neutral');
  assert.equal(evidence.explicitConflict, false);
  assert.equal(evidence.sourceVintageMismatch, 'candidate source title says 2018; request is 2012');
});

test('marks anonymous wrong-cardinality output invalid so the proof engine can retry it', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Exact',
      product_cuvee: 'Wine',
      appellation: '',
      vintage: '2022',
      wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });

  const evidence = await reader(
    { name: 'Exact Wine', producer: 'Exact', vintage: '2022' },
    candidates.slice(0, 3),
  );

  assert.equal(evidence.length, 3);
  assert.deepEqual(evidence.map(({ readStatus }) => readStatus), ['invalid', 'invalid', 'invalid']);
  assert.deepEqual(evidence.map(({ reasonCode }) => reasonCode), [
    'READER_RESPONSE_INVALID',
    'READER_RESPONSE_INVALID',
    'READER_RESPONSE_INVALID',
  ]);
  assert.equal(evidence.readerTrace.responseCardinalityValid, false);
});

test('bounded reader can replace each full shot with one local label crop', async () => {
  const prepared = [];
  let body;
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    prepareImage: async (candidate) => {
      prepared.push(candidate.id);
      return Buffer.from(`crop-${candidate.id}`);
    },
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[]' } }] }) };
    },
    verifyIdentity: async () => ({ accept: false }),
  });
  await reader({ name: 'Wine' }, candidates);
  assert.deepEqual(prepared, ['0', '1', '2']);
  assert.equal(body.messages[0].content.filter((item) => item.type === 'image_url').length, 3);
  const images = body.messages[0].content.filter((item) => item.type === 'image_url');
  assert.match(images[0].image_url.url, /Y3JvcC0w$/);
});

test('a broad local producer guess is not promoted to an explicit conflict', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Exact',
        product_cuvee: 'Wine',
        appellation: '',
        vintage: '',
        matches_requested_identity: null,
      }]) } }] }),
    }),
    verifyIdentity: async () => ({ accept: false, conflict: 'california -> black ridge/coastal ridge' }),
  });
  const [evidence] = await reader({ name: 'Exact Wine' }, candidates.slice(0, 1));
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, false);
  assert.equal(evidence.identityMatch, null);
});

test('missing requested product text is unresolved evidence, not a contradiction', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Pichler-Krutzler',
        product_cuvee: '',
        appellation: 'Wachau',
        vintage: '2023',
        matches_requested_identity: true,
      }]) } }] }),
    }),
    verifyIdentity: async () => ({ accept: false }),
  });
  const [evidence] = await reader({
    name: 'Pichler-Krutzler Riesling Ried Loibenberg',
    producer: 'Pichler-Krutzler',
    vintage: '2023',
  }, candidates.slice(0, 1));
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.productAnchor, false);
  assert.equal(evidence.explicitConflict, false);
  assert.equal(evidence.reasonCode, 'PRODUCT_FACET_UNREADABLE');
});

test('local pixel OCR vetoes a model-biased wrong vintage', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Pierre Damoy',
        product_cuvee: 'Les Ravry',
        appellation: 'Bourgogne',
        vintage: '2019',
        matches_requested_identity: true,
      }]) } }] }),
    }),
    verifyIdentity: async () => ({ accept: true, localLabel: 'PIERRE DAMOY BOURGOGNE LES RAVRY 2018' }),
  });
  const [evidence] = await reader({ name: 'Pierre Damoy Bourgogne Rouge', vintage: '2019' }, candidates.slice(0, 1));
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, true);
  assert.equal(evidence.localVisibleVintage, '2018');
});

test('an exact vintage-neutral bottle anchors a vintage listing', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Domaine Jean Royer',
        product_cuvee: 'Cuvee Prestige',
        appellation: 'Chateauneuf-du-Pape',
        vintage: '',
      }]) } }] }),
    }),
    verifyIdentity: async () => ({
      accept: true,
      localLabel: 'DOMAINE JEAN ROYER CUVEE PRESTIGE CHATEAUNEUF DU PAPE',
    }),
  });
  const [evidence] = await reader(
    {
      name: 'Domaine Jean Royer Chateauneuf du Pape Cuvee Prestige',
      producer: 'Domaine Jean Royer',
      vintage: '2022',
    },
    candidates.slice(0, 1),
  );
  assert.equal(evidence.anchor, true);
  assert.equal(evidence.explicitConflict, false);
  assert.equal(evidence.visibleVintage, '');
});

test('a blind pixel-style contradiction vetoes a model confirmation', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Domaine de la Mordoree',
        product_cuvee: 'La Dame Rousse',
        appellation: 'Cotes du Rhone',
        vintage: '2021',
        wine_style: 'red',
        matches_requested_identity: true,
      }]) } }] }),
    }),
    verifyIdentity: async () => ({ accept: true, localLabel: 'LA DAME ROUSSE COTES DU RHONE 2021' }),
  });
  const [evidence] = await reader(
    { name: 'Domaine de la Mordoree Cotes du Rhone Rose', vintage: '2021' },
    [{ ...candidates[0], title: 'Mordoree Cotes du Rhone Rose 2021' }],
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, true);
});

test('a transcribed producer activates the local sibling-cuvee veto', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Lignier-Michelot',
        product_cuvee: 'Les Chenevery',
        appellation: 'Morey Saint Denis Premier Cru',
        vintage: '2011',
        matches_requested_identity: true,
      }]) } }] }),
    }),
    verifyIdentity: async (wine) => ({
      accept: false,
      conflict: `label does not tell this apart from another ${wine.producer} wine`,
      localLabel: '',
    }),
  });
  const [evidence] = await reader(
    { name: 'Lignier-Michelot Morey Saint Denis Vieilles Vignes', producer: '', vintage: '2011' },
    candidates.slice(0, 1),
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, true);
});

test('a premier-cru candidate cannot stand in for a non-premier request', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Maxime Cheurlin Noellat',
        product_cuvee: 'Les Vignerondes',
        appellation: 'Nuits Saint Georges 1er Cru',
        vintage: '2021',
        matches_requested_identity: true,
      }]) } }] }),
    }),
    verifyIdentity: async () => ({ accept: true, localLabel: 'NUITS SAINT GEORGES 1ER CRU 2021' }),
  });
  const [evidence] = await reader(
    { name: 'Maxime Cheurlin Noellat Nuits Saint Georges', vintage: '2021' },
    candidates.slice(0, 1),
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, true);
});

test('reader outage is explicit and cannot become a negative identity verdict', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: false, status: 403 }),
    verifyIdentity: async () => ({ accept: false }),
  });
  await assert.rejects(() => reader({}, candidates), ReaderUnavailableError);
});

test('reader is blind to the requested identity and rejects a different producer', async () => {
  let prompt = '';
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[0].content[0].text;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        single_bottle: true,
        producer_brand: 'Blackbird Vineyards',
        product_cuvee: 'Proprietary Red',
        appellation: 'Napa Valley',
        vintage: '2012',
      }]) } }] }) };
    },
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Brand Napa Valley Proprietary Red', producer: 'Brand Napa', vintage: '2012' },
    candidates.slice(0, 1),
  );
  assert.equal(prompt.includes('Brand Napa'), false);
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, true);
});

test('a compound producer requires every distinctive producer word', async () => {
  const read = createBoundedLabelReader({
    apiKey: 'test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'F.X. Pichler',
      product_cuvee: '',
      appellation: 'Durnsteiner Ried Kellerberg',
      vintage: '2023',
      wine_style: 'white',
    }]) } }] }) }),
    readFileImpl: async () => Buffer.from('x'),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });
  const evidence = await read(
    { name: 'Weingut Pichler-Krutzler Riesling Ried Kellerberg', producer: 'Weingut Pichler-Krutzler', vintage: '2023' },
    [{ id: 'candidate-1', file: 'one.png' }]
  );
  assert.equal(evidence[0].anchor, false);
  assert.match(evidence[0].conflict, /producer/i);
});

test('an Estate bottling remains unresolved when the Estate designation is missing', async () => {
  const read = createBoundedLabelReader({
    apiKey: 'test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Eden Rift',
      product_cuvee: '',
      appellation: 'Central Coast',
      vintage: '',
      wine_style: 'red',
    }]) } }] }) }),
    readFileImpl: async () => Buffer.from('x'),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });
  const evidence = await read(
    { name: 'Eden Rift Vineyards Estate Pinot Noir', producer: 'Eden Rift', vintage: '2022' },
    [{ id: 'candidate-1', file: 'one.png', title: 'Eden Rift Valliant Central Coast Pinot Noir 2022' }]
  );
  assert.equal(evidence[0].anchor, false);
  assert.equal(evidence[0].explicitConflict, false);
  assert.equal(evidence[0].reasonCode, 'PRODUCT_FACET_UNREADABLE');
});

test('a sibling vineyard is rejected when the requested discriminator is absent', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'FX Pichler',
      product_cuvee: 'Durnsteiner',
      appellation: 'Gruner Veltliner',
      vintage: '',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Weingut FX Pichler Gruner Veltliner Ried Loibenberg', producer: 'Weingut FX Pichler', vintage: '2023' },
    candidates.slice(0, 1),
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, true);
  assert.equal(evidence.reasonCode, 'SIBLING_CUVEE_CONFLICT');
});

test('a requested reserve tier must be visible in the blind transcription', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Zolo',
      product_cuvee: 'Malbec',
      appellation: 'Mendoza',
      vintage: '',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Zolo Malbec Reserve', vintage: '2023' },
    candidates.slice(0, 1),
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, false);
  assert.equal(evidence.reasonCode, 'PRODUCT_FACET_UNREADABLE');
});

test('an exact source may supply a tiny discriminator when no competing cuvee is readable', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Domaine Chofflet',
      product_cuvee: '',
      appellation: 'Givry 1er Cru',
      vintage: '2022',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Domaine Chofflet Valdenaire Givry 1er Cru en Choue', producer: 'Domaine Chofflet Valdenaire', vintage: '2022' },
    [{ ...candidates[0], title: 'Domaine Chofflet Givry 1er Cru En Choue 2022' }],
  );
  assert.equal(evidence.anchor, true);
  assert.equal(evidence.explicitConflict, false);
});

test('a numbered bottling stays unresolved unless its designation is visible or named by the source', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Domaine Aegerter',
      product_cuvee: '',
      appellation: 'Nuits-Saint-Georges',
      vintage: '',
      wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Paul Aegerter Nuits Saint Georges #4', producer: 'Paul Aegerter', vintage: '2020' },
    [{ ...candidates[0], title: '2020 Jean Luc et Paul Aegerter Nuits-Saint-Georges Les Plateaux' }],
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, false);
  assert.equal(evidence.reasonCode, 'NUMERIC_DESIGNATION_UNREADABLE');
  assert.match(evidence.conflict || '', /^$/);
});

test('a source title may prove a numbered designation too small to read from the bottle', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Domaine Aegerter',
      product_cuvee: '',
      appellation: 'Nuits-Saint-Georges',
      vintage: '2020',
      wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Paul Aegerter Nuits Saint Georges #4', producer: 'Paul Aegerter', vintage: '2020' },
    [{ ...candidates[0], title: 'Paul Aegerter Nuits-Saint-Georges #4 2020' }],
  );
  assert.equal(evidence.anchor, true);
  assert.equal(evidence.explicitConflict, false);
});

test('an exact source cannot override a different readable cuvee', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test',
    readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'FX Pichler',
      product_cuvee: 'Durnsteiner',
      appellation: 'Gruner Veltliner',
      vintage: '',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Weingut FX Pichler Gruner Veltliner Ried Loibenberg', producer: 'Weingut FX Pichler', vintage: '2023' },
    [{ ...candidates[0], title: 'FX Pichler Gruner Veltliner Ried Loibenberg 2023' }],
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, true);
});

test('source metadata vetoes a premier-cru sibling omitted by transcription', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true, producer_brand: 'Jean-Luc & Eric Burguet',
      product_cuvee: 'Les Rouges du Dessus', appellation: 'Vosne Romanee', vintage: '2019', wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Domaine Alain Burguet Vosne Romanee', vintage: '2019' },
    [{ ...candidates[0], url: 'https://cdn.example/alain-burguet-vosne-romanee-1er-cru-les-rouges-du-dessus-2019.jpg' }],
  );
  assert.equal(evidence.anchor, false);
  assert.match(evidence.conflict, /premier cru/);
});

test('source metadata vetoes a wrong grape even when nano misreads the label', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true, producer_brand: 'FX Pichler', product_cuvee: 'Loibenberg',
      appellation: 'Riesling', vintage: '2022', wine_style: 'white',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'Weingut FX Pichler Riesling Ried Loibenberg', vintage: '2022' },
    [{ ...candidates[0], context: 'https://example.test/fx-pichler-gruner-veltliner-loibenberg' }],
  );
  assert.equal(evidence.anchor, false);
  assert.match(evidence.conflict, /gruner veltliner/);
});

test('a readable named cuvee absent from the request is a sibling conflict', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true, producer_brand: 'Jean-Claude Ramonet', product_cuvee: 'Morgeot',
      appellation: 'Chassagne Montrachet', vintage: '', wine_style: 'white',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    { name: 'JC Ramonet Le Montrachet Grand Cru', vintage: '2022' },
    candidates.slice(0, 1),
  );
  assert.equal(evidence.anchor, false);
  assert.match(evidence.conflict, /different cuvee: morgeot/);
});

test('an appellation misplaced into producer_brand is not a false producer conflict', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true, producer_brand: 'Chambolle-Musigny', product_cuvee: 'Vieilles Vignes',
      appellation: '', vintage: '', wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: false }),
  });
  const [evidence] = await reader(
    { name: 'Domaine Philippe Jouan Chambolle Musigny', producer: 'Domaine Philippe Jouan', vintage: '2023' },
    [{ ...candidates[0], title: '2023 Domaine Henri & Philippe Jouan Chambolle Musigny' }],
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, false);
});

test('a fuzzy cuvee token misplaced into producer_brand is not a producer conflict', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true, producer_brand: 'Concellette', product_cuvee: '',
      appellation: 'Morgon Vieilles Vignes', vintage: '2018', wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });
  const [evidence] = await reader(
    {
      name: 'Bouland Domaine Daniel Bouland Morgon Vieilles Vignes Corcelette',
      producer: 'Bouland', vintage: '2018',
    },
    candidates.slice(0, 1),
  );
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, false);
});

test('matching appellation and cuvee cannot anchor a bottle when the requested producer is absent', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Volnay-Fremiets',
      product_cuvee: 'Premier Cru',
      appellation: 'Bourgogne-Chambertin',
      vintage: '',
      wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true }),
  });

  const [evidence] = await reader(
    {
      name: 'Domaine des Epeneaux Volnay 1ER Cru les Fremiets',
      producer: 'Domaine des Epeneaux',
      vintage: '2018',
    },
    candidates.slice(0, 1),
  );

  assert.equal(evidence.anchor, false);
  assert.equal(evidence.explicitConflict, false);
});

test('a one-letter OCR omission in a distinctive cuvee does not create a false conflict', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Domaine Chicotot',
      product_cuvee: 'Nuits-Saint-Georges 1er Cru',
      appellation: 'Aux Torey',
      vintage: '2019',
      wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });
  const [evidence] = await reader(
    {
      name: 'Chicotot Domaine Georges Chicotot Nuits Saint Georges 1er Cru aux Thorey',
      producer: 'Domaine Georges Chicotot',
      vintage: '2019',
    },
    [{ ...candidates[0], title: 'Nuits-Saint-Georges 1er Cru Aux Thorey 2019' }],
  );

  assert.equal(evidence.anchor, true);
  assert.equal(evidence.explicitConflict, false);
});

test('a two-word bottle brand present in the catalog name can prove its parent producer', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      single_bottle: true,
      producer_brand: 'Baker & Hamilton',
      product_cuvee: 'Cabernet Sauvignon',
      appellation: 'Oakville, Napa Valley',
      vintage: '2022',
      wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });
  const [evidence] = await reader(
    {
      name: 'Vine Hill Ranch Baker & Hamilton Cabernet Sauvignon Napa Valley',
      producer: 'Vine Hill Ranch',
      vintage: '2022',
    },
    candidates.slice(0, 1),
  );

  assert.equal(evidence.anchor, true);
  assert.equal(evidence.explicitConflict, false);
});

test('an explicit bottle-facing brand alias can prove its commercial producer', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      candidate_id: '0',
      single_bottle: true,
      producer_brand: 'Laetitia Ducroux',
      product_cuvee: 'Sancerre',
      appellation: 'Sancerre',
      vintage: '',
      wine_style: 'white',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });
  const [evidence] = await reader(
    {
      name: 'Huteau Boulanger Sancerre Laetitia Ducroux',
      producer: 'Huteau Boulanger',
      bottleBrands: ['Laetitia Ducroux'],
      vintage: '2024',
    },
    candidates.slice(0, 1),
  );

  assert.equal(evidence.anchor, true);
  assert.equal(evidence.productAnchor, true);
  assert.equal(evidence.explicitConflict, false);
});

test('a visibly wrong vintage preserves product proof but blocks publication', async () => {
  const reader = createBoundedLabelReader({
    apiKey: 'test', readFileImpl: async () => Buffer.from('image'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{
      candidate_id: '0',
      single_bottle: true,
      producer_brand: 'Exact',
      product_cuvee: 'Wine',
      appellation: '',
      vintage: '2021',
      wine_style: 'red',
    }]) } }] }) }),
    verifyIdentity: async () => ({ accept: true, localLabel: '' }),
  });
  const [evidence] = await reader(
    { name: 'Exact Wine', producer: 'Exact', vintage: '2022' },
    candidates.slice(0, 1),
  );

  assert.equal(evidence.productAnchor, true);
  assert.equal(evidence.anchor, false);
  assert.equal(evidence.vintageStatus, 'wrong-visible');
  assert.equal(evidence.reasonCode, 'VISIBLE_WRONG_VINTAGE');
});

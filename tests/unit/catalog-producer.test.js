import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProducerLookup, expectedProducer } from '../../tools/labelfetch/catalog-producer.mjs';

test('a blank producer inherits the unique producer from another vintage of the same wine', () => {
  const rows = [
    { name: 'Domaine Jean Royer Cuvee Prestige', vintage: '2020', producer: 'Jean Royer' },
    { name: 'Domaine Jean Royer Cuvee Prestige', vintage: '2022', producer: '' },
  ];
  assert.equal(expectedProducer(rows[1], buildProducerLookup(rows)), 'Jean Royer');
});

test('an ambiguous catalog name does not invent an expected producer', () => {
  const rows = [
    { name: 'Reserve Red', producer: 'Estate A' },
    { name: 'Reserve Red', producer: 'Estate B' },
    { name: 'Reserve Red', producer: '' },
  ];
  assert.equal(expectedProducer(rows[2], buildProducerLookup(rows)), '');
});

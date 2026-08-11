import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTwoSourceApproval } from '../../tools/labelfetch/two-source-approval.mjs';

const candidate = (overrides = {}) => ({
  file: 'candidate.png',
  page: 'https://one.example/domaine-rapet-corton-charlemagne-grand-cru-2023',
  image: 'https://one.example/rapet-corton-charlemagne-2023.png',
  size: '400x700',
  strongestGroup: true,
  subjectOk: true,
  displayOk: true,
  explicitConflict: false,
  why: 'identity not proven automatically',
  ...overrides,
});

test('approves the best publishable copy when two exact independent sources agree', () => {
  const record = { name: 'Domaine Rapet Corton Charlemagne Grand Cru' };
  const candidates = [
    candidate(),
    candidate({ file: 'large.png', page: 'https://two.example/domaine-rapet-corton-charlemagne-grand-cru', size: '800x1200' }),
  ];
  const result = chooseTwoSourceApproval(record, candidates, [{ a: 0, b: 1, distance: 5 }]);
  assert.equal(result.pick.file, 'large.png');
  assert.deepEqual(result.hosts, ['one.example', 'two.example']);
});

test('refuses same-host duplicates and explicit identity conflicts', () => {
  const record = { name: 'Domaine Rapet Corton Charlemagne Grand Cru' };
  const sameHost = [candidate(), candidate({ file: 'b.png' })];
  assert.equal(chooseTwoSourceApproval(record, sameHost, [{ a: 0, b: 1, distance: 1 }]), null);

  const conflict = [candidate(), candidate({
    file: 'wrong.png',
    page: 'https://two.example/domaine-rapet-corton-charlemagne-grand-cru',
    explicitConflict: true,
    why: 'visible vintage 2020; catalog vintage 2023',
  })];
  assert.equal(chooseTwoSourceApproval(record, conflict, [{ a: 0, b: 1, distance: 1 }]), null);
});

test('refuses a lookalike pair whose sources do not identify the requested wine', () => {
  const record = { name: 'Domaine Rapet Corton Charlemagne Grand Cru' };
  const candidates = [
    candidate(),
    candidate({ file: 'sibling.png', page: 'https://two.example/generic-white-burgundy' }),
  ];
  assert.equal(chooseTwoSourceApproval(record, candidates, [{ a: 0, b: 1, distance: 2 }]), null);
});

test('uses an exact-vintage strongest-group image instead of a larger older bottle', () => {
  const record = {
    name: 'Domaine Rapet Corton Charlemagne Grand Cru',
    query: 'Domaine Rapet Corton Charlemagne Grand Cru 2023 bottle',
  };
  const candidates = [
    candidate({ size: '1000x1600', page: 'https://one.example/domaine-rapet-corton-charlemagne-grand-cru-2022' }),
    candidate({ file: 'peer.png', page: 'https://two.example/domaine-rapet-corton-charlemagne-grand-cru-2021' }),
    candidate({ file: 'exact.png', page: 'https://three.example/domaine-rapet-corton-charlemagne-grand-cru-2023', size: '300x600' }),
  ];
  const result = chooseTwoSourceApproval(record, candidates, [{ a: 0, b: 1, distance: 4 }]);
  assert.equal(result.pick.file, 'exact.png');
});

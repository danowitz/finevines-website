import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarise } from '../../tools/coverage/report.mjs'

test('counts cards, not rows — vintages of one wine collapse', () => {
  const wines = [
    { sku: '1', producer: 'Dom X', name: 'Cuvee A', vintage: '2020', imagePath: 'a.jpg' },
    { sku: '2', producer: 'Dom X', name: 'Cuvee A', vintage: '2021', imagePath: 'b.svg' },
    { sku: '3', producer: 'Dom Y', name: 'Cuvee B', vintage: '2020', imagePath: 'c.svg' },
  ]
  const s = summarise(wines, {})
  assert.equal(s.cards, 2)
  assert.equal(s.cardsWithPhoto, 1)
  assert.equal(s.rowsWithPhoto, 1)
})

test('splits the imageless into tried and never-tried', () => {
  const wines = [
    { sku: '1', producer: 'A', name: 'A', imagePath: 'a.svg' },
    { sku: '2', producer: 'B', name: 'B', imagePath: 'b.svg' },
  ]
  const ledger = { 1: { outcome: 'miss', attempts: 3 } }
  const s = summarise(wines, ledger)
  assert.equal(s.missing.miss, 1)
  assert.equal(s.missing.never, 1)
})

test('missing imagePath counts as imageless at both row and card level', () => {
  const wines = [
    { sku: '1', producer: 'Dom X', name: 'Wine A', vintage: '2020', imagePath: 'a.jpg' },
    { sku: '2', producer: 'Dom X', name: 'Wine A', vintage: '2021' }, // missing imagePath
    { sku: '3', producer: 'Dom Y', name: 'Wine B', vintage: '2020' }, // missing imagePath
  ]
  const s = summarise(wines, {})
  assert.equal(s.rows, 3)
  assert.equal(s.rowsWithPhoto, 1)
  assert.equal(s.cards, 2)
  assert.equal(s.cardsWithPhoto, 1)
  assert.equal(s.missing.never, 2)
})

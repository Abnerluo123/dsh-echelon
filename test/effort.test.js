/**
 * Tests for reasoning-effort translation.
 * @module test/effort.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EFFORT_IDS, EFFORT_LADDER, effortIds, effortOptions, mapEffort, rankOf, supportsLadder } from '../src/effort.js'

const list = (...ids) => ids.map(id => ({ id, name: id }))

test('the ladder runs off → low → middle → high → xhigh', () => {
  assert.deepEqual(EFFORT_IDS, ['off', 'low', 'middle', 'high', 'xhigh'])
  assert.deepEqual(EFFORT_LADDER.map(step => step.rank), [0, 1, 2, 3, 4])
  assert.deepEqual(EFFORT_LADDER.map(step => step.id), EFFORT_IDS)
})

test('spellings from different providers land on the same rank', () => {
  // The whole point: one provider's `middle` is another's `medium`/`mid`.
  assert.equal(rankOf('off'), 0)
  assert.equal(rankOf('none'), 0)
  assert.equal(rankOf('low'), 1)
  assert.equal(rankOf('minimal'), 1)
  assert.equal(rankOf('medium'), 2)
  assert.equal(rankOf('middle'), 2)
  assert.equal(rankOf('mid'), 2)
  assert.equal(rankOf('high'), 3)
  assert.equal(rankOf('xhigh'), 4)
  assert.equal(rankOf('XHigh'), 4)
  assert.equal(rankOf('x-high'), 4)
  assert.equal(rankOf('max'), 4)
  assert.equal(rankOf('turbo'), undefined, 'an unknown name belongs to nobody')
  assert.equal(rankOf(undefined), undefined)
  assert.equal(rankOf(42), undefined)
})

test('an exact match is forwarded untouched', () => {
  const result = mapEffort('high', list('low', 'high', 'max'))
  assert.equal(result.effort, 'high')
  assert.equal(result.mapped, false)
  assert.equal(result.reason, 'exact')
})

test('xhigh becomes the model\'s own top level', () => {
  const result = mapEffort('xhigh', list('low', 'medium', 'high', 'max'))
  assert.equal(result.effort, 'max', '`max` is this model\'s xhigh')
  assert.equal(result.mapped, true)
  assert.equal(result.reason, 'same-rank')
})

test('middle becomes whatever that model calls the middle', () => {
  assert.equal(mapEffort('middle', list('minimal', 'low', 'medium', 'high')).effort, 'medium')
  // `middle` (2) is one step from low and one from high here, so the tie rule
  // applies and picks the stronger one.
  assert.equal(mapEffort('middle', list('off', 'low', 'high')).effort, 'high')
})

test('a missing rung snaps to the nearest available one', () => {
  // high(3) is one step from xhigh(4) and two from low(1).
  assert.equal(mapEffort('high', list('low', 'xhigh')).effort, 'xhigh')
  // Requesting `xhigh` from a model topping out at high.
  assert.equal(mapEffort('xhigh', list('low', 'medium', 'high')).effort, 'high')
})

test('ties go to the stronger level', () => {
  // `middle` is equidistant from `low` and `high`; the stronger one must win so
  // a request never quietly gets the cheaper lane.
  assert.equal(mapEffort('middle', list('low', 'high')).effort, 'high')
})

test('off maps to the lowest level when the model cannot switch reasoning off', () => {
  const result = mapEffort('off', list('low', 'medium', 'high'))
  assert.equal(result.effort, 'low', 'the cheapest available lane is the closest thing to off')
  assert.equal(mapEffort('off', list('off', 'high')).effort, 'off')
})

test('unknown support forwards the request unchanged', () => {
  // A model that declares nothing keeps the provider's own default; guessing
  // here would replace it with an invented level.
  const result = mapEffort('high', undefined)
  assert.equal(result.effort, 'high')
  assert.equal(result.mapped, false)
  assert.equal(result.reason, 'unknown-support')
  assert.deepEqual(mapEffort('high', []), { effort: 'high', mapped: false, reason: 'unknown-support' })
})

test('a foreign name passes through when it cannot be matched', () => {
  const result = mapEffort('turbo', list('low', 'high'))
  assert.equal(result.effort, 'turbo')
  assert.equal(result.mapped, false)
  assert.equal(result.reason, 'foreign-name')
  // ...but still works when the model actually offers it.
  assert.equal(mapEffort('turbo', list('low', 'turbo')).effort, 'turbo')
})

test('follow-session stays undefined', () => {
  assert.deepEqual(mapEffort(undefined, list('low', 'high')), { effort: undefined, mapped: false, reason: 'follow-session' })
})

test('effortIds tolerates both shapes', () => {
  assert.deepEqual(effortIds([{ id: 'low' }, 'high']), ['low', 'high'])
  assert.deepEqual(effortIds([{ id: 'low' }, { id: 'low' }]), ['low'], 'duplicates collapse')
  assert.deepEqual(effortIds(undefined), [])
  assert.deepEqual(effortIds(['', 7, null]), [])
})

test('effortOptions always offers the ladder, plus declared extras', () => {
  assert.deepEqual(effortOptions().map(option => option.id), EFFORT_IDS)
  const withExtra = effortOptions(['turbo', 'low']).map(option => option.id)
  assert.deepEqual(withExtra.slice(0, 5), EFFORT_IDS, 'the ladder comes first')
  assert.ok(withExtra.includes('turbo'), 'a provider-specific name stays selectable')
  assert.equal(withExtra.filter(id => id === 'low').length, 1, 'no duplicate')
})

test('supportsLadder needs at least one rankable member', () => {
  assert.equal(supportsLadder([list('low', 'high')]), true)
  assert.equal(supportsLadder([list('turbo'), list('low')]), true)
  assert.equal(supportsLadder([list('turbo'), undefined]), false)
  assert.equal(supportsLadder([undefined, []]), false)
})

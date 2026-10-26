/**
 * Tests for reasoning-effort translation.
 * @module test/effort.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EFFORT_IDS, EFFORT_LADDER, effortIds, mapEffort, rankOf, snapEffort } from '../src/effort.js'

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

test('off never crosses into the strength levels', () => {
  // `off` is a switch, not the bottom rung. Mapping `off` onto `low` used to be
  // described as "the cheapest available lane", but it is not off: the model
  // keeps thinking. Dropping the request lets the member use its own default,
  // which is the honest outcome and is reported as such.
  const result = mapEffort('off', list('low', 'medium', 'high'))
  assert.equal(result.effort, undefined)
  assert.equal(result.reason, 'cannot-disable')
  assert.equal(mapEffort('off', list('off', 'high')).effort, 'off')
  // `none` is an `off` spelling, so it lands exactly.
  assert.equal(mapEffort('off', list('none', 'low', 'high')).effort, 'none')
})

test('a request for thinking never lands on off', () => {
  // The reported bug: a gateway declaring a binary `off`/`on` toggle turned a
  // request for `high` into `off`, because `off` was the only rankable
  // neighbour. Asking for hard thinking and getting none is worse than sending
  // nothing.
  assert.equal(mapEffort('high', list('off', 'on')).effort, 'on', '`on` means thinking')
  assert.equal(mapEffort('high', list('off', 'on')).reason, 'same-rank')
  const stuck = mapEffort('high', list('off'))
  assert.equal(stuck.effort, undefined, 'a member that only knows off cannot be asked for high')
  assert.equal(stuck.reason, 'no-thinking-level')
})

test('unknown support drops the level instead of forwarding it', () => {
  // A model that publishes nothing rejects *any* explicit effort before provider
  // I/O (DSH returns UNSUPPORTED_REASONING_EFFORT). Forwarding the request
  // unchanged — the old behaviour — therefore guaranteed a failed call rather
  // than preserving the provider default.
  const result = mapEffort('high', undefined)
  assert.equal(result.effort, undefined)
  assert.equal(result.mapped, true)
  assert.equal(result.reason, 'unknown-support')
  assert.deepEqual(mapEffort('xhigh', []), { effort: undefined, mapped: true, reason: 'unknown-support' })
})

test('a foreign name is dropped when the member does not publish it', () => {
  const result = mapEffort('turbo', list('low', 'high'))
  assert.equal(result.effort, undefined, 'sending turbo here would be rejected by the member')
  assert.equal(result.mapped, true)
  assert.equal(result.reason, 'foreign-name')
  // ...but still works when the model actually offers it.
  assert.equal(mapEffort('turbo', list('low', 'turbo')).effort, 'turbo')
})

test('a member with only foreign names gets no level rather than an unsafe guess', () => {
  assert.deepEqual(mapEffort('high', list('turbo', 'ludicrous')), { effort: undefined, mapped: true, reason: 'no-thinking-level' })
})

test('every mapped level is one the member publishes', () => {
  // The invariant DSH requires: an explicit effort is forwarded verbatim and
  // rejected unless the model declares it. Anything else must be dropped.
  const declared = [list('none', 'low', 'high', 'max'), list('minimal', 'medium'), list('turbo'), list('off', 'xhigh')]
  for (const supported of declared) {
    const ids = supported.map(effort => effort.id)
    for (const wanted of [...EFFORT_IDS, 'turbo', 'ludicrous', 'medium']) {
      const result = mapEffort(wanted, supported)
      assert.ok(
        result.effort === undefined || ids.includes(result.effort),
        `${wanted} on ${ids.join('/')} produced ${result.effort}`,
      )
    }
  }
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

test('a pinned default snaps onto the levels a member actually publishes', () => {
  // The settings control speaks the five canonical names; a tier may speak
  // Off/Low/High/Max. `xhigh` has to arrive as `max`, not as a word the model
  // never published.
  assert.equal(snapEffort('xhigh', ['none', 'low', 'high', 'max']), 'max')
  assert.equal(snapEffort('middle', ['off', 'low', 'high']), 'high', 'ties go to the stronger level')
  assert.equal(snapEffort('low', ['none', 'low', 'high', 'max']), 'low', 'an exact match is kept')
  assert.equal(snapEffort('high', []), undefined, 'nothing to snap onto')
  assert.equal(snapEffort('high', ['turbo']), undefined, 'a foreign-only menu cannot honour a ladder name')
})


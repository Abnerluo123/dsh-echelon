/**
 * Tests for the request log and its retention rules.
 * @module test/log.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT, MIN_LOG_LIMIT } from '../src/config.js'
import { RequestLog, clampLogLimit, usageOf } from '../src/log.js'

/** A log seeded with `count` committed entries. */
function seeded(count, limit) {
  const log = new RequestLog({ limit })
  for (let index = 0; index < count; index += 1) {
    const turn = log.begin({ tier: 'auto', tierName: 'Auto' })
    turn.attempt({ provider: 'p', model: `m${index}`, attempt: 1, outcome: 'ok' })
    turn.commit({ outcome: 'ok', provider: 'p', model: `m${index}` })
  }
  return log
}

test('an entry is invisible until it is committed', () => {
  const log = new RequestLog()
  const turn = log.begin({ tier: 'auto', tierName: 'Auto' })
  assert.equal(log.read().total, 0, 'a pending turn must not be readable')
  turn.commit({ outcome: 'ok', provider: 'p', model: 'm' })
  assert.equal(log.read().total, 1)
  assert.equal(log.read().entries[0].provider, 'p')
})

test('a committed entry records its duration and keeps attempts in order', () => {
  const log = new RequestLog()
  const turn = log.begin({ tier: 'fast', tierName: '快' })
  turn.attempt({ provider: 'a', model: 'one', attempt: 1, outcome: 'failover', code: 'SERVER' })
  turn.attempt({ provider: 'b', model: 'two', attempt: 1, outcome: 'ok' })
  turn.commit({ outcome: 'ok', provider: 'b', model: 'two' })
  const [entry] = log.read().entries
  assert.equal(entry.tierName, '快')
  assert.equal(entry.attempts.length, 2)
  assert.equal(entry.attempts[0].provider, 'a')
  assert.equal(entry.attempts[1].provider, 'b')
  assert.ok(Number.isFinite(entry.durationMs))
  assert.ok(entry.durationMs >= 0)
})

test('commit twice keeps the first outcome', () => {
  const log = new RequestLog()
  const turn = log.begin({ tier: 'auto', tierName: 'Auto' })
  turn.commit({ outcome: 'ok', provider: 'p', model: 'm' })
  turn.commit({ outcome: 'failed' })
  assert.equal(log.read().total, 1)
  assert.equal(log.read().entries[0].outcome, 'ok')
})

test('retention bounds the log and keeps the newest entries', () => {
  const log = seeded(30, 40)
  assert.equal(log.read().total, 30)
  log.setLimit(MIN_LOG_LIMIT)
  assert.equal(log.read().total, MIN_LOG_LIMIT, 'lowering the limit drops the oldest immediately')
  assert.equal(log.read().entries[0].model, 'm29', 'the newest entry survives')

  // Below the floor the constructor clamps up rather than letting a caller
  // configure a log that forgets the turn it is about to explain.
  const floor = seeded(30, 3)
  assert.equal(floor.limit, MIN_LOG_LIMIT)
  assert.equal(floor.read().total, MIN_LOG_LIMIT)

  const capped = seeded(30, 22)
  assert.equal(capped.read().total, 22)
  assert.equal(capped.read().entries[0].model, 'm29')
})

test('ids keep advancing so a since-poll stays correct', () => {
  const log = seeded(3)
  const first = log.read()
  assert.equal(first.newestId, 3)
  log.clear()
  assert.equal(log.read().total, 0)
  assert.equal(log.read().newestId, 3, 'clearing does not rewind the id source')
  const turn = log.begin({ tier: 'auto', tierName: 'Auto' })
  turn.commit({ outcome: 'ok' })
  assert.equal(log.read().entries[0].id, 4, 'a new entry never reuses a cleared id')
  const since = log.read({ since: 3 })
  assert.equal(since.entries.length, 1)
  assert.equal(log.read({ since: 4 }).entries.length, 0)
})

test('read returns detached copies', () => {
  const log = seeded(1)
  const view = log.read()
  view.entries[0].model = 'mutated'
  view.entries[0].attempts[0].model = 'mutated'
  const fresh = log.read().entries[0]
  assert.equal(fresh.model, 'm0')
  assert.equal(fresh.attempts[0].model, 'm0')
})

test('attempt rows are capped and the overflow is counted, not silently dropped', () => {
  const log = new RequestLog()
  const turn = log.begin({ tier: 'auto', tierName: 'Auto' })
  for (let index = 0; index < 20; index += 1) {
    turn.attempt({ provider: 'p', model: `m${index}`, attempt: 1, outcome: 'failover' })
  }
  turn.commit({ outcome: 'failed' })
  const [entry] = log.read().entries
  assert.equal(entry.attempts.length, 12)
  assert.equal(entry.droppedAttempts, 8)
})

test('limits are clamped rather than trusted', () => {
  assert.equal(clampLogLimit(undefined), DEFAULT_LOG_LIMIT)
  assert.equal(clampLogLimit(0), MIN_LOG_LIMIT)
  assert.equal(clampLogLimit(10 ** 9), MAX_LOG_LIMIT)
  assert.equal(clampLogLimit('abc'), DEFAULT_LOG_LIMIT)
  assert.equal(clampLogLimit(50), 50)
})

test('read honours an explicit limit', () => {
  const log = seeded(10, 20)
  assert.equal(log.read({ limit: 3 }).entries.length, 3)
  assert.equal(log.read({ limit: 0 }).entries.length, 1, 'a zero limit clamps to one')
})

test('usageOf takes the last usage chunk of the committed stream', () => {
  assert.deepEqual(
    usageOf([
      { type: 'text-delta', text: 'hi' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  )
  assert.deepEqual(
    usageOf([
      { type: 'usage', usage: { inputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } },
    ]),
    { inputTokens: 2, outputTokens: 3 },
    'the last report wins',
  )
  assert.equal(usageOf([{ type: 'text-delta', text: 'hi' }]), undefined)
  assert.equal(usageOf([{ type: 'usage', usage: {} }]), undefined, 'an empty usage is not a reading')
})

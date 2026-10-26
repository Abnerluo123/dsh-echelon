/**
 * End-to-end tests for the adapter's dispatch behaviour against a fake LLM
 * runtime that behaves like DSH's own registry.
 *
 * The fake implements the three pieces the adapter depends on — `listProviders`,
 * `resolveModelInfo`, and `prepareCall` returning a one-shot stream — so these
 * tests exercise the real failover logic, not a stub of it.
 *
 * @module test/adapter.test.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { RouterAdapter, commitsAnswer, intersectEfforts, runMember } from '../src/adapter.js'
import { SettingsStore } from '../src/store.js'

const directories = []
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

/** Build a store backed by a temporary settings file. */
function makeStore(settings) {
  const directory = mkdtempSync(join(tmpdir(), 'router-test-'))
  directories.push(directory)
  const file = join(directory, 'settings.json')
  writeFileSync(file, JSON.stringify(settings), 'utf8')
  return new SettingsStore(file, { log: () => {} })
}

/**
 * One scripted member: a list of attempts, each either a chunk list or a throw.
 * @param {...Array<object>} attempts - chunk lists, one per attempt.
 */
function ok(chunks) {
  return { kind: 'ok', chunks }
}

const fail = (code, message = 'failed') => ({ kind: 'fail', code, message })
const bang = message => ({ kind: 'throw', message })

/** Build a fake `llm` service whose `prepareCall` is scripted per route. */
function makeLlm(script) {
  const calls = []
  const models = new Map(Object.entries(script.models ?? {}))
  return {
    calls,
    listProviders: () => [...models.keys()].map(id => ({ id, name: id })),
    resolveModelInfo: async (provider, model) => {
      const entry = models.get(provider)
      if (entry === undefined) throw new Error(`no provider ${provider}`)
      const known = entry.models?.find(candidate => candidate.id === model)
      if (known === undefined) throw new Error(`no model ${model}`)
      return {
        provider, id: model, name: known.name ?? model,
        ...(known.contextWindow === undefined ? {} : { context: { contextWindow: known.contextWindow } }),
        ...(known.efforts === undefined ? {} : {
          reasoning: { efforts: known.efforts.map(id => ({ id, name: id })), defaultEffort: known.efforts[0] },
        }),
      }
    },
    prepareCall: async config => {
      calls.push(`${config.provider}/${config.model}`)
      const plan = script.routes[`${config.provider}/${config.model}`]
      if (plan === undefined) throw new Error(`unrouted ${config.provider}/${config.model}`)
      return {
        config: { ...config },
        stream: () => streamOf(plan.shift() ?? fail('TRANSPORT', 'no scripted attempt left')),
      }
    },
  }
}

/** Turn one scripted attempt into an async chunk stream. */
async function* streamOf(attempt) {
  if (attempt.kind === 'throw') throw new Error(attempt.message)
  if (attempt.kind === 'ok') {
    for (const chunk of attempt.chunks) yield chunk
    return
  }
  yield { type: 'finish', reason: { kind: 'error', failure: { code: attempt.code, message: attempt.message } } }
}

/** A complete, visible answer. */
const answer = text => ok([
  { type: 'text-delta', text },
  { type: 'block-end', block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop', stopReason: 'end' } },
])

/** Reasoning only — nothing a transcript reader would see. */
const reasoningOnly = () => ok([
  { type: 'reasoning-delta', text: 'thinking…' },
  { type: 'block-end', block: { type: 'reasoning', text: 'thinking…' } },
  { type: 'finish', reason: { kind: 'stop', stopReason: 'end' } },
])

/** Wire an adapter to a store and a fake runtime. */
function wire(settings, script) {
  const store = makeStore(settings)
  const llm = makeLlm(script)
  const adapter = new RouterAdapter({ store, logger: {} })
  adapter.ctx = { llm }
  return { adapter, store, llm, log: adapter.requestLog }
}

/** Collect a tier's stream to completion. */
async function collect(adapter, model, extra = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'model-router', model, messages: [], ...extra })) {
    chunks.push(chunk)
  }
  return chunks
}

/** The final finish chunk of a stream. */
const finishOf = chunks => chunks.find(chunk => chunk.type === 'finish')

/** One configured tier with the given members. */
const tierSettings = (members, extra = {}) => ({
  version: 1,
  exposure: 'all',
  tiers: [{ id: 'auto', name: 'Auto', order: 0, members }],
  hide: [],
  ...extra,
})

test('the first answering member wins and later members are never dialled', async () => {
  const { adapter, llm } = wire(
    tierSettings([{ provider: 'a', model: 'one' }, { provider: 'b', model: 'two' }]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [answer('hello')], 'b/two': [answer('unused')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hello')
  assert.deepEqual(llm.calls, ['a/one'])
  assert.equal(finishOf(chunks).reason.kind, 'stop')
})

test('a failing member fails over to the next one', async () => {
  const { adapter, llm } = wire(
    tierSettings([
      { provider: 'a', model: 'one', attempts: 0 },
      { provider: 'b', model: 'two' },
    ]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [fail('SERVER')], 'b/two': [answer('backup')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.deepEqual(llm.calls, ['a/one', 'b/two'])
})

test('one member is retried before the chain moves on', async () => {
  const { adapter, llm } = wire(
    tierSettings([{ provider: 'a', model: 'one', attempts: 2 }, { provider: 'b', model: 'two' }]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [fail('RATE_LIMIT'), fail('RATE_LIMIT'), answer('recovered')], 'b/two': [answer('unused')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.deepEqual(llm.calls, ['a/one', 'a/one', 'a/one'])
})

test('a deterministic failure is not retried on the same member', async () => {
  const { adapter, llm } = wire(
    tierSettings([{ provider: 'a', model: 'one', attempts: 3 }, { provider: 'b', model: 'two' }]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [fail('AUTH')], 'b/two': [answer('next lane')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.deepEqual(llm.calls, ['a/one', 'b/two'], 'an auth failure must not consume the retry budget')
})

test('reasoning-only output is not committed, so the lane can still be abandoned', async () => {
  const { adapter } = wire(
    tierSettings([{ provider: 'a', model: 'one', attempts: 0 }, { provider: 'b', model: 'two' }]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [reasoningOnly()], 'b/two': [answer('real answer')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'real answer')
  assert.equal(
    chunks.filter(chunk => chunk.type === 'reasoning-delta').length,
    0,
    'the abandoned lane’s reasoning must never reach the transcript',
  )
})

test('every member failing ends the turn once, naming what was tried', async () => {
  const { adapter } = wire(
    tierSettings([{ provider: 'a', model: 'one', attempts: 1 }, { provider: 'b', model: 'two', attempts: 0 }]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [fail('SERVER'), fail('SERVER')], 'b/two': [fail('QUOTA', 'no credit')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  const finishes = chunks.filter(chunk => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'error')
  assert.match(finishes[0].reason.failure.message, /a\/one/)
  assert.match(finishes[0].reason.failure.message, /b\/two/)
})

test('an empty tier reports how to fix it instead of silently failing', async () => {
  const { adapter } = wire(tierSettings([]), { models: {}, routes: {} })
  const chunks = await collect(adapter, 'auto')
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /模型路由/)
})

test('an unknown tier id and a disabled tier each end the turn', async () => {
  const { adapter } = wire(
    { ...tierSettings([{ provider: 'a', model: 'one' }]), tiers: [{ id: 'auto', name: 'Auto', enabled: false, members: [{ provider: 'a', model: 'one' }] }] },
    { models: { a: { models: [{ id: 'one' }] } }, routes: {} },
  )
  assert.equal(finishOf(await collect(adapter, 'nope')).reason.failure.code, 'NO_ROUTE')
  assert.equal(finishOf(await collect(adapter, 'auto')).reason.failure.code, 'CONFIG_DISABLED')
})

test('members whose provider vanished are skipped instead of dialled', async () => {
  const { adapter, llm } = wire(
    tierSettings([{ provider: 'gone', model: 'x' }, { provider: 'a', model: 'one' }]),
    { models: { a: { models: [{ id: 'one' }] } }, routes: { 'a/one': [answer('ok')] } },
  )
  const chunks = await collect(adapter, 'auto')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.deepEqual(llm.calls, ['a/one'])
})

test('an abort during a member ends the turn as aborted, not as a chain failure', async () => {
  const controller = new AbortController()
  const store = makeStore(tierSettings([{ provider: 'a', model: 'one' }]))
  const adapter = new RouterAdapter({ store, logger: {} })
  adapter.ctx = {
    llm: {
      listProviders: () => [{ id: 'a', name: 'a' }],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
      prepareCall: async config => ({
        config,
        stream: async function* () {
          controller.abort()
          yield* streamOf(fail('ABORTED'))
        },
      }),
    },
  }
  const chunks = await collect(adapter, 'auto', { signal: controller.signal })
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
})

test('a member idle past its timeout is abandoned and the chain continues', async () => {
  const store = makeStore(tierSettings([
    { provider: 'a', model: 'one', attempts: 0, idleTimeoutMs: 5_000 },
    { provider: 'b', model: 'two' },
  ]))
  const adapter = new RouterAdapter({ store, logger: {} })
  let returned = false
  adapter.ctx = {
    llm: {
      listProviders: () => [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
      prepareCall: async config => ({
        config,
        stream: () => config.provider === 'a'
          // Never yields: the idle timeout must win.
          ? {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise(() => {}),
                return: async () => { returned = true; return { done: true } },
              }
            },
          }
          : streamOf(answer('rescued')),
      }),
    },
  }
  const started = Date.now()
  const chunks = await collect(adapter, 'auto')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.ok(Date.now() - started >= 4_900, 'the timeout must actually elapse')
  assert.equal(returned, true, 'the abandoned iterator must be settled')
})

test('a member that throws is treated as a failed attempt', async () => {
  const { adapter, llm } = wire(
    tierSettings([{ provider: 'a', model: 'one', attempts: 1 }, { provider: 'b', model: 'two' }]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [bang('socket hang up'), answer('second try')], 'b/two': [answer('unused')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.deepEqual(llm.calls, ['a/one', 'a/one'])
})

test('advertised tiers are ordered, enabled-only, and include the empty default', async () => {
  const store = makeStore({
    tiers: [
      { id: 'slow', name: '慢', order: 2, members: [{ provider: 'a', model: 'one' }] },
      { id: 'fast', name: '快', order: 1, members: [{ provider: 'a', model: 'one' }] },
      { id: 'off', name: '停用', order: 0, enabled: false, members: [{ provider: 'a', model: 'one' }] },
    ],
  })
  const adapter = new RouterAdapter({ store, logger: {} })
  const models = await adapter.listModels('model-router')
  assert.deepEqual(models.map(model => model.id), ['fast', 'slow'])
  assert.deepEqual(models.map(model => model.name), ['快', '慢'])
})

test('a tier reports the smallest member window and the shared efforts', async () => {
  const { adapter } = wire(
    tierSettings([{ provider: 'a', model: 'big' }, { provider: 'b', model: 'small' }]),
    {
      models: {
        a: { models: [{ id: 'big', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'] }] },
        b: { models: [{ id: 'small', contextWindow: 128_000, efforts: ['medium', 'high'] }] },
      },
      routes: {},
    },
  )
  const info = await adapter.resolveModel('model-router', 'auto')
  assert.equal(info.context.contextWindow, 128_000)
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['medium', 'high'])
  assert.equal(info.reasoning.defaultEffort, 'medium')
})

test('a deleted tier still resolves so a stored selection keeps rendering', async () => {
  const { adapter } = wire(tierSettings([{ provider: 'a', model: 'one' }]), { models: {}, routes: {} })
  const info = await adapter.resolveModel('model-router', 'vanished')
  assert.equal(info.id, 'vanished')
  assert.equal(info.name, 'vanished')
})

test('runMember reports each terminal shape', async () => {
  assert.equal((await runMember(streamOf(answer('x')))).kind, 'answer')
  assert.equal((await runMember(streamOf(fail('SERVER')))).code, 'SERVER')
  assert.equal((await runMember(streamOf(bang('boom')))).kind, 'failed')
  assert.equal((await runMember(streamOf(ok([
    { type: 'text-delta', text: '  ' },
    { type: 'finish', reason: { kind: 'stop', stopReason: 'end' } },
  ])))).code, 'EMPTY_RESPONSE')
  // A stream that stops without its finish chunk cannot be replayed.
  assert.equal((await runMember(streamOf(ok([{ type: 'text-delta', text: 'x' }])))).code, 'TRANSPORT')
})

test('commitsAnswer keeps reasoning provisional', () => {
  assert.equal(commitsAnswer({ type: 'reasoning-delta', text: 'hmm' }), false)
  assert.equal(commitsAnswer({ type: 'text-delta', text: '   ' }), false)
  assert.equal(commitsAnswer({ type: 'text-delta', text: 'hi' }), true)
  assert.equal(commitsAnswer({ type: 'tool-call-delta', argumentsDelta: '{}' }), true)
  assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'text', text: '' } }), false)
  assert.equal(commitsAnswer({ type: 'usage', usage: {} }), false)
})

test('intersectEfforts requires every member to agree', () => {
  const one = { reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: 'low' } }
  const two = { reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' } }
  assert.deepEqual(intersectEfforts([one, two]).efforts.map(effort => effort.id), ['high'])
  assert.equal(intersectEfforts([one, { }]), undefined)
  assert.equal(intersectEfforts([{ reasoning: { efforts: [{ id: 'a', name: 'a' }] } }, { reasoning: { efforts: [{ id: 'b', name: 'b' }] } }]), undefined)
})

test('a member effort override narrows the offered set instead of widening it', () => {
  const info = { reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: 'low' } }
  // Declaring `high` leaves only `high`: offering `low` would dispatch a value
  // this member's override does not use.
  assert.deepEqual(intersectEfforts([info], [{ reasoningEffort: 'high' }]).efforts.map(effort => effort.id), ['high'])
  // An effort the model does not publish cannot be claimed.
  assert.equal(intersectEfforts([info], [{ reasoningEffort: 'max' }]), undefined)
  // No override means the model's own list is offered.
  assert.deepEqual(intersectEfforts([info], [{}]).efforts.map(effort => effort.id), ['low', 'high'])
})

test('a declared context window overrides what the model reports', async () => {
  const { adapter } = wire(
    tierSettings([{ provider: 'a', model: 'big', contextWindow: 64_000, maxTokens: 4_096 }]),
    { models: { a: { models: [{ id: 'big', contextWidth: 1_000_000, contextWindow: 1_000_000 }] } }, routes: {} },
  )
  const info = await adapter.resolveModel('model-router', 'auto')
  assert.equal(info.context.contextWindow, 64_000, 'the override wins over the reported window')
  assert.equal(info.defaultMaxTokens, 4_096)
})

test('a tier override applies to every member that does not set its own', async () => {
  const { adapter } = wire(
    {
      ...tierSettings([
        { provider: 'a', model: 'one' },
        { provider: 'b', model: 'two', contextWindow: 32_000 },
      ]),
      tiers: [{
        id: 'auto', name: 'Auto', order: 0, contextWindow: 100_000, reasoningEffort: 'high',
        members: [{ provider: 'a', model: 'one' }, { provider: 'b', model: 'two', contextWindow: 32_000 }],
      }],
    },
    {
      models: {
        a: { models: [{ id: 'one', contextWindow: 200_000, efforts: ['low', 'high'] }] },
        b: { models: [{ id: 'two', contextWindow: 128_000, efforts: ['low', 'high'] }] },
      },
      routes: {},
    },
  )
  const info = await adapter.resolveModel('model-router', 'auto')
  // The member's 32K wins over the tier's 100K, and the tier reports the
  // smallest effective value across the chain.
  assert.equal(info.context.contextWindow, 32_000)
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['high'])
})

test('the log records which member answered and why earlier ones were dropped', async () => {
  const { adapter, log } = wire(
    tierSettings([
      { provider: 'a', model: 'one', attempts: 1 },
      { provider: 'b', model: 'two' },
    ]),
    {
      models: { a: { models: [{ id: 'one' }] }, b: { models: [{ id: 'two' }] } },
      routes: { 'a/one': [fail('SERVER'), fail('SERVER')], 'b/two': [answer('rescued')] },
    },
  )
  const chunks = await collect(adapter, 'auto')
  assert.equal(finishOf(chunks).reason.kind, 'stop')

  const view = log.read()
  assert.equal(view.total, 1)
  const [entry] = view.entries
  assert.equal(entry.outcome, 'ok')
  assert.equal(entry.provider, 'b', 'the winner is named')
  assert.equal(entry.model, 'two')
  assert.equal(entry.tierName, 'Auto')
  assert.equal(entry.attempts.length, 3, 'two retries plus the winner')
  assert.deepEqual(entry.attempts.map(attempt => attempt.outcome), ['retry', 'failover', 'ok'])
  assert.deepEqual(entry.attempts.map(attempt => attempt.provider), ['a', 'a', 'b'])
  assert.equal(entry.attempts[0].code, 'SERVER')
  assert.ok(entry.attempts.every(attempt => Number.isFinite(attempt.durationMs)))
})

test('the log records a turn where every member failed', async () => {
  const { adapter, log } = wire(
    tierSettings([{ provider: 'a', model: 'one', attempts: 0 }]),
    { models: { a: { models: [{ id: 'one' }] } }, routes: { 'a/one': [fail('QUOTA', 'no credit')] } },
  )
  await collect(adapter, 'auto')
  const [entry] = log.read().entries
  assert.equal(entry.outcome, 'failed')
  assert.equal(entry.provider, undefined)
  assert.match(entry.message, /a\/one/)
  assert.equal(entry.attempts[0].code, 'QUOTA')
})

test('the log records a cancelled turn without marking it a chain failure', async () => {
  const controller = new AbortController()
  const store = makeStore(tierSettings([{ provider: 'a', model: 'one' }]))
  const adapter = new RouterAdapter({ store, logger: {} })
  adapter.ctx = {
    llm: {
      listProviders: () => [{ id: 'a', name: 'a' }],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
      prepareCall: async config => ({
        config,
        stream: async function* () {
          controller.abort()
          yield* streamOf(fail('ABORTED'))
        },
      }),
    },
  }
  await collect(adapter, 'auto', { signal: controller.signal })
  const [entry] = adapter.requestLog.read().entries
  assert.equal(entry.outcome, 'aborted')
  assert.equal(entry.attempts[0].outcome, 'aborted')
})

test('a turn that never dispatches still leaves one log entry', async () => {
  const { adapter, log } = wire(tierSettings([]), { models: {}, routes: {} })
  await collect(adapter, 'auto')
  const [entry] = log.read().entries
  assert.equal(log.read().total, 1, 'the failure is what the user comes to the log for')
  assert.equal(entry.outcome, 'failed')
  assert.equal(entry.attempts.length, 0)
})

test('usage from the winning attempt reaches the log', async () => {
  const { adapter, log } = wire(
    tierSettings([{ provider: 'a', model: 'one' }]),
    {
      models: { a: { models: [{ id: 'one' }] } },
      routes: {
        'a/one': [ok([
          { type: 'text-delta', text: 'hi' },
          { type: 'usage', usage: { inputTokens: 120, outputTokens: 7, totalTokens: 127 } },
          { type: 'finish', reason: { kind: 'stop', stopReason: 'end' } },
        ])],
      },
    },
  )
  await collect(adapter, 'auto')
  const [entry] = log.read().entries
  assert.deepEqual(entry.usage, { inputTokens: 120, outputTokens: 7, totalTokens: 127 })
})

test('logging respects the stored retention limit at construction', () => {
  const store = makeStore({ ...tierSettings([{ provider: 'a', model: 'one' }]), logLimit: 25 })
  const adapter = new RouterAdapter({ store, logger: {} })
  assert.equal(adapter.requestLog.limit, 25)
})

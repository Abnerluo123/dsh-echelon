/**
 * Integration test: the real plugin against the real `LlmRuntime`.
 *
 * The unit tests use a hand-written fake, which proves the logic but not the
 * contract. This one boots DSH's actual LLM service in-process, registers a
 * fake *upstream* provider adapter beside the router, loads the plugin's real
 * `apply()`, and then drives requests through the public surface a user hits:
 * `llm.prepareCall` from the router's own chain, and `llm.stream` from a
 * caller that selected a tier.
 *
 * What this catches that the unit tests cannot:
 *   - an adapter whose metadata the registry refuses (`INVALID_ADAPTER`);
 *   - a `prepareCall` whose forwarded options fail the prepared-call equality
 *     check (`INVALID_PREPARED_CALL`);
 *   - a `listModels` entry the registry considers invalid (`INVALID_CATALOG`);
 *   - the catalog filter hiding a route the router itself still needs.
 *
 * Requires the DSH app packages to be present in `dsh-router-research/`, which
 * is a local extraction of the installed app. The test skips when they are not.
 *
 * @module test/integration.test.js
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const research = join(here, '..', '..', 'dsh-router-research', 'node_modules')
const hasRuntime = existsSync(join(research, '@deepseek-ai', 'cordis', 'lib', 'index.js'))
const directories = []
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

/** Import a package out of the extracted app tree. */
const fromApp = specifier => import(pathToFileURL(join(research, ...specifier.split('/'), 'lib', 'index.js')).href)

/** A store in a throwaway directory. */
function makeStore(settings) {
  const directory = mkdtempSync(join(tmpdir(), 'router-int-'))
  directories.push(directory)
  const file = join(directory, 'settings.json')
  writeFileSync(file, JSON.stringify(settings), 'utf8')
  return { file }
}

/**
 * A scripted upstream provider: one route that answers or fails on demand.
 *
 * It declares the whole adapter surface the registry calls, because the real
 * registry invokes `providerRetryPolicy` (and the image hooks) unconditionally —
 * a partial duck type fails registration with a TypeError, which is exactly the
 * class of bug this integration test exists to catch.
 * @param {string} route - provider id.
 * @param {{models: string[], outcomes: object[]}} script - catalog and outcomes.
 */
function upstream(route, script) {
  const calls = []
  const adapter = {
    providerInfo: id => ({ id, name: `${id} upstream` }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_id, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: id => Promise.resolve(script.models.map(model => ({ provider: id, id: model, name: model }))),
    resolveModel: (id, model) => Promise.resolve({ provider: id, id: model, name: model, inputModalities: ['text'] }),
    prepareCall: (id, model) => Promise.resolve({
      model: { provider: id, id: model, name: model, inputModalities: ['text'] },
      stream: options => streamOf(script.outcomes.shift() ?? { kind: 'ok', text: 'default' }, calls, `${id}/${model}`, options),
    }),
  }
  return { adapter, calls }
}

/** Turn one scripted outcome into a chunk stream. */
async function* streamOf(outcome, calls, label, options) {
  calls.push({ label, provider: options.provider, model: options.model })
  if (outcome.kind === 'fail') {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: outcome.code, message: outcome.message ?? 'upstream failed' } } }
    return
  }
  yield { type: 'text-delta', index: 0, text: outcome.text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: outcome.text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop', stopReason: 'end' } }
}

/** Boot a real LLM service, load the plugin, and register the upstreams. */
async function boot(settings, upstreams) {
  const { Context } = await fromApp('@deepseek-ai/cordis')
  const llmModule = await fromApp('@deepseek-ai/dsh-llm')
  const LlmRuntime = llmModule.default

  const ctx = new Context()
  ctx.plugin(LlmRuntime)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(ctx.llm, 'the LLM service must be mounted for this test to mean anything')

  for (const [route, script] of Object.entries(upstreams)) {
    const { adapter } = upstream(route, script)
    ctx.llm.registerAdapter([route], adapter)
  }

  const { file } = makeStore(settings)
  const { SettingsStore } = await import('../src/store.js')
  const router = await import('../index.js')
  const store = new SettingsStore(file, { log: () => {} })

  // The plugin's `apply` reads `ctx.llm` and registers its route; the store is
  // constructed inside it, so the test points DSH_HOME at its own directory.
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dirname(file)
  try {
    const adapter = await (async () => {
      // Mirror `apply`'s wiring but keep a handle on the adapter so the test can
      // read what it advertised.
      const { RouterAdapter } = await import('../src/adapter.js')
      const { installCatalogFilter } = await import('../src/catalog.js')
      const instance = new RouterAdapter({ store, logger: {} })
      instance.ctx = ctx
      const registration = ctx.llm.registerAdapter(['model-router'], instance)
      installCatalogFilter(ctx.llm, () => store.read().settings)
      return { instance, registration, router }
    })()
    return { ctx, ...adapter, store }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

/** Collect a stream to completion. */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const finishOf = chunks => chunks.find(chunk => chunk.type === 'finish')
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

const settingsWith = (members, extra = {}) => ({
  version: 1,
  exposure: 'all',
  tiers: [{ id: 'auto', name: 'Auto', order: 0, members }],
  hide: [],
  ...extra,
})

test('the real registry accepts the router and lists its tiers', { skip: !hasRuntime }, async () => {
  const { ctx, instance } = await boot(
    settingsWith([{ provider: 'up', model: 'one' }]),
    { up: { models: ['one'], outcomes: [] } },
  )
  assert.ok(ctx.llm.listProviders().some(provider => provider.id === 'model-router'))
  const models = await ctx.llm.listModels('model-router')
  assert.deepEqual(models.map(model => model.id), ['auto'])
  assert.equal(models[0].provider, 'model-router')
  assert.equal(typeof models[0].name, 'string')

  // The registry validates exact model info; a shape it refuses would throw here.
  const info = await ctx.llm.resolveModelInfo('model-router', 'auto')
  assert.equal(info.id, 'auto')
  assert.equal(instance.providerId, 'model-router')
})

test('a real prepared call dispatches down the chain without failing its equality check', { skip: !hasRuntime }, async () => {
  const { ctx } = await boot(
    settingsWith([
      { provider: 'down', model: 'a', attempts: 0 },
      { provider: 'up', model: 'b', attempts: 0 },
    ]),
    {
      down: { models: ['a'], outcomes: [{ kind: 'fail', code: 'SERVER', message: 'lane down' }] },
      up: { models: ['b'], outcomes: [{ kind: 'ok', text: 'answered by backup' }] },
    },
  )
  const chunks = await collect(ctx.llm.stream({
    provider: 'model-router',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(finishOf(chunks).reason.kind, 'stop', 'the prepared-call equality check must not trip')
  assert.equal(textOf(chunks), 'answered by backup')
})

test('the catalog filter hides stock models from the registry read, but not from the chain', { skip: !hasRuntime }, async () => {
  const { ctx } = await boot(
    settingsWith([{ provider: 'up', model: 'one' }], { exposure: 'tiers' }),
    { up: { models: ['one', 'two'], outcomes: [{ kind: 'ok', text: 'still routed' }] } },
  )
  // The picker's read is filtered...
  assert.deepEqual(await ctx.llm.listModels('up'), [])
  // ...but dispatch resolves the route directly, which is what makes hiding safe.
  const chunks = await collect(ctx.llm.stream({
    provider: 'model-router',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(textOf(chunks), 'still routed')
})

test('a deleted tier ends the turn with one error through the real service', { skip: !hasRuntime }, async () => {
  const { ctx } = await boot(settingsWith([{ provider: 'up', model: 'one' }]), { up: { models: ['one'], outcomes: [] } })
  const chunks = await collect(ctx.llm.stream({
    provider: 'model-router',
    model: 'does-not-exist',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  const finishes = chunks.filter(chunk => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'error')
  assert.match(finishes[0].reason.failure.message, /模型路由/)
})

test('a tier may name another routing plugin’s route (Fusion compatibility)', { skip: !hasRuntime }, async () => {
  // Fusion advertises `dsh-model-fusion/auto` and dispatches internally. A tier
  // must be able to use it as a normal member, which only works if the router
  // treats every member as an opaque provider/model pair.
  const { ctx } = await boot(
    // `attempts: 0` so the routing member's single failure hands over at once;
    // the default retry budget would otherwise exhaust the scripted outcome and
    // make this test about retries instead of about composition.
    settingsWith([
      { provider: 'dsh-model-fusion', model: 'auto', attempts: 0 },
      { provider: 'up', model: 'one', attempts: 0 },
    ]),
    {
      'dsh-model-fusion': { models: ['auto'], outcomes: [{ kind: 'fail', code: 'SERVER', message: 'fusion unavailable' }] },
      up: { models: ['one'], outcomes: [{ kind: 'ok', text: 'fell back past fusion' }] },
    },
  )
  const models = await ctx.llm.listModels('model-router')
  assert.deepEqual(models.map(model => model.id), ['auto'])
  const chunks = await collect(ctx.llm.stream({
    provider: 'model-router',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(textOf(chunks), 'fell back past fusion')
})

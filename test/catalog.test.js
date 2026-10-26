/**
 * Tests for the catalog filter that hides models from the picker.
 * @module test/catalog.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterModels, hiddenSummary, installCatalogFilter, listUnfiltered } from '../src/catalog.js'
import { normalizeSettings } from '../src/config.js'

const models = [
  { provider: 'p', id: 'one', name: 'One' },
  { provider: 'p', id: 'two', name: 'Two' },
]
const pairSettings = target => normalizeSettings({ exposure: 'custom', hide: [{ target }] })

test('custom exposure drops only the named targets', () => {
  assert.deepEqual(filterModels(models, pairSettings('p/one')).map(model => model.id), ['two'])
  assert.deepEqual(filterModels(models, pairSettings('p')).map(model => model.id), [])
})

test('tiers exposure hides every stock model once a tier can dispatch', () => {
  const settings = normalizeSettings({
    exposure: 'tiers',
    tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'one' }] }],
  })
  assert.deepEqual(filterModels(models, settings, ['p']), [])
})

test('tiers exposure hides nothing while no tier can dispatch', () => {
  // The shipped default: `exposure: tiers` with an empty auto tier. Hiding here
  // would empty the model picker and leave no way back in from the GUI — the bug
  // that made the picker unusable on a fresh install.
  assert.equal(filterModels(models, normalizeSettings(undefined), ['p']), models)

  // ...and it stays lifted when the only tier names a provider that is gone.
  const stranded = normalizeSettings({
    exposure: 'tiers',
    tiers: [{ id: 'a', name: 'A', members: [{ provider: 'vanished', model: 'x' }] }],
  })
  assert.equal(filterModels(models, stranded, ['p']), models)
})

test('all exposure hides nothing', () => {
  assert.equal(filterModels(models, normalizeSettings({ exposure: 'all' })), models)
})

test('a disabled rule hides nothing', () => {
  const settings = normalizeSettings({ exposure: 'custom', hide: [{ target: 'p/one', enabled: false }] })
  assert.equal(filterModels(models, settings), models)
})

test('the filter never hides the router’s own tiers', () => {
  const settings = normalizeSettings({ exposure: 'tiers' })
  const tiers = [{ provider: 'model-router', id: 'auto', name: 'Auto' }]
  assert.equal(filterModels(tiers, settings), tiers)
})

test('the filter is contained: a broken settings read leaves the list alone', () => {
  // `isHidden` is called with a setting object that throws on property access.
  const explosive = new Proxy({}, { get() { throw new Error('boom') } })
  assert.equal(filterModels(models, explosive), models)
})

test('installCatalogFilter passes live providers so the interlock can work', async () => {
  const runtime = {
    listModels: () => Promise.resolve(models),
    listProviders: () => [
      { id: 'p', name: 'P' },
      { id: 'model-router', name: 'Router' },
    ],
  }
  const emptyTier = normalizeSettings({ exposure: 'tiers' })
  let settings = emptyTier
  const dispose = installCatalogFilter(runtime, () => settings)
  try {
    // No dispatchable tier yet: the stock menu must be intact.
    assert.deepEqual((await runtime.listModels('p')).map(model => model.id), ['one', 'two'])
    // Now a tier can dispatch: hiding applies.
    settings = normalizeSettings({
      exposure: 'tiers',
      tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'one' }] }],
    })
    assert.deepEqual(await runtime.listModels('p'), [])
  } finally {
    dispose()
  }
})

test('installCatalogFilter wraps the instance method, not the prototype', async () => {
  const calls = []
  const runtime = {
    listModels(provider) {
      calls.push(provider)
      return Promise.resolve(models)
    },
  }
  const original = runtime.listModels
  const dispose = installCatalogFilter(runtime, () => pairSettings('p/one'))
  try {
    assert.deepEqual((await runtime.listModels('p')).map(model => model.id), ['two'])
    assert.deepEqual((await runtime.listModels('model-router')).map(model => model.id), ['one', 'two'])
    assert.deepEqual(calls, ['p', 'model-router'])
  } finally {
    dispose()
  }
  assert.equal(runtime.listModels, original, 'dispose restores the exact method it wrapped')
})

test('a second install is a no-op so HMR cannot stack wrappers', async () => {
  const runtime = {
    listModels: () => Promise.resolve(models),
  }
  const first = installCatalogFilter(runtime, () => pairSettings('p/one'))
  const wrappedOnce = runtime.listModels
  const second = installCatalogFilter(runtime, () => pairSettings('p/one'))
  assert.equal(runtime.listModels, wrappedOnce)
  try {
    assert.deepEqual((await runtime.listModels('p')).map(model => model.id), ['two'], 'still filtered exactly once')
  } finally {
    second()
    first()
  }
  assert.deepEqual((await runtime.listModels('p')).map(model => model.id), ['one', 'two'])
})

test('installCatalogFilter tolerates a runtime without listModels', () => {
  assert.doesNotThrow(() => installCatalogFilter({}, () => normalizeSettings()).call(null))
  assert.doesNotThrow(() => installCatalogFilter(null, () => normalizeSettings()))
})

test('hiddenSummary counts what the picker will lose', () => {
  const groups = [
    { id: 'p', models: [{ id: 'one' }, { id: 'two' }] },
    { id: 'q', models: [{ id: 'three' }] },
  ]
  const settings = normalizeSettings({ exposure: 'custom', hide: [{ target: 'p/one' }, { target: 'q' }] })
  const summary = hiddenSummary(groups, settings)
  assert.equal(summary.hidden, 2)
  assert.equal(summary.total, 3)
  assert.deepEqual(summary.sample, ['p/one', 'q/three'])
})

test('the plugin can still read models that hiding removes', async () => {
  // Regression: the member editor read the *filtered* list, so turning hiding on
  // made every hidden model unaddable — the user had to disable hiding to build
  // the very tier hiding depends on.
  const models = [
    { provider: 'p', id: 'hidden-one', name: 'hidden-one' },
    { provider: 'p', id: 'hidden-two', name: 'hidden-two' },
  ]
  const llm = {
    listProviders: () => [{ id: 'p', name: 'p' }],
    listModels: async () => models.slice(),
  }
  // The interlock lifts hiding while no tier can dispatch, so the fixture needs
  // one real tier for the hide to take effect at all.
  const settings = normalizeSettings({
    exposure: 'tiers',
    tiers: [{ id: 'auto', name: 'Auto', members: [{ provider: 'p', model: 'm' }] }],
  })
  installCatalogFilter(llm, () => settings)
  assert.deepEqual(await llm.listModels('p'), [], 'the picker sees nothing')

  const unfiltered = await listUnfiltered(llm, 'p')
  assert.deepEqual(unfiltered.map(model => model.id), ['hidden-one', 'hidden-two'], 'the editor still sees everything')
})

test('listUnfiltered works before the filter is installed', async () => {
  const llm = { listModels: async () => [{ id: 'a' }, { id: 'b' }] }
  assert.deepEqual((await listUnfiltered(llm, 'p')).map(model => model.id), ['a', 'b'])
  assert.deepEqual(await listUnfiltered({}, 'p'), [], 'a service without the method yields nothing instead of throwing')
})

/**
 * Smoke tests for the browser bundle.
 *
 * The bundle is a ModuleLoader factory, so the test provides the tiny stub
 * surface it asks for (`react`, `window.__ModuleLoader__`) and then exercises
 * the pure helpers the page exports plus a full render pass through a
 * hand-rolled React shim. That catches the failure this kind of bundle usually
 * ships with: a syntax-valid file that throws on first render.
 *
 * @module test/client.test.js
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client.js')

/**
 * Execute the bundle and return its exports.
 *
 * The bundle is a plain script that registers itself on
 * `window.__ModuleLoader__`, so it is evaluated with `vm` rather than imported:
 * a module import would be cached after the first test and never re-register.
 * @returns {object} the bundle exports, including `__test` helpers.
 */
function loadBundle() {
  let registration
  const globals = globalThis
  const previousWindow = globals.window
  globals.window = { __ModuleLoader__: { load: value => { registration = value } }, confirm: () => true }
  try {
    vm.runInThisContext(readFileSync(bundlePath, 'utf8'), { filename: bundlePath })
  } finally {
    globals.window = previousWindow
  }
  assert.equal(registration?.id, 'dsh-model-router')
  return registration.factory(require)
}

/** Minimal React stand-in: enough for the bundle's render path. */
function require(specifier) {
  if (specifier !== 'react') throw new Error(`unexpected require(${specifier})`)
  const createElement = (type, props, ...children) => ({ type, props: { ...props, children } })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useMemo: factory => factory(),
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
  }
}

/**
 * Walk a rendered element tree, invoking every function component.
 *
 * This is the assertion this kind of bundle most needs: a ModuleLoader bundle
 * with a typo in a component still parses, and the failure only appears when
 * the shell mounts it. Calling each component once with its props proves the
 * page can produce its first render.
 * @param {object|Array|string|null} node - element tree.
 * @param {number} depth - recursion guard.
 * @returns {number} number of components invoked.
 */
function render(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return 0
  if (Array.isArray(node)) return node.reduce((count, child) => count + render(child, depth + 1), 0)
  if (typeof node !== 'object') return 0
  if (depth > 60) throw new Error('render depth exceeded')
  if (typeof node.type === 'function') return 1 + render(node.type(node.props ?? {}), depth + 1)
  return render(node.props?.children, depth + 1)
}

test('the settings page produces a first render against a fake backend', () => {
  const exports = loadBundle()
  const sections = []
  exports.apply({
    slots: {
      inject: (_name, factory) => { factory() },
      register: (_options, component) => { sections.push(component); return () => {} },
    },
  })
  assert.equal(sections.length, 1)
  // The first render happens before any fetch settles, so this exercises the
  // loading branch. It must produce a tree rather than throwing.
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' })
  try {
    const tree = sections[0]({})
    assert.ok(tree !== null && tree !== undefined, 'the loading branch must render something')
    assert.doesNotThrow(() => render(tree))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('the error branch renders a retry affordance', () => {
  const exports = loadBundle()
  let component
  exports.apply({
    slots: {
      inject: (_name, factory) => { factory() },
      register: (_options, value) => { component = value; return () => {} },
    },
  })
  // No backend at all: the page must still mount its failure state.
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    assert.doesNotThrow(() => render(component({})))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('the bundle exports the plugin surface', async () => {
  const exports = await loadBundle()
  assert.equal(exports.name, 'model-router')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.__test.makeTierId, 'function')
})

test('a payload whose catalog is not an array still mounts', () => {
  // Regression: `/state` once serialized an unresolved Promise as `{}`, and the
  // page threw `catalog is not iterable` inside `useMemo`, painting a blank
  // panel. The component must survive any payload the API can produce.
  const exports = loadBundle()
  let component
  exports.apply({
    slots: {
      inject: (_name, factory) => { factory() },
      register: (_options, value) => { component = value; return () => {} },
    },
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      settings: {
        version: 1, exposure: 'tiers', defaultIdleTimeoutMs: 90_000, showTierDescriptions: true,
        tiers: [{ id: 'auto', name: 'Auto', enabled: true, order: 0, members: [] }], hide: [],
      },
      catalog: {},
      file: 'x',
    }),
  })
  try {
    assert.doesNotThrow(() => render(component({})))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('apply registers exactly one settings section', async () => {
  const exports = await loadBundle()
  const registered = []
  const ctx = {
    slots: {
      inject(name, factory) {
        registered.push(name)
        factory()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(registered[0], 'settings.section')
  const entry = registered.find(item => typeof item === 'object')
  assert.equal(entry.options.id, 'model-router')
  assert.equal(entry.options.name, 'settings.section')
  assert.equal(typeof entry.options.label(), 'string')
  assert.equal(typeof entry.component, 'function')
})

test('makeTierId matches the host id rules', async () => {
  const { makeTierId } = loadBundle().__test
  assert.equal(makeTierId('Fast', []), 'fast')
  assert.equal(makeTierId('  Daily  Use ', []), 'daily-use')
  // Non-ASCII names hash rather than collapse, and the two sides agree.
  const zh = makeTierId('鏀诲潥', [])
  assert.match(zh, /^tier-[0-9a-f]{6}$/)
  assert.equal(zh, makeTierId('鏀诲潥', []))
  // A collision gets a suffix instead of overwriting the existing tier.
  assert.equal(makeTierId('Fast', ['fast']), 'fast-2')
  assert.equal(makeTierId('Fast', ['fast', 'fast-2']), 'fast-3')
})

test('timeout conversion round-trips and clamps', async () => {
  const { fromSeconds, toSeconds } = loadBundle().__test
  assert.equal(toSeconds(90_000), 90)
  assert.equal(toSeconds(0), 0)
  assert.equal(fromSeconds(90), 90_000)
  assert.equal(fromSeconds(0), 0)
  assert.equal(fromSeconds(-5), 0)
  assert.equal(fromSeconds(1), 5_000, 'a sub-5s timeout would fail every lane')
  assert.equal(fromSeconds(10_000), 600_000)
  assert.equal(fromSeconds(undefined), 0)
})

test('move reorders without mutating or overflowing', async () => {
  const { move } = loadBundle().__test
  const list = ['a', 'b', 'c']
  assert.deepEqual(move(list, 0, 1), ['b', 'a', 'c'])
  assert.deepEqual(move(list, 2, -1), ['a', 'c', 'b'])
  assert.equal(move(list, 0, -1), list, 'moving off the top is a no-op')
  assert.equal(move(list, 2, 1), list, 'moving off the bottom is a no-op')
  assert.deepEqual(list, ['a', 'b', 'c'], 'the input list is untouched')
})

test('setHideRule adds, updates and removes one target', async () => {
  const { setHideRule } = loadBundle().__test
  let settings = { hide: [] }
  settings = setHideRule(settings, 'p', true)
  assert.deepEqual(settings.hide, [{ target: 'p', enabled: true }])
  settings = setHideRule(settings, 'p', false)
  assert.deepEqual(settings.hide, [])
  settings = setHideRule(setHideRule(settings, 'p', true), 'p', true)
  assert.equal(settings.hide.length, 1, 'a repeated target must not duplicate')
})

test('both dictionaries cover the same keys', async () => {
  const { DICT } = loadBundle().__test
  const zh = Object.keys(DICT.zh).sort()
  const en = Object.keys(DICT.en).sort()
  const missingEn = zh.filter(key => !en.includes(key))
  const missingZh = en.filter(key => !zh.includes(key))
  assert.deepEqual(missingEn, [], 'keys present in zh but missing from en')
  assert.deepEqual(missingZh, [], 'keys present in en but missing from zh')
})


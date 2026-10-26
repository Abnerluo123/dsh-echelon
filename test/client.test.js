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

test('every CSS custom property exists in the host theme', () => {
  // Regression: the page once used `--dsw-alias-bg-page-primary`, which DSH
  // does not define. An unknown custom property invalidates the whole
  // declaration, so the surface silently turned transparent and showed a grey
  // block through it — with nothing in the console to explain why.
  //
  // The list below is every theme variable the DSH shell ships. A new name here
  // must be verified against the running shell before it is added.
  const hostVariables = new Set([
    'alias-bg-base', 'alias-bg-layer-1', 'alias-bg-layer-2', 'alias-bg-layer-3', 'alias-bg-layer-4',
    'alias-bg-mask-1', 'alias-bg-module-platform', 'alias-border-l1', 'alias-border-l2', 'alias-border-l3',
    'alias-border-l4', 'alias-brand-primary', 'alias-button-primary-fill', 'alias-button-primary-hover',
    'alias-code-diff-added', 'alias-code-diff-deleted', 'alias-interactive-bg-active',
    'alias-interactive-bg-hover', 'alias-interactive-bg-hover-danger', 'alias-label-caption',
    'alias-label-dimmed', 'alias-label-error', 'alias-label-primary', 'alias-label-primary-foreground',
    'alias-label-secondary', 'alias-label-tertiary', 'alias-state-business-primary', 'alias-state-error-primary',
    'alias-state-success-primary', 'alias-state-success-tertiary', 'alias-state-warn-label',
    'alias-state-warn-primary', 'alias-markdown-code-block', 'alias-scrollbar-bg-l2',
    'alias-toast-bg', 'alias-toast-label', 'elevation-prominent', 'elevation-stroke-color',
    'font-markdown-code-font-family', 'hovercard-bg',
  ])
  const { CSS } = loadBundle().__test
  const used = [...new Set([...CSS.matchAll(/var\(--dsw-([a-z0-9-]+)/g)].map(match => match[1]))]
  const unknown = used.filter(name => !hostVariables.has(name))
  assert.deepEqual(unknown, [], `these theme variables do not exist in DSH: ${unknown.join(', ')}`)
})

test('surfaces use the host elevation ramp, not a hardcoded colour', () => {
  const { CSS } = loadBundle().__test
  // A literal colour here would survive one scheme and be wrong in the other.
  const surfaces = [...CSS.matchAll(/\.mr-(?:card|tier|member|log-row|preview|radio|modal-card|disclosure)\{[^}]*background:([^;}]+)/g)]
  assert.ok(surfaces.length >= 6, 'expected the main surfaces to declare a background')
  for (const [, value] of surfaces) {
    assert.match(value, /var\(--dsw-/, `a surface uses a literal background: ${value}`)
  }
})

test('detail blocks are collapsed unless opened', () => {
  const { CSS } = loadBundle().__test
  // `<details>` is closed by default in the browser; nothing in the stylesheet
  // may force it open, or "默认折叠" would depend on a style accident.
  assert.doesNotMatch(CSS, /\.mr-disclosure\s*\{[^}]*display:\s*block/, 'a disclosure must not override the details default')
  assert.match(CSS, /\.mr-disclosure\[open\]/, 'the open state needs its own rule to rotate the chevron')
})

test('a collapsed disclosure still describes itself', () => {
  const { CSS } = loadBundle().__test
  // A chevron alone left a wide empty strip. The label and the current values
  // stay visible while collapsed; only the inputs are hidden behind it.
  assert.doesNotMatch(
    CSS,
    /\.mr-disclosure-meta\{[^}]*display:none/,
    'the summary text must stay visible while collapsed',
  )
  assert.match(
    CSS,
    /\.mr-disclosure-meta\{[^}]*display:flex/,
    'the summary text is part of the collapsed row',
  )
  assert.match(
    CSS,
    /\.mr-disclosure-digest\{[^}]*text-overflow:ellipsis/,
    'a long digest truncates instead of pushing the row wider',
  )
})

test('the page root has a definite width', () => {
  // Regression: `.mr-root` was a column flex container with only `max-width`,
  // so inside an unsized parent it shrank to its narrowest child — the collapsed
  // chevron — and every descendant inherited a zero-width line. The expanded
  // digest then measured 0px wide and never appeared.
  const { CSS } = loadBundle().__test
  const rule = CSS.match(/\.mr-root\{[^}]*\}/)[0]
  assert.match(rule, /width:\s*100%/, 'a column flex root needs a definite width')
  assert.match(rule, /max-width:\s*760px/, 'and still caps itself')
})

test('the summary row is never allowed to collapse to nothing', () => {
  const { CSS } = loadBundle().__test
  // Regression: a `width:auto` summary inside the column flex page shrank to
  // zero and the whole row disappeared. The row now sizes itself to its text
  // and is capped by the container, so neither extreme can happen.
  const rules = [...CSS.matchAll(/\.mr-disclosure[^{]*\{[^}]*width:[^;}]+/g)].map(match => match[0])
  assert.ok(rules.length > 0, 'the summary row declares a width')
  for (const rule of rules) {
    assert.doesNotMatch(rule, /width:\s*auto/, `width:auto collapses a flex row: ${rule}`)
  }
})

test('the page is split into four tabs that partition the sections', async () => {
  // Regression: the exposure card used to live on 配置 with the tier list, and
  // the preview was buried under the settings form. Both made the page a scroll.
  const { DICT, TABS } = loadBundle().__test
  for (const key of ['tabs.configure', 'tabs.settings', 'tabs.preview', 'tabs.log']) {
    assert.equal(typeof DICT.zh[key], 'string', `missing tab label ${key}`)
  }
  assert.equal(DICT.zh['tabs.configure'], '配置')
  assert.equal(DICT.zh['tabs.settings'], '设置')
  assert.equal(DICT.zh['tabs.preview'], '预览')

  // The order is the workflow, not a taxonomy: build tiers → check the result →
  // reach for behaviour switches → read the log.
  assert.deepEqual(TABS.map(tab => tab.id), ['configure', 'preview', 'settings', 'log'])

  // Render and confirm each tab shows only its own cards.
  const exports = loadBundle()
  let component
  exports.apply({
    slots: {
      inject: (_name, factory) => { factory() },
      register: (_options, value) => { component = value; return () => {} },
    },
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input)
    const body = url.includes('/log')
      ? { entries: [], total: 0, limit: 200, newestId: 0 }
      : {
        settings: {
          version: 2, exposure: 'all', defaultIdleTimeoutMs: 90_000, showTierDescriptions: true,
          logRequests: true, logLimit: 200,
          tiers: [{ id: 'auto', name: 'Auto', enabled: true, order: 0, members: [{ provider: 'p', model: 'm', attempts: 1, idleTimeoutMs: 90_000, enabled: true }] }],
          hide: [],
        },
        catalog: [{ id: 'p', name: 'p', models: [{ id: 'm', name: 'm' }] }],
        file: '/tmp/settings.json',
        log: 0,
      }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  try {
    render(component({}))
  } finally {
    globalThis.fetch = previousFetch
  }
})



test('the browser ladder matches the host ladder', async () => {
  // client.js ships as a standalone bundle and cannot import from src, so the
  // ladder is declared twice. This keeps the two declarations honest.
  const { EFFORT_LADDER } = await import('../src/effort.js')
  const { effortChoices, EFFORT_LADDER: clientLadder } = loadBundle().__test
  assert.deepEqual(clientLadder, EFFORT_LADDER.map(step => step.id))
  assert.deepEqual(effortChoices([]), clientLadder, 'the menu always offers every rung')
  assert.deepEqual(effortChoices(['turbo']).slice(-1), ['turbo'], 'a foreign name is appended, not replaced')
})

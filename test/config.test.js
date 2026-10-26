/**
 * Tests for the router's pure configuration logic.
 * @module test/config.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_IDLE_TIMEOUT_MS,
  MAX_TIERS,
  ROUTER_PROVIDER,
  exposureHidesStock,
  formatTokenBudget,
  isHidden,
  isRetryable,
  normalizeMember,
  normalizeSettings,
  normalizeTier,
  parseTokenBudget,
  retryDelay,
  tierChain,
  tierIdOf,
} from '../src/config.js'

test('tierIdOf keeps latin ids and disambiguates non-ascii names', () => {
  assert.equal(tierIdOf('Fast'), 'fast')
  assert.equal(tierIdOf('  Cheap & Good  '), 'cheap-good')
  assert.equal(tierIdOf(''), '')
  const zh = tierIdOf('高质量')
  assert.match(zh, /^tier-[0-9a-f]{6}$/)
  // Same input, same id: a reload must not orphan the stored selection.
  assert.equal(zh, tierIdOf('高质量'))
  assert.notEqual(tierIdOf('高质量'), tierIdOf('中质量'))
})

test('a member needs both halves of a route', () => {
  assert.equal(normalizeMember({ provider: 'p', model: '' }), undefined)
  assert.equal(normalizeMember({ provider: '', model: 'm' }), undefined)
  assert.equal(normalizeMember({ provider: ROUTER_PROVIDER, model: 'm' }), undefined)
  assert.equal(normalizeMember(null), undefined)
  assert.deepEqual(normalizeMember({ provider: 'p', model: 'm' }), {
    provider: 'p', model: 'm', attempts: DEFAULT_ATTEMPTS, idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, enabled: true,
  })
})

test('a token budget accepts the short forms people type', () => {
  // The UI shows `128k`; a hand-edited settings file has to mean the same thing,
  // or the two ways of writing one value would disagree.
  assert.equal(parseTokenBudget(131_072), 131_072)
  assert.equal(parseTokenBudget('131072'), 131_072)
  assert.equal(parseTokenBudget('128k'), 128 * 1_024)
  assert.equal(parseTokenBudget('128K'), 128 * 1_024)
  assert.equal(parseTokenBudget('128 k'), 128 * 1_024)
  assert.equal(parseTokenBudget('1m'), 1_048_576)
  assert.equal(parseTokenBudget('1.5m'), 1_572_864)
  // Binary, not decimal: a model advertising "1M context" means 1,048,576.
  assert.notEqual(parseTokenBudget('1m'), 1_000_000)
  assert.equal(parseTokenBudget(''), undefined)
  assert.equal(parseTokenBudget('abc'), undefined)
  assert.equal(parseTokenBudget('0'), undefined)
  assert.equal(parseTokenBudget(-5), undefined)
  assert.equal(parseTokenBudget(undefined), undefined)
})

test('a token budget is displayed in the shortest exact form', () => {
  assert.equal(formatTokenBudget(131_072), '128k')
  assert.equal(formatTokenBudget(1_048_576), '1m')
  assert.equal(formatTokenBudget(1_000_000), '1000000', 'not a clean multiple, so it stays exact')
  assert.equal(formatTokenBudget(100_000), '100000', 'not a multiple of 1024')
  assert.equal(formatTokenBudget(undefined), '')
  // A shown value must read back as the same number, or the field rewrites itself.
  for (const tokens of [131_072, 1_048_576, 100_000, 32_768, 1_024, 4_000_000]) {
    assert.equal(parseTokenBudget(formatTokenBudget(tokens)), tokens, `round-trip for ${tokens}`)
  }
})

test('a short-form budget reaches the member and the tier', () => {
  const member = normalizeMember({ provider: 'p', model: 'm', contextWindow: '128k', maxTokens: '1m' })
  assert.equal(member.contextWindow, 131_072)
  assert.equal(member.maxTokens, 1_048_576)
  const tier = normalizeTier({ id: 't', name: 'T', contextWindow: '1m', members: [{ provider: 'p', model: 'm' }] })
  assert.equal(tier.contextWindow, 1_048_576)
  // The clamp still applies after parsing.
  assert.equal(normalizeMember({ provider: 'p', model: 'm', contextWindow: '1' }).contextWindow, 1_024)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', contextWindow: '99m' }).contextWindow, 4_000_000)
})

test('member knobs are clamped instead of trusted', () => {
  assert.equal(normalizeMember({ provider: 'p', model: 'm', attempts: 99 }).attempts, MAX_ATTEMPTS)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', attempts: -3 }).attempts, 0)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', attempts: 'x' }).attempts, DEFAULT_ATTEMPTS)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', idleTimeoutMs: 0 }).idleTimeoutMs, 0)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', idleTimeoutMs: 1 }).idleTimeoutMs, 5000)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', idleTimeoutMs: 10 ** 9 }).idleTimeoutMs, MAX_IDLE_TIMEOUT_MS)
})

test('duplicate members collapse onto the first occurrence', () => {
  const tier = normalizeTier({
    id: 't', name: 'T',
    members: [
      { provider: 'a', model: '1', attempts: 2 },
      { provider: 'b', model: '2' },
      { provider: 'a', model: '1', attempts: 0 },
    ],
  })
  assert.equal(tier.members.length, 2)
  assert.equal(tier.members[0].attempts, 2)
})

test('disabled members survive storage but leave the dispatch chain', () => {
  const tier = normalizeTier({
    id: 't', name: 'T',
    members: [{ provider: 'a', model: '1' }, { provider: 'b', model: '2', enabled: false }],
  })
  assert.equal(tier.members.length, 2, 'the settings page must still render the disabled row')
  assert.deepEqual(tierChain(tier).map(member => member.provider), ['a'])
})

test('a tier with no usable member is dropped, not advertised', () => {
  assert.equal(normalizeTier({ id: 't', name: 'T', members: [] }), undefined)
  assert.equal(normalizeTier({ id: 't', name: 'T', members: [{ provider: 'p' }] }), undefined)
})

test('tier ids that would collide with the provider route are refused', () => {
  assert.equal(normalizeTier({ id: ROUTER_PROVIDER, name: 'X', members: [{ provider: 'p', model: 'm' }] }), undefined)
})

test('an empty document still yields a selectable menu', () => {
  const settings = normalizeSettings(undefined)
  assert.equal(settings.tiers.length, 1)
  assert.equal(settings.tiers[0].id, 'auto')
  assert.deepEqual(settings.tiers[0].members, [])
  assert.equal(settings.exposure, 'all', 'a fresh install hides nothing')
})

test('garbage input normalizes to defaults rather than throwing', () => {
  for (const value of [null, 42, 'text', [], { tiers: 'nope' }, { tiers: [null, 3] }]) {
    const settings = normalizeSettings(value)
    assert.equal(settings.tiers.length, 1)
    assert.equal(settings.tiers[0].id, 'auto')
  }
})

test('tiers are ordered, capped and renumbered, so the picker order matches storage', () => {
  const many = Array.from({ length: MAX_TIERS + 5 }, (_, index) => ({
    id: `t${index}`, name: `T${index}`, order: 100 - index,
    members: [{ provider: 'p', model: 'm' }],
  }))
  const settings = normalizeSettings({ tiers: many })
  assert.equal(settings.tiers.length, MAX_TIERS)
  // `order: 100 - index` means the last stored row ranks first; capping after
  // sorting keeps the highest-ranked tiers rather than the earliest ones.
  assert.equal(settings.tiers[0].id, `t${MAX_TIERS + 4}`)
  assert.deepEqual(settings.tiers.map(tier => tier.order), Array.from({ length: MAX_TIERS }, (_, index) => index))
})

test('exposure tiers hides everything only while some tier can dispatch', () => {
  const empty = normalizeSettings({ exposure: 'tiers', tiers: [{ id: 'a', name: 'A', members: [] }] })
  assert.equal(exposureHidesStock(empty, ['p']), false, 'no usable tier means the stock menu must stay')

  const ready = normalizeSettings({
    exposure: 'tiers',
    tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }],
  })
  assert.equal(exposureHidesStock(ready, ['p']), true)
  assert.equal(exposureHidesStock(ready, []), false, 'a tier whose provider is gone cannot carry the menu')

  const off = normalizeSettings({ ...ready, exposure: 'all' })
  assert.equal(exposureHidesStock(off, ['p']), false)
})

test('custom exposure hides only the listed targets', () => {
  const settings = normalizeSettings({
    exposure: 'custom',
    tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }],
    hide: [{ target: 'p' }, { target: 'q/one' }],
  })
  assert.equal(isHidden({ provider: 'p', model: 'anything' }, settings), true)
  assert.equal(isHidden({ provider: 'q', model: 'one' }, settings), true)
  assert.equal(isHidden({ provider: 'q', model: 'two' }, settings), false)
  assert.equal(isHidden({ provider: ROUTER_PROVIDER, model: 'a' }, settings), false, 'the tiers themselves are never hidden')
})

test('hide rules cannot name this plugin route', () => {
  const settings = normalizeSettings({ hide: [{ target: ROUTER_PROVIDER }, { target: 'p' }] })
  assert.deepEqual(settings.hide.map(rule => rule.target), ['p'])
})

test('retryable codes exclude the deterministic failures', () => {
  assert.equal(isRetryable('RATE_LIMIT'), true)
  assert.equal(isRetryable('TIMEOUT'), true)
  assert.equal(isRetryable(undefined), true)
  assert.equal(isRetryable('AUTH'), false)
  assert.equal(isRetryable('QUOTA'), false)
  assert.equal(isRetryable('ABORTED'), false)
  assert.equal(isRetryable('CONTEXT_WINDOW_EXCEEDED'), false)
})

test('backoff grows then plateaus', () => {
  assert.ok(retryDelay(0) < retryDelay(1))
  assert.equal(retryDelay(10), 4_000)
})

test('context and output overrides are optional, clamped, and per-member', () => {
  const bare = normalizeMember({ provider: 'p', model: 'm' })
  assert.equal(bare.contextWindow, undefined, 'unset must stay unset, not become zero')
  assert.equal(bare.maxTokens, undefined)

  const set = normalizeMember({ provider: 'p', model: 'm', contextWindow: 200_000, maxTokens: 8_192 })
  assert.equal(set.contextWindow, 200_000)
  assert.equal(set.maxTokens, 8_192)

  // Out-of-range values are clamped rather than rejected, so a typo cannot
  // produce a tier that refuses to load.
  assert.equal(normalizeMember({ provider: 'p', model: 'm', contextWindow: 10 }).contextWindow, 1_024)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', contextWindow: 10 ** 9 }).contextWindow, 4_000_000)
  // An empty string is "inherit", which is what an emptied input sends.
  assert.equal(normalizeMember({ provider: 'p', model: 'm', contextWindow: '' }).contextWindow, undefined)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', maxTokens: 'abc' }).maxTokens, undefined)
})

test('tier-level defaults survive storage and reach the chain', () => {
  const settings = normalizeSettings({
    tiers: [{
      id: 'a', name: 'A', reasoningEffort: 'high', contextWindow: 100_000, maxTokens: 16_000,
      members: [
        { provider: 'p', model: 'inherit' },
        { provider: 'q', model: 'override', contextWindow: 32_000, reasoningEffort: 'low' },
      ],
    }],
  })
  const tier = settings.tiers[0]
  assert.equal(tier.reasoningEffort, 'high')
  assert.equal(tier.contextWindow, 100_000)

  const chain = tierChain(tier)
  assert.equal(chain[0].reasoningEffort, 'high', 'the tier default reaches a member that sets none')
  assert.equal(chain[0].contextWindow, 100_000)
  assert.equal(chain[0].maxTokens, 16_000)
  assert.equal(chain[1].reasoningEffort, 'low', "the member's own value wins")
  assert.equal(chain[1].contextWindow, 32_000, "the member's own window wins")
})

test('log retention settings are clamped and default on', () => {
  const shipped = normalizeSettings(undefined)
  assert.equal(shipped.logRequests, true)
  assert.equal(shipped.logLimit, 200)

  assert.equal(normalizeSettings({ logLimit: 5 }).logLimit, 20)
  assert.equal(normalizeSettings({ logLimit: 10 ** 6 }).logLimit, 2_000)
  assert.equal(normalizeSettings({ logLimit: 'x' }).logLimit, 200)
  assert.equal(normalizeSettings({ logRequests: false }).logRequests, false)
})

test('the stored version records the shape change', () => {
  assert.equal(normalizeSettings({ version: 1 }).version, 3)
})

/**
 * Tests for the router's pure configuration logic.
 * @module test/config.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_VISION_WINDOW,
  MAX_ATTEMPTS,
  MAX_IDLE_TIMEOUT_MS,
  MAX_TIERS,
  MAX_VISION_WINDOW,
  MIN_IDLE_TIMEOUT_MS,
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
  visionWindow,
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
    provider: 'p', model: 'm', enabled: true,
  })
})

test('a token budget accepts the short forms people type', () => {
  // The UI shows `128k`; a hand-edited settings file has to mean the same thing,
  // or the two ways of writing one value would disagree.
  assert.equal(parseTokenBudget(131_072), 131_072)
  assert.equal(parseTokenBudget('131072'), 131_072)
  // Decimal multipliers, uppercase accepted, so what the field shows is what it
  // means: `1m` is a million, not 1,048,576.
  assert.equal(parseTokenBudget('128k'), 128_000)
  assert.equal(parseTokenBudget('128K'), 128_000)
  assert.equal(parseTokenBudget('128 k'), 128_000)
  assert.equal(parseTokenBudget('1m'), 1_000_000)
  assert.equal(parseTokenBudget('1M'), 1_000_000)
  assert.equal(parseTokenBudget('1.5m'), 1_500_000)
  assert.equal(parseTokenBudget('256k'), 256_000)
  assert.equal(parseTokenBudget(''), undefined)
  assert.equal(parseTokenBudget('abc'), undefined)
  assert.equal(parseTokenBudget('0'), undefined)
  assert.equal(parseTokenBudget(-5), undefined)
  assert.equal(parseTokenBudget(undefined), undefined)
})

test('a token budget is displayed the way a person would say it', () => {
  // The complaint that drove this: a context field reading `1000000` makes you
  // count zeros. It must never fall back to a digit string.
  assert.equal(formatTokenBudget(128_000), '128k')
  assert.equal(formatTokenBudget(100_000), '100k')
  assert.equal(formatTokenBudget(256_000), '256k')
  assert.equal(formatTokenBudget(1_000_000), '1m')
  assert.equal(formatTokenBudget(4_000_000), '4m')
  assert.equal(formatTokenBudget(undefined), '')
  // A provider's binary number is shown on the decimal scale rather than as
  // digits; typing the shown text back is a rounding, which is the accepted trade.
  assert.equal(formatTokenBudget(131_072), '131k')
  assert.equal(formatTokenBudget(262_144), '262k')
  assert.equal(formatTokenBudget(1_048_576), '1m')
  // Exact thousands round-trip unchanged.
  for (const tokens of [128_000, 100_000, 256_000, 1_000_000, 4_000_000, 32_000]) {
    assert.equal(parseTokenBudget(formatTokenBudget(tokens)), tokens, `round-trip for ${tokens}`)
  }
  // The short forms are decimal, so what the field shows is what it means.
  assert.equal(parseTokenBudget('1m'), 1_000_000)
  assert.equal(parseTokenBudget('256k'), 256_000)
  assert.equal(parseTokenBudget('1.5m'), 1_500_000)
})

test('a short-form budget reaches the member and the tier', () => {
  const member = normalizeMember({ provider: 'p', model: 'm', contextWindow: '128k', maxTokens: '1m' })
  assert.equal(member.contextWindow, 128_000)
  assert.equal(member.maxTokens, 1_000_000)
  const tier = normalizeTier({ id: 't', name: 'T', contextWindow: '1m', members: [{ provider: 'p', model: 'm' }] })
  assert.equal(tier.contextWindow, 1_000_000)
  // The clamp still applies after parsing.
  assert.equal(normalizeMember({ provider: 'p', model: 'm', contextWindow: '1' }).contextWindow, 1_024)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', contextWindow: '99m' }).contextWindow, 4_000_000)
})

test('member knobs are clamped instead of trusted', () => {
  assert.equal(normalizeMember({ provider: 'p', model: 'm', attempts: 99 }).attempts, MAX_ATTEMPTS)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', attempts: -3 }).attempts, 0)
  // A row that does not say is *unset*, not "the default value": keeping the two
  // apart is what lets a tier default reach the member at all.
  assert.equal(normalizeMember({ provider: 'p', model: 'm', attempts: 'x' }).attempts, undefined)
  assert.equal(normalizeMember({ provider: 'p', model: 'm' }).attempts, undefined)
  assert.equal(normalizeMember({ provider: 'p', model: 'm' }).idleTimeoutMs, undefined)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', idleTimeoutMs: 0 }).idleTimeoutMs, 0)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', idleTimeoutMs: 1 }).idleTimeoutMs, MIN_IDLE_TIMEOUT_MS)
  assert.equal(normalizeMember({ provider: 'p', model: 'm', idleTimeoutMs: 10 ** 9 }).idleTimeoutMs, MAX_IDLE_TIMEOUT_MS)
})

test('the timeout range is three to sixty seconds, defaulting to six', () => {
  // DSH retries a failed turn itself, and a retry is cheaper than waiting out a
  // dead lane, so the ceiling is deliberately short.
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 6_000)
  assert.equal(MIN_IDLE_TIMEOUT_MS, 3_000)
  assert.equal(MAX_IDLE_TIMEOUT_MS, 60_000)
  assert.equal(normalizeSettings({}).defaultIdleTimeoutMs, 6_000)
  assert.equal(normalizeSettings({ defaultIdleTimeoutMs: 1 }).defaultIdleTimeoutMs, 3_000)
  assert.equal(normalizeSettings({ defaultIdleTimeoutMs: 600_000 }).defaultIdleTimeoutMs, 60_000)
  // 0 still means "no limit" for the global default: that is an explicit choice.
  assert.equal(normalizeSettings({ defaultIdleTimeoutMs: 0 }).defaultIdleTimeoutMs, 0)
})

test('a tier can carry its own timeout and retries, and 0 means inherit', () => {
  // The panel offers these so a chain of slow models can be given more room
  // without editing every member. `0` is not a value here: a tier-level zero
  // would otherwise mean "no limit for the whole chain", which is the opposite
  // of what clearing the box should do.
  const tier = normalizeTier({
    id: 't', name: 'T', attempts: 2, idleTimeoutMs: 25_000,
    members: [{ provider: 'p', model: 'm' }],
  })
  assert.equal(tier.attempts, 2)
  assert.equal(tier.idleTimeoutMs, 25_000)
  const chain = tierChain(tier)
  assert.equal(chain[0].attempts, 2, 'the tier default reaches a member that sets none')
  assert.equal(chain[0].idleTimeoutMs, 25_000)

  const cleared = normalizeTier({ id: 't', name: 'T', attempts: 0, idleTimeoutMs: 0, members: [{ provider: 'p', model: 'm' }] })
  assert.equal(cleared.attempts, undefined, '0 clears the tier default instead of disabling it')
  assert.equal(cleared.idleTimeoutMs, undefined)
  // `tierChain` resolves only the two layers it knows about; the global default
  // is applied at dispatch, so an unset member stays `undefined` here.
  const clearedChain = tierChain(cleared)
  assert.equal(clearedChain[0].idleTimeoutMs, undefined, 'nothing left to inherit at this layer')
  assert.equal(clearedChain[0].attempts, undefined)

  // A member's own value still wins, including its own explicit 0.
  const mixed = normalizeTier({
    id: 't', name: 'T', attempts: 2, idleTimeoutMs: 25_000,
    members: [{ provider: 'p', model: 'm', attempts: 0, idleTimeoutMs: 0 }],
  })
  const mixedChain = tierChain(mixed)
  assert.equal(mixedChain[0].attempts, 0, "a member's own 0 is a real value")
  assert.equal(mixedChain[0].idleTimeoutMs, 0)
})

test('a tier timeout is clamped to the same range as a member', () => {
  assert.equal(normalizeTier({ id: 't', name: 'T', idleTimeoutMs: 1, members: [{ provider: 'p', model: 'm' }] }).idleTimeoutMs, MIN_IDLE_TIMEOUT_MS)
  assert.equal(normalizeTier({ id: 't', name: 'T', idleTimeoutMs: 10 ** 9, members: [{ provider: 'p', model: 'm' }] }).idleTimeoutMs, MAX_IDLE_TIMEOUT_MS)
  assert.equal(normalizeTier({ id: 't', name: 'T', attempts: 99, members: [{ provider: 'p', model: 'm' }] }).attempts, MAX_ATTEMPTS)
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
  // 128 turns: the log is persisted now, so this is how much history a restart
  // keeps rather than how much fits in memory.
  assert.equal(shipped.logLimit, 128)

  assert.equal(normalizeSettings({ logLimit: 5 }).logLimit, 20)
  assert.equal(normalizeSettings({ logLimit: 10 ** 6 }).logLimit, 2_000)
  assert.equal(normalizeSettings({ logLimit: 'x' }).logLimit, 128)
  assert.equal(normalizeSettings({ logRequests: false }).logRequests, false)
})

test('the stored version records the shape change', () => {
  assert.equal(normalizeSettings({ version: 1 }).version, 3)
})

test('vision compatibility is off by default and clamped when on', () => {
  const shipped = normalizeSettings(undefined)
  assert.equal(shipped.visionCompat, false, 'the shipped default keeps every image authoritative')
  assert.equal(shipped.visionCompatValue, DEFAULT_VISION_WINDOW)
  assert.equal(shipped.visionCompatUnit, 'messages')
  assert.equal(visionWindow(shipped), undefined, 'no window exists while the switch is off')

  const on = normalizeSettings({ visionCompat: true, visionCompatValue: 3, visionCompatUnit: 'minutes' })
  assert.deepEqual(visionWindow(on), { value: 3, unit: 'minutes' })

  // A hand-edited file is still input: out-of-range and unusable values fall
  // back rather than producing a window that never closes.
  assert.equal(normalizeSettings({ visionCompat: true, visionCompatValue: 0 }).visionCompatValue, 1)
  assert.equal(normalizeSettings({ visionCompat: true, visionCompatValue: 10 ** 6 }).visionCompatValue, MAX_VISION_WINDOW)
  assert.equal(normalizeSettings({ visionCompat: true, visionCompatValue: 'x' }).visionCompatValue, DEFAULT_VISION_WINDOW)
  assert.equal(normalizeSettings({ visionCompat: true, visionCompatUnit: 'hours' }).visionCompatUnit, 'messages')
  assert.equal(normalizeSettings({ visionCompat: 'yes' }).visionCompat, false, 'only a real boolean switches it on')
  assert.deepEqual(visionWindow({ visionCompat: true }), { value: DEFAULT_VISION_WINDOW, unit: 'messages' },
    'a caller without a normalized document still gets the fallbacks')
})

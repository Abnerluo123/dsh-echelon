/**
 * Tests for request-size estimation and context-aware chain ordering.
 * @module test/tokens.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderByContext } from '../src/config.js'
import { contentHasVisibleImage, estimateMessageTokens, estimateRequestTokens, fitsContext, inputBudgetFor, requestHasImage, textTokens } from '../src/tokens.js'

const text = body => [{ type: 'text', text: body }]
const member = (provider, contextWindow, extra = {}) => ({ provider, model: 'm', attempts: 0, idleTimeoutMs: 1, ...(contextWindow === undefined ? {} : { contextWindow }), ...extra })

test('text tokens follow the fixed-density heuristic with block framing', () => {
  assert.equal(textTokens(''), 0)
  assert.equal(textTokens('abcd'), 1 + 4, '4 chars per token plus block overhead')
  assert.equal(textTokens('a'.repeat(400)), 100 + 4)
  assert.equal(textTokens(undefined), 0, 'a missing text is free, not a throw')
})

test('a message is priced with role framing and per-block overhead', () => {
  const one = estimateMessageTokens({ role: 'user', content: text('abcd') })
  const two = estimateMessageTokens({ role: 'user', content: [{ type: 'text', text: 'abcd' }, { type: 'text', text: 'abcd' }] })
  assert.equal(two - one, 5, 'each extra block costs its own text plus framing')
  assert.equal(estimateMessageTokens(null), 0)
  assert.equal(estimateMessageTokens({ content: 'plain string' }), textTokens('plain string') + 4)
})

test('tool calls are priced by name and arguments, not just JSON noise', () => {
  const call = estimateMessageTokens({ role: 'assistant', content: [{ type: 'tool-call', name: 'a'.repeat(40), arguments: 'x'.repeat(400) }] })
  const empty = estimateMessageTokens({ role: 'assistant', content: [] })
  assert.ok(call > empty + 100, 'the arguments dominate the price')
})

test('the request estimate includes tool schemas', () => {
  const messages = [{ role: 'user', content: text('hi') }]
  const bare = estimateRequestTokens({ messages })
  const withTools = estimateRequestTokens({ messages, tools: [{ name: 'read', description: 'x'.repeat(4_000), parameters: {} }] })
  assert.ok(withTools.inputTokens > bare.inputTokens + 500, 'tool schemas are part of the prompt')
  assert.equal(bare.source, 'heuristic')
})

test('the mounted meter is preferred over the local heuristic', () => {
  const messages = [{ role: 'user', content: text('hello world') }]
  const meter = { estimateMessage: () => 1_000 }
  const viaMeter = estimateRequestTokens({ messages }, meter)
  assert.equal(viaMeter.source, 'meter')
  assert.equal(viaMeter.inputTokens, 1_000)
  assert.notEqual(estimateRequestTokens({ messages }).inputTokens, 1_000)
})

test('a throwing meter falls back instead of ending the turn', () => {
  const messages = [{ role: 'user', content: text('hello') }]
  const meter = { estimateMessage: () => { throw new Error('meter exploded') } }
  const result = estimateRequestTokens({ messages }, meter)
  assert.equal(result.source, 'heuristic')
  assert.ok(result.inputTokens > 0)
})

test('the input budget keeps output room and a safety margin', () => {
  const { usable, safety } = inputBudgetFor(100_000, 8_000)
  assert.equal(safety, 2_000)
  assert.equal(usable, 100_000 - 2_000 - 8_000)
  // A tiny window still reserves at least the floor, never a negative budget.
  assert.ok(inputBudgetFor(1_000, 0).usable >= 0)
  assert.equal(inputBudgetFor(0, 0).usable, 0)
  assert.equal(inputBudgetFor(undefined, 0).usable, 0)
})

test('fitsContext treats an unknown window as eligible', () => {
  assert.deepEqual(fitsContext({}, 10 ** 6), { fits: true })
  const { fits, window } = fitsContext({ contextWindow: 10_000 }, 100_000)
  assert.equal(fits, false)
  assert.equal(window, 10_000)
})

test('orderByContext keeps the user order and skips only what cannot fit', () => {
  const chain = [member('small', 300_000), member('big', 1_000_000)]
  const result = orderByContext(chain, 700_000)
  assert.equal(result.fits, true)
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['big'])
  assert.deepEqual(result.skipped.map(entry => entry.provider), ['small'])
  assert.equal(result.skipped[0].window, 300_000)
})

test('orderByContext leaves a fitting chain untouched', () => {
  const chain = [member('small', 300_000), member('big', 1_000_000)]
  const result = orderByContext(chain, 1_000)
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['small', 'big'], 'no reordering when everything fits')
  assert.deepEqual(result.skipped, [])
})

test('orderByContext falls back to the roomiest member when nothing fits', () => {
  const chain = [member('tiny', 8_000), member('medium', 16_000)]
  const result = orderByContext(chain, 10 ** 7)
  assert.equal(result.fits, false)
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['medium'])
  assert.equal(result.skipped.length, 2, 'both are still reported as too small')
})

test('orderByContext keeps members whose window is unknown', () => {
  const chain = [member('unknown'), member('big', 1_000_000)]
  const result = orderByContext(chain, 10 ** 7)
  // `unknown` is eligible because nothing proved it small; `big` does not fit.
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['unknown'])
})

test('orderByContext can resolve windows through a callback', () => {
  const chain = [{ provider: 'a', model: 'm', attempts: 0, idleTimeoutMs: 1 }, { provider: 'b', model: 'm', attempts: 0, idleTimeoutMs: 1 }]
  const result = orderByContext(chain, 500_000, entry => (entry.provider === 'a' ? 200_000 : 1_000_000))
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['b'])
})

test('a member reserve reduces the usable window', () => {
  const chain = [member('capped', 100_000, { maxTokens: 50_000 }), member('roomy', 100_000)]
  const result = orderByContext(chain, 60_000)
  // `capped` cannot hold 60K input once 50K is reserved for output.
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['roomy'])
  assert.deepEqual(result.skipped.map(entry => entry.provider), ['capped'])
})

test('the roomy strategy prefers free space over chain order', () => {
  // Both fit; order says 'small' first, headroom says 'big' first. This is the
  // lever that keeps a long session off a model with barely enough room.
  const chain = [member('small', 300_000), member('big', 1_000_000)]
  const byOrder = orderByContext(chain, 1_000, undefined, { strategy: 'order' })
  assert.deepEqual(byOrder.ordered.map(entry => entry.provider), ['small', 'big'])
  const byRoom = orderByContext(chain, 1_000, undefined, { strategy: 'roomy' })
  assert.deepEqual(byRoom.ordered.map(entry => entry.provider), ['big', 'small'])
  assert.equal(byRoom.strategy, 'roomy')
})

test('roomy still refuses members that cannot hold the request', () => {
  const chain = [member('tiny', 8_000), member('big', 1_000_000)]
  const result = orderByContext(chain, 100_000, undefined, { strategy: 'roomy' })
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['big'])
  assert.deepEqual(result.skipped.map(entry => entry.provider), ['tiny'])
})

test('roomy keeps chain order when capacities tie', () => {
  const chain = [member('a', 200_000), member('b', 200_000)]
  const result = orderByContext(chain, 1_000, undefined, { strategy: 'roomy' })
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['a', 'b'], 'a stable tie is the user order')
})

test('an unknown window is not demoted by the roomy strategy', () => {
  // Nothing proved it small, so it stays ahead of the ranked members.
  const chain = [member('unknown'), member('big', 1_000_000)]
  const result = orderByContext(chain, 1_000, undefined, { strategy: 'roomy' })
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['unknown', 'big'])
})

test('an unknown strategy falls back to chain order', () => {
  const chain = [member('small', 300_000), member('big', 1_000_000)]
  const result = orderByContext(chain, 1_000, undefined, { strategy: 'nonsense' })
  assert.deepEqual(result.ordered.map(entry => entry.provider), ['small', 'big'])
  assert.equal(result.strategy, 'order')
})

test('a requested output reserve shrinks what counts as fitting', () => {
  const chain = [member('tight', 10_000)]
  // 5000 input would fit a 10K window outright, but not once 6000 is reserved.
  assert.equal(orderByContext(chain, 5_000, undefined, {}).fits, true)
  assert.equal(orderByContext(chain, 5_000, undefined, { reserveOutput: 6_000 }).fits, false)
})

const img = (extra = {}) => ({ type: 'image', source: { kind: 'attachment', id: 'a1' }, ...extra })
const msg = (role, content) => ({ role, content })

test('an offloaded image no longer counts as an image', () => {
  // DSH replaces offloaded images with a text placeholder before sending, so a
  // text-only member can read that request. Counting it would keep excluding
  // text members for an image that is not in the prompt any more.
  assert.equal(contentHasVisibleImage([img()]), true)
  assert.equal(contentHasVisibleImage([img({ offloaded: true })]), false)
  assert.equal(contentHasVisibleImage([{ type: 'text', text: 'hi' }]), false)
  assert.equal(contentHasVisibleImage(undefined), false)
})

test('any image still in the conversation requires vision', () => {
  // This is the reported bug. An image attached three turns ago is still part of
  // the prompt; DSH flattens it for any member whose own declaration excludes
  // `image`, so routing the follow-up to a text model replaces the screenshot
  // with a placeholder and the model answers "I can't see any image".
  const followUp = [msg('user', [img()]), msg('assistant', [{ type: 'text', text: 'ok' }]), msg('user', [{ type: 'text', text: 'thanks' }])]
  assert.equal(requestHasImage({ messages: followUp }), true, 'an older image still counts')
  const current = [msg('user', [{ type: 'text', text: 'earlier' }]), msg('assistant', [{ type: 'text', text: 'ok' }]), msg('user', [img()])]
  assert.equal(requestHasImage({ messages: current }), true, 'a fresh image counts')
  const textOnly = [msg('user', [{ type: 'text', text: 'hi' }]), msg('assistant', [{ type: 'text', text: 'ok' }])]
  assert.equal(requestHasImage({ messages: textOnly }), false)
})

test('a screenshot in a tool result still requires vision', () => {
  // A browser tool returns an image as a tool result, not as a user message.
  const messages = [msg('user', [{ type: 'text', text: 'open it' }]), msg('assistant', [{ type: 'text', text: 'ok' }]), msg('tool', [img()])]
  assert.equal(requestHasImage({ messages }), true, 'tool-result images count')
})

test('an offloaded image does not require vision', () => {
  // DSH only marks a block offloaded once the image is gone from the prompt.
  const messages = [msg('user', [img({ offloaded: true })]), msg('assistant', [{ type: 'text', text: 'ok' }])]
  assert.equal(requestHasImage({ messages }), false)
})

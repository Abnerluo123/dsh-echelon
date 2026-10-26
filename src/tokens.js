/**
 * Estimating how much context one request will occupy.
 *
 * A tier may span models with different windows, so "which member can take this
 * request" has to be answered *before* dispatch — otherwise the turn is handed
 * to a model that rejects it and the failure looks like the provider's fault.
 *
 * Two sources, in order of authority:
 *
 * 1. `ctx.tokenMeter.estimateMessage` — DSH's own meter, the same number the
 *    compaction and occupancy displays use. Preferred because agreeing with the
 *    rest of the harness matters more than absolute accuracy here.
 * 2. A local copy of the documented heuristic (4 characters per token, plus
 *    framing overhead per block and message), used when the meter is absent —
 *    a headless composition, for instance.
 *
 * Both are *estimates*. They are deliberately slightly conservative, because
 * guessing low ends a turn on the wrong model while guessing high only sends it
 * to a capable one.
 *
 * @module src/tokens.js
 */

/** Characters per token in the fixed-density heuristic DSH uses. */
const CHARS_PER_TOKEN = 4
/** Per-block structural framing overhead. */
const BLOCK_OVERHEAD = 4
/** Per-message role framing overhead. */
const ROLE_OVERHEAD = 4

/**
 * Tokens of one text block, matching the meter's fixed-density arm.
 * @param {string} text - block text.
 * @returns {number} estimated tokens.
 */
export function textTokens(text) {
  const value = typeof text === 'string' ? text : ''
  if (value === '') return 0
  return Math.ceil(value.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Tokens of one message under the documented heuristic.
 * @param {object} message - a harness message or request-only user input.
 * @returns {number} estimated tokens including framing.
 */
export function estimateMessageTokens(message) {
  if (message === null || typeof message !== 'object') return 0
  const content = message.content
  if (typeof content === 'string') return textTokens(content) + ROLE_OVERHEAD
  if (!Array.isArray(content)) return ROLE_OVERHEAD
  let tokens = ROLE_OVERHEAD
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'reasoning') {
      tokens += textTokens(block.text)
      continue
    }
    if (block.type === 'tool-call') {
      tokens += textTokens(block.name) + textTokens(block.arguments)
      continue
    }
    // Unknown and merge-extended blocks (images included) keep a conservative
    // structural price rather than being counted as free.
    try {
      tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    } catch {
      tokens += BLOCK_OVERHEAD
    }
  }
  return tokens
}

/**
 * Estimate the input side of one request.
 *
 * Tool schemas are part of the prompt an adapter sends, and on a tool-heavy
 * session they can dwarf the conversation, so they are priced too.
 * @param {object} options - the generate options about to be dispatched.
 * @param {object} [meter] - the mounted `tokenMeter` service, when present.
 * @returns {{inputTokens: number, source: 'meter' | 'heuristic'}} estimated input size.
 */
export function estimateRequestTokens(options, meter) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const tools = Array.isArray(options?.tools) ? options.tools : []
  if (meter !== undefined && typeof meter.estimateMessage === 'function') {
    try {
      let tokens = 0
      for (const message of messages) tokens += meter.estimateMessage(message)
      if (tools.length > 0) {
        // A tool declaration is a prompt fragment with no message of its own, so
        // it is priced as text; the meter has no dedicated arm for it.
        tokens += Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN)
      }
      return { inputTokens: Math.max(tokens, 0), source: 'meter' }
    } catch {
      // A meter that throws on one odd message must not end the turn.
    }
  }
  let tokens = 0
  for (const message of messages) tokens += estimateMessageTokens(message)
  if (tools.length > 0) tokens += Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN)
  return { inputTokens: Math.max(tokens, 0), source: 'heuristic' }
}

/**
 * The headroom a member needs beyond the estimate before a request is handed to it.
 *
 * Reserving the output budget matters: a model accepts a prompt that fills its
 * window exactly and then cannot emit a single token. The fraction covers
 * tokenizer drift between the estimate and the provider's own count.
 * @param {number} contextWindow - the member's effective window.
 * @param {number | undefined} reserveOutput - output tokens to keep free.
 * @param {number} [safetyFraction] - fraction of the window held back.
 * @returns {{usable: number, safety: number}} tokens available for input, and the safety margin used.
 */
export function inputBudgetFor(contextWindow, reserveOutput, safetyFraction = 0.02) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { usable: 0, safety: 0 }
  const safety = Math.max(Math.ceil(contextWindow * safetyFraction), 512)
  const reserve = Number.isFinite(reserveOutput) && reserveOutput > 0 ? reserveOutput : 0
  return { usable: Math.max(contextWindow - safety - reserve, 0), safety }
}

/**
 * Whether one member can accept a request of this size.
 * @param {object} member - a dispatch-chain entry with `modelInfo` already resolved.
 * @param {number} inputTokens - estimated input size.
 * @param {number} [reserveOutput] - output tokens the member must keep free.
 * @returns {{fits: boolean, usable?: number, window?: number}} the verdict and the numbers behind it.
 */
export function fitsContext(member, inputTokens, reserveOutput) {
  const window = member?.contextWindow ?? member?.modelInfo?.context?.contextWindow
  if (!Number.isFinite(window) || window <= 0) {
    // An unknown window is not evidence of a small one: dispatch rather than
    // skip a member that might be perfectly able to answer.
    return { fits: true }
  }
  const reserve = member?.maxTokens ?? member?.modelInfo?.defaultMaxTokens ?? reserveOutput
  const { usable } = inputBudgetFor(window, reserve)
  return { fits: inputTokens <= usable, usable, window }
}

/**
 * Whether one content block list carries an image the model must be able to read.
 *
 * An **offloaded** image does not count. DSH's offload flow marks the block
 * `offloaded: true` and substitutes a text placeholder before the request is
 * sent, so by the time a model sees it there is no image left. Ignoring that flag
 * would keep excluding text-only members for an image that is no longer there.
 * @param {unknown} content - a message's content blocks.
 * @returns {boolean} true when a live image block is present.
 */
export function contentHasVisibleImage(content) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'image') continue
    if (block.offloaded === true) continue
    return true
  }
  return false
}

/**
 * Whether a request needs a model that can see.
 *
 * Every image still in the conversation counts, not just the one attached to the
 * current turn. That is not a preference: DSH projects an image to text for any
 * member whose own `inputModalities` excludes `image` (see
 * `dsh-llm/lib/index.js`, the `projectImagesForTextModel` call in `adapterStream`),
 * and `prepared.modelInfo` there is the *dispatched member's* info, not the
 * tier's.
 *
 * So routing a follow-up question to a text-only member does not "save a vision
 * model" — it replaces the screenshot with a placeholder, and the model then
 * truthfully reports that it cannot see any image. That was the reported bug: an
 * earlier scope option (`recent`) ignored older images, which silently dropped
 * them from the model's view while the user could still see them in the
 * transcript.
 * @param {object} options - the generate options about to be dispatched.
 * @returns {boolean} true when the conversation carries a live image.
 */
export function requestHasImage(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return messages.some(message => contentHasVisibleImage(message?.content))
}

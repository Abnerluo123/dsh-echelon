/**
 * In-memory request log.
 *
 * The question this answers is the one a tier makes impossible to answer by
 * looking at the transcript: *which* model actually served that turn, which
 * lanes were tried first, why each was abandoned, and how long the winner took.
 *
 * Design notes
 * ------------
 * - **Memory only, bounded.** A tier hides its members, so the log is the only
 *   place the physical route is visible at all — but it is also a debugging
 *   surface, not an audit trail. It holds the last N entries and resets with the
 *   process, which is why nothing here touches the disk.
 * - **Append-at-finish.** An entry is written once, when a turn settles, from a
 *   mutable draft the adapter fills in as it goes. Nothing observes a
 *   half-written attempt, and a long streaming answer costs no extra work.
 * - **Read-only to the outside.** The HTTP layer may list and clear; it cannot
 *   inject a row.
 *
 * @module src/log.js
 */
import { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT, MIN_LOG_LIMIT } from './config.js'

/** How many attempts a single entry keeps before coalescing the rest into a count. */
const MAX_ATTEMPTS_KEPT = 12

/**
 * Clamp a requested retention limit.
 * @param {unknown} value - requested limit.
 * @returns {number} a usable ring size.
 */
export function clampLogLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LOG_LIMIT
  return Math.min(Math.max(Math.trunc(parsed), MIN_LOG_LIMIT), MAX_LOG_LIMIT)
}

/**
 * A bounded, newest-first request log.
 */
export class RequestLog {
  /** @type {object[]} */
  #entries = []
  /** @type {number} */
  #limit
  /** Monotonic id source, so a client can poll for "everything after N". */
  #sequence = 0

  /**
   * @param {{limit?: number}} [options] - initial retention.
   */
  constructor(options = {}) {
    this.#limit = clampLogLimit(options.limit)
  }

  /** @returns {number} how many entries are retained. */
  get limit() {
    return this.#limit
  }

  /**
   * Change retention. Lowering it drops the oldest entries immediately.
   * @param {unknown} value - requested limit.
   * @returns {number} the applied limit.
   */
  setLimit(value) {
    this.#limit = clampLogLimit(value)
    if (this.#entries.length > this.#limit) this.#entries.length = this.#limit
    return this.#limit
  }

  /**
   * Begin one entry.
   *
   * The returned draft is the object the adapter mutates; `commit` freezes and
   * stores it. Keeping the draft out of the list until commit means a caller can
   * never observe an entry whose outcome is still undecided.
   * @param {{tier: string, tierName: string}} seed - identity of the turn.
   * @returns {object} a mutable draft, and a `commit` to publish it.
   */
  begin(seed) {
    const startedAt = Date.now()
    const draft = {
      id: ++this.#sequence,
      startedAt,
      tier: seed.tier,
      tierName: seed.tierName,
      attempts: [],
      outcome: 'pending',
      provider: undefined,
      model: undefined,
      durationMs: 0,
      usage: undefined,
      message: undefined,
      droppedAttempts: 0,
    }
    let committed = false
    return {
      draft,
      /** Record one attempt; the adapter calls this before each dispatch. */
      attempt(record) {
        if (draft.attempts.length >= MAX_ATTEMPTS_KEPT) {
          draft.droppedAttempts += 1
          return
        }
        draft.attempts.push(record)
      },
      /** Publish the entry. Safe to call once; later calls are ignored. */
      commit: patch => {
        if (committed) return
        committed = true
        Object.assign(draft, patch, { durationMs: Date.now() - startedAt })
        this.#entries.unshift(draft)
        if (this.#entries.length > this.#limit) this.#entries.length = this.#limit
      },
    }
  }

  /**
   * Read entries, newest first.
   * @param {{limit?: number, since?: number}} [options] - `since` returns only ids greater than it.
   * @returns {{entries: object[], total: number, limit: number, newestId: number}} a detached view.
   */
  read(options = {}) {
    const since = Number.isFinite(Number(options.since)) ? Number(options.since) : undefined
    const limit = Number.isFinite(Number(options.limit))
      ? Math.min(Math.max(Math.trunc(Number(options.limit)), 1), this.#limit)
      : this.#limit
    const selected = (since === undefined ? this.#entries : this.#entries.filter(entry => entry.id > since)).slice(0, limit)
    return {
      entries: selected.map(entry => ({ ...entry, attempts: entry.attempts.map(attempt => ({ ...attempt })) })),
      total: this.#entries.length,
      limit: this.#limit,
      newestId: this.#sequence,
    }
  }

  /** Drop every entry. The id counter keeps advancing so a `since` poll stays correct. */
  clear() {
    this.#entries.length = 0
  }
}

/**
 * Fold one settled stream's usage chunk into a compact total.
 * @param {object[]} chunks - the committed chunks of the winning attempt.
 * @returns {{inputTokens?: number, outputTokens?: number, totalTokens?: number} | undefined} usage, when reported.
 */
export function usageOf(chunks) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index]
    if (chunk?.type !== 'usage' || !chunk.usage) continue
    const { inputTokens, outputTokens, totalTokens } = chunk.usage
    if (![inputTokens, outputTokens, totalTokens].some(value => Number.isFinite(value))) continue
    return {
      ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
      ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
      ...(Number.isFinite(totalTokens) ? { totalTokens } : {}),
    }
  }
  return undefined
}

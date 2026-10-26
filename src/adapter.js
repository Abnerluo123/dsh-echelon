/**
 * The router adapter: one provider route whose models are the user's tiers.
 *
 * Design
 * ------
 * Each tier is a *virtual model*. Selecting it in the picker sends
 * `{ provider: 'model-router', model: '<tier id>' }`; the adapter resolves that
 * id to an ordered chain of real routes and walks it.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **Nothing partial leaks.** A member's stream is buffered until it produces
 *    content a reader would see. A lane that fails after emitting reasoning but
 *    before answering can therefore be abandoned silently — the transcript never
 *    shows the attempt that lost.
 * 2. **The turn ends exactly once.** Every path out of `stream()` yields exactly
 *    one terminal `finish` chunk, so the loop sees either a real answer or one
 *    error that names every lane it tried and why.
 *
 * Compatibility note: tiers may name *any* registered provider route, including
 * another routing plugin's route (Fusion's `dsh-model-fusion/auto`, the free
 * model plugin's combos). The chain dispatches through `ctx.llm.prepareCall`, so
 * whatever that route resolves to is what runs — this adapter never assumes a
 * member speaks a particular wire protocol.
 *
 * @module src/adapter.js
 */
import { Adapter } from './base.js'
import {
  AUTO_TIER_ID,
  ROUTER_PROVIDER,
  isRetryable,
  orderByContext,
  splitByModality,
  unionModalities,
  retryDelay,
  tierChain,
} from './config.js'
import { EFFORT_IDS, effortIds, mapEffort, snapEffort } from './effort.js'
import { RequestLog, usageOf } from './log.js'
import { SettingsStore } from './store.js'
import { estimateRequestTokens, requestHasImage } from './tokens.js'

/** How long a resolved model's metadata is reused, in milliseconds. */
const INFO_TTL_MS = 30_000

/**
 * Ceiling on one metadata lookup, in milliseconds.
 *
 * Deliberately short and not user-configurable: this is a capability probe, not
 * generation, so waiting longer than a few seconds means the lane is gone. A
 * timeout degrades to "unknown capabilities" instead of failing the turn.
 */
const INFO_TIMEOUT_MS = 8_000

/** How many member attempts one turn may spend before the chain is declared dead. */
const MAX_ATTEMPTS_PER_TURN = 64

/**
 * Whether one chunk is the point of no return for a candidate.
 *
 * Text, a tool call, or any non-reasoning block means the user will see
 * something from this lane, so committing is the only honest option left.
 * Reasoning alone is deliberately *not* a commit: a lane that thinks and then
 * dies has produced nothing the reader asked for.
 * @param {object} chunk - one stream chunk.
 * @returns {boolean} true when output must be forwarded and the candidate kept.
 */
export function commitsAnswer(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  const block = chunk.block
  if (!block || typeof block !== 'object') return false
  if (block.type === 'reasoning') return false
  if (block.type === 'text') return typeof block.text === 'string' && block.text.trim() !== ''
  return true
}

/** Sleep that settles early when the turn is cancelled. */
function delay(ms, signal) {
  if (signal?.aborted === true || ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

/** Render one thrown value without letting hostile coercion escape. */
function describe(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  try {
    return String(error)
  } catch {
    return 'router member failed'
  }
}

/**
 * Read the stable failure code DSH attaches to its own errors.
 * `LlmError` and every other `HarnessError` carry `code`, which is what decides
 * whether a retry is worth attempting.
 * @param {unknown} error - a thrown value.
 * @returns {string | undefined} the code, when the value carries one.
 */
function codeOf(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** Extract a stable failure code and message from a terminal finish reason. */
function failureOf(reason) {
  const failure = reason?.failure
  return {
    code: typeof failure?.code === 'string' ? failure.code : undefined,
    message: typeof failure?.message === 'string' ? failure.message : undefined,
  }
}

/**
 * Buffered dispatch of one member.
 *
 * Runs the member's stream while holding every chunk, then reports whether
 * anything visible was produced. A held answer is returned so the caller can
 * replay it; a silent failure is returned as a verdict.
 * @param {AsyncIterable<object>} stream - the member's chunk stream.
 * @param {AbortSignal} [signal] - turn cancellation.
 * @param {number} [idleTimeoutMs] - abandon the attempt after this long without a chunk; 0 disables.
 * @returns {Promise<{kind: 'answer', chunks: object[]} | {kind: 'failed', code?: string, message?: string} | {kind: 'aborted', message?: string}>}
 */
/**
 * Run one member, streaming as soon as it is safe to.
 *
 * The buffering rule exists for failover: a lane that dies after emitting half an
 * answer must not leak that half, so output is withheld until it contains
 * something a reader actually asked for (text, a tool call). But withholding
 * *everything* — which an earlier version did — costs the entire point of a
 * stream: the caller waits for the full answer, time-to-first-token becomes the
 * whole generation, and the harness measures a throughput of tokens/second that
 * divides by zero-ish elapsed time and prints absurd numbers like 264160 tok/s.
 *
 * So: hold chunks until the commit point, then pass every later chunk straight
 * through. After the commit the turn can no longer fail over anyway — output is
 * already visible — so there is nothing left to protect.
 *
 * The verdict is written into `sink.verdict` because a generator cannot both
 * yield chunks and return a value the caller reads.
 * @param {AsyncIterable<object>} stream - the member's chunk stream.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {number} [idleTimeoutMs] - fail after this long with no chunk; 0 disables.
 * @param {{verdict?: object}} sink - receives the verdict before the generator ends.
 * @returns {AsyncGenerator<object>} committed chunks only.
 */
export async function* streamMember(stream, signal, idleTimeoutMs = 0, sink = {}, abort) {
  const held = []
  let committed = false
  let failure
  let aborted
  let finished = false
  let usage
  // Progress, not mere traffic, resets the watchdog.
  //
  // The per-step deadline below only bounds one `next()` call, so a gateway that
  // sends a keepalive — an empty delta, a usage-only row, a heartbeat event —
  // every few hundred milliseconds keeps every individual wait short and the
  // attempt alive forever, with nothing on screen. That is precisely the
  // "模型几分钟没输出，超时也没拦住" report. So a second clock measures time since
  // the last chunk that actually *carries* something, and the same idle budget
  // applies to it.
  //
  // `carriesProgress` is about payload, not chunk shape: an empty delta is a
  // keepalive. Reasoning counts as fully as prose, so a long think is never cut
  // off, and a member waiting on a local command has already finished its call.
  let lastProgressAt = Date.now()
  const iterator = stream[Symbol.asyncIterator]()
  const timeoutMessage = () => `超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有进展（收到过空数据，但没有任何输出）`
  /** Settle the verdict exactly once. */
  const settle = verdict => {
    sink.verdict = verdict
    return verdict
  }
  /**
   * Release the member, without waiting for it.
   *
   * `iterator.return()` does not merely signal: on an async generator it awaits
   * whatever that generator is currently suspended on. For a member stuck in a
   * provider read, that await is the very thing that hung — so `await
   * iterator.return()` turned one deadline into two waits and the attempt ran for
   * minutes after the timeout had already fired. The reported `277767 ms`
   * TIMEOUT with an 8-second budget was this: detected at 8s, then blocked in
   * cleanup.
   *
   * The fix has two halves, both needed:
   * - `abort()` cancels the member's own request, which is what actually
   *   unblocks the underlying socket;
   * - `return()` is still called for adapters that hang their own hooks off it,
   *   but its settlement is bounded and its failure ignored.
   */
  const release = async () => {
    try {
      abort?.()
    } catch {
      // Cancelling is best-effort; the verdict below is what matters.
    }
    try {
      const closing = iterator.return?.()
      if (closing !== undefined) {
        await Promise.race([
          Promise.resolve(closing).catch(() => {}),
          new Promise(resolve => {
            const timer = setTimeout(resolve, 1_000)
            timer.unref?.()
          }),
        ])
      }
    } catch {
      // A generator that throws on close is already gone.
    }
  }
  try {
    while (true) {
      if (signal?.aborted === true) {
        await release()
        settle({ kind: 'aborted' })
        return
      }
      if (idleTimeoutMs > 0 && Date.now() - lastProgressAt > idleTimeoutMs) {
        // The stream is still trickling, but has produced nothing for a whole
        // budget: treat it exactly like silence.
        await release()
        settle({ kind: 'failed', code: 'TIMEOUT', message: timeoutMessage() })
        return
      }
      const step = idleTimeoutMs > 0
        ? await raceDeadline(iterator.next(), idleTimeoutMs)
        : { kind: 'value', value: await iterator.next() }
      if (step.kind === 'timeout') {
        // The provider went quiet mid-stream.
        await release()
        settle({ kind: 'failed', code: 'TIMEOUT', message: `超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到任何数据` })
        return
      }
      if (step.kind === 'error') {
        await release()
        const code = codeOf(step.error)
        settle({ kind: 'failed', message: describe(step.error), ...(code === undefined ? {} : { code }) })
        return
      }
      const row = step.value
      if (row.done === true) break
      const chunk = row.value
      if (carriesProgress(chunk)) lastProgressAt = Date.now()
      // Bookkeeping runs before any commit short-circuit: a member that has
      // already emitted visible output still has to have its terminal `finish`
      // observed, or a good answer would be reported as a truncated stream.
      if (chunk?.type === 'finish') {
        finished = true
        if (chunk.reason?.kind === 'aborted') aborted = failureOf(chunk.reason)
        else if (chunk.reason?.kind === 'error') failure = failureOf(chunk.reason)
        if (!committed) { held.push(chunk); continue }
        yield chunk
        continue
      }
      if (chunk?.type === 'usage') usage = chunk
      if (committed) {
        yield chunk
        continue
      }
      held.push(chunk)
      if (!commitsAnswer(chunk)) continue
      committed = true
      // Flush what was held, then every later chunk flows live.
      for (const pending of held) yield pending
      held.length = 0
    }
  } catch (error) {
    const code = codeOf(error)
    settle({ kind: 'failed', message: describe(error), ...(code === undefined ? {} : { code }) })
    return
  }
  if (aborted !== undefined || signal?.aborted === true) {
    settle({ kind: 'aborted', ...(aborted === undefined ? {} : { message: aborted.message }), ...(aborted === undefined ? {} : { code: 'ABORTED' }) })
    return
  }
  if (failure !== undefined) {
    // A terminal error chunk after output was already shown cannot be retried:
    // the reader has the partial answer, and a failover would print a second
    // answer on top of it.
    settle(committed
      ? { kind: 'failed', committed: true, message: failure.message, ...(failure.code === undefined ? {} : { code: failure.code }) }
      : { kind: 'failed', ...failure })
    return
  }
  if (failure !== undefined) return
  if (!finished) {
    // A stream that stops without its finish chunk cannot be replayed.
    settle(committed
      ? { kind: 'failed', committed: true, code: 'TRANSPORT', message: '数据流没有正常结束' }
      : { kind: 'failed', code: 'TRANSPORT', message: '数据流没有正常结束' })
    return
  }
  if (!committed) {
    settle({ kind: 'failed', code: 'EMPTY_RESPONSE', message: '没有返回任何可见内容' })
    return
  }
  settle({ kind: 'answer', ...(usage === undefined ? {} : { usage }) })
}

/**
 * Drain one member and return its verdict, keeping the chunks.
 *
 * Used by the tests and by any caller that wants the whole answer at once. The
 * dispatch path uses {@link streamMember} directly so it can forward output as it
 * arrives.
 * @param {AsyncIterable<object>} stream - the member's chunk stream.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {number} [idleTimeoutMs] - fail after this long with no chunk; 0 disables.
 * @returns {Promise<object>} verdict, with `chunks` when it answered.
 */
export async function runMember(stream, signal, idleTimeoutMs = 0) {
  const sink = {}
  const chunks = []
  for await (const chunk of streamMember(stream, signal, idleTimeoutMs, sink)) chunks.push(chunk)
  const verdict = sink.verdict ?? { kind: 'failed', code: 'TRANSPORT', message: '数据流没有正常结束' }
  return verdict.kind === 'answer' ? { ...verdict, chunks } : verdict
}

/**
 * Race one promise against a deadline.
 *
 * Used for the *pre-stream* half of an attempt. `streamMember` already bounds
 * each `iterator.next()`, but `prepareCall` ran outside any deadline, so a member
 * that hung while resolving its capability or refreshing a token held the turn
 * open with no failover — which looks exactly like "the model died and the
 * timeout never fired". The loser of the race is only abandoned, never
 * awaited, because the point is to stop waiting, not to keep the turn open a
 * little longer.
 * @param {Promise<any>} promise - the work to bound.
 * @param {number} ms - deadline in milliseconds; 0 or less disables it.
 * @param {() => string} message - text for the timeout failure.
 * @returns {Promise<any>} the promise's value, or a TIMEOUT rejection.
 */
function withDeadline(promise, ms, message) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message())
      error.code = 'TIMEOUT'
      reject(error)
    }, ms)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Race one iterator step against a deadline, settling the loser.
 * @param {Promise<IteratorResult<object>>} promise - the next iterator step.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<{kind: 'value', value: IteratorResult<object>} | {kind: 'timeout'} | {kind: 'error', error: unknown}>}
 */
function raceDeadline(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve({ kind: 'value', value })
      },
      error => {
        clearTimeout(timer)
        resolve({ kind: 'error', error })
      },
    )
  })
}

/**
 * The adapter. One instance serves the single `model-router` route.
 */
export class RouterAdapter extends Adapter {
  /** @type {SettingsStore} */
  #store
  /** @type {object} */
  #logger
  /** @type {RequestLog} */
  #log
  /** @type {Map<string, {at: number, info: object | undefined}>} */
  #info = new Map()

  /**
   * @param {object} options - wiring supplied by the plugin entry.
   * @param {SettingsStore} [options.store] - settings storage.
   * @param {object} [options.logger] - Cordis logger, optional.
   * @param {RequestLog} [options.log] - shared request log, optional.
   */
  constructor({ store, logger, log } = {}) {
    super()
    this.#store = store ?? new SettingsStore()
    this.#logger = logger ?? {}
    this.#log = log ?? new RequestLog()
    // Retention is a setting, so the log follows it without a reload.
    this.#log.setLimit(this.#store.read().settings.logLimit)
  }

  /** @returns {string} the provider route this adapter owns. */
  get providerId() {
    return ROUTER_PROVIDER
  }

  /** @returns {SettingsStore} the settings store this adapter reads. */
  get store() {
    return this.#store
  }

  /** @returns {RequestLog} the request log this adapter writes. */
  get requestLog() {
    return this.#log
  }

  /** @returns {string[]} ids currently advertised to the picker. */
  advertisedIds() {
    const { settings } = this.#store.read()
    return settings.tiers.filter(tier => tier.enabled).map(tier => tier.id)
  }

  /**
   * Describe the route. The name is the picker's group heading, so it says what
   * the group *is* rather than repeating a package name.
   * @param {string} provider - the registered route.
   * @returns {{id: string, name: string}} detached provider metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: 'Echelon' }
  }

  /**
   * Advertise the enabled tiers, in the user's order.
   *
   * An empty tier is advertised on purpose: it is the fresh-install state, and
   * hiding it would leave the picker with no entry to select and therefore no
   * way to discover that the router exists.
   * @param {string} provider - the registered route.
   * @returns {Promise<Array<object>>} tier models for the picker.
   */
  async listModels(provider) {
    const { settings } = this.#store.read()
    const llm = this.ctx?.llm
    const tiers = settings.tiers
      .slice()
      .sort((left, right) => left.order - right.order)
      .filter(tier => tier.enabled)
    return Promise.all(tiers.map(async tier => {
      // Advertise 'image' as soon as one member can see, mirroring the window
      // rule: claim what the chain can do, then route each request to a member
      // that can do it. A text-only advertisement here makes DSH flatten every
      // image before this adapter is ever consulted.
      const chain = tierChain(tier, this.#providers())
      const infos = await Promise.all(chain.map(member => this.#infoOf(llm, member)))
      return {
        provider,
        id: tier.id,
        name: tier.name,
        ...(settings.showTierDescriptions ? { description: describeTier(tier) } : {}),
        inputModalities: unionModalities(chain.map((member, index) => (member.seesImages === undefined ? infos[index]?.inputModalities : member))),
      }
    }))
  }

  /**
   * Resolve one tier's metadata.
   *
   * The context window is the *largest* input capacity among members: the
   * dispatcher then routes each request to a member that fits it (see
   * `routeByContext`). Reasoning levels are not capacity, though — they are a
   * vocabulary, so they come from the members' own declarations rather than
   * being intersected or invented (see `tierReasoning`).
   * @param {string} provider - the registered route.
   * @param {string} model - tier id.
   * @returns {Promise<object>} exact model info.
   */
  async resolveModel(provider, model) {
    const { settings } = this.#store.read()
    const tier = settings.tiers.find(candidate => candidate.id === model)
    const allModalities = () => unionModalities(chain.map((member, index) => (member.seesImages === undefined ? (infos[index] ?? member) : member)))
    const base = { provider, id: model, name: tier?.name ?? model, inputModalities: ['text'] }
    if (tier === undefined) {
      // Unknown ids still resolve, so a stored selection keeps rendering after
      // its tier was deleted; `stream` is where that failure is reported.
      return base
    }
    const chain = tierChain(tier, this.#providers())
    if (chain.length === 0) return base
    const infos = await Promise.all(chain.map(async member => {
      try {
        return await this.ctx?.llm?.resolveModelInfo?.(member.provider, member.model)
      } catch {
        return undefined
      }
    }))
    const usable = infos.filter(Boolean)
    if (usable.length === 0) return base
    // A member's own declared window replaces what its model reports: the user
    // may know their gateway truncates earlier than the model's headline number.
    const windows = chain.map((member, index) => member.contextWindow ?? usable[index]?.context?.contextWindow)
      .filter(window => Number.isInteger(window) && window > 0)
    const defaults = chain.map((member, index) => member.maxTokens ?? usable[index]?.defaultMaxTokens)
      .filter(tokens => Number.isSafeInteger(tokens) && tokens > 0)
    // What the picker shows depends on the mapping switch, because the two
    // modes mean different things:
    //
    // - mapping ON: the user picks from this plugin's fixed ladder and every
    //   selection is translated per member at dispatch. Showing the model's own
    //   names here would defeat the point — the vocabulary would change per tier
    //   and the switch would look like it did nothing.
    // - mapping OFF: no translation happens, so the menu must list exactly what
    //   the underlying model accepts, or a choice would be forwarded verbatim to
    //   an endpoint that cannot honour it.
    //
    // Both modes only ever advertise levels that some real member publishes, or
    // (mapping on) this plugin's ladder whose every rung is translated — the
    // fixed ladder is safe precisely because dispatch never forwards it as-is.
    const mapping = settings.effortMapping !== false
    const reasoning = tierReasoning(infos, chain, mapping)
    const offered = reasoning === undefined ? [] : reasoning.efforts.map(effort => effort.id)
    // A pinned default is expressed on the ladder. With mapping on the ladder is
    // what the picker shows, so the pin can be used as-is; with it off the pin
    // has to land on one of the levels *this* tier advertises, and the model's
    // own default takes over when it cannot.
    const pinned = settings.defaultEffort === undefined
      ? undefined
      : (mapping ? (offered.includes(settings.defaultEffort) ? settings.defaultEffort : undefined) : snapEffort(settings.defaultEffort, offered))
    const defaultEffort = pinned ?? reasoning?.defaultEffort
    const reported = reasoning === undefined
      ? undefined
      : { efforts: reasoning.efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
    return {
      ...base,
      inputModalities: allModalities(),
      ...(settings.showTierDescriptions ? { description: describeTier(tier) } : {}),
      // The tier advertises the LARGEST window in its chain, not the smallest.
      // Advertising the smallest would cap every request at the weakest member
      // and throw away the big model's capacity; the dispatcher instead picks a
      // member that can actually hold each request (see `orderByContext`), and
      // falls back to the roomiest member when none can.
      ...(windows.length === 0 ? {} : { context: { contextWindow: Math.max(...windows) } }),
      // Output is still the conservative number: a request may land on any
      // member, and claiming the largest output cap would overstate the floor.
      ...(defaults.length === 0 ? {} : { defaultMaxTokens: Math.min(...defaults) }),
      ...(reported === undefined ? {} : { reasoning: reported }),
    }
  }

  /**
   * Check which members of one tier resolve right now, and report what each one
   * declares about itself.
   *
   * The settings page needs the model's own numbers to offer a meaningful
   * override: a context window field pre-filled with "the model says 1M" is a
   * different decision from one pre-filled with 128K.
   * @param {object} tier - a normalized tier.
   * @returns {Promise<Array<{provider: string, model: string, ok: boolean, error?: string, contextWindow?: number, maxTokens?: number, efforts?: string[], defaultEffort?: string}>>} per-member results.
   */
  async probe(tier) {
    const chain = tierChain(tier, this.#providers())
    return Promise.all(chain.map(async member => {
      try {
        const info = await this.ctx?.llm?.resolveModelInfo?.(member.provider, member.model)
        if (info === undefined) return { provider: member.provider, model: member.model, ok: false, error: '无法解析' }
        return {
          provider: member.provider,
          model: member.model,
          ok: true,
          ...(info.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
          ...(info.inputModalities === undefined ? {} : { inputModalities: [...info.inputModalities] }),
          ...(info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens }),
          ...(info.reasoning === undefined ? {} : {
            efforts: info.reasoning.efforts.map(effort => effort.id),
            ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
          }),
        }
      } catch (error) {
        return { provider: member.provider, model: member.model, ok: false, error: describe(error) }
      }
    }))
  }

  /**
   * Resolve one member's metadata, briefly cached.
   *
   * Both the catalog surface and the dispatch path need `inputModalities` and
   * `context`, and neither can afford one metadata round-trip per member per
   * keystroke. The TTL is short on purpose: a gateway that starts advertising
   * vision should take effect within a turn or two, without a restart.
   *
   * The lookup is bounded. It runs *before* any attempt is logged, so a member
   * whose `resolveModelInfo` never settles hung the whole turn with nothing in
   * the log to explain it — the "几分钟没有任何输出、日志也是空的" report. A
   * timeout here is not an error: it degrades to "unknown capabilities", which
   * the router already handles (the member stays a candidate).
   * @param {object} llm - the live LLM service.
   * @param {{provider: string, model: string}} member - the member to resolve.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object | undefined>} model info, or undefined when unresolvable.
   */
  async #infoOf(llm, member, signal) {
    const key = `${member.provider}/${member.model}`
    const hit = this.#info.get(key)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < INFO_TTL_MS) return hit.info
    let info
    try {
      info = await withDeadline(
        Promise.resolve(llm.resolveModelInfo?.(member.provider, member.model, signal)),
        INFO_TIMEOUT_MS,
        () => `超过 ${Math.round(INFO_TIMEOUT_MS / 1000)} 秒没有查到模型能力`,
      )
    } catch {
      info = undefined
    }
    // An unresolvable member is cached too, so a dead route does not cost a
    // lookup on every single request.
    this.#info.set(key, { at: now, info })
    return info
  }

  /** Registered provider route ids, read through the live registry. */
  #providers() {
    try {
      return (this.ctx?.llm?.listProviders?.() ?? []).map(provider => provider.id)
    } catch {
      return []
    }
  }

  /**
   * Resolve each member's real context window and order the chain by fit.
   *
   * Windows are resolved per turn rather than cached: a gateway can change what
   * it advertises, and a stale window would route a large request into a small
   * model for the rest of the process's life. The resolution is bounded (one
   * `resolveModelInfo` per member).
   *
   * The same pass also attaches each member's advertised reasoning efforts,
   * because effort mapping needs them and a second lookup per attempt would
   * double the metadata calls for every turn.
   * @param {object} llm - the live LLM service.
  /**
   * The optional token meter, or undefined when the host has none.
   *
   * Must go through `ctx.get(...)`, not `ctx.tokenMeter`. Cordis guards service
   * property access with the plugin's `inject` list, so an undeclared read throws
   * `cannot get property "tokenMeter" without inject` — and because this runs on
   * the dispatch path, that error ended every turn instead of falling back to the
   * local heuristic. `get` is the explicit, unguarded accessor and returns
   * undefined when the service is absent, which is exactly the contract wanted:
   * the meter is an optimisation, never a requirement.
   * @returns {object | undefined} the meter service.
   */
  #meter() {
    try {
      return this.ctx?.get?.('tokenMeter')
    } catch {
      return undefined
    }
  }

  /**
   * Resolve each member's real context window and order the chain by fit.
   *
   * Windows are resolved per turn rather than cached: a gateway can change what
   * it advertises, and a stale window would route a large request into a small
   * model for the rest of the process's life. The resolution is bounded (one
   * `resolveModelInfo` per member).
   *
   * The same pass also attaches each member's advertised reasoning efforts,
   * because effort mapping needs them and a second lookup per attempt would
   * double the metadata calls for every turn.
   * @param {object} llm - the live LLM service.
   * @param {Array<object>} chain - the tier's dispatch chain.
   * @param {object} options - the request about to be dispatched.
   * @returns {Promise<{ordered: Array<object>, skipped: Array<object>, estimate: number, fits: boolean}>} routing decision.
   */
  async #routeByContext(llm, chain, options, strategy, modalityRouting, imageScope) {
    const estimate = estimateRequestTokens(options, this.#meter()).inputTokens
    // Even a single-member chain needs its efforts, for mapping.
    const resolved = new Map()
    await Promise.all(chain.map(async member => {
      const info = await this.#infoOf(llm, member, options.signal)
      // An unresolvable member keeps no metadata: `orderByContext` then treats
      // it as eligible and effort mapping forwards the request unchanged.
      if (info !== undefined) resolved.set(`${member.provider}/${member.model}`, info)
    }))
    const enriched = chain.map(member => {
      const info = resolved.get(`${member.provider}/${member.model}`)
      if (info === undefined) return member
      const window = member.contextWindow ?? info.context?.contextWindow
      return {
        ...member,
        ...(Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
        ...(info.reasoning?.efforts === undefined ? {} : { efforts: info.reasoning.efforts }),
        ...(info.inputModalities === undefined ? {} : { inputModalities: info.inputModalities }),
        ...(member.seesImages === undefined ? {} : { seesImages: member.seesImages }),
      }
    })
    // A request carrying an image must not land on a member DSH would flatten it
    // for: that is silent data loss, and it looks like the model "got dumber".
    const vision = requestHasImage(options, imageScope) && modalityRouting !== false
    const split = modalityRouting === false ? { usable: enriched, skipped: [] } : splitByModality(enriched, vision)
    if (split.usable.length === 0) {
      // No member can see. Proceed with the whole chain anyway: DSH projects the
      // image to text, so the turn still answers, and the log names the
      // limitation rather than pretending the image was understood.
      const ordered = chain.length === 1 ? enriched : orderByContext(enriched, estimate, undefined, { strategy, reserveOutput: options.maxTokens }).ordered
      return { ordered, skipped: [], blindSkipped: split.skipped, vision, estimate, fits: true, strategy, noVisionMember: true }
    }
    const skipped = split.skipped.map(member => ({ ...member, reason: 'NO_VISION' }))
    if (split.usable.length === 1) {
      return { ordered: split.usable, skipped, blindSkipped: [], vision, estimate, fits: true, strategy }
    }
    const decision = orderByContext(split.usable, estimate, undefined, { strategy, reserveOutput: options.maxTokens })
    return { ...decision, skipped: [...skipped, ...decision.skipped], blindSkipped: [], vision }
  }

  /**
   * Dispatch one tier down its chain.
   *
   * The member order is the user's order. Each member is tried up to
   * `attempts + 1` times while its failure looks transient; the first member
   * that produces visible output wins and the rest of the chain is untouched.
   * @param {object} options - generate options, already resolved by the runtime.
   * @returns {AsyncGenerator<object>} chunks ending in exactly one finish.
   */
  async *stream(options) {
    const { settings, error } = this.#store.read()
    const tier = settings.tiers.find(candidate => candidate.id === options.model)
    // Every rejection below is logged, because "my message failed" is exactly
    // the moment a user opens the log. A reason that never reached the log is
    // indistinguishable from the plugin being broken.
    const reject = (code, message) => {
      const turn = this.#log.begin({ tier: tier?.id ?? String(options.model), tierName: tier?.name ?? String(options.model) })
      turn.commit({ outcome: 'failed', message })
      return finishError(code, message)
    }
    if (tier === undefined) {
      yield reject('NO_ROUTE', `Echelon：挡位 “${String(options.model)}” 不存在。请在 设置 → Echelon 中重新创建或改选。`)
      return
    }
    if (tier.enabled === false) {
      yield reject('CONFIG_DISABLED', `Echelon：挡位 “${tier.name}” 已停用。`)
      return
    }
    const chain = tierChain(tier, this.#providers())
    if (chain.length === 0) {
      yield reject('NO_ROUTE', error === undefined
        ? `Echelon：挡位 “${tier.name}” 没有可用成员。请在 设置 → Echelon 中添加模型。`
        : `Echelon：${error}`)
      return
    }
    const llm = this.ctx?.llm
    if (llm === undefined) {
      yield reject('NO_ADAPTER', 'Echelon：LLM 服务不可用。')
      return
    }

    // Pick the members that can actually hold this request *before* dialling
    // any of them. A tier spans models with different windows, so the whole
    // point of advertising the largest one is that the dispatcher then routes by
    // size instead of letting a smaller member reject the prompt.
    const routed = await this.#routeByContext(llm, chain, options, tier.contextStrategy, settings.modalityRouting, settings.imageScope)

    const tried = []
    let budget = MAX_ATTEMPTS_PER_TURN
    // One log entry per turn, committed exactly once from whichever branch
    // settles it. It is also how the settings page answers "which model actually
    // served that turn", which the transcript cannot show for a tier.
    const turn = this.#log.begin({ tier: tier.id, tierName: tier.name })
    for (const skipped of routed.skipped) {
      // Recorded as its own attempt kind so the log explains the jump instead of
      // looking like the member was never configured. Two reasons are reported:
      // too small for the context, or unable to see the attached image.
      const blind = skipped.reason === 'NO_VISION'
      turn.attempt({
        provider: skipped.provider,
        model: skipped.model,
        attempt: 0,
        outcome: 'skipped',
        ...(blind ? { code: 'NO_VISION', message: '该成员不支持图像输入' } : {
          code: 'CONTEXT_TOO_SMALL',
          message: skipped.reserve === undefined || skipped.reserve === 0
            ? `需要 ${skipped.needed ?? routed.estimate} tokens，可用 ${skipped.usable} / 窗口 ${skipped.window}`
            : `需要 ${skipped.needed ?? routed.estimate} tokens，窗口 ${skipped.window}，输出预留 ${skipped.reserve}，只剩 ${skipped.usable}`,
        }),
      })
    }
    if (routed.noVisionMember === true) {
      this.#logger.warn?.(`model-router: tier "${tier.id}" has no image-capable member; the image will be flattened to text`)
      turn.attempt({
        provider: '—',
        model: '—',
        attempt: 0,
        outcome: 'skipped',
        code: 'NO_VISION_MEMBER',
        message: `挡位里没有支持图像的成员，图片会被降级成文字。可用成员：${routed.blindSkipped?.length ?? 0} 个都不行`,
      })
    }
    for (const member of routed.ordered) {
      const label = `${member.provider}/${member.model}`
      const attempts = Math.max(member.attempts, 0) + 1
      const idleTimeoutMs = member.idleTimeoutMs ?? settings.defaultIdleTimeoutMs
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (options.signal?.aborted === true) {
          turn.commit({ outcome: 'aborted', message: '请求已取消' })
          yield aborted('请求已取消')
          return
        }
        if (budget <= 0) {
          turn.commit({ outcome: 'exhausted', message: `超过单轮尝试上限 ${MAX_ATTEMPTS_PER_TURN}` })
          yield finishError('TRANSPORT', `Echelon：挡位 “${tier.name}” 尝试次数超过上限（${MAX_ATTEMPTS_PER_TURN}）。已尝试：${tried.join(' → ') || '无'}`)
          return
        }
        budget -= 1
        const startedAt = Date.now()
        // The attempt yields as it produces output, so this loop forwards the
        // answer live; `sink.verdict` tells us how it ended once it is over.
        const sink = {}
        for await (const chunk of this.#attempt(llm, member, options, idleTimeoutMs, settings.effortMapping !== false, sink)) {
          yield chunk
        }
        const outcome = sink.verdict ?? { kind: 'failed', code: 'TRANSPORT', message: '没有收到数据流' }
        if (outcome.kind === 'answer') {
          this.#logger.info?.(`model-router: tier "${tier.id}" answered with ${label}`)
          turn.attempt({
            provider: member.provider,
            model: member.model,
            attempt: attempt + 1,
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
            ...(sink.effort === undefined ? {} : { effort: sink.effort }),
          })
          turn.commit({
            outcome: 'ok',
            provider: member.provider,
            model: member.model,
            estimate: routed.estimate,
            // What the tier asked for versus what the member actually received.
            // The two differ whenever mapping translated the level, or dropped it
            // because the member publishes none — which is exactly the thing a
            // user opening the log is trying to find out.
            ...(sink.requested === undefined ? {} : { requestedEffort: sink.requested }),
            ...(sink.effort === undefined ? {} : { effort: sink.effort }),
            ...(sink.effortDropped === true ? { effortDropped: true } : {}),
            ...(routed.vision === true ? { vision: true } : {}),
            ...(Number.isFinite(member.contextWindow) ? { contextWindow: member.contextWindow } : {}),
            ...(outcome.usage === undefined ? {} : { usage: usageOf([outcome.usage]) }),
          })
          return
        }
        if (outcome.committed === true) {
          // Output already reached the reader, so failing over would print a
          // second answer on top of the first. Report the failure as terminal.
          turn.attempt({ provider: member.provider, model: member.model, attempt: attempt + 1, outcome: 'failover', ...(outcome.code === undefined ? {} : { code: outcome.code }), durationMs: Date.now() - startedAt, message: outcome.message ?? '流中断' })
          turn.commit({ outcome: 'failed', provider: member.provider, model: member.model, message: outcome.message ?? '输出中途失败' })
          yield finishError(outcome.code ?? 'TRANSPORT', `Echelon：挡位 “${tier.name}” 在输出过程中失败（${outcome.message ?? '未知原因'}）。已输出内容保留在上方。`)
          return
        }
        if (outcome.kind === 'aborted') {
          turn.attempt({ provider: member.provider, model: member.model, attempt: attempt + 1, outcome: 'aborted', durationMs: Date.now() - startedAt })
          turn.commit({ outcome: 'aborted', message: outcome.message ?? '请求已取消' })
          yield aborted(outcome.message ?? '请求已取消')
          return
        }
        const reason = outcome.message ?? outcome.code ?? '失败'
        this.#logger.warn?.(`model-router: tier "${tier.id}" member ${label} failed (attempt ${attempt + 1}/${attempts}): ${reason}`)
        const retryable = isRetryable(outcome.code) && attempt + 1 < attempts
        turn.attempt({
          provider: member.provider,
          model: member.model,
          attempt: attempt + 1,
          outcome: retryable ? 'retry' : 'failover',
          ...(outcome.code === undefined ? {} : { code: outcome.code }),
          durationMs: Date.now() - startedAt,
          message: reason,
        })
        if (!isRetryable(outcome.code)) {
          // Deterministic on this lane: retrying wastes the turn, but another
          // lane may still answer, so record it and keep walking the chain.
          tried.push(`${label} (${outcome.code ?? '失败'}：${reason})`)
          break
        }
        if (attempt + 1 < attempts) {
          await delay(retryDelay(attempt), options.signal)
          continue
        }
        tried.push(`${label} (${outcome.code ?? '失败'}：${reason})`)
      }
    }
    turn.commit({ outcome: 'failed', message: tried.join(' → ') || '无可用成员' })
    yield finishError('TRANSPORT', `Echelon：挡位 “${tier.name}” 的所有成员都失败了。已尝试：${tried.join(' → ') || '无'}`)
  }

  /**
   * Prepare and run one member attempt, normalized to a verdict.
   * @param {object} llm - the live LLM service.
   * @param {object} member - one dispatch-chain entry, carrying advertised `efforts`.
   * @param {object} options - the request.
   * @param {number} idleTimeoutMs - fail the attempt after this long with no data.
   * @param {boolean} mappingEnabled - translate the effort ladder onto this member.
   */
  async *#attempt(llm, member, options, idleTimeoutMs, mappingEnabled, sink) {
    // One controller per attempt, so a timeout can cancel the member's own
    // request instead of only walking away from it. DSH threads a signal into the
    // provider call, and cancelling is what unblocks a socket mid-read: without it
    // the attempt stops being *waited on* but the request keeps running, and the
    // cleanup that follows (`iterator.return()`) blocks on that very read.
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) controller.abort(options.signal.reason)
    else options.signal?.addEventListener?.('abort', forwardAbort, { once: true })
    const signal = controller.signal
    try {
      // Precedence for the effort: the member's own choice, then the tier's
      // default (already folded in by `tierChain`), then whatever the session
      // asked for. `maxTokens` follows the same shape, so an explicit budget on
      // a member also caps that member's request.
      const requested = member.reasoningEffort ?? options.reasoningEffort
      // Translation happens here, per member, because "high" means a different
      // id on every provider. The result is always an id this member publishes,
      // or undefined — never the requested name forwarded on a guess, because
      // DSH rejects an explicit effort the model does not declare. Mapping off is
      // the escape hatch for anyone who wants the raw value forwarded.
      const mapped = mappingEnabled ? mapEffort(requested, member.efforts) : { effort: requested }
      const effort = mapped.effort
      sink.requested = requested
      sink.effort = effort
      const maxTokens = member.maxTokens ?? options.maxTokens
      const controls = {
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
      }
      // The watchdog has to cover `prepareCall` too.
      //
      // `prepareCall` is where DSH resolves the member's capability and where an
      // adapter performs its own network work (a gateway that refreshes a token,
      // a catalog probe). It used to run with no deadline at all: the idle timer
      // started only once `stream()` was entered, so a member that hung here held
      // the turn open indefinitely — minutes of silence with no failover, which is
      // the "超时没拦截" report. The same budget applies because from the user's
      // point of view both halves are "the model is not answering".
      const prepared = await withDeadline(
        llm.prepareCall({ provider: member.provider, model: member.model, ...controls }, signal),
        idleTimeoutMs,
        () => `超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有准备好请求`,
      )
      // A prepared call validates that the dispatched options restate its own
      // resolved config, so the forwarded request carries the resolved values
      // rather than the tier's requested ones.
      const forwarded = {
        ...options,
        provider: member.provider,
        model: member.model,
        reasoningEffort: prepared.config.reasoningEffort,
        maxTokens: prepared.config.maxTokens,
        temperature: prepared.config.temperature,
        stop: prepared.config.stop,
      }
      // Record what the adapter actually resolved, which can differ from what was
      // asked for (a provider default materialized by `prepareCall`). "Requested
      // but not sent" is the interesting case: it means mapping had to drop the
      // level, and the member answered on its own default.
      const forwardedEffort = prepared.config.reasoningEffort
      sink.effort = forwardedEffort
      sink.effortDropped = requested !== undefined && forwardedEffort === undefined
      // Stream through: once this member commits, its output reaches the caller
      // as it is produced, so the harness can measure real latency and
      // throughput instead of a single burst at the end.
      for await (const chunk of streamMember(prepared.stream(forwarded), signal, idleTimeoutMs, sink, () => controller.abort())) {
        yield chunk
      }
    } catch (cause) {
      const code = codeOf(cause)
      sink.verdict = { kind: 'failed', message: describe(cause), ...(code === undefined ? {} : { code }) }
    } finally {
      options.signal?.removeEventListener?.('abort', forwardAbort)
    }
  }
}

/**
 * Whether one chunk proves the provider is still producing something.
 *
 * The distinction the watchdog needs: traffic is not progress. A gateway that
 * emits an empty delta every hundred milliseconds is "sending data" while the
 * user stares at a blank panel, and an earlier version of this function counted
 * those — it keyed off the chunk *type* alone, so a keepalive stream reset the
 * clock forever and a 90-second budget never fired. That is why the fix has to be
 * about payload, not shape.
 *
 * Rules, in order of how much they matter:
 *
 * - A delta counts only when it carries non-whitespace text. An empty string is a
 *   keepalive; one character is real work.
 * - A tool-call delta counts only when it carries a name or non-empty arguments,
 *   for the same reason.
 * - A block boundary counts, because it is a real protocol event that only
 *   happens when the model moves from one part of an answer to another.
 * - The terminal `finish` counts, so a completed turn is never mistaken for a
 *   stalled one.
 * - Reasoning counts as fully as prose: a model that thinks for ten minutes is
 *   producing deltas the whole time, and cheap models often answer in one
 *   `block-end` with lengthier thinking than text.
 *
 * @param {object} chunk - one stream chunk.
 * @returns {boolean} true when the chunk carries content.
 */
export function carriesProgress(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text.trim() !== ''
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '')
        || (typeof chunk.name === 'string' && chunk.name !== '')
    case 'block-start':
    case 'block-end':
    case 'finish':
      return true
    default:
      return false
  }
}

/** One terminal error chunk. */
function finishError(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

/** One terminal abort chunk. */
function aborted(message) {
  return { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message } } }
}

/**
 * The reasoning menu one tier should advertise.
 *
 * Two modes, two vocabularies — and one rule shared by both: a level that
 * reaches dispatch must be one the answering member publishes, or the call is
 * rejected before any provider I/O (`UNSUPPORTED_REASONING_EFFORT`).
 *
 * - **on** — this plugin's fixed ladder (`off/low/middle/high/xhigh`). Safe
 *   *because* every rung is translated per member at dispatch, so the picker can
 *   offer one stable vocabulary even when no two members agree on names. That is
 *   the entire point of the switch; without it the menu would churn per tier.
 *   A chain in which not one member declares levels advertises nothing: there is
 *   nothing to translate onto, so every rung would be dropped silently and the
 *   menu would be a row of settings that do nothing.
 * - **off** — nothing is translated, so the menu must be the members' own levels
 *   and nothing else. With several members that is the intersection; offering a
 *   level outside it would send a value the member cannot honour.
 *
 * @param {Array<object | undefined>} infos - resolved member metadata, aligned with `chain`.
 * @param {Array<object>} [chain] - dispatch chain, whose `reasoningEffort` overrides narrow a member.
 * @param {boolean} [mapping] - whether dispatch translates levels per member.
 * @returns {{efforts: Array<object>, defaultEffort?: string} | undefined} what to advertise, or undefined when the chain claims nothing.
 */
export function tierReasoning(infos, chain, mapping = true) {
  const pool = infos.flatMap(info => (Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []))
  const declared = infos.map(info => effortIds(info?.reasoning?.efforts))
  const advertised = declared.map((ids, index) => {
    const override = chain?.[index]?.reasoningEffort
    if (override === undefined) return ids
    // A member pinned to one level offers only that level: every other value
    // would be replaced at dispatch, so advertising it would lie.
    return ids.includes(override) ? [override] : []
  })

  if (mapping !== false) {
    // The ladder is the vocabulary here, so a member-level pin is a dispatch
    // detail: hiding the other rungs would leave the picker with one option.
    //
    // It is advertised even when no member declares anything. That is the whole
    // contract of this mode — "one stable set of names, translated underneath" —
    // and it is safe precisely because dispatch never forwards a rung as written:
    // a member that publishes nothing gets no effort at all and uses its own
    // default. Showing an empty menu instead would make the switch look broken
    // on exactly the gateways and free lanes where it is most useful.
    //
    // Start from the head member's own default expressed on the ladder, so a
    // fresh conversation opens on the level that model would have used anyway.
    const own = declared.reduce((found, ids, index) => (found === undefined && ids.length > 0 ? infos[index]?.reasoning?.defaultEffort : found), undefined)
    const onLadder = typeof own === 'string' ? mapEffort(own, EFFORT_IDS).effort : undefined
    const defaultEffort = onLadder !== undefined && EFFORT_IDS.includes(onLadder) ? onLadder : 'high'
    return { efforts: EFFORT_IDS.map(id => ({ id, name: id })), defaultEffort }
  }

  if (advertised.length === 0 || advertised.some(ids => ids.length === 0)) return undefined
  const [first, ...rest] = advertised
  const shared = first.filter(id => rest.every(ids => ids.includes(id)))
  if (shared.length === 0) return undefined
  const agreed = agreedDefault(infos)
  const defaultEffort = agreed !== undefined && shared.includes(agreed) ? agreed : shared[0]
  return { efforts: shared.map(id => copyOf(pool, id)), defaultEffort }
}

/**
 * The declared entry for one id, so names and descriptions survive.
 * @param {Array<object | string>} efforts - every declaration seen in the chain.
 * @param {string} id - the id to copy.
 * @returns {{id: string, name: string}} an entry DSH will accept.
 */
function copyOf(efforts, id) {
  const found = efforts.find(effort => (typeof effort === 'string' ? effort : effort?.id) === id)
  if (typeof found === 'string') return { id: found, name: found }
  // DSH rejects an effort without a non-empty name, so a bare `{id}` is not an
  // option here even though the id is what gets dispatched.
  if (found === undefined || typeof found.name !== 'string' || found.name === '') return { id, name: id }
  return { id, name: found.name, ...(typeof found.description === 'string' ? { description: found.description } : {}) }
}

/**
 * The default level every member agrees on, when they all publish one.
 * @param {Array<object | undefined>} infos - resolved member metadata.
 * @returns {string | undefined} the shared default, or undefined.
 */
function agreedDefault(infos) {
  const defaults = infos.map(info => info?.reasoning?.defaultEffort)
  if (defaults.length === 0 || defaults.some(value => typeof value !== 'string')) return undefined
  return defaults.every(value => value === defaults[0]) ? defaults[0] : undefined
}

/**
 * One-line summary of a tier for the picker: how many members, and which one
 * answers first. That is what a user picking a tier by feel needs to see.
 * @param {object} tier - normalized tier.
 * @returns {string} description text.
 */
export function describeTier(tier) {
  const active = tier.members.filter(member => member.enabled)
  if (active.length === 0) return '尚未添加成员，打开 设置 → Echelon 配置'
  const head = active[0]
  const tail = active.length > 1 ? ` → 备用 ${active.length - 1}` : ''
  const attempts = head.attempts > 0 ? ` · 重试 ${head.attempts} 次` : ''
  return `${head.provider}/${head.model}${tail}${attempts}`
}

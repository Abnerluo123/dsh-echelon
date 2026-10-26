/**
 * Router configuration: tiers, member chains, and the rules that turn stored
 * user input into something the adapter can dispatch.
 *
 * Everything here is pure. Storage, HTTP, and the LLM adapter all import this
 * module, so a malformed settings file can only ever produce a dropped field —
 * never a dispatch to a route the user did not choose.
 *
 * Vocabulary
 * ----------
 * - **member**: one `<provider>/<model>` pair plus its own retry budget and
 *   idle timeout — the unit the chain walks.
 * - **tier**: a named, ordered list of members. This is the *only* thing the
 *   model picker shows, so a tier name is what the user picks by feel.
 * - **exposure**: whether the picker also lists the underlying provider models
 *   (`all`), lists none of them (`tiers`), or hides just the listed ones
 *   (`custom`).
 *
 * @module src/config.js
 */

/** Provider route this plugin owns. Never equal to another plugin's route. */
export const ROUTER_PROVIDER = 'model-router'

/** Id of the built-in auto tier. */
export const AUTO_TIER_ID = 'auto'

/** Ceiling on members per tier: a longer chain is latency, not safety. */
export const MAX_MEMBERS = 32

/** Ceiling on tiers, so the picker stays navigable. */
export const MAX_TIERS = 24

/** Ceiling on a tier's display name length. */
export const MAX_TIER_NAME = 48

/** Ceiling on extra attempts per member. */
export const MAX_ATTEMPTS = 5

/** Default extra attempts per member when the row does not say. */
export const DEFAULT_ATTEMPTS = 1

/** Default idle timeout per attempt, in milliseconds. `0` disables it. */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000

/** Accepted range for an idle timeout: 5s … 10min, or 0 for "wait forever". */
export const MIN_IDLE_TIMEOUT_MS = 5_000
export const MAX_IDLE_TIMEOUT_MS = 600_000

/**
 * Token budgets a member may declare: context window and output cap.
 *
 * Both are *overrides of what the model reports*, so the floor is high enough to
 * be meaningful and the ceiling is generous enough for a 1M-window model. A tier
 * reports the strictest value across its members, so an override here can only
 * make the tier more conservative than its models already are — never less.
 */
export const MIN_TOKEN_BUDGET = 1_024
export const MAX_TOKEN_BUDGET = 4_000_000

/** Request-log retention. Bounded so a long-running host cannot grow forever. */
export const DEFAULT_LOG_LIMIT = 200
export const MIN_LOG_LIMIT = 20
export const MAX_LOG_LIMIT = 2_000

/**
 * Backoff base for retrying one member, in milliseconds. Doubles per attempt
 * and is capped by {@link MAX_BACKOFF_MS}. Deliberately short: a rate-limited
 * lane will not recover inside a chat turn, so a long wait only delays the
 * failover that would have worked.
 */
export const BASE_BACKOFF_MS = 400
export const MAX_BACKOFF_MS = 4_000

/**
 * Failure codes worth retrying on the same member. Everything else — auth,
 * quota, a malformed request — is deterministic on that lane, so a retry only
 * burns the turn while another lane could have answered.
 */
export const RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'UNKNOWN',
])

/** Failure codes that must end the turn rather than fail over. */
export const TERMINAL_CODES = Object.freeze(['ABORTED', 'CONTEXT_WINDOW_EXCEEDED'])

/** Exposure modes, most-to-least hidden. */
export const EXPOSURE_MODES = Object.freeze(['tiers', 'custom', 'all'])

const TIER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/

/**
 * Normalize free text into a stable tier id.
 * Non-Latin names still need an identity that survives a reload, so they keep a
 * short hash suffix rather than collapsing to an empty slug.
 * @param {unknown} raw - proposed id or display name.
 * @returns {string} an id matching {@link TIER_ID_PATTERN}, or `''`.
 */
export function tierIdOf(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '') return ''
  const slug = text.replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  if (slug !== '' && !/[^\x20-\x7e]/.test(text)) return slug
  return `${slug || 'tier'}-${hash32(text)}`
}

/** Small deterministic hash, used only to disambiguate non-ASCII ids. */
function hash32(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * Thought level for a member or a tier.
 *
 * The adapter-defined effort ids are opaque strings (`low`, `high`, `max`,
 * `off`, …), so this is a pass-through with one tri-state meaning:
 *   - `undefined` — follow whatever the session asked for (the default),
 *   - `'off'`     — explicitly no reasoning,
 *   - any string  — that exact effort, validated against the model at dispatch.
 */
export const EFFORT_FOLLOW = undefined

/** Special stored value meaning "explicitly disable reasoning". */
export const EFFORT_OFF = 'off'

/**
 * Coerce one stored member.
 * Returns `undefined` when the row cannot name a real route: half a route is not
 * a fallback, it is a guaranteed failure at dispatch time.
 * @param {unknown} raw - a stored member row.
 * @returns {{provider: string, model: string, attempts: number, idleTimeoutMs: number, contextWindow?: number, maxTokens?: number, enabled: boolean, reasoningEffort?: string} | undefined}
 */
export function normalizeMember(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '' || provider === ROUTER_PROVIDER) return undefined
  const attempts = Number(raw.attempts)
  const timeout = Number(raw.idleTimeoutMs)
  const reasoningEffort = typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim() !== ''
    ? raw.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    attempts: Number.isFinite(attempts) ? clamp(Math.trunc(attempts), 0, MAX_ATTEMPTS) : DEFAULT_ATTEMPTS,
    idleTimeoutMs: Number.isFinite(timeout)
      ? (timeout === 0 ? 0 : clamp(Math.trunc(timeout), MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS))
      : DEFAULT_IDLE_TIMEOUT_MS,
    ...tokenBudget('contextWindow', raw.contextWindow),
    ...tokenBudget('maxTokens', raw.maxTokens),
    enabled: raw.enabled !== false,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/**
 * Coerce an optional token budget override.
 *
 * `undefined` means "use whatever the model reports", which is the only honest
 * default: a number here is a *declaration about a model the plugin does not
 * own*, so it is clamped to a sane range rather than trusted.
 * @param {'contextWindow' | 'maxTokens'} key - the field being read.
 * @param {unknown} value - stored value.
 * @returns {object} either `{}` or a one-key patch.
 */
function tokenBudget(key, value) {
  const parsed = Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(parsed)) return {}
  return { [key]: clamp(Math.trunc(parsed), MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET) }
}

/** Clamp a number into an inclusive range. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Drop duplicate members by route, keeping the first occurrence so the user's
 * ordering intent wins over an accidental re-add.
 * @param {Array<object>} members - normalized members.
 * @returns {Array<object>} deduplicated members in original order.
 */
export function dedupeMembers(members) {
  const seen = new Set()
  const out = []
  for (const member of members) {
    const key = `${member.provider}\u0000${member.model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(member)
  }
  return out
}

/**
 * Coerce one stored tier.
 * A tier with no usable member row is dropped rather than kept as a menu entry
 * that cannot answer; disabled members are *kept* so the settings page can offer
 * the toggle back, and are filtered out of dispatch by {@link tierChain}.
 * @param {unknown} raw - a stored tier row.
 * @param {number} index - position, used for a stable order when absent.
 * @returns {{id: string, name: string, enabled: boolean, order: number, members: Array<object>, reasoningEffort?: string, contextWindow?: number, maxTokens?: number} | undefined}
 */
export function normalizeTier(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const name = String(raw.name ?? '').trim().slice(0, MAX_TIER_NAME)
  const id = TIER_ID_PATTERN.test(String(raw.id ?? '')) ? String(raw.id) : tierIdOf(raw.id ?? name)
  if (id === '' || id === ROUTER_PROVIDER) return undefined
  const rows = Array.isArray(raw.members) ? raw.members : []
  const members = dedupeMembers(rows.map(normalizeMember).filter(Boolean)).slice(0, MAX_MEMBERS)
  if (members.length === 0) return undefined
  const reasoningEffort = typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim() !== ''
    ? raw.reasoningEffort.trim()
    : undefined
  return {
    id,
    name: name === '' ? id : name,
    enabled: raw.enabled !== false,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    members,
    // Tier-level defaults: a member may override either of them, and an
    // undefined value means "ask the model / follow the session".
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...tokenBudget('contextWindow', raw.contextWindow),
    ...tokenBudget('maxTokens', raw.maxTokens),
  }
}

/**
 * Coerce one stored hide rule.
 * A bare `<provider>` hides a whole picker group; `<provider>/<model>` hides one
 * entry. Both match literally, never as a pattern.
 * @param {unknown} raw - a stored hide row.
 * @returns {{target: string, enabled: boolean} | undefined}
 */
export function normalizeHide(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const target = String(raw.target ?? '').trim()
  if (target === '' || target.split('/')[0] === ROUTER_PROVIDER) return undefined
  return { target, enabled: raw.enabled !== false }
}

/**
 * Coerce a whole stored settings document.
 *
 * Every field is user input that survived a JSON file, so nothing is trusted:
 * unknown keys are dropped, out-of-range numbers are clamped, unusable rows
 * disappear. The result is always usable — an empty document yields the default
 * auto tier, never an empty menu.
 * @param {unknown} raw - parsed settings document, possibly missing or corrupt.
 * @returns {{version: number, exposure: string, tiers: Array<object>, hide: Array<object>, defaultIdleTimeoutMs: number, showTierDescriptions: boolean}}
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const seen = new Set()
  const tiers = []
  for (const [index, row] of (Array.isArray(source.tiers) ? source.tiers : []).entries()) {
    const tier = normalizeTier(row, index)
    if (tier === undefined || seen.has(tier.id)) continue
    seen.add(tier.id)
    tiers.push(tier)
  }
  // The picker needs at least one entry that names the feature, and `auto` is
  // the name the rest of the system already knows. A settings page that deletes
  // every tier therefore leaves a working menu rather than an empty one.
  if (tiers.length === 0) tiers.push(defaultAutoTier())
  // Order before capping: when a document is over the limit, the tiers the user
  // put first are the ones that survive, not whichever happened to be written
  // first in the array.
  tiers.sort((left, right) => left.order - right.order)
  const kept = tiers.slice(0, MAX_TIERS)
  for (const [index, tier] of kept.entries()) tier.order = index
  const hide = []
  const seenHide = new Set()
  for (const row of Array.isArray(source.hide) ? source.hide : []) {
    const rule = normalizeHide(row)
    if (rule === undefined || seenHide.has(rule.target)) continue
    seenHide.add(rule.target)
    hide.push(rule)
  }

  const timeout = Number(source.defaultIdleTimeoutMs)
  const logLimit = Number(source.logLimit)
  return {
    version: 3,
    exposure: EXPOSURE_MODES.includes(source.exposure) ? source.exposure : 'tiers',
    tiers: kept,
    hide,
    defaultIdleTimeoutMs: Number.isFinite(timeout)
      ? (timeout === 0 ? 0 : clamp(Math.trunc(timeout), MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS))
      : DEFAULT_IDLE_TIMEOUT_MS,
    showTierDescriptions: source.showTierDescriptions !== false,
    // Request log: kept in memory by default (survives a reload of the settings
    // page, not a restart) and bounded so a long-running harness cannot grow it
    // without limit.
    logRequests: source.logRequests !== false,
    logLimit: Number.isFinite(logLimit) ? clamp(Math.trunc(logLimit), MIN_LOG_LIMIT, MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT,
    // Effort auto-mapping: translate the plugin's five words onto whatever each
    // model calls its levels. On by default because without it a tier mixing
    // models with different vocabularies can only offer levels they share —
    // often none at all.
    effortMapping: source.effortMapping !== false,
  }
}

/**
 * The shipped default tier: one name, no members.
 * An empty chain is honest — the settings page says so, and the exposure
 * interlock keeps the stock menu intact until the user adds a member.
 * @returns {object} the default tier row.
 */
export function defaultAutoTier() {
  return { id: AUTO_TIER_ID, name: 'Auto', enabled: true, order: 0, members: [] }
}

/**
 * Whether a route is hidden by the current rules.
 *
 * `tiers` hides every stock model *only when at least one tier can actually
 * dispatch*. Without that interlock a fresh install ships as `exposure: tiers`
 * with an empty default tier, which hides the whole menu and leaves the user
 * unable to select anything at all. The interlock is what keeps that state
 * recoverable from the picker instead of only from settings.
 * @param {{provider: string, model: string}} route - a real provider/model pair.
 * @param {object} settings - normalized settings.
 * @param {Iterable<string>} [available] - provider names the registry knows.
 * @returns {boolean} true when the stock picker must not offer this route.
 */
export function isHidden(route, settings, available) {
  if (route.provider === ROUTER_PROVIDER) return false
  if (settings.exposure === 'all') return false
  if (settings.exposure === 'tiers') return exposureHidesStock(settings, available)
  const pair = `${route.provider}/${route.model}`
  return settings.hide.some(rule => rule.enabled && (rule.target === route.provider || rule.target === pair))
}

/**
 * Whether exposure may actually hide the stock models.
 *
 * `tiers` hides everything but the tiers, which is the point of the plugin — but
 * it must never be honoured while no tier can dispatch, or the picker would offer
 * nothing at all and the user would have no way back in from the GUI.
 * @param {object} settings - normalized settings.
 * @param {Iterable<string>} [available] - provider routes the registry knows.
 * @returns {boolean} true when the stock models are to be hidden.
 */
export function exposureHidesStock(settings, available) {
  if (settings.exposure === 'all') return false
  if (settings.exposure === 'custom') return true
  return settings.tiers.some(tier => tier.enabled && tierChain(tier, available).length > 0)
}

/**
 * Expand one tier into its ordered dispatch chain.
 *
 * Unresolvable members are dropped here rather than at dispatch: a chain that
 * reports "tried three candidates" for a turn where only one route existed is
 * lying to the user in the one place they look when things break.
 *
 * Each entry carries its *effective* controls, with the member's own value
 * winning over the tier's default. Keeping that resolution here — rather than in
 * the adapter — means the settings page and the dispatcher can never disagree
 * about which effort or budget a member will actually use.
 * @param {object} tier - a normalized tier.
 * @param {Iterable<string>} [available] - provider names the registry knows.
 * @returns {Array<{provider: string, model: string, attempts: number, idleTimeoutMs: number, reasoningEffort?: string, contextWindow?: number, maxTokens?: number}>} dispatch chain.
 */
export function tierChain(tier, available) {
  if (!tier || tier.enabled === false) return []
  const known = available === undefined ? undefined : new Set(available)
  return tier.members
    .filter(member => member.enabled)
    .filter(member => known === undefined || known.has(member.provider))
    .map(member => {
      const reasoningEffort = member.reasoningEffort ?? tier.reasoningEffort
      const contextWindow = member.contextWindow ?? tier.contextWindow
      const maxTokens = member.maxTokens ?? tier.maxTokens
      return {
        provider: member.provider,
        model: member.model,
        attempts: member.attempts,
        idleTimeoutMs: member.idleTimeoutMs,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }
    })
}

/**
 * Order a chain for one request's context size.
 *
 * The rule is the user's rule: keep the chain order (which encodes cheap-first,
 * strong-later), but never hand a request to a member that cannot hold it. The
 * first *fitting* member in order therefore wins, and members skipped for size
 * are reported separately so the request log can explain the jump.
 *
 * When nothing fits, the largest window in the chain is tried anyway: the
 * provider's own rejection is more informative than a synthetic one, and a
 * slightly optimistic estimate should not lose a turn that would have worked.
 * @param {Array<object>} chain - dispatch chain, each entry optionally carrying a resolved `contextWindow`.
 * @param {number} inputTokens - estimated input size of the request.
 * @param {(member: object) => number | undefined} [windowOf] - resolves a member's window when the entry does not carry one.
 * @returns {{ordered: Array<object>, skipped: Array<{provider: string, model: string, window: number, usable: number}>, estimate: number, fits: boolean}} the reordered chain and what was skipped.
 */
export function orderByContext(chain, inputTokens, windowOf) {
  const fits = []
  const skipped = []
  for (const member of chain) {
    const window = member.contextWindow ?? (windowOf === undefined ? undefined : windowOf(member))
    if (!Number.isFinite(window) || window <= 0) {
      // An unknown window is not evidence of a small one.
      fits.push(member)
      continue
    }
    const reserve = member.maxTokens
    const usable = Math.max(window - Math.max(Math.ceil(window * 0.02), 512) - (Number.isFinite(reserve) ? reserve : 0), 0)
    if (inputTokens <= usable) {
      fits.push(member)
      continue
    }
    skipped.push({ provider: member.provider, model: member.model, window, usable })
  }
  if (fits.length > 0) return { ordered: fits, skipped, estimate: inputTokens, fits: true }

  // Nothing holds it. Try the roomiest member so the failure is the provider's
  // real one rather than a guess, but keep the skip list for the log.
  let biggest
  let biggestWindow = -1
  for (const member of chain) {
    const window = member.contextWindow ?? (windowOf === undefined ? undefined : windowOf(member))
    if (Number.isFinite(window) && window > biggestWindow) {
      biggestWindow = window
      biggest = member
    }
  }
  return {
    ordered: biggest === undefined ? chain : [biggest],
    skipped,
    estimate: inputTokens,
    fits: false,
  }
}

/**
 * Backoff before one retry of the same member.
 * @param {number} attempt - 0-based attempt index that just failed.
 * @returns {number} milliseconds to wait.
 */
export function retryDelay(attempt) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempt, 0), MAX_BACKOFF_MS)
}

/**
 * Whether a failure can be answered by retrying the same member.
 * @param {string | undefined} code - provider-neutral failure code.
 * @returns {boolean} true when a retry is worth the latency.
 */
export function isRetryable(code) {
  if (typeof code !== 'string') return true
  if (TERMINAL_CODES.includes(code)) return false
  return RETRYABLE_CODES.includes(code)
}

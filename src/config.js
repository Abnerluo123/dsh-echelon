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

/**
 * Levels a user may pick as the default for a new conversation.
 *
 * Mirrors the ladder in `src/effort.js`. Declared here so this module stays the
 * dependency-free floor: settings normalization must not import the routing layer.
 */
export const DEFAULT_EFFORT_CHOICES = Object.freeze(['off', 'low', 'middle', 'high', 'xhigh'])

/** Ceiling on tiers, so the picker stays navigable. */
export const MAX_TIERS = 24

/** Ceiling on a tier's display name length. */
export const MAX_TIER_NAME = 48

/** Ceiling on extra attempts per member. */
export const MAX_ATTEMPTS = 5

/** Default extra attempts per member when the row does not say. */
export const DEFAULT_ATTEMPTS = 1

/**
 * Default idle timeout per attempt, in milliseconds. `0` disables it.
 *
 * Six seconds, and the ceiling is sixty. DSH retries a failed turn itself, and a
 * retry is more efficient than waiting: a lane that has produced nothing in six
 * seconds is usually gone, while a lane that is merely slow will still answer on
 * the next attempt. Waiting two minutes to reach the same conclusion only costs
 * the user two minutes.
 *
 * The floor is two seconds because the panel allows it, not because it is a good
 * idea for every member — a big model behind a queue needs more.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 6_000

/** Accepted range for an idle timeout: 3s … 60s, or 0 for "wait forever". */
export const MIN_IDLE_TIMEOUT_MS = 3_000
export const MAX_IDLE_TIMEOUT_MS = 60_000

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

/**
 * Multipliers for the short forms a person types: `128k`, `1m`.
 *
 * Deliberately decimal, because that is what people mean when they type them and
 * what a round display value has to read back as. `1m` is 1,000,000 and `128k` is
 * 128,000 — matching the number a provider advertises in prose, and matching what
 * the field shows, so typing what you see never silently changes the value.
 *
 * A model whose real window is 1,048,576 is stored as that exact number and shown
 * as `1m`; reading it back as 1,000,000 is the one accepted rounding, and it is
 * the direction a user expects (a slightly conservative override, never a larger
 * one than the model claims).
 */
const TOKEN_UNITS = Object.freeze({ '': 1, k: 1_000, m: 1_000_000 })

/**
 * Parse a token budget written by hand: `131072`, `128k`, `1m`, `1.5m`.
 * @param {unknown} raw - the typed text.
 * @returns {number | undefined} whole tokens, or undefined when unusable.
 */
export function parseTokenBudget(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined
  if (typeof raw !== 'string') return undefined
  // `128 k` and `128K` are the same intention as `128k`.
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(raw)
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = (match[2] ?? '').toLowerCase()
  return Math.round(amount * TOKEN_UNITS[unit])
}

/**
 * Render a token budget the way a person would say it: `1m`, `256k`, `128k`.
 *
 * Two rules, and the order matters:
 *
 * 1. an exact multiple keeps its own value, so `128000` is `128k` and reads back
 *    unchanged;
 * 2. anything else is a binary number a model actually reports (131072, 262144,
 *    1048576) and is shown on the decimal scale a reader thinks in — `131k`,
 *    `262k`, `1m`. The field must never fall back to a digit string, because
 *    "stop making me count zeros" is the entire reason this exists.
 *
 * The cost of rule 2 is a rounding of at most half a k when the shown text is
 * typed back in. That is the right trade: a context override that is 0.4% shy of
 * the model's headline number changes nothing, while `1048576` in a text box is
 * unreadable.
 * @param {number | undefined} value - stored tokens.
 * @returns {string} text for the field, or '' when unset.
 */
export function formatTokenBudget(value) {
  if (!Number.isFinite(value) || value <= 0) return ''
  const tokens = Math.round(value)
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`
  // An exact thousand keeps its own digits: 128000 is `128k`, not `131k`.
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`
  // A binary number from a provider, shown on the decimal scale.
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`
  }
  return String(tokens)
}

/**
 * Request-log retention. Bounded so a long-running host cannot grow forever.
 *
 * The log is now persisted, so this is the number of turns kept *across restarts*
 * rather than in memory. 128 is about a working day of turns: enough to look up
 * the failure you just had, small enough that the file stays trivial.
 */
export const DEFAULT_LOG_LIMIT = 128
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
 *
 * Timeout and retries are stored as `undefined` when the row does not say, so a
 * tier default can fill them in later (see {@link tierChain}). Materialising the
 * global default here instead — which is what this used to do — made the tier
 * default unreachable: every member already had a number, so there was never a
 * gap for it to fill.
 * @param {unknown} raw - a stored member row.
 * @returns {{provider: string, model: string, attempts?: number, idleTimeoutMs?: number, contextWindow?: number, maxTokens?: number, enabled: boolean, reasoningEffort?: string} | undefined}
 */
export function normalizeMember(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : ''
  if (provider === '' || model === '' || provider === ROUTER_PROVIDER) return undefined
  const reasoningEffort = typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim() !== ''
    ? raw.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    ...memberAttempts(raw.attempts),
    ...memberTimeout(raw.idleTimeoutMs),
    ...tokenBudget('contextWindow', raw.contextWindow),
    ...tokenBudget('maxTokens', raw.maxTokens),
    enabled: raw.enabled !== false,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    // Tri-state vision override: undefined = trust the adapter, true/false =
    // the user says this model can/cannot see. Needed because several gateways
    // support images without ever disclosing inputModalities, and guessing wrong
    // in either direction is expensive: claiming vision sends images to an
    // endpoint that may reject them, denying it flattens images the model could
    // have read.
    ...(typeof raw.seesImages === 'boolean' ? { seesImages: raw.seesImages } : {}),
  }
}

/**
 * Read a member's retry count, keeping "unset" distinct from "zero".
 * @param {unknown} raw - stored value.
 * @returns {object} either `{}` or `{attempts}`.
 */
function memberAttempts(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return {}
  return { attempts: clamp(Math.trunc(parsed), 0, MAX_ATTEMPTS) }
}

/**
 * Read a member's idle timeout, keeping "unset" distinct from `0` (no limit).
 * @param {unknown} raw - stored value.
 * @returns {object} either `{}` or `{idleTimeoutMs}`.
 */
function memberTimeout(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return {}
  if (parsed === 0) return { idleTimeoutMs: 0 }
  return { idleTimeoutMs: clamp(Math.trunc(parsed), MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS) }
}

/**
 * Coerce an optional token budget override.
 *
 * `undefined` means "use whatever the model reports", which is the only honest
 * default: a number here is a *declaration about a model the plugin does not
 * own*, so it is clamped to a sane range rather than trusted.
 *
 * Accepts `"128k"` / `"1m"` as well as a number, so a hand-edited settings file
 * can be written the way the UI shows it instead of in raw digits.
 * @param {'contextWindow' | 'maxTokens'} key - the field being read.
 * @param {unknown} value - stored value.
 * @returns {object} either `{}` or a one-key patch.
 */
function tokenBudget(key, value) {
  if (value === undefined || value === null || value === '') return {}
  const parsed = parseTokenBudget(value)
  if (parsed === undefined) return {}
  return { [key]: clamp(parsed, MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET) }
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
    ...tierTimeout(raw.idleTimeoutMs),
    ...tierAttempts(raw.attempts),
    ...(CONTEXT_STRATEGIES.includes(raw.contextStrategy) && raw.contextStrategy !== DEFAULT_CONTEXT_STRATEGY
      ? { contextStrategy: raw.contextStrategy }
      : {}),
  }
}

/**
 * Coerce a tier-level idle timeout.
 *
 * `undefined` means "no tier default": every member then keeps its own value, and
 * a member that does not set one follows the global default. `0` is also stored
 * as undefined rather than as "no limit" — at the tier level, `0` is the panel's
 * way of saying "use whatever the tier default says", so a tier cannot express
 * "wait forever" on behalf of its members. Only a member can do that, which
 * keeps one obvious place to disable the watchdog.
 * @param {unknown} raw - stored value.
 * @returns {object} either `{}` or `{idleTimeoutMs}`.
 */
function tierTimeout(raw) {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return {}
  return { idleTimeoutMs: clamp(Math.trunc(parsed), MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS) }
}

/**
 * Coerce a tier-level retry count.
 *
 * Same `0`-means-inherit rule as {@link tierTimeout}: the tier default is a
 * default, so clearing it must fall back to the member's own value instead of
 * silently turning retries off for the whole chain.
 * @param {unknown} raw - stored value.
 * @returns {object} either `{}` or `{attempts}`.
 */
function tierAttempts(raw) {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return {}
  return { attempts: clamp(Math.trunc(parsed), 0, MAX_ATTEMPTS) }
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
    // A fresh install shows everything. Hiding is a deliberate step a user takes
    // after they have built a working tier; defaulting to "tiers only" made a new
    // user's entire model list disappear the moment they installed the plugin,
    // with nothing on screen explaining where it went.
    exposure: EXPOSURE_MODES.includes(source.exposure) ? source.exposure : 'all',
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
    // Default reasoning level for a new conversation. Unset means "whatever the
    // model itself defaults to", which is the only value that is always valid for
    // every tier; a chosen level is mapped onto each tier's own list before it is
    // advertised, so the picker never shows a level it does not offer.
    defaultEffort: DEFAULT_EFFORT_CHOICES.includes(source.defaultEffort) ? source.defaultEffort : undefined,
    // Image routing: when a request carries an image, prefer a member that can
    // actually see it. Off means "keep chain order even if the image gets
    // flattened to text", which is only sensible for debugging.
    modalityRouting: source.modalityRouting !== false,
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
      // Timeout and retries follow the same "member wins, tier fills the gap"
      // shape as the budgets above. The distinction that matters: a member's own
      // `0` is a real value ("no limit", "no retry") and must survive the merge,
      // while a tier-level `0` was already normalized away into "no default", so
      // `??` never confuses the two.
      const idleTimeoutMs = member.idleTimeoutMs ?? tier.idleTimeoutMs
      const attempts = member.attempts ?? tier.attempts
      return {
        provider: member.provider,
        model: member.model,
        attempts,
        idleTimeoutMs,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(member.seesImages === undefined ? {} : { seesImages: member.seesImages }),
      }
    })
}

/**
 * How a tier picks among the members that can hold the current request.
 *
 * - `order` — the first fitting member in the user's chain order. Predictable,
 *   and the right default: the chain already encodes "cheap first, strong later".
 * - `roomy` — the fitting member with the most free space. Costs nothing extra
 *   (it still only considers members that fit) but trades chain order for
 *   headroom: useful when a long session must not be squeezed into a model that
 *   has barely enough room, because that is where truncation and forced
 *   mid-conversation switches come from.
 */
export const CONTEXT_STRATEGIES = Object.freeze(['order', 'roomy'])

/** The shipped strategy: keep the user's order. */
export const DEFAULT_CONTEXT_STRATEGY = 'order'

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
 * @param {{strategy?: string, reserveOutput?: number}} [options] - selection policy.
 * @returns {{ordered: Array<object>, skipped: Array<{provider: string, model: string, window: number, usable: number}>, estimate: number, fits: boolean, strategy: string}} the reordered chain and what was skipped.
 */
export function orderByContext(chain, inputTokens, windowOf, options = {}) {
  const strategy = CONTEXT_STRATEGIES.includes(options.strategy) ? options.strategy : DEFAULT_CONTEXT_STRATEGY
  const fits = []
  const skipped = []
  const usableOf = member => {
    const window = member.contextWindow ?? (windowOf === undefined ? undefined : windowOf(member))
    if (!Number.isFinite(window) || window <= 0) return undefined
    const reserve = member.maxTokens ?? options.reserveOutput
    const safety = Math.max(Math.ceil(window * 0.02), 512)
    const kept = Number.isFinite(reserve) ? reserve : 0
    return { window, reserve: kept, safety, usable: Math.max(window - safety - kept, 0) }
  }
  for (const member of chain) {
    const room = usableOf(member)
    if (room === undefined) {
      // An unknown window is not evidence of a small one.
      fits.push(member)
      continue
    }
    if (inputTokens <= room.usable) {
      fits.push(member)
      continue
    }
    skipped.push({ provider: member.provider, model: member.model, window: room.window, usable: room.usable, reserve: room.reserve, needed: inputTokens })
  }
  if (fits.length > 0) {
    const ordered = strategy === 'roomy' ? byHeadroom(fits, usableOf) : fits
    return { ordered, skipped, estimate: inputTokens, fits: true, strategy }
  }

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
    strategy,
  }
}

/**
 * Sort fitting members by free space, most first.
 *
 * Members whose window is unknown keep their relative position ahead of the
 * ranked ones: nothing proved them small, and demoting them would make the
 * strategy surprise anyone whose provider does not report a window.
 * A stable tie keeps the user's order for equal capacity.
 * @param {Array<object>} members - members that fit.
 * @param {(member: object) => {window: number, usable: number} | undefined} usableOf - room measurement.
 * @returns {Array<object>} members, roomiest first.
 */
function byHeadroom(members, usableOf) {
  const ranked = members.map((member, index) => ({ member, index, room: usableOf(member) }))
  ranked.sort((left, right) => {
    const leftRoom = left.room === undefined ? Infinity : left.room.usable
    const rightRoom = right.room === undefined ? Infinity : right.room.usable
    if (leftRoom !== rightRoom) return rightRoom - leftRoom
    return left.index - right.index
  })
  return ranked.map(entry => entry.member)
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


/**
 * Whether a member can accept an image: yes, no, or unknown.
 *
 * "Unknown" is its own answer and the distinction matters. DSH only flattens
 * images for a model that explicitly declares a set **without** `image`; a model
 * that declares nothing receives the image untouched. So an undeclared member is
 * not evidence that it cannot see — and treating it as such was exactly the bug
 * that made a real vision model report "I can't see your image": the tier
 * advertised text-only, so DSH replaced the image with a placeholder before the
 * router ever chose a member.
 *
 * **A forced `seesImages: true` cannot beat an explicit text-only declaration.**
 * Flattening is decided inside DSH from the dispatched member's own
 * `inputModalities` (`dsh-llm`, `adapterStream`), which this plugin cannot
 * override. Believing the override here would route an image to a member that is
 * guaranteed to receive a placeholder — the second way the model ends up saying
 * it cannot see a picture that is plainly attached. The override therefore only
 * takes effect where it can work: a member that declares nothing at all.
 * @param {object} member - chain entry, optionally carrying `seesImages`.
 * @returns {true | false | undefined} true = declares/forced vision, false = explicitly text-only, undefined = not disclosed.
 */
export function visionOf(member) {
  const declared = member?.inputModalities
  const declaredTextOnly = Array.isArray(declared) && !declared.includes('image')
  if (member?.seesImages === true) return declaredTextOnly ? false : true
  if (member?.seesImages === false) return false
  if (!Array.isArray(declared)) return undefined
  return declared.includes('image')
}

/**
 * Whether a member is known to be unable to see.
 * @param {object} member - chain entry.
 * @returns {boolean} true only when the model said so (or the user forced it).
 */
export function seesImages(member) {
  return visionOf(member) === true
}

/**
 * Split a chain by whether its members can see images.
 *
 * Only applied when the request actually contains one: a text-only request must
 * not start preferring vision models, because that would reorder the chain for
 * every ordinary turn.
 *
 * Candidates are ordered confirmed-vision first, then undisclosed. A member that
 * explicitly declared text-only is dropped, because DSH would flatten the image
 * for it and the user would get an answer about a picture nobody looked at.
 * @param {Array<object>} chain - dispatch chain, entries carrying `inputModalities`.
 * @param {boolean} needsImage - whether the request contains an image.
 * @returns {{usable: Array<object>, skipped: Array<{provider: string, model: string}>}} ordered candidates and the members that cannot see.
 */
export function splitByModality(chain, needsImage) {
  if (needsImage !== true) return { usable: chain, skipped: [] }
  const sure = []
  const unknown = []
  const skipped = []
  for (const member of chain) {
    const vision = visionOf(member)
    if (vision === true) sure.push(member)
    else if (vision === false) skipped.push({ provider: member.provider, model: member.model })
    else unknown.push(member)
  }
  // Confirmed vision wins; undisclosed members are still worth trying, because
  // DSH forwards the image to them rather than flattening it.
  return { usable: [...sure, ...unknown], skipped }
}

/**
 * The input modalities a tier should advertise.
 *
 * Image is claimed unless **every** member explicitly declared text-only. A tier
 * that under-claims is the worst case: DSH flattens images before dispatch, so a
 * chain full of vision models answers "I cannot see images". Undisclosed members
 * count as a reason to claim, because DSH passes images to them untouched.
 * @param {Array<unknown>} entries - modality lists, or chain members carrying an override.
 * @returns {string[]} `['text']`, or `['text', 'image']` when vision cannot be ruled out.
 */
export function unionModalities(entries) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return ['text']
  const canSee = list.some(entry => {
    // Entries are usually chain members; a raw modality list is also accepted.
    const subject = entry !== null && typeof entry === 'object' && !Array.isArray(entry) && ('seesImages' in entry || 'inputModalities' in entry)
      ? entry
      : { inputModalities: entry }
    return visionOf(subject) !== false
  })
  return canSee ? ['text', 'image'] : ['text']
}

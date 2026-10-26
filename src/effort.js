/**
 * Mapping the user's reasoning-effort vocabulary onto whatever a model calls its
 * own levels.
 *
 * Every adapter names its levels differently: one ships `minimal/low/medium/high`,
 * another `off/low/high/max`, a third only `default/high`, and a fourth (a free
 * lane behind a gateway) declares nothing at all. A tier that has to intersect
 * those sets ends up offering nothing, which is why a tier's effort menu could
 * come up empty apart from "follow session".
 *
 * So the plugin owns one vocabulary and translates at dispatch:
 *
 *     off  <  low  <  middle  <  high  <  xhigh
 *
 * The user thinks in those five words. For each attempt the requested level is
 * translated to the nearest level the actual member advertises, preferring an
 * exact match, then the closest rank, then the higher of two equally close
 * levels (a tier asking for `high` on a model that only knows
 * `medium`/`xhigh` should not silently get the cheap one).
 *
 * Two rules keep this honest:
 *
 * - **Unknown support passes through unchanged.** When a model declares no
 *   levels, the request is forwarded as written. Guessing here would replace a
 *   provider's own default with an invented one.
 * - **Mapping only translates inside the ladder.** A name the ladder does not
 *   recognise is forwarded as written too, so a gateway that invents `turbo`
 *   still works when the user types `turbo`.
 *
 * @module src/effort.js
 */

/**
 * The canonical ladder, weakest first.
 *
 * `rank` is the only thing that matters for comparison; `id` is what gets stored
 * in settings and shown in the UI.
 */
export const EFFORT_LADDER = Object.freeze([
  { id: 'off', rank: 0 },
  { id: 'low', rank: 1 },
  { id: 'middle', rank: 2 },
  { id: 'high', rank: 3 },
  { id: 'xhigh', rank: 4 },
])

/** Ladder ids, in display order (strongest first, matching most providers). */
export const EFFORT_IDS = Object.freeze(['off', 'low', 'middle', 'high', 'xhigh'])

/**
 * Spellings that mean one of the five ranks.
 *
 * Deliberately generous: this is the translation table for other people's
 * vocabulary, so `mid`, `medium`, `balanced` and `default` all land on `middle`.
 * A provider that uses `auto` to mean "you decide" is closer to middle than to
 * any extreme.
 */
const ALIASES = Object.freeze({
  off: 0, none: 0, no: 0, disabled: 0, disable: 0, zero: 0, false: 0,
  low: 1, lowest: 1, lower: 1, min: 1, minimal: 1, light: 1, fast: 1, small: 1,
  middle: 2, mid: 2, medium: 2, normal: 2, standard: 2, balanced: 2, default: 2, auto: 2, moderate: 2,
  high: 3, higher: 3, strong: 3, deep: 3, thinking: 3,
  xhigh: 4, xh: 4, extrahigh: 4, max: 4, maximum: 4, highest: 4, ultra: 4, extreme: 4, insane: 4,
})

/**
 * Normalise an effort id for lookup: lower-case, letters and digits only.
 * `x-high`, `XHigh` and `x_high` are the same word for this purpose.
 * @param {unknown} value - raw effort id.
 * @returns {string} a lookup key, or '' when there is nothing usable.
 */
function keyOf(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : ''
}

/**
 * The ladder rank an effort id belongs to.
 * @param {unknown} value - raw effort id, in any spelling.
 * @returns {number | undefined} 0…4, or undefined when the name is not on the ladder.
 */
export function rankOf(value) {
  const key = keyOf(value)
  if (key === '') return undefined
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : undefined
}

/**
 * Read the effort ids out of whatever shape a model advertises.
 * @param {unknown} efforts - `[{id}]`, `['low']`, or undefined.
 * @returns {string[]} usable ids in the original order.
 */
export function effortIds(efforts) {
  if (!Array.isArray(efforts)) return []
  const ids = []
  for (const effort of efforts) {
    const id = typeof effort === 'string' ? effort : effort?.id
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Translate one requested level into a level the member actually supports.
 *
 * @param {string | undefined} requested - what the user chose, in any spelling.
 * @param {unknown} supported - the member's advertised efforts, or undefined when unknown.
 * @returns {{effort: string | undefined, mapped: boolean, reason: string}} the level to send, and whether it was translated.
 */
export function mapEffort(requested, supported) {
  if (requested === undefined) return { effort: undefined, mapped: false, reason: 'follow-session' }
  const ids = effortIds(supported)
  if (ids.length === 0) {
    // Nothing to translate against: forward the request untouched rather than
    // replacing the provider's default with a guess.
    return { effort: requested, mapped: false, reason: 'unknown-support' }
  }
  if (ids.includes(requested)) return { effort: requested, mapped: false, reason: 'exact' }

  const wanted = rankOf(requested)
  if (wanted === undefined) {
    // A name outside the ladder belongs to the provider's own vocabulary; only
    // an exact match could be honoured, and there was none.
    return { effort: requested, mapped: false, reason: 'foreign-name' }
  }

  let best
  let bestRank
  let bestDistance = Infinity
  for (const id of ids) {
    const rank = rankOf(id)
    if (rank === undefined) continue
    const distance = Math.abs(rank - wanted)
    // Ties go to the stronger level: a request for `high` must not quietly land
    // on the cheaper of two equally close options.
    if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
      best = id
      bestRank = rank
      bestDistance = distance
    }
  }
  if (best === undefined) return { effort: requested, mapped: false, reason: 'no-ladder-match' }
  return { effort: best, mapped: best !== requested, reason: bestDistance === 0 ? 'same-rank' : 'nearest-rank' }
}

/**
 * The effort menu one tier should offer.
 *
 * Always the whole ladder, plus any extra ids the members declare that the ladder
 * does not recognise — so a gateway with its own names stays usable, and the five
 * canonical words are always available regardless of what the models call things.
 * @param {Iterable<string>} [declared] - effort ids collected from the tier's members.
 * @returns {Array<{id: string, label?: string}>} options for a `<select>`.
 */
export function effortOptions(declared) {
  const seen = new Set(EFFORT_IDS)
  const extra = []
  for (const id of effortIds(declared === undefined ? [] : [...declared])) {
    if (seen.has(id)) continue
    seen.add(id)
    extra.push(id)
  }
  return [...EFFORT_IDS.map(id => ({ id })), ...extra.map(id => ({ id }))]
}

/**
 * Whether a set of member effort lists can honour the whole ladder.
 *
 * Used by the picker's advertised efforts: with mapping on, a tier can offer every
 * rung as long as at least one member declares something rankable.
 * @param {Array<unknown>} lists - one advertised-effort list per member.
 * @returns {boolean} true when mapping can translate the ladder onto the members.
 */
export function supportsLadder(lists) {
  return lists.some(list => effortIds(list).some(id => rankOf(id) !== undefined))
}

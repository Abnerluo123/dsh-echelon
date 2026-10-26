/**
 * Mapping the user's reasoning-effort vocabulary onto whatever a model calls its
 * own levels.
 *
 * Every adapter names its levels differently: one ships `minimal/low/medium/high`,
 * another `off/low/high/max`, a third only `default/high`, and a fourth (a free
 * lane behind a gateway) declares nothing at all. A tier that had to intersect
 * those sets ends up offering nothing, which is why a tier's effort menu could
 * come up empty apart from "follow session".
 *
 * The menu itself comes from the models (see `tierReasoning` in `src/adapter.js`);
 * this module only *translates* a level onto the member that is about to be
 * dispatched:
 *
 *     off  <  low  <  middle  <  high  <  xhigh
 *
 * That ladder is a comparison scale, not a vocabulary to advertise. A requested
 * level is translated to the nearest level the actual member publishes,
 * preferring an exact match, then the closest rank, then the higher of two
 * equally close levels (a tier asking for `high` on a model that only knows
 * `medium`/`xhigh` should not silently get the cheap one).
 *
 * One rule keeps that safe, and it is not negotiable:
 *
 * - **The result is either a level the member publishes, or nothing.** DSH
 *   validates an explicit effort before any provider I/O and rejects a value the
 *   model does not declare (`UNSUPPORTED_REASONING_EFFORT`) — it never clamps or
 *   aliases. So forwarding an unknown name is not "leaving the provider's default
 *   alone", it is a guaranteed failed call. When there is nothing to translate
 *   against, the level is dropped and the member answers with its own default.
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

/** The rank that means "reasoning off". A switch, not the bottom rung. */
export const OFF_RANK = 0

/**
 * Spellings that mean one of the five ranks.
 *
 * Deliberately generous: this is the translation table for other people's
 * vocabulary, so `mid`, `medium`, `balanced` and `default` all land on `middle`.
 * A provider that uses `auto` to mean "you decide" is closer to middle than to
 * any extreme.
 *
 * `on` is a real name in the wild — a gateway with a binary thinking toggle
 * declares exactly `off`/`on` — and it means "thinking, at whatever the provider
 * calls normal", so it ranks with the strength levels rather than being unknown.
 */
const ALIASES = Object.freeze({
  off: 0, none: 0, no: 0, disabled: 0, disable: 0, zero: 0, false: 0,
  low: 1, lowest: 1, lower: 1, min: 1, minimal: 1, light: 1, fast: 1, small: 1,
  middle: 2, mid: 2, medium: 2, normal: 2, standard: 2, balanced: 2, default: 2, auto: 2, moderate: 2,
  high: 3, higher: 3, strong: 3, deep: 3, thinking: 3,
  on: 3, enabled: 3, true: 3,
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
 * Translate one requested level into a level the member actually publishes.
 *
 * The return value is always safe to hand to `prepareCall`: either the id is one
 * of the member's advertised ids, or the effort is `undefined` and the member
 * applies its own default.
 *
 * **`off` is a switch, not the bottom rung.** Treating it as rank 0 on one
 * shared scale produced the worst possible translation: a member that publishes
 * only `off`/`on` (a gateway with a binary thinking toggle) turned a request for
 * `high` into `off`, because `off` was the only rankable neighbour. Asking for
 * hard thinking and silently getting none is worse than sending nothing at all,
 * so the two halves of the scale never translate into each other:
 *
 * - a request to *disable* reasoning only ever lands on a level that means
 *   "off"; if the member cannot switch reasoning off, the request is dropped and
 *   the model keeps its default (cheapest possible lane, honestly reported);
 * - a request for *some* strength never lands on an "off" level. If the member
 *   offers nothing but `off`, the request is dropped rather than honoured
 *   backwards.
 *
 * @param {string | undefined} requested - what the user chose, in any spelling.
 * @param {unknown} supported - the member's advertised efforts, or undefined when unknown.
 * @returns {{effort: string | undefined, mapped: boolean, reason: string}} the level to send, and whether it was translated.
 */
export function mapEffort(requested, supported) {
  if (requested === undefined) return { effort: undefined, mapped: false, reason: 'follow-session' }
  const ids = effortIds(supported)
  if (ids.length === 0) {
    // The member publishes no levels at all, so DSH would reject any explicit
    // effort for it. Drop the request and let the model use its own default.
    return { effort: undefined, mapped: true, reason: 'unknown-support' }
  }
  if (ids.includes(requested)) return { effort: requested, mapped: false, reason: 'exact' }

  const wanted = rankOf(requested)
  if (wanted === undefined) {
    // A name outside the ladder is the provider's own vocabulary. It can only be
    // honoured by an exact match, which there was not: sending it anyway would
    // fail validation on this member.
    return { effort: undefined, mapped: true, reason: 'foreign-name' }
  }

  const wantOff = wanted === OFF_RANK
  let best
  let bestRank
  let bestDistance = Infinity
  for (const id of ids) {
    const rank = rankOf(id)
    if (rank === undefined) continue
    // Never cross the on/off boundary in either direction.
    if ((rank === OFF_RANK) !== wantOff) continue
    const distance = Math.abs(rank - wanted)
    // Ties go to the stronger level: a request for `high` must not quietly land
    // on the cheaper of two equally close options.
    if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
      best = id
      bestRank = rank
      bestDistance = distance
    }
  }
  if (best === undefined) {
    // No level on the requested side of the switch. Dropping is the only honest
    // answer: the alternatives are "reasoning off when it was wanted" or "a name
    // this member rejects".
    return { effort: undefined, mapped: true, reason: wantOff ? 'cannot-disable' : 'no-thinking-level' }
  }
  return { effort: best, mapped: best !== requested, reason: bestDistance === 0 ? 'same-rank' : 'nearest-rank' }
}

/**
 * The canonical level nearest to `wanted` among `ids`, or undefined.
 *
 * Used when the user pinned a default for new conversations: the pin is expressed
 * on the ladder, and each tier has to advertise one of *its* levels instead.
 * @param {string} wanted - a ladder id (or any spelling of one).
 * @param {Iterable<string>} ids - levels the tier advertises.
 * @returns {string | undefined} a declared id, or undefined when nothing matches.
 */
export function snapEffort(wanted, ids) {
  const list = effortIds([...ids])
  if (list.length === 0) return undefined
  const result = mapEffort(wanted, list).effort
  return result !== undefined && list.includes(result) ? result : undefined
}

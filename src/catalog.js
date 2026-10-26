/**
 * Hiding the underlying models from the model picker.
 *
 * DSH has no catalog-filter hook: the GUI's model menu, `/model`, the picker's
 * "is this selection routable" check, and every plugin that renders a model
 * dropdown all read one path — `ctx.llm.listModels(provider)` — and the
 * provider-grouped catalog built from it. So the only way to hide a model
 * without patching DSH is to wrap that single public read on the live `llm`
 * service instance.
 *
 * What that buys and what it costs
 * --------------------------------
 * - Hiding filters *presentation and selection*, never dispatch. A member hidden
 *   from the menu is still reachable by a tier, because a tier dispatches
 *   through `prepareCall` and never consults `listModels`. This is the property
 *   that makes "only my tiers are visible" work at all.
 * - `sessionController.selectModel` validates a choice with the same read, so a
 *   hidden model can no longer be *selected* — including from a session that
 *   saved it earlier. That is the intended meaning of hiding, and the settings
 *   page says so next to the toggle.
 * - Because the filter is presentation-level, a failure inside it degrades to
 *   "nothing hidden" rather than a broken menu. Every entry point is wrapped.
 *
 * The wrapper is installed once per plugin fiber and removed on dispose, leaving
 * the prototype method the service shipped with.
 *
 * @module src/catalog.js
 */

import { ROUTER_PROVIDER, isHidden } from './config.js'

/** Marks a wrapped method so a second install is a no-op instead of a double wrap. */
const WRAPPED = Symbol.for('dsh-model-router.listModels')

/**
 * Holds the pre-wrap function, so the plugin can still read the *unfiltered*
 * catalog for its own editors.
 *
 * This matters: hiding is meant to shape the model picker, but the plugin's own
 * "add member" dialog must keep offering every real model — otherwise enabling
 * "hide everything" locks the user out of adding the very models being hidden,
 * and the only way back is to turn hiding off. The plain `listModels` cannot be
 * used for that read, because it is the filtered one by then.
 */
const ORIGINAL = Symbol.for('dsh-model-router.unfiltered')

/**
 * Read one provider's catalog as the adapter advertises it, ignoring hiding.
 * @param {object} llm - the `llm` service instance.
 * @param {string} provider - provider route id.
 * @returns {Promise<Array<object>>} every model, hidden or not.
 */
export async function listUnfiltered(llm, provider) {
  const read = llm?.listModels
  if (typeof read !== 'function') return []
  const original = read[ORIGINAL]
  return typeof original === 'function' ? original.call(llm, provider) : read.call(llm, provider)
}

/**
 * Install the catalog filter on a live `LlmRuntime`.
 *
 * @param {object} llm - the `llm` service instance.
 * @param {() => object} readSettings - returns the current normalized settings.
 * @returns {() => void} disposer restoring the original method.
 */
export function installCatalogFilter(llm, readSettings) {
  if (llm === null || typeof llm !== 'object') return () => {}
  const existing = llm.listModels
  if (typeof existing !== 'function') return () => {}
  if (existing[WRAPPED] === true) {
    // Another router instance already owns the read. Its own disposer restores
    // the prototype method, so this one must not stack a second wrapper on top.
    return () => {}
  }

  // The interlock needs to know which provider routes actually exist, so the
  // filter can tell "hide everything" from "hide everything and leave the user
  // with an empty menu". Read lazily, per call: a route may register later.
  const available = () => {
    try {
      return (llm.listProviders?.() ?? []).map(provider => provider.id)
    } catch {
      return []
    }
  }

  const wrapped = async function listModels(provider) {
    const models = await existing.call(this, provider)
    if (provider === ROUTER_PROVIDER) return models
    return filterModels(models, readSettings(), available())
  }
  // Async function identity does not survive a bind, so the marker goes on the
  // wrapper itself; `apply`/`call` are used above to keep the receiver intact.
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false })
  // Keep the unfiltered read reachable for the plugin's own editors.
  Object.defineProperty(wrapped, ORIGINAL, { value: existing, enumerable: false })
  Object.defineProperty(wrapped, 'name', { value: 'listModels', configurable: true })

  llm.listModels = wrapped
  return () => {
    if (llm.listModels === wrapped) llm.listModels = existing
  }
}

/**
 * Drop hidden models from one provider's advertised catalog.
 * Failures are contained: a settings read that throws leaves the list intact,
 * because an empty menu is a much worse outcome than an unfiltered one.
 * @param {Array<object>} models - adapter-advertised models for one provider.
 * @param {object} settings - normalized settings.
 * @param {Iterable<string>} [available] - provider routes the registry knows.
 * @returns {Array<object>} the models the picker may show.
 */
export function filterModels(models, settings, available) {
  if (!Array.isArray(models) || models.length === 0) return models
  let hidden
  try {
    hidden = models.filter(model => isHidden({ provider: model?.provider, model: model?.id }, settings, available))
  } catch {
    return models
  }
  if (hidden.length === 0) return models
  return models.filter(model => !hidden.includes(model))
}

/**
 * Count how many models the current rules hide, for the settings page's
 * "you are hiding N models" summary.
 * @param {Array<{id: string, models: Array<{id: string, name?: string}>}>} groups - provider-grouped catalog.
 * @param {object} settings - normalized settings.
 * @param {Iterable<string>} [available] - provider routes the registry knows.
 * @returns {{hidden: number, total: number, sample: string[]}} summary counts and a few hidden names.
 */
export function hiddenSummary(groups, settings, available) {
  let hidden = 0
  let total = 0
  const sample = []
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const model of Array.isArray(group?.models) ? group.models : []) {
      total += 1
      if (!isHidden({ provider: group.id, model: model.id }, settings, available)) continue
      hidden += 1
      if (sample.length < 6) sample.push(`${group.id}/${model.id}`)
    }
  }
  return { hidden, total, sample }
}

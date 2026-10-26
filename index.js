/**
 * dsh-model-router — Host half.
 *
 * Registers one provider route (`model-router`) whose models are the user's
 * named tiers, wires the settings API on the web server, and optionally hides
 * the underlying provider models from the picker so the tier list is the whole
 * menu.
 *
 * The three pieces are deliberately independent fibers:
 *
 * - the **adapter** needs only `llm`, so model routing works on any kernel line;
 * - the **catalog filter** needs only the live `llm` instance;
 * - the **settings API** needs `webServer`, so a headless composition keeps
 *   routing traffic even though it serves no page.
 *
 * Nothing here patches DSH: the adapter is registered through the public
 * registry, and the filter wraps one public read method on the service instance
 * rather than its prototype.
 *
 * @module dsh-model-router
 */
import { RouterAdapter } from './src/adapter.js'
import { installCatalogFilter, listUnfiltered } from './src/catalog.js'
import { ROUTER_PROVIDER, exposureHidesStock } from './src/config.js'
import { API_PREFIX, createHandler } from './src/http.js'
import { RequestLog } from './src/log.js'
import { SettingsStore } from './src/store.js'

export const name = 'model-router'

/**
 * `llm` is the only hard requirement. `webServer` and `connection` are read
 * lazily/injected separately so their absence never blocks model routing.
 */
export const inject = ['llm']

/**
 * Mount the router.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger ?? {}
  const store = new SettingsStore(undefined, { log: message => logger.warn?.(message) })
  // One log per plugin generation, shared by the adapter that writes it and the
  // settings API that reads it.
  const log = new RequestLog({ limit: store.read().settings.logLimit })
  const adapter = new RouterAdapter({ store, logger, log })

  // Adopting the live `llm` service is what lets `resolveModel`/`probe` reach
  // sibling routes; `LlmAdapter` has no constructor hook for it.
  adapter.ctx = ctx

  const registration = ctx.llm.registerAdapter([ROUTER_PROVIDER], adapter)
  ctx.effect(() => () => registration(), 'model-router: adapter route')

  // The picker only needs to learn about these entries; the settings page
  // requests a fresh read itself.
  ctx.llm.registerConfigurableProviders?.([{
    provider: ROUTER_PROVIDER,
    displayName: '模型路由',
    settingsNs: name,
    settingsPath: [],
  }])

  // Keep one disposer for the catalog filter so an HMR reload restores the
  // method it wrapped instead of stacking wrappers.
  ctx.effect(() => {
    const dispose = installCatalogFilter(ctx.llm, () => store.read().settings)
    return () => dispose()
  }, 'model-router: catalog filter')

  // Hiding the stock models changes what the picker offers, and the picker only
  // re-reads its catalog when the registry announces a change. Announce on a
  // save (immediately) and on a hand edit (picked up by the same mtime poll the
  // store uses for reads), so an edit is visible without a page reload.
  let lastSignature
  const announce = () => {
    const { settings } = store.read()
    const signature = JSON.stringify([
      settings.exposure,
      settings.tiers.map(tier => [tier.id, tier.enabled, tier.members.length]),
      settings.hide.map(rule => [rule.target, rule.enabled]),
    ])
    if (signature === lastSignature) return
    lastSignature = signature
    try {
      // `emitAdaptersUpdated` is the registry's own notification; going through
      // it keeps the client's existing refresh path authoritative.
      ctx.llm.emitAdaptersUpdated?.()
    } catch {
      // A failed notification only delays the menu refresh.
    }
  }
  ctx.effect(() => store.subscribe(announce), 'model-router: catalog notifications')
  // A settings write goes through the serialized store, so the subscription
  // above fires on the very next read. This second trigger covers a write made
  // by a hand edit while the process is otherwise idle.
  ctx.effect(() => {
    const timer = setInterval(() => store.read(), 3_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'model-router: settings watch')

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    const handler = createHandler({
      store,
      adapter,
      catalog: () => liveCatalog(ctx),
      connection: () => {
        try {
          return ctx.get('connection')
        } catch {
          return undefined
        }
      },
      logger,
    })
    scoped.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler }), 'model-router: api routes')
    logger.info?.(`model-router: settings API mounted at ${API_PREFIX}`)
  })
}

/** Provider route ids currently registered, or an empty list when the registry is unavailable. */
function providerIds(ctx) {
  try {
    return (ctx.llm?.listProviders?.() ?? []).map(provider => provider.id)
  } catch {
    return []
  }
}

/** Whether the current rules would leave the picker empty; drives the settings warning. */
export function stockMenuWouldBeEmpty(ctx, settings) {
  return !exposureHidesStock(settings, providerIds(ctx))
}

/**
 * The provider-grouped catalog of *real* models, as the settings page sees it.
 *
 * Read **unfiltered**: hiding shapes the model picker, but this list feeds the
 * member editor, which must be able to offer a model that is currently hidden —
 * otherwise "show only my tiers" makes the other models unaddable, and the user
 * has to disable hiding before they can build the tier that hiding depends on.
 *
 * This plugin's own route is excluded, because a tier list whose editor offered
 * tiers as members would let a user build a cycle through the UI.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<Array<{id: string, name: string, models: Array<object>}>>} groups for the editor.
 */
async function liveCatalog(ctx) {
  const llm = ctx.llm
  if (llm === undefined) return []
  const providers = llm.listProviders().filter(provider => provider.id !== ROUTER_PROVIDER)
  const groups = await Promise.all(providers.map(async provider => {
    try {
      const models = await listUnfiltered(llm, provider.id)
      const resolved = await Promise.all(models.map(async model => {
        try {
          const info = await llm.resolveModelInfo(provider.id, model.id)
          return {
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }),
            ...(info.reasoning === undefined ? {} : { efforts: info.reasoning.efforts.map(effort => effort.id) }),
          }
        } catch {
          return { id: model.id, name: model.name }
        }
      }))
      return { id: provider.id, name: provider.name, models: resolved }
    } catch (error) {
      // A provider that cannot answer is reported as an empty group so the
      // settings page can still show the route and its diagnostic.
      return { id: provider.id, name: provider.name, models: [], error: String(error) }
    }
  }))
  return groups.filter(group => group.models.length > 0 || group.error !== undefined)
}

export { ROUTER_PROVIDER }

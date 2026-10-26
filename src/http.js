/**
 * The settings surface over HTTP, consumed by this plugin's own browser half.
 *
 * Why plain same-origin routes instead of a typed Remote service: the client
 * half only needs JSON in and JSON out, and the `webServer` prefix route is the
 * one seam every DSH kernel line this plugin targets actually serves. It also
 * keeps the settings page working when the connection service is replaced.
 *
 * Security boundary: a prefix route longer than `/api` outranks the kernel's own
 * dispatch, so this handler re-applies the same trust decision the kernel would
 * have applied, using the mounted `connection` service when there is one and a
 * structural loopback/origin check when there is not.
 *
 * @module src/http.js
 */

/** Fixed marker every route sits under. */
export const API_PREFIX = '/api/model-router'

/** Largest settings body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024

/** Hostnames a same-machine browser can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/**
 * Decide whether a request may use this plugin's routes.
 *
 * Order matters: the composition's own admission is authoritative when present,
 * because it also carries the browser-auth cookie check. The structural replica
 * exists only for compositions that mount no connection service.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {object|undefined} connection - the mounted `connection` service, if any.
 * @returns {number|undefined} HTTP status to reject with, or undefined to allow.
 */
export function rejectionFor(req, connection) {
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      return status
    }
    const older = connection?.requestRejection
    if (typeof older === 'function') {
      const status = older.call(connection, req)
      if (status === undefined) return undefined
      return status
    }
  } catch {
    // A mounted service that throws must never be read as "allowed".
    return 503
  }
  return structuralRejection(req)
}

/**
 * The replica fence: loopback Host header, no cross-site fetch, matching Origin.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {number|undefined} 403 when the request is not a trusted local page.
 */
export function structuralRejection(req) {
  const host = authority(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    // The desktop shell relays loopback requests from its own `dsh-app://app`
    // page and strips the browser markers on the way; that Referer is the app's
    // own page, not a foreign origin.
    if (header === 'referer' && isDesktopAppReferer(raw)) continue
    const origin = authority(raw.trim())
    if (origin === null) return 403
    if (origin.hostname !== host.hostname || origin.port !== host.port || origin.scheme !== host.scheme) return 403
  }
  return undefined
}

/** @returns {boolean} true for the desktop shell's own application page. */
function isDesktopAppReferer(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''
  } catch {
    return false
  }
}

/** Split an authority value into scheme, hostname and port. */
function authority(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/** Read a JSON object body with a byte ceiling. */
async function readJson(req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) throw new HttpError(415, '需要 application/json')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return value
}

/** An error carrying the status code to answer with. */
export class HttpError extends Error {
  /** @param {number} status - HTTP status to answer with. @param {string} message - user-facing text. */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Write a JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Build the route handler.
 *
 * @param {object} deps - wiring supplied by the plugin entry.
 * @param {import('./store.js').SettingsStore} deps.store - settings storage.
 * @param {object} deps.adapter - the router adapter, for live diagnostics.
 * @param {() => object[]} deps.catalog - provider-grouped catalog of real models.
 * @param {() => object|undefined} deps.connection - the mounted connection service, read per request.
 * @param {object} [deps.logger] - Cordis logger.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler(deps) {
  const { store, adapter, catalog, connection, logger } = deps
  return async function handler(req, res) {
    const rejection = rejectionFor(req, connection?.())
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        error: rejection === 401 ? '未登录' : rejection === 503 ? '连接服务不可用' : '来源不受信任',
      })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = stripPrefix(url.pathname)
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET' && routePath === '/state') {
        const { settings, error } = store.read()
        // `catalog` is async: awaiting it here is not optional. A Promise method
        // serialized by `JSON.stringify` becomes `{}`, which reaches the page as
        // a truthy non-array and throws on the first `.map` — a blank panel with
        // nothing in the console to explain it.
        let groups
        try {
          groups = await catalog()
        } catch (cause) {
          logger?.warn?.(`model-router: catalog read failed: ${String(cause)}`)
          groups = []
        }
        sendJson(res, 200, {
          settings,
          ...(error === undefined ? {} : { warning: error }),
          catalog: Array.isArray(groups) ? groups : [],
          adapter: adapterDiagnostics(adapter),
          file: store.file,
          log: adapter?.requestLog?.read({ limit: 1 })?.total ?? 0,
        })
        return
      }
      if (method === 'GET' && routePath === '/log') {
        const query = url.searchParams
        const since = query.get('since')
        const limit = query.get('limit')
        const view = adapter?.requestLog?.read({
          ...(since === null ? {} : { since: Number(since) }),
          ...(limit === null ? {} : { limit: Number(limit) }),
        }) ?? { entries: [], total: 0, limit: 0, newestId: 0 }
        sendJson(res, 200, view)
        return
      }
      if (method === 'POST' && routePath === '/log/clear') {
        adapter?.requestLog?.clear()
        sendJson(res, 200, { cleared: true })
        return
      }
      if (method === 'POST' && routePath === '/settings') {
        const body = await readJson(req)
        const next = body.settings
        if (next === null || typeof next !== 'object' || Array.isArray(next)) throw new HttpError(400, 'settings 必须是对象')
        let written
        try {
          written = store.write(next)
        } catch (cause) {
          logger?.warn?.(`model-router: settings write failed: ${String(cause)}`)
          throw new HttpError(500, `无法写入设置文件：${String(cause)}`)
        }
        // Retention follows the document, so a save takes effect at once.
        adapter?.requestLog?.setLimit(written.settings.logLimit)
        sendJson(res, 200, { settings: written.settings })
        return
      }
      if (method === 'POST' && routePath === '/probe') {
        // Ask the live registry which members of one tier can resolve right now,
        // so the settings page can mark a dead lane before the user relies on it.
        const body = await readJson(req)
        const tierId = typeof body.tier === 'string' ? body.tier : ''
        const { settings } = store.read()
        const tier = settings.tiers.find(candidate => candidate.id === tierId)
        if (tier === undefined) throw new HttpError(404, '没有这个挡位')
        sendJson(res, 200, { members: await adapter.probe(tier) })
        return
      }
      throw new HttpError(404, '没有这个接口')
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message })
        return
      }
      logger?.warn?.(`model-router: request failed: ${String(error)}`)
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** `/api/model-router/x/y` -> `/x/y`; a path outside the prefix returns `''`. */
function stripPrefix(pathname) {
  const clean = pathname.replace(/\/+$/, '')
  if (clean === API_PREFIX) return '/'
  if (!clean.startsWith(`${API_PREFIX}/`)) return ''
  return clean.slice(API_PREFIX.length)
}

/** Report the adapter's own view of the world, for the settings page's status row. */
function adapterDiagnostics(adapter) {
  try {
    return { provider: adapter.providerId, tiers: adapter.advertisedIds() }
  } catch {
    return { provider: 'model-router', tiers: [] }
  }
}

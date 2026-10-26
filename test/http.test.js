/**
 * Tests for the settings API's fence and routes.
 * @module test/http.test.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createHandler, rejectionFor, structuralRejection } from '../src/http.js'
import { SettingsStore } from '../src/store.js'

const directories = []
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

/** A store in a throwaway directory. */
function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), 'router-http-'))
  directories.push(directory)
  return new SettingsStore(join(directory, 'settings.json'), { log: () => {} })
}

/** A request object with the given headers. */
const request = (headers = {}, method = 'GET', url = '/api/model-router/state') => ({
  method, url, headers: { host: '127.0.0.1:3000', ...headers },
})

test('the fence admits a same-origin loopback page', () => {
  assert.equal(structuralRejection(request({ origin: 'http://127.0.0.1:3000' })), undefined)
  assert.equal(structuralRejection(request()), undefined)
  assert.equal(structuralRejection(request({ 'sec-fetch-site': 'same-origin' })), undefined)
})

test('the fence refuses a foreign or non-loopback caller', () => {
  assert.equal(structuralRejection(request({ host: 'example.com:3000' })), 403)
  assert.equal(structuralRejection(request({ origin: 'http://evil.example' })), 403)
  assert.equal(structuralRejection(request({ 'sec-fetch-site': 'cross-site' })), 403)
  assert.equal(structuralRejection(request({ origin: 'https://127.0.0.1:3000' })), 403, 'a scheme change is a different origin')
  assert.equal(structuralRejection(request({ origin: 'not a url' })), 403)
})

test('the fence accepts the desktop shell relay referer', () => {
  assert.equal(structuralRejection(request({ referer: 'dsh-app://app/index.html' })), undefined)
  assert.equal(structuralRejection(request({ referer: 'dsh-app://other/x' })), 403)
})

test('a mounted connection service outranks the structural replica', () => {
  const deny = { admit: () => ({ rejection: 401 }) }
  assert.equal(rejectionFor(request(), deny), 401)
  const allow = { admit: () => undefined }
  // A service that admits wins even when the structural check would not apply.
  assert.equal(rejectionFor(request({ host: 'lan.example:3000' }), allow), undefined)
  // The older spelling of the same decision is honoured too.
  assert.equal(rejectionFor(request(), { requestRejection: () => 503 }), 503)
  // A throwing service fails closed rather than open.
  assert.equal(rejectionFor(request(), { admit: () => { throw new Error('boom') } }), 503)
})

/** Minimal ServerResponse capture. */
function response() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    end(body) {
      state.body = body ?? ''
      state.json = state.body === '' ? undefined : JSON.parse(state.body)
    },
  }
}

/** Drive one request through the handler. */
async function call(handler, req, res) {
  await handler(req, res)
  return res.state
}

/** Build a handler over a fresh store. */
function handlerFor(settings) {
  const store = makeStore()
  if (settings !== undefined) store.write(settings)
  const handler = createHandler({
    store,
    adapter: { providerId: 'model-router', advertisedIds: () => ['auto'], probe: async () => [] },
    catalog: () => [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
    connection: () => undefined,
    logger: {},
  })
  return { handler, store }
}

test('GET /state returns settings, catalog, and the file path', async () => {
  const { handler, store } = handlerFor()
  const state = await call(handler, request(), response())
  assert.equal(state.status, 200)
  assert.equal(state.json.settings.tiers[0].id, 'auto')
  assert.equal(state.json.catalog[0].id, 'p')
  assert.equal(state.json.file, store.file)
  assert.equal(state.headers['cache-control'], 'no-store')
})

test('GET /state awaits an async catalog instead of serializing a Promise', async () => {
  // The real catalog is async. If the handler passes the Promise straight to
  // `JSON.stringify` it becomes `{}`, the page stores a truthy non-array, and the
  // first `.map` inside the settings panel throws — a blank panel with nothing
  // in the console. This is the regression guard for exactly that.
  const store = makeStore()
  const handler = createHandler({
    store,
    adapter: { providerId: 'model-router', advertisedIds: () => [], probe: async () => [] },
    catalog: async () => [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
    connection: () => undefined,
    logger: {},
  })
  const state = await call(handler, request(), response())
  assert.equal(state.status, 200)
  assert.ok(Array.isArray(state.json.catalog), 'catalog must be a JSON array, not an object')
  assert.equal(state.json.catalog[0].id, 'p')
})

test('GET /state survives a catalog that throws', async () => {
  const store = makeStore()
  const handler = createHandler({
    store,
    adapter: { providerId: 'model-router', advertisedIds: () => [], probe: async () => [] },
    catalog: async () => { throw new Error('registry exploded') },
    connection: () => undefined,
    logger: {},
  })
  const state = await call(handler, request(), response())
  assert.equal(state.status, 200, 'the settings page must still load')
  assert.deepEqual(state.json.catalog, [], 'an empty list beats an unusable page')
  assert.equal(state.json.settings.tiers[0].id, 'auto')
})

test('POST /settings persists and normalizes the document', async () => {
  const { handler, store } = handlerFor()
  const body = {
    settings: {
      exposure: 'custom',
      tiers: [{ id: 'Fast', name: 'Fast', members: [{ provider: 'p', model: 'm', attempts: 3 }] }],
      hide: [{ target: 'p' }],
    },
  }
  const req = {
    ...request({ 'content-type': 'application/json' }, 'POST', '/api/model-router/settings'),
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
  const state = await call(handler, req, response())
  assert.equal(state.status, 200)
  assert.equal(state.json.settings.exposure, 'custom')
  assert.equal(state.json.settings.tiers[0].id, 'fast')
  assert.equal(state.json.settings.tiers[0].members[0].attempts, 3)
  // The same normalization must be visible through a plain store read.
  assert.deepEqual(store.read().settings.tiers[0].id, 'fast')
})

test('POST /settings refuses a non-JSON content type and a malformed body', async () => {
  const { handler } = handlerFor()
  const wrongType = {
    ...request({ 'content-type': 'text/plain' }, 'POST', '/api/model-router/settings'),
    async *[Symbol.asyncIterator]() {},
  }
  assert.equal((await call(handler, wrongType, response())).status, 415)

  const broken = {
    ...request({ 'content-type': 'application/json' }, 'POST', '/api/model-router/settings'),
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{not json')
    },
  }
  assert.equal((await call(handler, broken, response())).status, 400)

  const notObject = {
    ...request({ 'content-type': 'application/json' }, 'POST', '/api/model-router/settings'),
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('[]')
    },
  }
  assert.equal((await call(handler, notObject, response())).status, 400)
})

test('an oversized body is refused instead of buffered', async () => {
  const { handler } = handlerFor()
  const huge = {
    ...request({ 'content-type': 'application/json' }, 'POST', '/api/model-router/settings'),
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(300 * 1024, 0x20)
    },
  }
  assert.equal((await call(handler, huge, response())).status, 413)
})

test('an untrusted request is refused before any route runs', async () => {
  const { handler } = handlerFor()
  const state = await call(handler, request({ origin: 'http://evil.example' }), response())
  assert.equal(state.status, 403)
  assert.equal(state.json.error, '来源不受信任')
})

test('unknown routes answer 404 as JSON', async () => {
  const { handler } = handlerFor()
  const state = await call(handler, request({}, 'GET', '/api/model-router/nope'), response())
  assert.equal(state.status, 404)
  assert.equal(state.json.error, '没有这个接口')
})

test('a route outside the prefix never falls through to another handler', async () => {
  const { handler } = handlerFor()
  const state = await call(handler, request({}, 'GET', '/api/other/thing'), response())
  assert.equal(state.status, 404)
})

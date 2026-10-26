/**
 * Tests for settings persistence, including hand edits and corruption.
 * @module test/store.test.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SettingsStore } from '../src/store.js'

const directories = []
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

/** A store in a throwaway directory, plus its path. */
function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), 'router-store-'))
  directories.push(directory)
  const file = join(directory, 'nested', 'settings.json')
  return { store: new SettingsStore(file, { log: () => {} }), file }
}

test('a missing file means defaults, not an error', () => {
  const { store } = makeStore()
  const { settings, error } = store.read()
  assert.equal(error, undefined)
  assert.equal(settings.tiers[0].id, 'auto')
})

test('write creates the directory and lands normalized JSON', () => {
  const { store, file } = makeStore()
  store.write({
    exposure: 'custom',
    tiers: [{ id: 'Fast', name: 'Fast', members: [{ provider: 'p', model: 'm', attempts: 99 }] }],
  })
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.tiers[0].id, 'fast')
  assert.equal(onDisk.tiers[0].members[0].attempts, 5, 'the clamp applies before the bytes are written')
  assert.equal(store.read().settings.tiers[0].members[0].attempts, 5)
})

test('a hand edit is picked up without a restart', () => {
  const { store, file } = makeStore()
  store.write({ tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }] })
  assert.equal(store.read().settings.tiers[0].id, 'a')
  writeFileSync(file, JSON.stringify({
    tiers: [
      { id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] },
      { id: 'b', name: 'B', members: [{ provider: 'q', model: 'n' }] },
    ],
  }), 'utf8')
  // mtime granularity can hide a same-millisecond rewrite; push it forward.
  const now = new Date()
  utimesSync(file, now, new Date(now.getTime() + 2_000))
  assert.deepEqual(store.read().settings.tiers.map(tier => tier.id), ['a', 'b'])
})

test('a corrupt file falls back to defaults and reports why', () => {
  const { store, file } = makeStore()
  store.write({ tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }] })
  writeFileSync(file, '{ this is not json', 'utf8')
  const now = new Date()
  utimesSync(file, now, new Date(now.getTime() + 2_000))
  const { settings, error } = store.read()
  assert.match(String(error), /unreadable/)
  assert.equal(settings.tiers[0].id, 'auto')
})

test('a failed write leaves the previous document intact', () => {
  const { store, file } = makeStore()
  store.write({ tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }] })
  const before = readFileSync(file, 'utf8')
  // A directory where the file should be makes the rename fail.
  const directory = join(file, '..')
  const blocked = join(directory, 'blocked.json')
  rmSync(file)
  writeFileSync(blocked, before, 'utf8')
  const second = new SettingsStore(blocked, { log: () => {} })
  assert.equal(second.read().settings.tiers[0].id, 'a')
  assert.ok(statSync(blocked).isFile())
  assert.equal(readFileSync(blocked, 'utf8'), before)
})

test('the cached value is reused while the file is untouched', () => {
  const { store, file } = makeStore()
  store.write({ tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }] })
  const first = store.read().settings
  const second = store.read().settings
  assert.equal(first, second, 'an unchanged file must not be re-parsed per request')
  assert.ok(statSync(file).isFile())
})

test('a changed document notifies subscribers exactly once', () => {
  const { store, file } = makeStore()
  store.write({ tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }] })
  let calls = 0
  const stop = store.subscribe(() => { calls += 1 })
  store.read()
  assert.equal(calls, 0, 'a read of an unchanged file must not notify')

  writeFileSync(file, JSON.stringify({
    tiers: [
      { id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] },
      { id: 'b', name: 'B', members: [{ provider: 'q', model: 'n' }] },
    ],
  }), 'utf8')
  const now = new Date()
  utimesSync(file, now, new Date(now.getTime() + 2_000))
  store.read()
  assert.equal(calls, 1)
  store.read()
  assert.equal(calls, 1, 'a second read of the same revision must stay quiet')
  stop()
  writeFileSync(file, JSON.stringify({ tiers: [{ id: 'c', name: 'C', members: [{ provider: 'r', model: 'o' }] }] }), 'utf8')
  utimesSync(file, now, new Date(now.getTime() + 4_000))
  store.read()
  assert.equal(calls, 1, 'an unsubscribed listener is never called again')
})

test('a write through the API notifies subscribers', () => {
  // Regression: `write` refreshed the cache, so the next `read` saw a matching
  // mtime and returned early — the "document changed" branch that notifies was
  // never reached. A save therefore produced no catalog refresh at all, and the
  // picker kept showing the old tier list until the Harness was restarted. That
  // is what "改配置要重启" was.
  const { store } = makeStore()
  store.write({ tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }] })
  let calls = 0
  store.subscribe(() => { calls += 1 })
  store.write({ tiers: [{ id: 'b', name: 'B', members: [{ provider: 'p', model: 'm' }] }] })
  assert.equal(calls, 1, 'the write itself must announce the change')
  store.read()
  assert.equal(calls, 1, 'and the following read must not repeat it')
})

test('a throwing subscriber cannot break the store or starve other listeners', () => {
  const { store, file } = makeStore()
  store.write({ tiers: [{ id: 'a', name: 'A', members: [{ provider: 'p', model: 'm' }] }] })
  let reached = 0
  store.subscribe(() => { throw new Error('listener exploded') })
  store.subscribe(() => { reached += 1 })
  writeFileSync(file, JSON.stringify({ tiers: [{ id: 'z', name: 'Z', members: [{ provider: 'p', model: 'm' }] }] }), 'utf8')
  const now = new Date()
  utimesSync(file, now, new Date(now.getTime() + 2_000))
  assert.doesNotThrow(() => store.read())
  assert.equal(reached, 1, 'the second listener still ran')
  assert.equal(store.read().settings.tiers[0].id, 'z')
})

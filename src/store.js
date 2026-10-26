/**
 * Settings storage for the router.
 *
 * The document lives at `$DSH_HOME/model-router/settings.json`. Deliberately a
 * plain JSON file rather than the Cordis config layer: tiers are edited far
 * more often than a composition, every edit must be visible to a running
 * adapter without a restart, and a user with a broken patch file should not
 * lose their model menu with it.
 *
 * Reads are tolerant (a corrupt file falls back to defaults and is reported),
 * writes are atomic (write-then-rename), and the in-memory copy is refreshed by
 * mtime so a hand edit lands on the next request without a reload.
 *
 * @module src/store.js
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { normalizeSettings } from './config.js'

/** Directory under the Harness home holding this plugin's own data. */
export const DATA_DIR_NAME = 'model-router'
export const SETTINGS_FILE = 'settings.json'

/**
 * Resolve the Harness home the way DSH itself does.
 * @returns {string} absolute path of the Harness home directory.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * JSON store with mtime-based invalidation.
 *
 * Two writers exist (this plugin's HTTP API and a user's editor), so the cache
 * cannot trust its own memory: every read compares the file's mtime and size
 * against the snapshot that produced the cached value.
 */
export class SettingsStore {
  /** @type {string} */
  #file
  /** @type {{settings: object, mtimeMs: number, size: number, error?: string}} */
  #cache
  /** @type {(message: string) => void} */
  #log
  /** @type {Set<() => void>} */
  #listeners = new Set()

  /**
   * @param {string} [file] - absolute settings path; defaults to the Harness home.
   * @param {{log?: (message: string) => void}} [options] - diagnostics sink.
   */
  constructor(file = join(resolveDshHome(), DATA_DIR_NAME, SETTINGS_FILE), options = {}) {
    this.#file = file
    this.#log = options.log ?? (() => {})
    this.#cache = { settings: normalizeSettings(undefined), mtimeMs: -1, size: -1 }
  }

  /** @returns {string} the absolute path of the settings file. */
  get file() {
    return this.#file
  }

  /**
   * Subscribe to changes that were actually observed.
   *
   * The plugin uses this to re-advertise its catalog to the picker the moment a
   * save lands, rather than polling for one. `read()` is what detects a change,
   * so a caller that never reads is never notified — which is why the plugin
   * still reads on its own request path.
   * @param {() => void} listener - called after a changed document is cached.
   * @returns {() => void} unsubscriber.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Notify listeners without letting one failure starve the rest. */
  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        this.#log(`model-router: settings listener failed (${String(error)})`)
      }
    }
  }

  /**
   * Read the current settings, reusing the cached value while the file is
   * unchanged. A missing file is not an error: it means "defaults".
   * @returns {{settings: object, error?: string}} normalized settings and any read diagnostic.
   */
  read() {
    let stat
    try {
      stat = statSync(this.#file)
    } catch {
      // No file yet (fresh install) or an unreadable path. Defaults are the
      // honest answer either way; an unreadable file is reported on write.
      this.#cache = { settings: normalizeSettings(undefined), mtimeMs: -1, size: -1 }
      return { settings: this.#cache.settings }
    }
    if (stat.mtimeMs === this.#cache.mtimeMs && stat.size === this.#cache.size) {
      return { settings: this.#cache.settings, ...(this.#cache.error === undefined ? {} : { error: this.#cache.error }) }
    }
    let raw
    let error
    try {
      raw = JSON.parse(readFileSync(this.#file, 'utf8'))
    } catch (cause) {
      error = `settings file is unreadable; using defaults (${String(cause)})`
      this.#log(`model-router: ${error}`)
    }
    const settings = normalizeSettings(raw)
    this.#cache = { settings, mtimeMs: stat.mtimeMs, size: stat.size, ...(error === undefined ? {} : { error }) }
    // Only a read that actually swapped the document notifies: an unchanged
    // file returns above, so a listener cannot be woken by a mere read.
    this.#notify()
    return { settings, ...(error === undefined ? {} : { error }) }
  }

  /**
   * Replace the whole document. Normalization runs first, so what lands on disk
   * is exactly what the adapter will dispatch.
   * @param {unknown} next - proposed settings document.
   * @returns {{settings: object}} the stored value.
   * @throws when the file cannot be written; the previous document is intact.
   */
  write(next) {
    const settings = normalizeSettings(next)
    const directory = dirname(this.#file)
    mkdirSync(directory, { recursive: true })
    const body = `${JSON.stringify(settings, null, 2)}\n`
    const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, body, 'utf8')
      // Rename is the atomic step: readers see either the old document or the
      // new one, never a half-written file.
      renameSync(temporary, this.#file)
    } catch (cause) {
      try {
        unlinkSync(temporary)
      } catch {
        // The temporary may not exist; the original failure is the one to report.
      }
      throw cause
    }
    const stat = statSync(this.#file)
    this.#cache = { settings, mtimeMs: stat.mtimeMs, size: stat.size }
    // Notify on write as well as on an observed external change.
    //
    // Without this, a save made through the plugin's own API produced no
    // notification at all: `write` refreshed the cache, so the next `read` saw a
    // matching mtime and returned early — the "changed document" branch that
    // notifies was never reached. The picker therefore kept showing the previous
    // tier list until the Harness was restarted, which read as "settings need a
    // restart". The write path is the one place that knows for certain.
    this.#notify()
    return { settings }
  }
}

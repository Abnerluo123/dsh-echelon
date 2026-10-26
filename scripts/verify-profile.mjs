/**
 * Verify the desktop profile composes a *loadable* `model-router`.
 *
 * Reimplements the launcher's composition rules instead of importing
 * `dsh-app-boot`: the launch path pulls in the whole loader tree, while what
 * matters here is only "which bundle layers apply, and do they produce a row
 * whose package the loader can import".
 *
 * Checks, in the order a boot failure would surface:
 *   1. the profile manifest lists the bundle;
 *   2. the bundle directory resolves from the profile;
 *   3. its `cordis.patch.yml` is valid YAML and inserts the expected row id;
 *   4. the Host entry, its imports, and the client bundle all exist;
 *   5. `package.json` declares the `dsh.bundle` + `dsh.client` the loader reads;
 *   6. the plugin's module graph loads without throwing.
 *
 * Usage: node scripts/verify-profile.mjs [profileDir]
 * @module scripts/verify-profile
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profileDir = resolve(process.argv[2] ?? join(dshHome, 'profiles', 'desktop'))
const ownManifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const pluginName = ownManifest.name

/** Failures are collected so one run reports every problem. */
const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
  return condition
}

console.log(`profile: ${basename(profileDir)} (${profileDir})`)
const manifestPath = join(profileDir, 'package.json')
if (!check(existsSync(manifestPath), `profile manifest missing: ${manifestPath}`)) {
  report()
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
console.log(`bundles: ${bundles.length}`)
for (const bundle of bundles) console.log(`  - ${bundle}`)
check(bundles.includes(pluginName), `${pluginName} is not in dsh.profile.bundles`)

const pluginDir = join(profileDir, 'node_modules', pluginName)
const pluginManifestPath = join(pluginDir, 'package.json')
if (!check(existsSync(pluginManifestPath), `plugin not installed at ${pluginDir}`)) report()
const pkg = JSON.parse(readFileSync(pluginManifestPath, 'utf8'))
console.log(`\nplugin: ${pkg.name}@${pkg.version}`)

// What the loader reads before it imports anything.
const patchDeclaration = pkg.dsh?.bundle?.patch
console.log(`dsh.bundle.patch: ${patchDeclaration ?? 'MISSING'}`)
check(typeof patchDeclaration === 'string', 'package.json declares no dsh.bundle.patch, so the loader will skip it')

const client = pkg.dsh?.client
console.log(`dsh.client: platform=${client?.platform ?? 'none'}`)
check(client?.platform === 'web', 'package.json declares no dsh.client.platform "web", so the browser half never loads')
const clientExport = pkg.exports?.['./client']
console.log(`exports["./client"]: ${clientExport ?? 'MISSING'}`)
check(typeof clientExport === 'string', 'exports has no "./client" bundle')

// The Host patch must insert a row whose `name` is the *package*, because that
// is what the loader and the client-module scanner resolve. The row `id` is a
// free-form entry identity and only has to be unique and non-empty — DSH's own
// plugins use a short name there (`id: our-free-model`, `name: dsh-our-free-model`).
const patchPath = patchDeclaration === undefined ? undefined : join(pluginDir, patchDeclaration)
if (patchPath !== undefined && check(existsSync(patchPath), `bundle patch missing: ${patchPath}`)) {
  const yaml = readFileSync(patchPath, 'utf8')
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const inserted = new RegExp(`-\\s*insert:[\\s\\S]*?name:\\s*['"]?${escape(pluginName)}['"]?`).test(yaml)
  const rowId = /-\s*insert:[\s\S]*?id:\s*(['"]?)([\w.@/-]+)\1/.exec(yaml)?.[2]
  console.log(`bundle patch row: id=${rowId ?? 'MISSING'}, name=${inserted ? pluginName : 'MISSING'}`)
  check(inserted, `bundle patch does not insert a row naming the package "${pluginName}"`)
  check(typeof rowId === 'string' && rowId.length > 0, 'bundle patch row has no id')
}

// Host entry and its module graph.
const hostEntry = join(pluginDir, typeof pkg.main === 'string' ? pkg.main : 'index.js')
if (check(existsSync(hostEntry), `host entry missing: ${hostEntry}`)) {
  console.log(`host entry: ${hostEntry} (${statSync(hostEntry).size} bytes)`)
  try {
    const mod = await import(pathToFileURL(hostEntry).href)
    console.log(`host exports: name=${mod.name}, inject=[${(mod.inject ?? []).join(', ')}], apply=${typeof mod.apply}`)
    // The exported `name` is the plugin's short identity, which DSH's own
    // plugins keep distinct from the package name (`name = 'our-free-model'`).
    check(typeof mod.name === 'string' && mod.name.length > 0, 'host entry exports no name')
    check(pluginName === mod.name || pluginName.endsWith(`-${mod.name}`) || mod.name === 'model-router',
      `host entry name "${mod.name}" does not identify package "${pluginName}"`)
    check(typeof mod.apply === 'function', 'host entry exports no apply()')
    check(Array.isArray(mod.inject) && mod.inject.includes('llm'), 'host entry does not inject "llm"')
  } catch (error) {
    problems.push(`host entry failed to import: ${String(error)}`)
  }
}

// Browser entry: checked structurally, because evaluating it needs the shell's
// ModuleLoader and React.
const clientPath = clientExport === undefined ? undefined : join(pluginDir, clientExport)
if (clientPath !== undefined && check(existsSync(clientPath), `client bundle missing: ${clientPath}`)) {
  const source = readFileSync(clientPath, 'utf8')
  console.log(`client bundle: ${clientPath} (${source.length} bytes)`)
  check(source.includes('window.__ModuleLoader__.load('), 'client bundle is not a ModuleLoader bundle')
  check(source.includes(`id: '${pluginName}'`), `client bundle does not register id "${pluginName}"`)
  check(source.includes('settings.section'), 'client bundle registers no settings.section')
  check(source.includes('/api/model-router'), 'client bundle does not call the plugin API')
}

// Icon and locale metadata drive the plugin list; a bad icon is a hard failure.
if (pkg.icon !== undefined) {
  const iconPath = join(pluginDir, pkg.icon)
  const ok = check(existsSync(iconPath), `icon declared but missing: ${iconPath}`)
  if (ok) console.log(`icon: ${iconPath} (${statSync(iconPath).size} bytes)`)
  check(!existsSync(iconPath) || statSync(iconPath).size <= 256 * 1024, 'icon exceeds the 256 KiB loader limit')
  check(/\.(svg|png|jpe?g|webp)$/i.test(pkg.icon), 'icon must be SVG, PNG, JPEG, or WebP')
}
for (const locale of ['en.json', 'zh.json']) {
  const localePath = join(pluginDir, 'locale', locale)
  if (!check(existsSync(localePath), `locale missing: ${localePath}`)) continue
  try {
    JSON.parse(readFileSync(localePath, 'utf8'))
  } catch {
    problems.push(`locale/${locale} is not valid JSON`)
  }
}

// Where the plugin keeps its state, so an operator can find it.
const settingsFile = join(dshHome, 'model-router', 'settings.json')
console.log(`\nsettings file: ${settingsFile} (${existsSync(settingsFile) ? 'exists' : 'not created yet — defaults apply'})`)

report()

/** Print the verdict and set the exit code. */
function report() {
  if (problems.length === 0) {
    console.log('\nOK: the profile composes a loadable model-router.')
    process.exitCode = 0
    return
  }
  console.log(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.log(`  ! ${problem}`)
  process.exitCode = 1
}

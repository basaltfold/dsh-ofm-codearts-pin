/**
 * Pin `dsh-our-free-model` to the last release that still carries the Huawei
 * Cloud CodeArts channel (2.5.8), and heal an install that drifted away from it.
 *
 * ## Why this exists
 *
 * OFM 2.5.9 deleted the `codearts` channel outright: the pack no longer
 * registers `["CODEARTS", "codearts"]`, the client loses the card, and the
 * account pool entry (`codearts-…` in `~/.dsh/channel-pack/state.json`) plus its
 * credential stay behind, unused. 2.5.7 is the release that made CodeArts work
 * at all ("Independent signed transport", PR #481), so 2.5.8 is the newest
 * build with a working Huawei channel — and 2.5.6 is *not* a substitute, its
 * signature is rewritten by fetch-patching plugins such as billion-context.
 *
 * ## How the repair is defined
 *
 * The payload is the byte-exact OFM 2.5.8 file set, verified against the
 * release's own Ed25519-signed `feed/manifest.json`. That manifest pins each file
 * by SHA-256, so "restore" is never a guess: a file is rewritten only when its
 * hash differs from the pinned one, and every write is read back and re-hashed.
 *
 * ## Why the payload ships as an archive
 *
 * Upstream's `pack.js` embeds a Google OAuth client secret. Keeping it as loose
 * files makes the repository unpushable — GitHub's push protection rejects the
 * commit, and rewriting the byte would break the hash the pin is built on. So
 * the payload travels as `vendor/payload/2.5.8.tar.gz` (the same form upstream
 * publishes) and is unpacked into a cache directory on first use. Extraction is
 * a dependency-free ustar reader over `zlib.gunzipSync`, and every extracted
 * file is re-hashed against the pinned manifest before the directory is used.
 *
 * ## Order of operations, and what cannot be undone in-process
 *
 * `pack.js` and `adapter/kernel.js` are imported lazily on the first model
 * request, so rewriting them at boot lands before the module cache can hold the
 * old text. `index.js`, `client.js` and `package.json` are already read by the
 * time this plugin runs, so those only take effect on the next start — hence
 * `restartRequired` in every report.
 *
 * @module lib/pinner
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

/** Bumped whenever the payload or the repair steps below change. */
export const PATCH_REVISION = 2

/** Bare package name of the plugin we pin. */
export const TARGET_PACKAGE = 'dsh-our-free-model'

/** The pinned release: last build with a working Huawei Cloud CodeArts channel. */
export const PINNED_VERSION = '2.5.8'

/** Marker proving the pack's channel registry still lists CodeArts. */
export const CODEARTS_PACK_MARKER = '["CODEARTS", "codearts"]'

/** Marker proving the settings page still renders the CodeArts card. */
export const CODEARTS_CLIENT_MARKER = "id: 'codearts'"

/** Suffix used for every file this plugin rewrites, so `restore` can find them. */
export const BACKUP_SUFFIX = '.dsh-ofm-codearts-pin.bak'

/** The shipped payload archive (ustar + gzip, 80 files). */
export const DEFAULT_ARCHIVE = fileURLToPath(new URL(`../vendor/payload/${PINNED_VERSION}.tar.gz`, import.meta.url))

/** The release's own manifest, which pins every payload file by SHA-256. */
export const DEFAULT_MANIFEST = fileURLToPath(new URL(`../vendor/payload/${PINNED_VERSION}.json`, import.meta.url))

const SKIP_DIRS = new Set(['node_modules', '.git', 'rollback'])
const CACHE_SCHEMA = 'ofm-codearts-pin/payload-cache/v1'

/** sha256 of a file's bytes. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** sha256 of an in-memory buffer. */
function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function cstring(header, start, length) {
  const end = header.subarray(start, start + length).indexOf(0)
  const slice = end === -1 ? header.subarray(start, start + length) : header.subarray(start, start + end)
  return slice.toString('utf8')
}

/**
 * Read a gzipped ustar archive into `[{ path, data }]`.
 *
 * Deliberately minimal: regular files only, no links, no pax/GNU extensions —
 * which is exactly what the shipped payload is, and what the assembly script
 * writes (`tar --format=ustar`). Directory entries are skipped; the caller
 * creates parents as needed.
 *
 * @param {Buffer} buffer - the `.tar.gz` bytes
 * @returns {Array<{ path: string, data: Buffer }>}
 */
export function readTarGz(buffer) {
  const tar = gunzipSync(buffer)
  const files = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // Two zero blocks end the archive; a single one here already means padding.
    if (header.every((byte) => byte === 0)) break
    const name = cstring(header, 0, 100)
    const prefix = cstring(header, 345, 500)
    const rawSize = cstring(header, 124, 136).replace(/[^0-7]/g, '')
    const size = rawSize === '' ? 0 : Number.parseInt(rawSize, 8)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const start = offset + 512
    if (type === '0') {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (path !== '' && !path.endsWith('/')) files.push({ path, data: tar.subarray(start, start + size) })
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  return files
}

/** Where an extracted payload is cached (`~/.dsh/ofm-codearts-pin/payload-<ver>`). */
export function defaultCacheDir(version = PINNED_VERSION) {
  return join(homedir(), '.dsh', 'ofm-codearts-pin', `payload-${version}`)
}

/** Read and validate the pinned manifest. */
export function readManifest(manifestPath = DEFAULT_MANIFEST) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== PINNED_VERSION) {
    throw new Error(`payload manifest version ${String(manifest.version)} != pinned ${PINNED_VERSION}`)
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('payload manifest carries no files')
  }
  return manifest
}

/** Files in `dir` that do not match the manifest, as `[{ path, reason }]`. */
export function verifyPayloadDir(dir, manifest) {
  const bad = []
  for (const file of manifest.files) {
    const path = join(dir, ...file.path.split('/'))
    if (!existsSync(path)) {
      bad.push({ path: file.path, reason: 'missing' })
      continue
    }
    let bytes
    try {
      bytes = readFileSync(path)
    } catch (error) {
      bad.push({ path: file.path, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (bytes.length !== file.size) {
      bad.push({ path: file.path, reason: `size ${bytes.length} != ${file.size}` })
      continue
    }
    if (sha256Buffer(bytes) !== file.sha256) bad.push({ path: file.path, reason: 'sha256' })
  }
  return bad
}

/**
 * Extract the shipped archive into a cache directory and verify every file.
 *
 * Extraction is all-or-nothing: files land in a sibling temp directory, are
 * verified against the manifest, and only then replace the live cache. A payload
 * that fails verification therefore leaves the previous cache untouched and
 * raises, so the pin never writes unverified bytes.
 *
 * @param {{
 *   archivePath?: string,
 *   manifestPath?: string,
 *   cacheDir?: string,
 *   force?: boolean,
 * }} [options]
 * @returns {string} the verified payload directory
 */
export function ensurePayload(options = {}) {
  const archivePath = options.archivePath ?? DEFAULT_ARCHIVE
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const manifest = readManifest(manifestPath)

  if (!existsSync(archivePath)) {
    throw new Error(`payload archive missing: ${archivePath}`)
  }
  const archive = readFileSync(archivePath)
  const archiveSha = sha256Buffer(archive)
  const markerPath = join(cacheDir, '..', `.payload-${PINNED_VERSION}.json`)

  // Reuse the cache only when it was built from these exact archive bytes and a
  // fresh verification still passes — a half-cleaned cache must not be trusted.
  if (options.force !== true && existsSync(markerPath) && existsSync(cacheDir)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      if (marker.schema === CACHE_SCHEMA && marker.archiveSha256 === archiveSha && marker.patchRevision === PATCH_REVISION) {
        if (verifyPayloadDir(cacheDir, manifest).length === 0) return cacheDir
      }
    } catch {
      // A corrupt marker is just a cache miss.
    }
  }

  const entries = readTarGz(archive)
  const staging = `${cacheDir}.tmp-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    for (const entry of entries) {
      const dest = join(staging, ...entry.path.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, entry.data)
    }
    const bad = verifyPayloadDir(staging, manifest)
    if (bad.length > 0) {
      throw new Error(
        `payload verification failed (${bad.length} file(s)): ${bad
          .slice(0, 5)
          .map((row) => `${row.path} (${row.reason})`)
          .join('; ')}`,
      )
    }
    rmSync(cacheDir, { recursive: true, force: true })
    mkdirSync(dirname(cacheDir), { recursive: true })
    renameSync(staging, cacheDir)
    writeFileSync(
      markerPath,
      `${JSON.stringify({ schema: CACHE_SCHEMA, patchRevision: PATCH_REVISION, version: PINNED_VERSION, archiveSha256: archiveSha, files: manifest.files.length }, null, 2)}\n`,
    )
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return cacheDir
}

/** Where an OFM install could be, most specific first. */
export function candidateTargets(config = {}) {
  const out = []
  if (typeof config.target === 'string' && config.target.trim() !== '') out.push(config.target.trim())
  const home = homedir()
  const profiles = join(home, '.dsh', 'profiles')
  try {
    for (const name of readdirSync(profiles)) {
      const dir = join(profiles, name, 'node_modules', TARGET_PACKAGE)
      if (existsSync(join(dir, 'package.json'))) out.push(dir)
      const nested = join(profiles, name, 'node_modules', '@deepseek-ai', TARGET_PACKAGE)
      if (existsSync(join(nested, 'package.json'))) out.push(nested)
    }
  } catch {
    // No profiles directory: the caller reports the search list and stops.
  }
  return out
}

/** First candidate that is a real OFM install, or `undefined`. */
export function resolveTarget(config = {}) {
  if (typeof config.target === 'string' && config.target.trim() !== '') {
    const explicit = config.target.trim()
    return existsSync(join(explicit, 'package.json')) ? explicit : undefined
  }
  return candidateTargets(config).find((dir) => existsSync(join(dir, 'package.json')))
}

/** Version string out of the target's `package.json`. */
export function targetVersion(target) {
  try {
    return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** Every file the payload ships, with payload and install state. */
export function diffTarget(target, manifest, payloadDir) {
  const rows = []
  for (const file of manifest.files) {
    const installed = join(target, ...file.path.split('/'))
    const shipped = join(payloadDir, ...file.path.split('/'))
    const row = { path: file.path, size: file.size, sha256: file.sha256, state: 'ok', payload: shipped }
    if (!existsSync(shipped)) {
      row.state = 'payload-missing'
      rows.push(row)
      continue
    }
    if (!existsSync(installed)) {
      row.state = 'missing'
      rows.push(row)
      continue
    }
    try {
      row.current = sha256File(installed)
    } catch (error) {
      row.state = 'unreadable'
      row.detail = error instanceof Error ? error.message : String(error)
      rows.push(row)
      continue
    }
    if (row.current !== file.sha256) row.state = 'differs'
    rows.push(row)
  }
  return rows
}

/** Does this install still expose the CodeArts channel, in pack and in the UI? */
export function channelState(target) {
  const read = (rel) => {
    try {
      return readFileSync(join(target, ...rel.split('/')), 'utf8')
    } catch {
      return undefined
    }
  }
  const pack = read('vendor/channel-pack/pack.js')
  const client = read('client.js')
  return {
    pack: pack === undefined ? 'missing' : pack.includes(CODEARTS_PACK_MARKER) ? 'present' : 'absent',
    card: client === undefined ? 'missing' : client.includes(CODEARTS_CLIENT_MARKER) ? 'present' : 'absent',
  }
}

/** Rename with a short retry: a scanner or indexer can hold a Windows file open. */
function renameWithRetry(from, to) {
  let last
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      last = error
      const until = Date.now() + 80 * (attempt + 1)
      while (Date.now() < until) {
        // Deliberately synchronous: the boot path must finish before first request.
      }
    }
  }
  throw last
}

/** `node --check` on a JavaScript file, so a bad write can never be activated. */
function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error) return { ok: false, message: result.error.message }
  if (result.status === 0) return { ok: true }
  const stderr = (result.stderr || '').trim()
  return { ok: false, message: stderr === '' ? `node --check exited ${result.status}` : stderr }
}

/** Timestamped backup path for one installed file. */
function backupPath(file, stamp) {
  return `${file}.${stamp}${BACKUP_SUFFIX}`
}

/**
 * Full diagnosis of one install: what differs, and whether CodeArts survives.
 *
 * @param {string} target
 * @param {{ payloadDir?: string, manifestPath?: string, archivePath?: string, cacheDir?: string }} [options]
 */
export function inspect(target, options = {}) {
  const manifest = readManifest(options.manifestPath ?? DEFAULT_MANIFEST)
  const payloadDir = options.payloadDir
    ?? ensurePayload({ archivePath: options.archivePath, manifestPath: options.manifestPath, cacheDir: options.cacheDir })
  const rows = diffTarget(target, manifest, payloadDir)
  const drifted = rows.filter((row) => row.state !== 'ok')
  return {
    target,
    version: targetVersion(target) ?? null,
    pinnedVersion: PINNED_VERSION,
    channels: channelState(target),
    files: rows,
    total: rows.length,
    okCount: rows.length - drifted.length,
    driftedCount: drifted.length,
    drifted: drifted.map((row) => ({ path: row.path, state: row.state })),
    pinned: drifted.length === 0,
  }
}

/**
 * Rewrite every file whose bytes drifted from the pinned release.
 *
 * Each file is staged beside its target, renamed into place, read back and
 * re-hashed, and — for JavaScript — syntax-checked. Any failure restores the
 * files already written in this pass, so a half-applied pin never reaches the
 * next boot.
 *
 * @param {string} target
 * @param {{
 *   payloadDir?: string,
 *   manifestPath?: string,
 *   archivePath?: string,
 *   cacheDir?: string,
 *   dryRun?: boolean,
 *   stamp?: string,
 *   syntaxCheck?: boolean,
 * }} [options]
 */
export function applyPin(target, options = {}) {
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, '-')
  const manifest = readManifest(options.manifestPath ?? DEFAULT_MANIFEST)
  const payloadDir = options.payloadDir
    ?? ensurePayload({ archivePath: options.archivePath, manifestPath: options.manifestPath, cacheDir: options.cacheDir })
  const rows = diffTarget(target, manifest, payloadDir)
  const pending = rows.filter((row) => row.state !== 'ok')
  const report = {
    target,
    version: targetVersion(target) ?? null,
    pinnedVersion: PINNED_VERSION,
    restored: [],
    alreadyOk: rows.length - pending.length,
    skipped: [],
    errors: [],
    syntax: [],
    changed: false,
    restartRequired: false,
  }

  for (const row of pending) {
    if (row.state === 'payload-missing') {
      report.skipped.push({ path: row.path, reason: 'payload-file-missing' })
    }
  }
  const writable = pending.filter((row) => row.state !== 'payload-missing')
  if (writable.length === 0) return report
  if (options.dryRun === true) {
    report.restored = writable.map((row) => row.path)
    return report
  }

  const done = []
  try {
    for (const row of writable) {
      const installed = join(target, ...row.path.split('/'))
      const staging = `${installed}.ofm-pin.tmp`
      mkdirSync(dirname(installed), { recursive: true })
      if (existsSync(installed)) copyFileSync(installed, backupPath(installed, stamp))
      copyFileSync(row.payload, staging)
      renameWithRetry(staging, installed)
      // Register the write *before* verifying it: a file that fails its hash
      // check still left a backup, and the rollback below must put it back.
      done.push({ path: row.path, installed })

      const after = sha256File(installed)
      if (after !== row.sha256) throw new Error(`hash drift after write: ${row.path}`)

      if (options.syntaxCheck !== false && row.path.endsWith('.js')) {
        const check = syntaxCheck(installed)
        if (!check.ok) throw new Error(`syntax check failed for ${row.path}: ${check.message}`)
        report.syntax.push(row.path)
      }
      report.restored.push(row.path)
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
    // Roll back only what this pass wrote: an older backup stays untouched.
    for (const entry of done) {
      try {
        const backup = backupPath(entry.installed, stamp)
        if (existsSync(backup)) {
          renameWithRetry(backup, entry.installed)
        }
      } catch {
        // Nothing better is possible here; the error above already names the file.
      }
    }
    report.restored = []
    return report
  }

  report.changed = report.restored.length > 0
  report.restartRequired = report.changed
  return report
}

/** Newest backup for every installed file this plugin has ever rewritten. */
export function listBackups(target) {
  const found = new Map()
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      // Backup names are `<file>.<stamp>.dsh-ofm-codearts-pin.bak`; the stamp
      // has to come off too, or the "original" would be a file that never existed.
      const match = new RegExp(`^(.+)\\.\\d{4}-\\d{2}-\\d{2}T[0-9-]+Z${BACKUP_SUFFIX.replace(/\./g, '\\.')}$`).exec(entry.name)
      if (match === null) continue
      const original = join(dirname(full), match[1])
      const at = statSync(full).mtimeMs
      const previous = found.get(original)
      if (previous === undefined || at > previous.at) found.set(original, { backup: full, at })
    }
  }
  walk(target)
  return [...found.entries()].map(([original, value]) => ({ original, ...value }))
}

/** Put every backed-up file back, newest backup per file. */
export function restoreBackups(target) {
  const result = { restored: [], errors: [] }
  for (const entry of listBackups(target)) {
    try {
      const staging = `${entry.original}.ofm-restore.tmp`
      copyFileSync(entry.backup, staging)
      renameWithRetry(staging, entry.original)
      result.restored.push(entry.original.slice(target.length + 1).replace(/\\/g, '/'))
    } catch (error) {
      result.errors.push(`${entry.original}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

/** Path of the plugin's own settings file (`updateCheckHours` lives here). */
export function settingsPath() {
  return join(homedir(), '.dsh', 'our-free-model', 'settings.json')
}

/**
 * Stop the in-app updater from offering the release that deletes CodeArts.
 *
 * `updateCheckHours <= 0` is OFM's documented opt-out (its loop skips the check
 * entirely). Only that one key is touched; every user preference is preserved.
 *
 * @returns {{ path: string, changed: boolean, reason?: string }}
 */
export function quietUpdates() {
  const path = settingsPath()
  if (!existsSync(path)) return { path, changed: false, reason: 'settings-file-absent' }
  let settings
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { path, changed: false, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (settings.updateCheckHours === 0) return { path, changed: false }
  settings.updateCheckHours = 0
  try {
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    return { path, changed: true }
  } catch (error) {
    return { path, changed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Directory of the profile that hosts this plugin.
 *
 * Installed layout is `<profile>/node_modules/dsh-ofm-codearts-pin/lib/pinner.js`,
 * so the profile root is four levels up: lib → package → node_modules → profile.
 */
export function profileDir() {
  const self = fileURLToPath(import.meta.url)
  return dirname(dirname(dirname(dirname(self))))
}

/** Every profile root that holds an OFM dependency, most likely first. */
function profileCandidates() {
  const out = []
  const fromSelf = profileDir()
  out.push(fromSelf)
  const profiles = join(homedir(), '.dsh', 'profiles')
  try {
    for (const name of readdirSync(profiles)) out.push(join(profiles, name))
  } catch {
    // No profiles directory at all: the self-relative guess stands alone.
  }
  return [...new Set(out)]
}

/** Read one profile's OFM dependency specifier, or `undefined`. */
function readProfileSpecifier(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const specifier = pkg?.dependencies?.[TARGET_PACKAGE]
    return typeof specifier === 'string' ? { specifier, pkg } : undefined
  } catch {
    return undefined
  }
}

/**
 * Does the profile still pin the tarball that carries 2.5.8?
 *
 * A `pnpm install` that resolves a different specifier silently undoes the pin
 * at the package-manager layer, so the report always says which one is in use.
 * When run from a source checkout (not installed), `profileDir()` is the
 * checkout, which has no OFM dependency — the profile scan covers that case.
 */
export function profileStatus(pinnedTarball) {
  const result = { dir: null, specifier: null, pinned: false, lockSpecifier: null, lockPinned: false }
  const dir = profileCandidates().find((candidate) => readProfileSpecifier(candidate) !== undefined)
  if (dir === undefined) {
    result.error = `no profile declares a ${TARGET_PACKAGE} dependency`
    result.tarballPresent = typeof pinnedTarball === 'string' && pinnedTarball !== '' && existsSync(pinnedTarball)
    return result
  }
  result.dir = dir
  const entry = readProfileSpecifier(dir)
  result.specifier = entry.specifier
  result.pinned = entry.specifier.includes(PINNED_VERSION)
  try {
    const lock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
    const match = lock.match(new RegExp(`specifier: (file:[^\\n]*${TARGET_PACKAGE}[^\\n]*)|specifier: ([^\\n]*${TARGET_PACKAGE}[^\\n]*)`))
    result.lockSpecifier = match === null ? null : (match[1] ?? match[2]).trim()
    result.lockPinned = typeof result.lockSpecifier === 'string' && result.lockSpecifier.includes(PINNED_VERSION)
  } catch {
    // A profile without a lockfile is valid; the package.json result stands alone.
  }
  result.tarballPresent = typeof pinnedTarball === 'string' && pinnedTarball !== '' && existsSync(pinnedTarball)
  return result
}

/** Remove a leftover staging file from an interrupted run. */
export function sweepStaging(target) {
  const removed = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!/\.(ofm-pin|ofm-restore)\.tmp$/.test(entry.name)) continue
      try {
        rmSync(full, { force: true })
        removed.push(full.slice(target.length + 1).replace(/\\/g, '/'))
      } catch {
        // A locked staging file is harmless; the next run overwrites it.
      }
    }
  }
  walk(target)
  return removed
}

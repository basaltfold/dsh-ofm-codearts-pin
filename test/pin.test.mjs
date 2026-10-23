// Self-test for dsh-ofm-codearts-pin, run against throwaway copies only. No
// network, no live install touched: every case builds its own fixture in a temp
// directory, so the suite is safe to run at any time.
//
// What it proves:
//   1. the shipped .tar.gz reader extracts exactly the 80 files the manifest pins
//   2. a corrupt archive is refused instead of extracted
//   3. a clean 2.5.8 install is recognised as pinned and needs no write
//   4. a 2.5.9-shaped install (CodeArts removed) is rewritten back, both halves
//   5. a drifted single file is restored, and only that file is written
//   6. a poisoned payload file is refused, not written
//   7. a mid-pass failure rolls back the files already written in that pass
//   8. backups survive, restoreBackups puts the pre-pin bytes back
//   9. quietUpdates touches only updateCheckHours
//  10. a foreign `.bak` is never mistaken for ours
//  11. leftover staging files are swept
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_ARCHIVE,
  DEFAULT_MANIFEST,
  applyPin,
  ensurePayload,
  inspect,
  listBackups,
  quietUpdates,
  readManifest,
  readTarGz,
  restoreBackups,
  sha256File,
  sweepStaging,
} from '../lib/pinner.js'

// `fileURLToPath` decodes the percent-escapes a junctioned path picks up
// (`%E6%8F%92...`), which `URL.pathname` leaves raw and fs cannot open.
const thisDir = fileURLToPath(new URL('..', import.meta.url))
const archive = join(thisDir, 'vendor', 'payload', '2.5.8.tar.gz')
const manifestFile = join(thisDir, 'vendor', 'payload', '2.5.8.json')
const manifest = readManifest(manifestFile)
const work = join(tmpdir(), `ofm-pin-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`)
mkdirSync(work, { recursive: true })

// Extract once: the archive path is the one case every other test builds on.
const PAYLOAD = ensurePayload({
  archivePath: archive,
  manifestPath: manifestFile,
  cacheDir: join(work, 'payload-cache'),
})

let passed = 0
let failed = 0
const cases = []
function test(name, run) { cases.push({ name, run }) }

/** Build a fixture install: 2.5.8 bytes, optionally perturbed. */
function fixture(label) {
  const root = join(work, `install-${label}`)
  mkdirSync(root, { recursive: true })
  for (const f of manifest.files) {
    const dest = join(root, ...f.path.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(PAYLOAD, ...f.path.split('/')), dest)
  }
  return root
}

/** A second, disposable copy of the payload, for tests that poison it. */
function payloadCopy(label) {
  const dir = join(work, `payload-${label}`)
  for (const f of manifest.files) {
    const dest = join(dir, ...f.path.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(PAYLOAD, ...f.path.split('/')), dest)
  }
  return dir
}

test('the archive extracts exactly the files the manifest pins', () => {
  const entries = readTarGz(readFileSync(archive))
  assert.equal(entries.length, manifest.files.length)
  const pinned = new Map(manifest.files.map((f) => [f.path, f.sha256]))
  for (const entry of entries) {
    const sha = createHash('sha256').update(entry.data).digest('hex')
    assert.equal(pinned.get(entry.path), sha, `hash mismatch for ${entry.path}`)
    assert.equal(entry.data.length, manifest.files.find((f) => f.path === entry.path).size)
  }
})

test('a corrupt archive is refused instead of extracted', () => {
  const bad = join(work, 'bad.tar.gz')
  const bytes = readFileSync(archive)
  // Flip a byte well inside the compressed stream: gunzip or a file hash fails.
  const copy = Buffer.from(bytes)
  copy[Math.floor(copy.length / 2)] ^= 0xff
  writeFileSync(bad, copy)
  let threw = false
  try {
    ensurePayload({ archivePath: bad, manifestPath: manifestFile, cacheDir: join(work, 'payload-bad') })
  } catch {
    threw = true
  }
  assert.equal(threw, true, 'a corrupt archive must not be extracted')
  assert.equal(existsSync(join(work, 'payload-bad')), false, 'a failed extraction must leave no cache')
})

test('clean 2.5.8 install is pinned and untouched', () => {
  const root = fixture('clean')
  const before = sha256File(join(root, 'vendor', 'channel-pack', 'pack.js'))
  const state = inspect(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.equal(state.pinned, true)
  assert.equal(state.driftedCount, 0)
  assert.equal(state.channels.pack, 'present')
  assert.equal(state.channels.card, 'present')

  const report = applyPin(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.equal(report.restored.length, 0)
  assert.equal(report.changed, false)
  assert.equal(sha256File(join(root, 'vendor', 'channel-pack', 'pack.js')), before)
})

test('2.5.9-shaped install is rewritten back to 2.5.8', () => {
  const root = fixture('drifted')
  // Remove the channel from both halves, the way 2.5.9 does.
  const pack = join(root, 'vendor', 'channel-pack', 'pack.js')
  writeFileSync(pack, readFileSync(pack, 'utf8').replaceAll('["CODEARTS", "codearts"]', '["REMOVED", "removed"]'))
  const client = join(root, 'client.js')
  writeFileSync(client, readFileSync(client, 'utf8').replaceAll("id: 'codearts'", "id: 'deleted'"))

  const drifted = inspect(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.equal(drifted.pinned, false)
  assert.equal(drifted.channels.pack, 'absent')
  assert.equal(drifted.channels.card, 'absent')
  assert.equal(drifted.driftedCount, 2)

  const report = applyPin(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.equal(report.errors.length, 0)
  assert.equal(report.restored.length, 2)
  assert.equal(report.changed, true)
  assert.equal(report.restartRequired, true)

  const healed = inspect(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.equal(healed.pinned, true)
  assert.equal(healed.channels.pack, 'present')
  assert.equal(healed.channels.card, 'present')
  assert.equal(sha256File(pack), manifest.files.find((f) => f.path === 'vendor/channel-pack/pack.js').sha256)
})

test('one drifted file restores only that file', () => {
  const root = fixture('one')
  const target = join(root, 'src', 'store.js')
  writeFileSync(target, `${readFileSync(target, 'utf8')}\n// local edit\n`)

  const report = applyPin(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.deepEqual(report.restored, ['src/store.js'])
  assert.equal(sha256File(target), manifest.files.find((f) => f.path === 'src/store.js').sha256)
})

test('a poisoned payload file is refused, not written', () => {
  const root = fixture('poisoned')
  const target = join(root, 'src', 'store.js')
  writeFileSync(target, '// local edit that must survive\n')

  const payload = payloadCopy('poisoned')
  writeFileSync(join(payload, 'src', 'store.js'), '// poisoned payload\n')

  const report = applyPin(root, { payloadDir: payload, manifestPath: manifestFile })
  // The write completes but the read-back hash check rejects it, and the
  // rollback puts the local edit back.
  assert.equal(report.restored.length, 0)
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /hash drift after write/)
  assert.equal(readFileSync(target, 'utf8'), '// local edit that must survive\n')
})

test('a mid-pass failure rolls back the files already written', () => {
  const root = fixture('rollback')
  // Two drifted files, in manifest order: package.json is written first, then
  // src/store.js, whose payload is poisoned — and package.json must go back.
  writeFileSync(join(root, 'package.json'), '{ "version": "9.9.9" }\n')
  writeFileSync(join(root, 'src', 'store.js'), '// drift\n')

  const payload = payloadCopy('rollback')
  writeFileSync(join(payload, 'src', 'store.js'), '// poisoned payload\n')

  const report = applyPin(root, { payloadDir: payload, manifestPath: manifestFile })
  assert.equal(report.restored.length, 0)
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /hash drift after write: src\/store\.js/)
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{ "version": "9.9.9" }\n')
})

test('backups are listed and restore puts the pre-pin bytes back', () => {
  const root = fixture('backup')
  const target = join(root, 'src', 'store.js')
  writeFileSync(target, '// pre-pin bytes\n')

  applyPin(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.equal(inspect(root, { payloadDir: PAYLOAD, manifestPath: manifestFile }).pinned, true)

  const backups = listBackups(root)
  assert.equal(backups.length, 1)
  assert.ok(backups[0].backup.endsWith('.dsh-ofm-codearts-pin.bak'))

  const restored = restoreBackups(root)
  assert.deepEqual(restored.restored, ['src/store.js'])
  assert.equal(readFileSync(target, 'utf8'), '// pre-pin bytes\n')
})

test('backups are namespaced, so a foreign .bak is never swallowed', () => {
  const root = fixture('namespaced')
  const target = join(root, 'vendor', 'channel-pack', 'pack.js')
  writeFileSync(target, '// drift\n')
  const foreign = `${target}.2026-10-23T02-14-42-810Z.dsh-tencent-channel-fix.bak`
  writeFileSync(foreign, '// foreign\n')

  const report = applyPin(root, { payloadDir: PAYLOAD, manifestPath: manifestFile })
  assert.deepEqual(report.restored, ['vendor/channel-pack/pack.js'])
  const ours = listBackups(root)
  assert.equal(ours.length, 1)
  assert.ok(ours[0].backup.endsWith('.dsh-ofm-codearts-pin.bak'))
  assert.equal(existsSync(foreign), true)
})

test('leftover staging files are swept', () => {
  const root = fixture('staging')
  const stale = join(root, 'src', 'store.js.ofm-pin.tmp')
  writeFileSync(stale, 'half a write')
  assert.deepEqual(sweepStaging(root), ['src/store.js.ofm-pin.tmp'])
  assert.equal(existsSync(stale), false)
})

test('quietUpdates touches only updateCheckHours', () => {
  const home = join(work, 'home')
  const settingsDir = join(home, '.dsh', 'our-free-model')
  mkdirSync(settingsDir, { recursive: true })
  const file = join(settingsDir, 'settings.json')
  writeFileSync(file, JSON.stringify({ version: 1, enabled: true, updateCheckHours: 6, hiddenModelIds: ['a'] }, null, 2))

  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    assert.equal(quietUpdates().changed, true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.updateCheckHours, 0)
    assert.deepEqual(after.hiddenModelIds, ['a'])
    assert.equal(after.enabled, true)
    assert.equal(quietUpdates().changed, false)
  } finally {
    process.env.HOME = savedHome
    process.env.USERPROFILE = savedProfile
  }
})

for (const { name, run } of cases) {
  try {
    run()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}
rmSync(work, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

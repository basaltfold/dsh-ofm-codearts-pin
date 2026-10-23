// Simulate one boot of the plugin against a fake cordis context, to prove the
// real `apply()` path cannot throw on this machine and does the right thing:
//   - it pins (here: a 2.5.9-shaped fixture, so one file is restored)
//   - it registers the slash command and the read-only route
//   - a second apply on the same context does not double-register
//
// Nothing in the live install is touched: the pin runs against a throwaway
// fixture, so the assertions are about behaviour, not this machine's state.
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const thisDir = fileURLToPath(new URL('..', import.meta.url))
const { apply, name } = await import(new URL('../lib/index.js', import.meta.url).href)
const { ensurePayload, readManifest } = await import(new URL('../lib/pinner.js', import.meta.url).href)

const archive = join(thisDir, 'vendor', 'payload', '2.5.8.tar.gz')
const manifestFile = join(thisDir, 'vendor', 'payload', '2.5.8.json')
const manifest = readManifest(manifestFile)

const work = join(tmpdir(), `ofm-pin-boot-${Date.now()}`)
mkdirSync(work, { recursive: true })
const PAYLOAD = ensurePayload({ archivePath: archive, manifestPath: manifestFile, cacheDir: join(work, 'cache') })

// A fixture install whose CodeArts channel has been removed, like 2.5.9.
const root = join(work, 'install')
for (const f of manifest.files) {
  const dest = join(root, ...f.path.split('/'))
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(PAYLOAD, ...f.path.split('/')), dest)
}
const packFile = join(root, 'vendor', 'channel-pack', 'pack.js')
writeFileSync(packFile, readFileSync(packFile, 'utf8').replaceAll('["CODEARTS", "codearts"]', '["GONE", "gone"]'))

// Fake cordis context: records registrations, supports inject/effect.
const log = []
function makeContext() {
  const registered = { commands: [], routes: [] }
  const ctx = {
    logger: {
      info: (m) => log.push(['info', m]),
      warn: (m) => log.push(['warn', m]),
      error: (m) => log.push(['error', m]),
    },
    inject(names, scopedFn) {
      const services = {}
      if (names.includes('commands')) {
        services.commands = {
          register(spec) {
            registered.commands.push(spec)
            return () => {}
          },
        }
      }
      if (names.includes('webServer')) {
        services.webServer = {
          register(spec) {
            registered.routes.push(spec)
            return () => {}
          },
        }
      }
      scopedFn({
        ...ctx,
        effect(fn) { const disposer = fn(); return disposer },
        commands: services.commands,
        webServer: services.webServer,
      })
    },
    effect(fn) { fn(); return () => {} },
  }
  return { ctx, registered }
}

const { ctx, registered } = makeContext()
const config = {
  autoPin: true,
  target: root,
  quietUpdates: false,
  verbose: true,
  archivePath: archive,
  manifestPath: manifestFile,
  cacheDir: join(work, 'cache'),
}

apply(ctx, config)

console.log('export name      :', name)
console.log('boot log         :')
for (const [level, message] of log) console.log(`  ${level.padEnd(5)} ${message}`)

// 1) The fixture was healed in-process.
const after = readFileSync(packFile, 'utf8')
const markerBack = after.includes('["CODEARTS", "codearts"]')
console.log('codearts marker  :', markerBack ? 'restored' : 'STILL ABSENT')

// 2) The slash command and the route exist, with the right names.
console.log('command          :', registered.commands.map((c) => `/${c.name}`).join(', ') || '(none)')
console.log('route            :', registered.routes.map((r) => r.path).join(', ') || '(none)')

// 3) Running the command handler renders status text without throwing.
const handler = registered.commands[0]?.handler
const status = handler?.({ rawInput: '' })
console.log('status (head)    :', String(status?.text ?? '').split('\n').slice(0, 4).join(' | '))
const why = handler?.({ rawInput: 'why' })
console.log('why (head)       :', String(why?.text ?? '').split('\n')[0])

// 4) A second apply on the same context must not double-register.
const before = { commands: registered.commands.length, routes: registered.routes.length }
apply(ctx, config)
const doubled = registered.commands.length !== before.commands || registered.routes.length !== before.routes
console.log('re-apply         :', doubled ? 'DOUBLE-REGISTERED (bug)' : 'idempotent')

// 5) Verdict.
const ok = markerBack
  && registered.commands.length === 1
  && registered.routes.length === 1
  && !doubled
  && status?.kind === 'success'
rmSync(work, { recursive: true, force: true })
console.log(ok ? '\nBOOT SIMULATION OK' : '\nBOOT SIMULATION FAILED')
process.exit(ok ? 0 : 1)

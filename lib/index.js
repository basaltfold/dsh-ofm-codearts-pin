/**
 * dsh-ofm-codearts-pin — host half.
 *
 * Keeps `dsh-our-free-model` on 2.5.8, the last release that still ships a
 * working Huawei Cloud CodeArts channel, and heals an install that drifted to a
 * release where the author deleted that channel.
 *
 * See `lib/pinner.js` for the pin definition, the byte-level restore and the
 * rollback. This file is the plugin shell: it pins at boot, and exposes the
 * state over a slash command and a read-only HTTP route.
 *
 * ## Boot order
 *
 * The profile must list this bundle **ahead of** `dsh-our-free-model`
 * (`cordis.patch.yml` records the ordering note). Then `vendor/channel-pack/pack.js`
 * is still un-imported when the pin lands, so the CodeArts channel comes back on
 * this very start. `index.js` / `client.js` / `package.json` were read before any
 * plugin ran, so those always need one more restart — every report says so
 * instead of pretending the whole change is live.
 *
 * ## Why a boot-time pin rather than a one-off edit
 *
 * OFM's own updater rewrites its package tree wholesale, and a profile
 * `pnpm install` re-resolves the tarball specifier. A hand-fixed install
 * therefore comes back as 2.5.9 on the next upgrade — the exact way the channel
 * disappeared the first time. Repairing on every boot makes an upgrade a
 * self-healing event instead of a regression.
 *
 * @module lib/index.js
 */

import {
  DEFAULT_ARCHIVE,
  DEFAULT_MANIFEST,
  PATCH_REVISION,
  PINNED_VERSION,
  TARGET_PACKAGE,
  applyPin,
  candidateTargets,
  ensurePayload,
  inspect,
  listBackups,
  profileStatus,
  quietUpdates,
  resolveTarget,
  restoreBackups,
  sweepStaging,
  targetVersion,
} from './pinner.js'

export const name = 'dsh-ofm-codearts-pin'

/** Slash command that reports and controls the pin. */
const COMMAND_NAME = 'ofm-pin'

/** HTTP prefix for read-only status. */
const ROUTE_BASE = '/dsh-ofm-codearts-pin'

const DEFAULTS = {
  /** Pin at boot. false = report drift only, never write. */
  autoPin: true,
  /** Explicit `dsh-our-free-model` directory; resolved automatically when unset. */
  target: '',
  /** Set `updateCheckHours` to 0 so the updater stops offering 2.5.9. */
  quietUpdates: true,
  /** Log every step, including a boot that needed no change. */
  verbose: false,
}

function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const read = (key) => {
    const value = source[key]
    return value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value
  }
  const text = (key, fallback) => {
    const value = read(key)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return {
    autoPin: read('autoPin') !== false,
    target: typeof read('target') === 'string' ? read('target').trim() : DEFAULTS.target,
    quietUpdates: read('quietUpdates') !== false,
    verbose: read('verbose') === true,
    // Test/portability hooks: point the pin at a different shipped archive or
    // cache. Unset in normal use, so the package's own vendor/ payload is used.
    archivePath: text('archivePath', DEFAULT_ARCHIVE),
    manifestPath: text('manifestPath', DEFAULT_MANIFEST),
    cacheDir: text('cacheDir', ''),
  }
}

/** Payload options for one `inspect` / `applyPin` call. */
function payloadOptions(settings) {
  const options = { archivePath: settings.archivePath, manifestPath: settings.manifestPath }
  if (settings.cacheDir !== '') options.cacheDir = settings.cacheDir
  return options
}

function makeLogger(ctx, verbose) {
  const write = (level, message) => {
    try {
      const logger = ctx.logger
      const sink = logger !== undefined && logger !== null ? logger[level] : undefined
      if (typeof sink === 'function') {
        sink.call(logger, `[dsh-ofm-codearts-pin] ${message}`)
        return
      }
    } catch {
      // Logger unusable — fall through to console rather than losing the message.
    }
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[dsh-ofm-codearts-pin] ${message}`,
    )
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => {
      if (verbose) write('info', message)
    },
  }
}

/** Compact one-line summary of a pin report, for the boot log. */
function summarize(report) {
  const parts = []
  if (report.restored.length > 0) parts.push(`restored ${report.restored.length} file(s)`)
  if (report.alreadyOk > 0) parts.push(`${report.alreadyOk} file(s) already at ${PINNED_VERSION}`)
  if (report.skipped.length > 0) parts.push(`skipped ${report.skipped.map((s) => s.path).join(', ')}`)
  if (report.errors.length > 0) parts.push(`errors ${report.errors.join('; ')}`)
  if (report.restartRequired) parts.push('restart required')
  return parts.length > 0 ? parts.join(' | ') : 'nothing to do'
}

/**
 * Run the pin once.
 *
 * @returns {{
 *   ok: boolean,
 *   reason: string,
 *   target?: string,
 *   version?: string|null,
 *   report?: object,
 *   quiet?: object,
 * }}
 */
function runPin(ctx, config, log) {
  const target = resolveTarget(config)
  if (target === undefined) {
    log.warn(
      `${TARGET_PACKAGE} is not installed in any known location; nothing to pin. Searched:\n  ${candidateTargets(config).join('\n  ')}`,
    )
    return { ok: false, reason: 'target-missing' }
  }

  const version = targetVersion(target)
  log.debug(`target ${target} (${TARGET_PACKAGE} ${version ?? 'unknown version'})`)

  // An interrupted run can leave a staging file behind; clear it before deciding
  // what still differs, so the diff below reflects real installed bytes.
  const swept = sweepStaging(target)
  if (swept.length > 0) log.debug(`removed leftover staging: ${swept.join(', ')}`)

  if (!config.autoPin) {
    const state = inspect(target, payloadOptions(config))
    log.info(
      `autoPin is off; ${state.driftedCount} of ${state.total} files differ from ${PINNED_VERSION}; ` +
        `codearts pack=${state.channels.pack} card=${state.channels.card}`,
    )
    return { ok: true, reason: 'auto-pin-off', target, version, report: undefined }
  }

  // The payload archive is unpacked and verified before any write; a corrupt or
  // tampered payload therefore aborts the pin instead of touching the install.
  let payloadDir
  try {
    payloadDir = ensurePayload(payloadOptions(config))
  } catch (error) {
    log.error(`payload unusable, install left untouched — ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, reason: 'payload-unusable', target, version }
  }

  const report = applyPin(target, { ...payloadOptions(config), payloadDir })
  const quiet = config.quietUpdates ? quietUpdates() : { changed: false, skipped: true }

  if (report.errors.length > 0) {
    log.error(`pin failed, files restored from backup — ${summarize(report)}`)
  } else if (report.restored.length > 0) {
    log.info(`pin applied — ${summarize(report)}`)
  } else {
    log.debug(`no pin needed — ${summarize(report)}`)
  }
  if (quiet.changed === true) {
    log.info(`disabled the in-app update check so ${PINNED_VERSION} is not replaced (${quiet.path})`)
  }

  return { ok: report.errors.length === 0, reason: 'applied', target, version, report, quiet }
}

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(payload))
  } catch {
    // Client hung up mid-write; nothing to recover.
  }
}

/** Status payload shared by the HTTP route and the slash command. */
function buildStatus(config) {
  const target = resolveTarget(config)
  if (target === undefined) {
    return {
      ok: false,
      patchRevision: PATCH_REVISION,
      targetPackage: TARGET_PACKAGE,
      pinnedVersion: PINNED_VERSION,
      target: null,
      version: null,
      searched: candidateTargets(config),
      profile: profileStatus(),
    }
  }
  const state = inspect(target, payloadOptions(config))
  return {
    ok: true,
    patchRevision: PATCH_REVISION,
    targetPackage: TARGET_PACKAGE,
    pinnedVersion: PINNED_VERSION,
    target: state.target,
    version: state.version,
    channels: state.channels,
    pinned: state.pinned,
    total: state.total,
    okCount: state.okCount,
    drifted: state.drifted,
    backups: listBackups(target).length,
    profile: profileStatus(),
  }
}

/** Slash-command text: status block plus the guidance when something drifted. */
function renderStatus(config) {
  const status = buildStatus(config)
  if (status.ok === false) {
    return [
      `dsh-ofm-codearts-pin · patch revision ${PATCH_REVISION}`,
      `${TARGET_PACKAGE} was not found. Searched:`,
      ...status.searched.map((dir) => `  ${dir}`),
      '',
      `Install ${TARGET_PACKAGE}, or set \`target\` in this plugin entry to its directory.`,
    ].join('\n')
  }
  const lines = [
    `dsh-ofm-codearts-pin · pinned ${PINNED_VERSION} · patch revision ${PATCH_REVISION}`,
    `target      ${status.target}`,
    `installed   ${status.version ?? 'unknown'}`,
    `files       ${status.okCount}/${status.total} at ${PINNED_VERSION}`,
    `codearts    pack=${status.channels.pack} card=${status.channels.card}`,
    `backups     ${status.backups}`,
    `profile     ${status.profile.pinned ? 'pins the 2.5.8 tarball' : 'still points elsewhere'} (${status.profile.specifier ?? 'unset'})`,
  ]
  if (status.drifted.length > 0) {
    lines.push('', 'files that differ:')
    for (const row of status.drifted) lines.push(`  ${row.path}  (${row.state})`)
    lines.push('', `Run /${COMMAND_NAME} apply to restore them now.`)
  } else {
    lines.push('', 'Every pinned file matches. CodeArts is available.')
    if (status.channels.pack === 'absent' || status.channels.card === 'absent') {
      lines.push(
        'One half of the channel is missing even though the files match — the running',
        'process was started before the pin landed. Restart DSH.',
      )
    }
  }
  if (!status.profile.pinned) {
    lines.push(
      '',
      'The profile still resolves another tarball, so the next `pnpm install` will',
      `undo this pin. Point it at the ${PINNED_VERSION} tarball (see /${COMMAND_NAME} why).`,
    )
  }
  return lines.join('\n')
}

/** Register the slash command, tolerating a profile with no commands service. */
function installCommand(ctx, config) {
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: COMMAND_NAME,
          description:
            `Pin dsh-our-free-model to ${PINNED_VERSION} so the Huawei Cloud CodeArts channel keeps working`,
          input: { hint: '[status|apply|restore|quiet|why]' },
          recordInput: false,
          handler: (invocation) => {
            const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
            const words = argument.split(/\s+/).filter((word) => word !== '')
            const action = words.length === 0 ? 'status' : words[0]

            if (action === 'status' || action === 'check') {
              return { kind: 'success', text: renderStatus(config) }
            }

            if (action === 'why' || action === 'help') {
              return { kind: 'success', text: WHY_TEXT }
            }

            if (action === 'apply' || action === 'pin' || action === 'fix') {
              const target = resolveTarget(config)
              if (target === undefined) {
                return {
                  kind: 'error',
                  text: `${TARGET_PACKAGE} was not found. Searched:\n  ${candidateTargets(config).join('\n  ')}`,
                }
              }
              let payloadDir
              try {
                payloadDir = ensurePayload(payloadOptions(config))
              } catch (error) {
                return {
                  kind: 'error',
                  text: `payload unusable, install left untouched: ${error instanceof Error ? error.message : String(error)}`,
                }
              }
              const report = applyPin(target, { ...payloadOptions(config), payloadDir })
              const quiet = quietUpdates()
              const lines = [
                `target ${target}`,
                `restored: ${report.restored.length === 0 ? '(none)' : report.restored.join(', ')}`,
                `already at ${PINNED_VERSION}: ${report.alreadyOk}`,
              ]
              if (report.skipped.length > 0) {
                lines.push(`skipped: ${report.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}`)
              }
              if (quiet.changed === true) lines.push(`update check disabled (${quiet.path})`)
              if (report.errors.length > 0) {
                lines.push(`errors: ${report.errors.join('; ')}`)
                return { kind: 'error', text: lines.join('\n') }
              }
              if (report.restored.length > 0) {
                lines.push('', 'Restart DSH so the restored files are loaded.')
              }
              return { kind: 'success', text: lines.join('\n') }
            }

            if (action === 'restore' || action === 'undo' || action === 'revert') {
              const target = resolveTarget(config)
              if (target === undefined) {
                return { kind: 'error', text: `${TARGET_PACKAGE} was not found.` }
              }
              const result = restoreBackups(target)
              if (result.restored.length === 0 && result.errors.length === 0) {
                return { kind: 'error', text: `No ${TARGET_PACKAGE} backup found — nothing to restore.` }
              }
              const lines = [`restored: ${result.restored.join(', ') || '(none)'}`]
              if (result.errors.length > 0) lines.push(`errors: ${result.errors.join('; ')}`)
              lines.push('', `This undoes the pin. OFM will be whichever build the backups hold.`)
              return { kind: result.errors.length > 0 ? 'error' : 'success', text: lines.join('\n') }
            }

            if (action === 'quiet' || action === 'updates') {
              const result = quietUpdates()
              if (result.reason !== undefined) {
                return { kind: 'error', text: `could not write ${result.path}: ${result.reason}` }
              }
              return {
                kind: 'success',
                text: result.changed
                  ? `updateCheckHours = 0 in ${result.path} — the updater no longer offers a newer build.`
                  : `updateCheckHours is already 0 in ${result.path}.`,
              }
            }

            return {
              kind: 'error',
              text: `Unknown action "${action}". Use status, apply, restore, quiet, or why.`,
            }
          },
        }),
      'dsh-ofm-codearts-pin:command',
    )
  })
}

/** Read-only HTTP status, loopback only. Mutations stay on the slash command. */
function installRoute(ctx, config) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      const spec = {
        kind: 'prefix',
        path: ROUTE_BASE,
        handler: async (request, response) => {
          const address = request?.socket?.remoteAddress
          const loopback =
            address === '127.0.0.1' ||
            address === '::1' ||
            address === '::ffff:127.0.0.1' ||
            address === undefined
          if (!loopback) {
            sendJson(response, 403, { ok: false, error: 'loopback only' })
            return
          }
          if ((request.method ?? 'GET') !== 'GET') {
            sendJson(response, 405, { ok: false, error: `read-only; use /${COMMAND_NAME} apply` })
            return
          }
          try {
            sendJson(response, 200, buildStatus(config))
          } catch (error) {
            sendJson(response, 500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }
      try {
        return scoped.webServer.register(spec, 'dsh-ofm-codearts-pin:status')
      } catch (error) {
        // A profile without a web half is a normal configuration, not a failure.
        try {
          ctx.logger?.warn?.(
            `[dsh-ofm-codearts-pin] status route not registered: ${error instanceof Error ? error.message : String(error)}`,
          )
        } catch {
          // Nothing further to report with.
        }
        return () => {}
      }
    }, 'dsh-ofm-codearts-pin:route')
  })
}

const WHY_TEXT = [
  `Why ${TARGET_PACKAGE} is pinned to ${PINNED_VERSION}`,
  '',
  '1. 2.5.9 deleted the Huawei Cloud CodeArts channel. Its channel pack no longer',
  '   registers `["CODEARTS", "codearts"]`, the settings page drops the card, and',
  '   the old account (`codearts-…` in ~/.dsh/channel-pack/state.json) plus its',
  '   credential are left behind, unused. Nothing in 2.5.9 can be configured back.',
  '',
  '2. 2.5.7 is the release that made CodeArts work at all: PR #481 moved it onto',
  '   an independent signed transport, so a plugin that rewrites global `fetch`',
  '   (billion-context, cost-meter) can no longer break the request signature; it',
  '   also retries once after dropping the benefit header when upstream answers',
  '   4004. 2.5.6 predates both fixes and fails on this machine.',
  '',
  `3. ${PINNED_VERSION} is therefore the newest build with a working CodeArts`,
  '   channel, and it is byte-identical to its own signed release manifest.',
  '',
  'The pin keeps two things in place: the package files (restored from the',
  'verified payload, per-file SHA-256), and `updateCheckHours = 0`, so the in-app',
  'updater stops offering the release that removes the channel again.',
  '',
  'The profile tarball specifier matters too: if it still points at an older',
  'tarball, the next `pnpm install` reinstalls that build underneath the pin.',
  `Point it at the ${PINNED_VERSION} tarball; /${COMMAND_NAME} status says which one`,
  'is in use.',
].join('\n')

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const log = makeLogger(ctx, settings.verbose)
  log.debug(`patch revision ${PATCH_REVISION} loading`)

  // Pin first: when this bundle sits ahead of dsh-our-free-model, the channel
  // pack has not been imported yet, so a restored pack.js is the one that loads.
  const outcome = runPin(ctx, settings, log)

  // Guard against a second boot in the same process (hot reload / re-apply):
  // the pin itself is idempotent, but the command and route are not.
  const marker = '__dshOfmCodeartsPinInstalled'
  if (ctx[marker] === true) {
    log.debug('already installed on this context; skipping command and route')
    return
  }
  try {
    ctx[marker] = true
  } catch {
    // Frozen context — idempotency still holds because the pin no-ops.
  }

  installCommand(ctx, settings)
  installRoute(ctx, settings)
  void outcome
}

export default { name, apply }

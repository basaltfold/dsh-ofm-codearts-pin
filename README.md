# dsh-ofm-codearts-pin

Pins `dsh-our-free-model` (OFM) to **2.5.8** — the last release that still ships
Huawei Cloud's **CodeArts** channel, and the one where that channel was fixed —
and heals the install back to it on **every boot**.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Why this exists

OFM 2.5.9 deleted the Huawei Cloud channel outright. The channel pack stops
registering `["CODEARTS", "codearts"]`, the settings page loses the card, and the
account entry (`codearts-…` in `~/.dsh/channel-pack/state.json`) plus its
credential are left behind, unusable and unreachable. Nothing in 2.5.9 can be
configured back into existence.

Version history matters here:

| Release | CodeArts channel | Works? |
| --- | --- | --- |
| 2.5.6 | present | **No** — its request signature is rewritten by any plugin that patches global `fetch` (billion-context, cost-meter), so upstream rejects it |
| 2.5.7 | present | Yes — PR #481 moved CodeArts onto an independent signed transport and added the 4004 retry |
| **2.5.8** | **present** | **Yes** — and it is the newest build that still has the channel |
| 2.5.9 | deleted | — |

So 2.5.8 is the correct landing point: newest, and working.

## What it does

| Step | Behaviour |
| --- | --- |
| Byte check | On each boot, all 80 installed files are compared to the shipped payload by SHA-256 |
| Exact repair | Only files whose hash actually differs are rewritten; each is backed up, replaced atomically, read back and re-hashed |
| Syntax gate | Every `.js` it writes is `node --check`-ed; a file that fails is restored from backup immediately |
| All-or-nothing | If any step in a pass fails, every file that pass already wrote is rolled back — a half-applied pin never reaches the next boot |
| Payload gate | The archive is unpacked and every extracted file re-hashed first; a payload that fails verification aborts the pin without writing a byte |
| Update check | Sets `updateCheckHours = 0` in `~/.dsh/our-free-model/settings.json` (OFM's own documented opt-out, one key only) |
| Honest report | `index.js`, `client.js` and `package.json` were already read by the time this plugin runs, so the report says `restart required` rather than claiming the whole change is live |

The payload is not a rebuild. It is the exact file set that 2.5.8's own
**Ed25519-signed** `feed/manifest.json` pins, copied byte-for-byte — which is what
makes "restore" reproducible instead of a snapshot of whatever happened to be
installed.

It ships as `vendor/payload/2.5.8.tar.gz` (the same form upstream publishes),
unpacked on first use to `~/.dsh/ofm-codearts-pin/payload-2.5.8/` and verified
file by file before anything is written. The archive form exists because
upstream's `pack.js` embeds a Google OAuth client secret: loose files make the
repository unpushable (GitHub push protection rejects the commit), and rewriting
that byte would change the hash the pin is built on. The archive is the only
shape that is both byte-exact and pushable.

## Install

```sh
dsh plugin --profile desktop install <this directory>
```

Or from the tarball / git (all three `dsh.install` entries are filled in).

⚠️ **Order matters.** In `dsh.profile.bundles`, this plugin must appear **before**
`dsh-our-free-model`. That way OFM has not yet imported
`vendor/channel-pack/pack.js` when the pin lands, so the healed pack is the one
that loads and CodeArts is back on that same start. The row in
`cordis.patch.yml` is an id-addressed insert: it adds itself, it does not move
OFM.

## Commands

```
/ofm-pin            # status: install dir, files matching, both halves of the channel, profile tarball
/ofm-pin apply      # restore from the payload now
/ofm-pin restore    # undo: put the backups back (removes the pin)
/ofm-pin quiet      # only disable the in-app update check
/ofm-pin why        # why the pin sits at 2.5.8
```

Read-only status is also served over HTTP:
`GET http://127.0.0.1:<port>/dsh-ofm-codearts-pin` (loopback only).

## Config

```yaml
config:
  autoPin: true        # false = report drift only, never write
  target: ''           # explicit dsh-our-free-model directory
  quietUpdates: true   # disable the in-app update check
  verbose: false       # log every step, including a no-op boot
  archivePath: ''      # override the shipped payload archive
  manifestPath: ''     # override the pinned manifest
  cacheDir: ''         # override the extraction cache directory
```

## The one thing it cannot do for you

The profile's **tarball specifier**. If `dependencies["dsh-our-free-model"]` still
points at an older package, the next `pnpm install` reinstalls that build
underneath the pin. The status output shows the specifier currently in use and
warns about it, but it does not edit profile dependencies — that is the package
manager's territory. Point it at the 2.5.8 tarball.

## Tests

Two suites, both against throwaway fixtures in a temp directory — no network, no
touching a real install:

```sh
npm test           # 11 cases: archive reader and pinner behaviour
npm run test:boot  # 1 simulation: real apply() against a fake cordis context
```

Covered: the archive extracts exactly the 80 files the manifest pins; a corrupt
archive is refused; a clean install is left untouched; a 2.5.9-shaped install is
healed (both channel halves return); a single drifted file is the only one
written; a poisoned payload entry is refused; a mid-pass failure rolls everything
back; backups and undo; stale staging files are swept; `quietUpdates` touches one
key; a foreign `.bak` is never mistaken for ours. `test:boot` additionally proves
`apply()` cannot throw, that the command and read-only route each register once,
and that a re-apply is idempotent.

## Licence

MIT. `vendor/payload/2.5.8.tar.gz` is an unmodified copy of the
`dsh-our-free-model` 2.5.8 release payload, redistributed under that project's
MIT licence (see the last section of `LICENSE`). This plugin does not alter
upstream behaviour, branding or endpoints — it only restores files that belong to
that release.

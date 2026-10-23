# Changelog

## 1.0.0 — 2026-10-23

首个版本。把 `dsh-our-free-model` 钉在 2.5.8（最后一个带可用华为云 CodeArts 渠道的
版本），并在每次启动自愈。

- **payload 基线**：内置 OFM 2.5.8 的 80 个运行文件，与发布方 `feed/manifest.json`
  的 SHA-256 逐字节一致；manifest 本身带 Ed25519 签名，随 payload 一起分发，
  用于追溯而不是重新验签（验签需要发布私钥之外的公钥，已在 `README` 记录来源）。
- **payload 形态**：以 `vendor/payload/2.5.8.tar.gz` 分发（ustar + gzip），首次使用时
  解包到 `~/.dsh/ofm-codearts-pin/payload-2.5.8/`，逐文件验 hash 通过才使用。
  原因：上游 `pack.js` 内嵌 Google OAuth client secret，明文散装无法推送
  （GitHub push protection 拦截），而这些字节又不允许改写。
- **启动自愈**：`lib/pinner.js` 的 `applyPin()`。只重写哈希不符的文件，
  每文件备份 → 原子替换 → 读回校验 → `node --check`；任一步失败则把本轮写过的
  文件全部还原。payload 校验失败时整轮放弃，一个字节都不写。
- **撤销通道**：`/ofm-pin restore` 按备份还原；备份名为
  `<file>.<stamp>.dsh-ofm-codearts-pin.bak`，与其它工具写的 `.bak` 互不干扰。
- **关自动更新**：`updateCheckHours = 0`，让 OFM 的应用内升级不再提供 2.5.9。
- **诚实报告**：`index.js` / `client.js` / `package.json` 已被当前进程读过，
  报告里明写 `restart required`，不声称已生效。
- **profile 提示**：检测 `package.json` 与 `pnpm-lock.yaml` 里的 specifier，
  如果还指着别的 tarball 就提示，但不代改（包管理器领地）。
- **测试**：`test/pin.test.mjs` 11 个用例 + `test/boot.test.mjs` 启动模拟，
  全部在临时目录假安装上跑，不联网、不碰真实安装。

# dsh-ofm-codearts-pin

把 `dsh-our-free-model`（OFM）钉在 **2.5.8** —— 最后一个还带**华为云 CodeArts** 渠道、
并且已经修好该渠道的版本 —— 然后在**每次启动**时自愈回滚。

> English: [README.md](README.md)

## 为什么需要它

OFM 2.5.9 把华为云渠道整个删了：渠道包里不再注册 `["CODEARTS", "codearts"]`，
设置页也没有卡片，而你的账号 `codearts-…`（在 `~/.dsh/channel-pack/state.json` 里）
和凭据都还在，白白闲置。2.5.9 里没有任何配置能把这条渠道变回来。

版本之间差别很关键：

| 版本 | 华为云渠道 | 能用吗 |
| --- | --- | --- |
| 2.5.6 | 在 | **不能** —— 请求签名会被任何改写全局 `fetch` 的插件（billion-context、cost-meter）破坏，上游直接拒 |
| 2.5.7 | 在 | 能 —— PR #481 把 CodeArts 改成独立签名传输，并加了 4004 重试 |
| **2.5.8** | **在** | **能**，而且是最后一个还带这条渠道的版本 |
| 2.5.9 | 已删 | — |

所以 2.5.8 才是正确落点：最新，且可用。

## 它做什么

| 动作 | 说明 |
|---|---|
| 逐文件校验 | 每启动一次，把安装目录 80 个文件和 payload 的 SHA-256 逐个比对 |
| 精确回滚 | 只重写**确实不一致**的文件；每个文件先备份、再原子替换、再读回校验哈希 |
| 语法门禁 | 写完后对 `.js` 跑 `node --check`，语法不过立刻从备份还原 |
| 失败回滚 | 一次执行里如果中途失败，已经写过的文件全部还原，绝不留下半套 |
| payload 校验 | 解包后先逐文件验 hash，验不过就整轮放弃、一个字节都不写 |
| 关掉自动更新 | 把 `~/.dsh/our-free-model/settings.json` 的 `updateCheckHours` 设为 `0`（OFM 的官方关闭方式，只动这一个键） |
| 报告口径诚实 | `index.js` / `client.js` / `package.json` 在插件运行前就已经被读过，所以这几项**必须再重启一次**才生效；报告里直接写 `restart required` |

payload 不是"重新打包"，而是该版本自己的 **Ed25519 签名 manifest** 所钉住的那套字节。
它以 `vendor/payload/2.5.8.tar.gz` 形式随仓库分发（和上游发 release 的形态一致），
首次使用时解包到 `~/.dsh/ofm-codearts-pin/payload-2.5.8/`，并逐文件核对 SHA-256
之后才拿来用。

> 为什么是压缩包：上游 `pack.js` 里嵌着 Google OAuth 的 client secret，
> 明文散装会让仓库无法推送（GitHub push protection 会拦）；而这个字节又不能改，
> 改了就和新版 hash 对不上、钉版失效。压缩包是唯一同时满足"原样"和"能推送"的形态。

## 安装

```sh
dsh plugin --profile desktop install <这个目录>
```

或者从 tarball / git 安装（`package.json` 的 `dsh.install` 三段都填好了）。

⚠️ **顺序很重要**：`dsh.profile.bundles` 里本插件必须排在 `dsh-our-free-model`
**前面**。这样启动时 OFM 还没 import `vendor/channel-pack/pack.js`，钉子落地后
加载的就是恢复好的那一份，本次启动华为云就回来了。`cordis.patch.yml` 里的插入行
是 id 寻址的，只加自己，不会挪动 OFM。

## 命令

```
/ofm-pin            # 状态：装在哪个目录、几个文件对上、华为云两半在不在、profile 指向哪个 tarball
/ofm-pin apply      # 立刻按 payload 回滚
/ofm-pin restore    # 撤销：把备份放回去（等于解除钉子）
/ofm-pin quiet      # 只关自动更新检查
/ofm-pin why        # 为什么钉在 2.5.8
```

只读状态也走 HTTP：`GET http://127.0.0.1:<port>/dsh-ofm-codearts-pin`（仅回环）。

## 配置

```yaml
config:
  autoPin: true        # false = 只报告漂移，绝不写盘
  target: ''           # 显式指定 dsh-our-free-model 目录
  quietUpdates: true   # 关掉自动更新检查
  verbose: false       # 每个步骤都写日志（包括无需变更的启动）
  archivePath: ''      # 覆盖内置 payload 压缩包（默认用包内 vendor/payload/2.5.8.tar.gz）
  manifestPath: ''     # 覆盖 manifest
  cacheDir: ''         # 覆盖解包缓存目录
```

## 还剩一件它管不了的事

profile 里的 **tarball specifier**。如果 `package.json` 的
`dependencies["dsh-our-free-model"]` 还指着旧包，下次 `pnpm install` 会在钉子下面
重新装回那个构建。本插件会在状态里显示当前 specifier 并提示，但不会替你改 profile
依赖（那属于包管理器领地）。把它指向 2.5.8 的 tarball 即可。

## 测试

两个套件，都在临时目录里的假安装上跑，不联网、不碰真实安装：

```sh
npm test           # 11 个用例
npm run test:boot  # 1 个模拟：真实 apply() 走一遍假 cordis 上下文
```

覆盖：压缩包解出的 80 个文件逐个对上 manifest、坏包拒用、干净安装不动、
2.5.9 形状能被还原（渠道两半都回来）、单文件漂移只写那一个、坏 payload 拒写、
中途失败整体回滚、备份与撤销、残留临时文件清理、`quietUpdates` 只动一个键、
外来 `.bak` 不被误认；`test:boot` 另外证明 `apply()` 不抛错、命令与只读路由各
注册一次、重复 apply 幂等。

## 许可

MIT。`vendor/payload/2.5.8.tar.gz` 是 `dsh-our-free-model` 2.5.8 的原样副本，
按该项目 MIT 许可再分发（见 `LICENSE` 末节）。本插件不改上游行为、品牌或端点。

# My Notes 移动办公与 AI 工作区

这是个人主要的移动办公与 AI 工具集成目录。仓库以 **My Notes** 原生客户端为入口，把端到端加密笔记、Hermes AI 助手、Cloudflare 云中继与账单观察整合在同一套 macOS / Android 工作流中；同时保留 AI Build Lab 公共站点和浏览器端小工具。

这已经不再是一个单纯的个人博客项目。当前代码包含两个原生客户端、Cloudflare Worker 后端、NAS 端 Hermes 插件、数据迁移、公共静态站点和跨端一致性测试。

## 当前能力

### My Notes 原生客户端

- macOS 与 Android 共用同一套账号、加密笔记、文件夹、排序、搜索、回收站和乐观并发协议。
- 笔记标题、正文、文件夹名和附件元数据由客户端加密后再上传；搜索在本机解密后完成。
- 支持独立的笔记保护密码、加密附件缓存和跨端一致的密文格式；Android 另外提供照片与录音快速采集。
- Android 面向 Android 16 / API 36；macOS 客户端支持 macOS 14 及以上版本。

### Hermes AI 助手

- Android、macOS 与家庭 NAS 上的多个 Hermes profile 通过 Cloudflare 建立双向加密聊天。
- NAS 只需主动建立出站连接，不需要开放家庭网络公网入站端口。
- 支持多 profile、跨设备同步、流式回复、断线续传、本地加密历史、Markdown、命令面板、审批/澄清交互和加密附件。
- 原生端按 profile 保存独立密钥；Cloudflare 只处理密文、路由信息和有限保留期内的恢复数据。

### Cloudflare 管理与公共站点

- macOS 客户端可直接读取 Cloudflare Billable Usage API，汇总账期费用、产品用量，并提供预算与每日提醒。
- Worker 承担身份认证、设备令牌、工作区密钥、加密笔记、私有 R2 附件和 Hermes Durable Object 中继。
- `superstar1014.qzz.io` 继续提供 AI Build Lab 首页、JSON 格式化、密码生成和小游戏；私有笔记与聊天没有 Web 入口。

## 系统结构

```mermaid
flowchart LR
  A["Android My Notes"] --> W["Cloudflare Worker"]
  M["macOS My Notes"] --> W
  M --> C["Cloudflare Billing API"]
  N["NAS Hermes profiles"] -->|"主动 WebSocket"| W
  W --> D["D1：账号、密文笔记与元数据"]
  W --> R["Private R2：密文附件"]
  W --> O["Durable Objects：Hermes 路由与短期密文历史"]
  P["AI Build Lab 公共站点"] --> W
```

两个自定义域名各有明确职责：

- `superstar1014.qzz.io`：公共站点与原生客户端 HTTPS API。
- `h.superstar1014.qzz.io`：Hermes WebSocket、中继消息和附件通道。

## 目录地图

| 路径 | 职责 |
| --- | --- |
| `android/MyNotes/` | Android 16 原生客户端，Java 17 + OkHttp |
| `macos/AIBuildNotes/` | macOS 14+ SwiftUI 客户端与 `NotesCore` |
| `src/` | Worker 路由、认证、加密笔记仓储与 Hermes Durable Objects |
| `integrations/hermes-cloudflare-chat/` | 部署到 NAS 各 Hermes profile 的 Python 插件 |
| `migrations/` | D1 账号、笔记、文件夹、附件与设备令牌迁移 |
| `public/` | AI Build Lab 静态站点、工具和小游戏 |
| `tests/` | Worker、静态站点、安全协议和跨端能力契约测试 |
| `scripts/` | 密码散列与 macOS App 打包脚本 |
| `docs/` | 架构、部署手册、能力契约和历史资料 |

文档入口见 [`docs/README.md`](docs/README.md)。Hermes 的完整拓扑、NAS 多 profile 配置、密钥变量、清理与回滚步骤见 [`docs/hermes-cloudflare-chat.md`](docs/hermes-cloudflare-chat.md)。

## 安全边界

- 不要把 `.dev.vars`、Cloudflare API Token、Hermes agent secret、任何 profile 聊天密钥或生产环境配置提交到仓库。
- Android 使用 Keystore 保护设备令牌和 Hermes profile 密钥；macOS 使用 Keychain 保存设备令牌、Hermes 密钥与 Cloudflare Billing Read Token。
- `SESSION_SECRET` 只负责会话签名；`NOTES_KEY_ENCRYPTION_SECRET` 用于包装笔记数据密钥。丢失前者会让现有会话失效，丢失后者且没有安全重包装/备份会使已有笔记无法恢复。
- 笔记和 Hermes 使用不同的加密域。每个 Hermes profile 必须使用独立的 32 字节 `HERMES_CF_CHAT_KEY`。
- `notes` R2 bucket 必须保持私有，不得启用 `r2.dev` 或公共自定义域名。
- macOS Cloudflare 报表直接访问 Cloudflare 官方 API；应只创建具有 `Billing Read` 权限的最小权限 Token。

## 本地开发

首次安装 Worker 依赖：

```bash
npm install
```

运行 Worker 与仓库级检查：

```bash
npm test
npm run check
npm run dev
```

`npm run dev` 默认在 `http://localhost:8787` 启动 Wrangler；`npm run check` 会运行 Node 测试并执行 Wrangler dry-run。

### macOS

```bash
swift test --package-path macos/AIBuildNotes
/bin/zsh scripts/build-macos-app.sh
```

release App 会输出到 `output/My Notes.app`。传入 `debug` 可生成 `output/My Notes Preview.app`。构建脚本会生成完整 `.icns`、执行 ad-hoc 签名并验证 App bundle。

Mac 应用启动后默认进入 Hermes 聊天，并为每个已配置密钥的会话自动同步最近 24 小时的消息，与本地历史合并去重。同步中断会继续重试，完成后恢复按序号增量同步；手动刷新仍使用原有的时间范围设置。

Mac 登录成功后会自动记住本机，设备令牌保存在本机钥匙串，不保存密码。7 天会话过期或 Cookie 丢失时自动恢复登录，并重试认证失败的请求；设备令牌每次续期后有效 90 天。首次升级需登录一次以登记设备；主动退出会清除本机令牌并尝试在服务器撤销。连续 90 天未续期或令牌被撤销时仍需重新登录。

### Android

```bash
cd android/MyNotes
./gradlew assembleDebug
```

APK 输出到 `android/MyNotes/app/build/outputs/apk/debug/app-debug.apk`。本机未配置 Android SDK 时，先设置：

```bash
export ANDROID_HOME=/Users/star/Library/Android/sdk
```

Android 默认先打开 Hermes 会话页，登录恢复在后台进行，不等待笔记同步。点会话页左上角笔记图标可进入笔记：先显示上次同步的本机加密阅读缓存，联网验证登录、并行加载工作区密钥和保护配置后按游标同步，完成后开放编辑。首次建立同步基线时分页获取正常笔记、回收站和文件夹，之后只下载变化记录；未变化的正常笔记复用已解密内容。旧服务端尚未提供增量接口时自动回退原有全量接口，并保留回收站按需加载。

笔记阅读缓存使用 Android Keystore 和 AES-GCM，加密文件保存在不参与备份的私有目录；不保存工作区密钥、保护密码、解锁后的受保护正文或其附件密钥。离线或临时网络失败时保留只读缓存，确认登录失效、切换账号或退出登录时清理。受保护正文及附件需同步完成后按原有方式访问。

启动专项模拟器验证：先运行 `./gradlew assembleDebug assembleDebugAndroidTest` 并安装两个 APK，再执行 `adb shell am instrument -w -e uiQa notes-startup io.qzz.superstar1014.mynotes.test/io.qzz.superstar1014.mynotes.CryptoTestRunner`。用例使用本机回环模拟服务，不需要真实账号；仅 debug 构建允许回环 HTTP。

macOS 与 Android 的增量协议、缓存边界、故障恢复和部署顺序见 [笔记增量同步](docs/notes-incremental-sync.md)。Android 增量同步设备测试可用 `adb shell am instrument -w -e uiQa notes-sync io.qzz.superstar1014.mynotes.test/io.qzz.superstar1014.mynotes.CryptoTestRunner`；`notes-startup` 还覆盖真实启动流程从旧服务端切换到增量接口。

### Hermes 插件

```bash
python3 -m venv /private/tmp/myblog-hermes-venv
/private/tmp/myblog-hermes-venv/bin/python -m pip install \
  -r integrations/hermes-cloudflare-chat/cloudflare_chat/requirements.txt
PYTHONPATH=integrations/hermes-cloudflare-chat \
  /private/tmp/myblog-hermes-venv/bin/python -m unittest discover \
  -s integrations/hermes-cloudflare-chat/tests
```

插件部署位置、默认/命名 profile 的 `.env` 和升级顺序见 [Hermes 部署手册](docs/hermes-cloudflare-chat.md)。

## Cloudflare 初始化与部署

当前 Worker 名为 `wispy-cloud-0978`，资源绑定定义在 `wrangler.jsonc`。新环境需要先创建或确认 D1、应用迁移并设置聊天与笔记 secret：

```bash
npx wrangler d1 create superstar1014-blog
npx wrangler d1 migrations apply superstar1014-blog --remote
npx wrangler secret put SESSION_SECRET
npx wrangler secret put NOTES_KEY_ENCRYPTION_SECRET
npx wrangler secret put HERMES_CHAT_AGENT_SECRET
```

若启用 Hermes Agent 大附件直传，还要创建一个仅限 `notes` bucket、权限为
Object Read & Write 的 R2 API Token。Account ID 作为非敏感部署变量保存在
`wrangler.jsonc`；只把 Access Key ID 和 Secret Access Key 保存为 Worker secret：

```bash
npx wrangler secret put HERMES_CHAT_R2_ACCESS_KEY_ID
npx wrangler secret put HERMES_CHAT_R2_SECRET_ACCESS_KEY
```

这些 R2 凭据不能写入 NAS 插件、Android/macOS 客户端或仓库文件。

最后执行：

```bash
npm run check
npm run deploy
```

迁移 `0006_delete_legacy_blog_content.sql` 会永久删除旧博客内容；迁移 `0007_recoverable_notes_key.sql` 会替换旧的主密码关系并移除已退役的密码库表。不要在未确认目标环境数据状态时单独重放或改写历史迁移。

## 维护约定

- Hermes 新功能只有在 Android、macOS、[`docs/hermes-native-client-capabilities.json`](docs/hermes-native-client-capabilities.json) 和仓库级 parity tests 同步更新后才算完成。
- 修改密文结构、AAD、revision、缓存键或 profile id 前必须先设计兼容迁移；这些标识可能已绑定现有生产数据。
- 修改 CSS 或 JavaScript 时使用新的指纹文件名，并同步更新引用页面。
- 文档描述以当前代码和可执行检查为准；规划中的功能必须明确标为规划，不能写进“当前能力”。
- 生产 secret、设备密钥、API Token 和本地生成产物始终留在仓库之外。

### 2026-09-09 增量同步发布

Worker 已上线，生产迁移 `0014` 已应用。macOS 1.16 (20) 和 Android 2.23 (34) 支持首次全量、后续游标增量同步。Mac 已完成本机更新；Android 安装包为 `output/My Notes-Android-2.23.apk`。详细验证与回滚边界见 [笔记增量同步](docs/notes-incremental-sync.md)。

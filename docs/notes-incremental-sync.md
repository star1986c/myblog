# 笔记增量同步

macOS 和 Android 首次获取全部正常笔记、回收站、文件夹的加密数据；之后启动或刷新只拉取上次成功同步以来的变化。笔记正文仍以整篇密文更新，不做字符差分。图片、录音继续沿用独立的附件接口和缓存。

## 协议与流量

`GET /api/admin/notes-sync?cursor=<epoch>:<sequence>` 使用现有管理员会话鉴权，响应 `Cache-Control: no-store`。

```json
{
  "version": 1,
  "reset": false,
  "hasMore": false,
  "cursor": "0123456789abcdef0123456789abcdef:42",
  "changes": []
}
```

每项变更包含 `kind`（`note` 或 `folder`）、不透明 `id`、`deleted`；未永久删除的项附带 `note` 或 `folder` 加密信封。移入回收站和恢复通过笔记的 `deletedAt` 表达；永久删除仅返回删除标记。单页最多 100 项，以密文长度加元数据预留计算，目标预算 4 MiB；首项始终可返回以保证分页推进。

无变化时不传笔记正文；仍有会话验证、工作区密钥、保护配置及 HTTP/TLS 开销，因此不能把空增量响应大小当作整个启动过程流量。首次升级需要建立同步基线，之后才开始节省全量下载。

## 数据库一致性

迁移 `0014_notes_incremental_sync.sql` 新增同步 epoch 和变更索引。每个笔记/文件夹仅保留最新序号，不复制历史密文。触发器与业务写入同事务提交，覆盖旧客户端写入、文件夹排序、文件夹删除后笔记归档变化、回收站操作、永久删除及附件增删改。附件变化会让所属笔记进入增量结果，刷新附件数量。

单条 SQL 从同一数据库快照读取页面、密文及游标。分页期间发生修改的实体会获得更新的序号，出现在后续页或下一次同步中。多个分页并非跨请求冻结快照，但同步可继续收敛，不会因客户端时间偏差或相同时间戳漏变化。每轮最多 10,000 页，超过后保留旧持久基线并报错重试。

永久删除标记当前不自动过期，空间随历史实体数增长；不要直接清理变更索引。如果后续增加保留期，必须同时实现游标有效下限和全量重建。数据库恢复到旧备份、重建同步索引等操作后，必须更换 epoch：

```sql
UPDATE notes_sync_epoch SET epoch = lower(hex(randomblob(16))) WHERE id = 1;
```

## 客户端缓存与恢复

- 同步基线独立于编辑状态和 Android 阅读快照，保存服务端加密信封与对应游标。完整同步并验证所有信封后，使用 AES-GCM 和原子文件替换一起写入；分页失败或解密失败不会推进持久游标。
- 同步文件额外使用工作区密钥加密并认证完整内容，以服务端地址和用户名作为作用域。密钥不随缓存落盘。换账号、换服务端、工作区密钥变化或文件损坏时重新建立基线。
- macOS 存在 Application Support 下的 `My Notes/NotesSync-v1`；Android 存在应用不参与备份的私有目录 `notes-sync-v1`。退出登录清理对应缓存；Android 还拒绝注销前排队任务的迟到写入。
- macOS 刷新前保存本地编辑；保存失败时保留未保存内容并停止刷新。现有写入 `revision` / `If-Match` 冲突检查保留。
- Android 仍可先展示本机只读阅读快照，网络同步成功后才开放编辑。Android 的首轮基线包含回收站，后续不再进入回收站时重复全量下载。
- 新客户端遇到旧服务端的增量接口 `404` 时使用原接口。网络错误、`401`、`503` 或不合法的成功响应不会静默冒充一次成功的增量同步。空/无效/过期 epoch/超前游标由服务端返回 `reset: true`，客户端丢弃旧基线重建。

## 部署顺序

本次代码验证使用本地/合成数据，不等同于线上发布或真实双设备同步验证。正式启用顺序如下：

1. 查看生产 D1 已应用迁移并确认有可恢复备份；仅执行本次待应用迁移，不重跑历史清理脚本。
2. 应用 `0014_notes_incremental_sync.sql`，检查 2 张同步表、9 个同步触发器、初始变更索引和外键完整性。
3. 部署包含 `/api/admin/notes-sync` 的 Worker。旧客户端继续正常工作，其写入同样进入增量索引。
4. 更新 macOS / Android 客户端。首次同步建立缓存，第二次无变化刷新应返回空 `changes`；用两台设备验证编辑、移入回收站、恢复、永久删除及文件夹排序。

准备发布时在项目根目录执行以下命令；先检查迁移列表，确认生产只有 `0014` 待应用、备份成功后再继续后两条：

```bash
npx wrangler d1 migrations list superstar1014-blog --remote
npx wrangler d1 export superstar1014-blog --remote --output output/notes-before-sync-2026-09-09.sql
npx wrangler d1 migrations apply superstar1014-blog --remote
npm run deploy
```

旧 Worker 回滚时可以保留新增表和触发器；新客户端会回退全量接口。不要在新 Worker 仍在线时移除同步表。恢复数据库备份时按上文更换 epoch。

## 验证入口

```bash
npm test
swift test --package-path macos/AIBuildNotes
npx wrangler deploy --dry-run
```

服务端 `tests/notes-sync.test.mjs` 使用真实 SQLite 执行全部迁移，验证历史数据初始化、增量、空响应、删除、排序、附件、分页并发变化、字节预算、epoch 重置及事务回滚。Node.js 需提供 `node:sqlite`（本轮使用 22.23.1）。另以临时本地 D1 应用全部迁移并执行同步 SQL，验证 Cloudflare 运行时中的嵌套触发器和删除标记。

macOS `NotesSyncTests` 使用 URLProtocol 模拟网络验证重启复用游标、分页删除、epoch 重建、中途失败、解密失败、缓存认证/隔离及异常分页。`AutoSaveTests` 保留旧服务端回退与自动保存回归覆盖。

Android 构建和设备测试：

```bash
cd android/MyNotes
./gradlew assembleDebug assembleDebugAndroidTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e uiQa notes-sync io.qzz.superstar1014.mynotes.test/io.qzz.superstar1014.mynotes.CryptoTestRunner
adb shell am instrument -w -e uiQa notes-startup io.qzz.superstar1014.mynotes.test/io.qzz.superstar1014.mynotes.CryptoTestRunner
```

设备用例使用本机回环合成服务，无需真实账号。请在专用且已解锁的模拟器上运行，会清理该测试应用的本机缓存与会话。

2026-09-09 本轮验证结果：服务端 275 项测试、macOS 80 项测试、Android 两组设备用例通过；Worker dry-run、全部迁移在临时本地 D1 应用、同步 SQL 运行、数据库完整性检查、macOS release 构建与签名检查、Android debug APK 构建均通过。生产迁移已于 2026-09-09 后续执行，Worker 已于同日后续发布，macOS 已更新并完成真实同步请求验证；Android 仅打包交付，真实双设备验收尚未执行。

项目原有 `node_modules` 的 workerd 原生运行时无法加载，本轮使用 `/tmp/my-notes-sync-runtime` 中按现有 lockfile 安装的依赖完成 Wrangler 检查，未变更依赖清单或锁文件。后续本机使用 Wrangler 如遇同样错误，应先修复依赖安装，再执行发布命令。

## 生产迁移记录（2026-09-09）

已将 `0014_notes_incremental_sync.sql` 应用到生产库 `superstar1014-blog`。执行前确认仅此一项待迁移，并导出备份、在本地内存 SQLite 完整恢复验证；执行后确认 2 张同步表、9 个同步触发器和工作区索引就绪，全部 7 篇笔记、3 个文件夹已纳入变更索引，数据数量保持不变，数据库完整性与外键检查通过，无剩余待应用迁移。

备份和核验记录位于被 Git 忽略的 `output/notes-migration-20260909-143525/`。本次生产核验仅读取元数据和数量，未执行业务增删改。后续 Worker 和 macOS 已更新，详见下方发布记录。

## 发布与客户端交付（2026-09-09）

- Worker `wispy-cloud-0978` 已发布，版本 `3dfb9755-400d-4a85-85d1-5c5534e4b7ce`，覆盖 `superstar1014.qzz.io` 与 `h.superstar1014.qzz.io`。上一个版本 `f346e318-4234-4c48-8b8c-c05103026d7f` 已记录，可用于回滚。
- macOS 1.16 (20) 已安装并运行于 `/Applications/My Notes.app`；旧版移入废纸篓，构建重复 App 清理，签名和可执行文件摘要核对通过，保留现有用户数据与钥匙串。Hermes User-Agent 同步更新为 1.16。
- 已通过新版 Mac 实际发起首次同步与带游标刷新，两次 `/api/admin/notes-sync` 均返回 200 / ok；线上观测仅记录固定路径、是否带游标和状态，不保存请求头、正文或笔记内容。未检查线上响应体或执行跨设备修改测试。两个域名未登录请求均为 401 / no-store。
- Android 2.23 (34) APK 已构建并校验签名，文件为 `output/My Notes-Android-2.23.apk`。沿用现有 Android Debug 签名，按用户要求只打包，不安装到手机。该安装包包含已有 Android 启动阅读缓存和 Hermes 默认入口优化，继续保留并由测试覆盖。
- 发布检查：275 项 Node 测试与 80 项 Swift 测试通过。此前 Android 两组模拟器用例通过，本轮版本号更新后重新构建并核对 APK 标识与签名。

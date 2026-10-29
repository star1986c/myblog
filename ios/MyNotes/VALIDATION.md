# iPhone 验证记录

## 0.1.3 (4) 真机安装与续签副本 — 2026-10-29

- 从通过回归的源码生成固定快照 `local-0.1.3-4-db09bf9bfbeca3f5`（78 文件），签名构建后保留应用数据覆盖安装；CoreDevice 确认 **0.1.3 (4)**，并成功启动。
- 安装前验证版本、团队、Bundle ID、设备描述文件、有效期和代码签名；安装成功后更新续签配置、清单、元数据、状态及构建。固定源码逐文件 SHA-256 全部通过，Swift 源码/工程与已测试工作区一致。
- 旧配置、状态及构建备份到 `upgrade-backups/0.1.2-to-0.1.3-20261029T031459Z/`，旧源码保留。普通续签检查返回 `healthy / not_due`；未恢复自动任务。
- 签名仍于 **2026-11-04 16:14:22（Asia/Taipei）**到期，本次为版本升级，未强制重新申请七天签名。通过数据线安装，未重测无线续签；真实重复会话的显示效果待用户使用确认，未读取用户聊天正文。
- 证据：本机续签目录 `logs/upgrade-013-summary.json`、`upgrade-013-build.log`、`upgrade-013-after.json`，以及 `/private/tmp/mynotes-013-launch.json`。跨客户端契约定向测试另有 **5/5** 通过（`/private/tmp/mynotes-replay-parity.log`）。
- 快照冻结于安装之前，内含文档记录当时验证状态；安装完成后的文档在仓库及续签目录顶层 README 更新，不重写已核验的固定源码。

## 0.1.3 (4) 重放消息去重 — 2026-10-29

- 复现：原始消息不在补同步窗口/本地缓存时，同一最终流式事件在两次批次和一次冷启动后生成 3 个气泡。
- 修复：界面和加密历史使用同一合并器，按消息 ID、原目标序号归并；保存本地编辑版本，旧原文/旧 final 不覆盖已完成的新回复。加载旧缓存自动归并同 ID/正序号重复项，收到 final 重放时修复旧孤立副本。不会按正文误合并独立回复。
- 保留附件、交互清除、原消息删除标识和事件级同步游标；新增字段仅进入本地加密快照，不改变线上加密消息格式。无法从现有标识确认关联的历史消息不按文字删除。
- 共享 Swift 测试 **100/100**（83 核心、17 macOS），iOS 模拟器 **21/21**（15 单元、6 UI），续签脚本 **11/11**；Release 无签名真机编译通过。新增 8 项共享回归和 1 项 iOS 冷启动回归覆盖缺失原文、重复/乱序 final、旧缓存、附件、交互、相同文字独立消息、后台恢复及未读数。
- 证据：`/private/tmp/mynotes-replay-negative.log`（修复前失败）、`/private/tmp/mynotes-replay-swift.log`、`/private/tmp/mynotes-replay-final.log`、`/private/tmp/mynotes-ios-replay-tests.log` / `.xcresult`、`/private/tmp/mynotes-ios-replay-release.log`。
- 本段记录本地测试结果；真实用户聊天内容未读取，Worker/NAS 未部署或修改。真机安装与续签快照以本版本后续安装记录为准。

## 0.1.2 (3) 真机升级与续签快照 — 2026-10-29

- 用户授权安装新版并更新手动续签快照。从已验证源码生成固定快照 `local-0.1.2-3-b3a8986715295cd9`，包含新增 MobileChatAttachments.swift 等 76 个文件。
- 从固定快照使用原团队和 Bundle ID 签名构建，核验签名、目标设备和描述文件后，通过数据线覆盖安装；未卸载应用。CoreDevice 安装后确认 **0.1.2 (3)**，启动成功。
- 手动续签 config、manifest、metadata、state 与签名构建均更新至新版；逐文件哈希、源码/工程与工作区的一致性通过。旧快照、配置、状态和构建保存在本机 `upgrade-backups/0.1.1-to-0.1.2-20261029T024512Z/`。
- 11 项续签离线测试、桌面入口语法、脚本正常未到期检查通过（healthy / not_due）。没有恢复自动任务。
- 沿用有效描述文件，到期 **2026-11-04 16:14:22（Asia/Taipei）**；本次升级不代表新取得 7 天签名，也未重测无线续签。真机已确认安装与启动；真实聊天图片和附件交互由用户实际使用验证，未读取聊天正文。
- 证据：`/private/tmp/mynotes-012-upgrade-build.log`、`/private/tmp/mynotes-012-launch.json`，本机续签目录 `logs/upgrade-after.json` 与 `logs/install.json`。

以下修复记录中的“尚未安装”是升级前状态，当前安装与快照以上述记录为准。

## 0.1.2 (3) 图片与附件预览 — 2026-10-29

- 聊天中的发送/接收图片显示异步缩略图，按 MIME 或扩展名识别；解码最长边 840 像素，缓存限 40 张/24 MiB，并按会话隔离。
- 图片和文档使用统一 Quick Look 预览容器，提供明确的“完成”和系统分享入口；关闭后保留原聊天页面。离开聊天后迟到的打开任务被丢弃，预览副本关闭时清理。
- 模拟器完整回归 20/20 通过（14 单元、6 UI）；包含发送图片 → 关闭 → 文档 → 关闭 → 再开图片 → 关闭，以及切换到接收图片会话后打开/关闭、返回会话列表。
- 单元测试验证降采样、错误格式回退、缓存隔离、预览副本删除后原图完整。目视检查合成图片缩略图及图片/文档关闭按钮；模拟器演示数据不向真实服务发送消息。
- 289 项 Node 测试、工程生成稳定性和 plist 语法通过。增加系统分享入口后的附件往返定向复测、最终 Release 无签名构建也通过。
- 尚未安装此版本到 iPhone，也未更新本机手动续签快照；手机/续签当前仍为 0.1.1 (2)。未提交或推送本轮修改。

证据：`/private/tmp/mynotes-ios-attachments-tests.log` 和 `.xcresult`；最终定向测试 `/private/tmp/mynotes-ios-attachments-final.log` 和 `.xcresult`；Release `/private/tmp/mynotes-ios-attachments-release-final.log`。截图保存在忽略目录 `output/ios-attachments-validation/`。

## 0.1.1 (2) 真机安装与快照更新 — 2026-10-29

- 用户明确要求安装新版并同步手动续签快照。使用固定快照 `local-0.1.1-2-a138b38d1f476dbb` 的 74 个文件签名构建；该快照来自已测试工作区，未创建 Git 提交，不包含 Android 修改。
- 核对签名团队、Bundle ID、目标设备、描述文件有效期、签名完整性及包内版本后，以数据线覆盖安装。CoreDevice 随后查询确认手机为 **0.1.1 (2)**，启动返回成功。
- 本机续签 config、manifest、metadata、state 和已签名构建同步切换到新版；旧快照、旧配置及构建均保留在私有备份目录。
- 11 项续签脚本离线测试、桌面脚本语法、完整源码清单校验通过。脚本正常检查返回 `healthy / not_due`。自动任务未恢复。
- 沿用有效签名，到期为 **2026-11-04 16:14:22（Asia/Taipei）**；本轮是升级，不代表重新获得 7 天或已复测无线续签。白屏、实际账号聊天和 Face ID 宽限仍需用户实际使用确认。
- 证据：`/private/tmp/mynotes-upgrade-build.log`、`/private/tmp/mynotes-upgrade-launch.json`；本机续签 `logs/upgrade-after.json` 和 `logs/install.json`。

以下为安装前代码验收记录，安装和快照状态以上述新记录为准。

## 0.1.1 (2) 体验修复 — 2026-10-29

- iOS 单元测试 13 项通过，UI 测试 5 项均已通过：完整回归 17/18 项通过后，将原生 Picker 选中值的错误 StaticText 查询改为 accessibility value 查询，该项定向复测通过。应用代码未因测试断言调整而变化。
- 连续 6 次进入主/个人会话、切换设置标签、后台返回，验证对应聊天正文存在且可见，之后能返回会话列表。草稿隔离、后台草稿保留、笔记编辑、保护正文和命令面板回归通过。
- 应用锁覆盖 179/180 秒、299/300 秒边界、立即锁定、关闭应用锁、冷启动、设置持久化、inactive 中断、重复后台回调、取消认证、重复认证和后台迟到的认证结果。测试注入时钟与认证结果，不能代替真机 Face ID 验证。
- 目视检查浅色会话列表、聊天/键盘、深色聊天和设置。截图使用合成数据，不连接生产服务，位于 `output/ios-polish-validation/`。
- 最终真机 Release 无签名构建通过，Info.plist 确认为 0.1.1 (2)。工程生成稳定、plist 语法及 git diff --check 通过。
- 本轮保留的 16 个既有 Android、手动续签及其他未提交文件哈希一致；未部署后端、恢复自动续签或安装手机，未提交/推送本轮修改。

证据：

- `/private/tmp/mynotes-ios-polish-tests-3.log` / `.xcresult`：13 单元 + 5 UI 的完整运行，其中设置测试有一处查询类型错误。
- `/private/tmp/mynotes-ios-polish-settings-final.log` / `.xcresult`：修正查询后的设置与深色模式测试通过。
- `/private/tmp/mynotes-ios-polish-release-final.log`：最终 0.1.1 (2) 真机 Release 构建通过。

用户报告的偶发白屏未在修改前稳定复现。本轮修复了代码中导航注册、页面出现/离开和标签切换分别修改会话状态的问题；通过上述模拟器回归，真实账号、真机白屏和 Face ID 体验仍需安装后确认。手动续签的私有源码快照仍是首版，后续安装新版时需一并更新快照。

## 0.1.0 首版工程交付记录

日期：2026-10-28（Asia/Taipei）。用户已明确选择先完成工程、稍后安装。

## 最终结果

| 检查 | 结果 |
| --- | --- |
| iPhone / iOS Release 编译，CODE_SIGNING_ALLOWED=NO | 通过；未签名，不代表可直接安装 |
| iOS 模拟器 Debug 编译与测试 | 通过，10 项：7 单元 + 3 UI |
| 共享 NotesCore Swift 测试 | 75 项通过 |
| macOS UI 辅助逻辑 Swift 测试 | 17 项通过 |
| Hermes 跨端能力、Mac 连接、协议及笔记增量同步 Node 检查 | 32 项通过；旧协议用例偶发失败说明见下文 |
| Info.plist / project.pbxproj 语法 | 通过 |
| 工程生成脚本重复运行 | 两个工程文件内容一致 |
| git diff --check | 通过 |

开发环境：Xcode 27.1，Swift 6，iOS SDK 27.1。测试设备为新建的 `MyNotes iPhone QA`（iPhone 17 Pro Max，iOS 26.1）；未修改或重置既有模拟器。

最终 iOS 测试使用系统暗色外观，并关闭测试并行克隆。已目视检查实际暗色聊天和笔记截图；此前也检查了亮色笔记与命令面板。启动参数未成功切换外观的早期结果不作为暗色证据。

## 覆盖内容

- 图像缩放、JPEG 转码、上传大小边界、文件导入格式与大小限制、导出文件名净化。
- Markdown 标题、列表、代码原文和流式未闭合代码围栏。
- 会话导航、profile 草稿隔离、切到后台再返回时保留内存草稿。
- 笔记列表/编辑页面、受保护正文隐藏、命令面板。
- 共享音频 AES-GCM 元数据/正文往返、无效音频时长拒绝。
- 后台暂停前落盘已接收消息，恢复后拒绝旧连接代次事件，保留历史。
- 受保护笔记保存失败时保留编辑，网络恢复后可重新保存并锁定。
- 刷新保留当前笔记、过期编辑回调拒绝修改其他笔记、自动/手动/后台并发保存合并。
- 录音权限晚返回及重复点击、后台保存到期只释放一次系统任务、旧聊天页面退出不清除新会话选择。
- 附件上传失败返回失败状态，编辑器保留媒体以便重试。
- 原有账号会话、笔记同步、加密、附件、Hermes 消息/交互等共享测试。

## 证据

仓库本机忽略目录 `output/ios-validation/` 包含最初交付的构建日志与亮色/暗色界面截图。提交前修复回归证据位于：

- `/private/tmp/mynotes-review-ios-tests.log`、`/private/tmp/mynotes-review-ios-tests.xcresult`：10 项 iOS 测试。
- `/private/tmp/mynotes-review-release.log`：无签名真机 Release 构建。
- `/private/tmp/mynotes-review-swift.log`：75 项核心 + 17 项 Mac 测试。
- `/private/tmp/mynotes-review-node.log`：首次 Node 检查，31/32 项通过。
- `/private/tmp/mynotes-review-node-deterministic.log`：确定性临时夹具验证，32/32 项通过。
- `/private/tmp/mynotes-review-node-rerun.log`：仓库原用例复跑，32/32 项通过。

这些日志、结果包和截图是本机产物，不提交到源码仓库。

### 旧协议测试的偶发失败

`tests/hermes-chat-protocol.test.mjs` 的篡改票据测试把签名的最后一个 Base64URL 字符替换成 `x`/`y`。当最后字符为 `w` 时，替换为 `x` 只修改未使用的填充位，解码后的签名字节完全相同，因此“无效签名”断言会偶发失败。已用字节比较独立复现此夹具缺陷。

为验证真实的篡改拒绝行为，将测试复制到临时目录，仅把篡改位置改为签名首字符，完整的 32 项检查通过；随后原用例完整复跑亦通过。此问题与 iPhone 修改无关，协议实现及原测试保持未改动，没有通过移除断言或修改后端来规避失败。

## 未验证范围

- 没有在用户手机安装，没有生成个人签名证书或描述文件，没有上传 App Store。
- 尚未进行真实账号登录、三端读写联调、真实 NAS 聊天/审批、相机/麦克风/Face ID 和长时间后台实测。
- 所有 UI 测试使用本机演示数据，不向生产 Hermes 发送测试消息。
- 没有部署 Worker、修改数据库或 NAS；既有 Android 工作区变更保留。
- 此版本的冷启动离线笔记、进程退出后的未发送草稿恢复和后台推送不在已实现能力内，详见 README。

# My Notes iPhone 个人版

原生 SwiftUI iPhone 客户端，最低 iOS 17。功能以 Android My Notes 为参考，与 macOS 复用 `NotesCore`、现有 Cloudflare API 和 NAS Hermes 插件。无需为此版本部署 Worker、迁移数据库或升级插件。

当前源码版本：**0.1.4 (5)**。本版修复 Hermes 会话列表附件消息摘要空白，优先显示文字说明，否则显示附件名称和数量；保留重放消息去重及图片/附件预览修复；验证与安装状态见 VALIDATION.md。My Notes 本身不直接接入 APNs，也不申请后台常驻能力；Hermes 提醒可由独立 Bark App 接收，见 [Bark 配置说明](../../docs/bark-push.md)。

## 打开工程

用 Xcode 打开 `ios/MyNotes/MyNotes.xcodeproj`，选择 `MyNotes` scheme。`NotesCore` 通过相对路径引用 `../../macos/AIBuildNotes`，必须保留仓库目录结构，不能只复制 `.xcodeproj`。

工程没有第三方 iOS UI 依赖，也不需要 CocoaPods 或 XcodeGen。新增、删除 Swift 文件后可在仓库根目录运行：

```sh
python3 scripts/generate-ios-project.py
```

此脚本会重建工程，不保存个人 Team 设置；若已设置签名团队，重新生成后需在 Xcode 再选择 Team。

## 免费 Apple 账号安装到自己的 iPhone

1. Xcode → Settings → Apple Accounts，登录自己的 Apple 账号。密码和验证码仅在苹果界面输入。
2. 数据线连接 iPhone，解锁并选择“信任此电脑”。在“设置 → 隐私与安全性 → 开发者模式”开启并按提示重启；首次配对后才可能出现此项。
3. 在 Xcode 选中工程 → `MyNotes` target → Signing & Capabilities，勾选 Automatically manage signing，Team 选择自己的 **Personal Team**。
4. 默认 Bundle Identifier 为 `io.qzz.superstar1014.mynotes.ios`。如提示被占用，改为自己的唯一标识，例如 `com.yourname.mynotes.personal`；确定后保持不变。
5. 顶部运行目标选自己的 iPhone 17 Pro Max，点击 Run（⌘R）。如果系统要求信任开发者，在“设置 → 通用 → VPN 与设备管理”中完成信任。
6. 登录现有 My Notes 账号，在每个 Hermes 会话中输入该 profile 对应的 `HERMES_CF_CHAT_KEY`。不要把密钥写入源码或截图。

**免费签名描述文件 7 天到期**：用同一 Apple 账号、同一 Bundle ID 再从 Xcode 运行覆盖安装。不要先卸载，避免删除本机数据；云端已同步内容不受签名到期影响。无需上传 App Store Connect，也无需 TestFlight。

若 Xcode 提示系统版本不受支持或无法准备开发者磁盘映像，先把 Xcode 更新到支持该 iPhone 系统的版本，再运行。当前开发环境为 Xcode 27.1、iOS SDK 27.1；已连接手机报告 iOS 27.2，首版已验证该组合可安装并启动，完整真机功能联调仍需另行验证。

官方资料：[免费账号限制](https://developer.apple.com/help/account/basics/about-your-developer-account)、[在设备上运行应用](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device)。

本机双击脚本、无线手动续签及账号故障处理见 [续签说明](AUTO_RENEWAL.md)；自动任务已按用户要求暂停。本机已安装 0.1.4 (5)，续签固定快照已同步更新；以后升级仍需一并更新快照，脚本的版本检查会阻止旧快照覆盖较新安装。

## iPhone 交互与隐私设置

- Hermes 会话按稳定 ID 保存导航路径，切换底部标签或返回前台后恢复当前会话；列表返回、新会话进入不再分别改写当前会话。加载中、暂无消息及搜索无结果均有明确提示。
- 图片附件在消息内异步显示缩略图，点开查看原文件；加载失败时仍可点开重试。缩略图只在内存缓存，按会话隔离。聊天和笔记的附件预览均可点右上角“完成”回到原页面，也可下滑关闭。
- 使用 iOS 原生导航、分组列表、选择页与底部输入区，页面采用系统灰阶背景和柔和蓝灰强调色。在「设置 → 外观 → 显示模式」可选择跟随系统、浅色或深色。
- 「设置 → 隐私 → 返回时要求解锁」支持立即、3 分钟后、5 分钟后，默认 3 分钟。启用应用锁后，从真正进入后台开始计时；宽限期内返回无需再次验证，权限弹窗等临时中断不开始计时。
- 冷启动/进程被系统终止后的重新启动仍需验证。后台预览仍遮挡内容，受保护笔记的独立密码规则不变。

## 功能范围

| 模块 | 此版本实现 |
| --- | --- |
| 账号 | 登录、设备令牌恢复、退出、修改密码、强制更新初始密码 |
| 笔记 | 列表、新建、编辑、2 秒静默自动保存、手动保存、本机搜索、回收站恢复/永久删除 |
| 文件夹 | 新建、重命名、上移/下移排序、删除、移动笔记、未分类 |
| 保护 | 复用跨端保护密码与密文格式；保护/解锁/取消保护；后台尝试保存并重新锁定 |
| 笔记媒体 | 相册/拍照、最长 5 分钟 AAC 录音、加密上传、按需预览/播放/系统分享、删除附件 |
| Hermes | 动态多 profile、密钥配置/移除、单 WebSocket 多路复用、流式更新、前台重连、跨端同步、历史补同步 |
| 聊天交互 | 本地搜索、未读数、文字/代码复制、基础 Markdown、命令目录/补全、审批/澄清/模型选择按钮 |
| 聊天附件 | 图片、录音、文件上传（每条最多 8 个，每个最多 10 MiB）、下载/预览/系统分享，沿用共享核心的私有 R2 大附件校验 |
| 管理 | 单条/多条删除（最多 100 条）、清空会话、设置本机缓存保留期 |
| 手机隐私 | 可选 Face ID/设备密码应用锁、全窗口后台遮罩、本机钥匙串、私有临时文件完整数据保护、缓存排除系统备份 |

### 与 Android 的差异和当前限制

- **My Notes 本身没有原生后台推送、后台常驻服务或后台录音**；通知通过独立 Bark App 接收。后台连接主动暂停；重新打开或网络恢复时重连，并按原有检查点补同步。录音在进入后台时取消。
- 首次启动及冷启动恢复笔记工作区需要联网认证和获取工作区密钥。尚未移植 Android 的“冷启动离线只读快照”功能；此版本不会把工作区密钥持久化到手机。已加载的数据在本次运行中可阅读。
- 聊天草稿按 profile 在内存中隔离保留；应用进程被系统终止后不会恢复未发送草稿。请发送或复制重要草稿后离开。
- 保存失败会显示错误并保留本次运行中的编辑，完成按钮不会直接关闭笔记。后台保存受 iOS 给定时间限制，未保存内容在进程被终止后仍可能丢失；断网时不要退出或强制结束应用。
- 笔记照片/录音上传失败会保留在当前编辑器，可重试或移除；这份待上传媒体不会在应用进程终止后恢复。
- 笔记保护密码仍需手动输入。应用锁使用 Face ID 或设备密码，不会替代独立的笔记保护密码。
- 附件通过 iOS Quick Look/分享菜单预览、播放和保存；实际支持的编解码器及文档格式取决于系统/已安装应用。Markdown 支持标题、列表、行内样式和围栏代码，复杂表格等保留可读原文。
- 接收私有 R2 大文件时沿用现有服务端协议，它与普通端到端加密附件的存储路径不同；本机副本受 iOS 数据保护，不改变协议语义。
- 尚未验证真机相机、麦克风、Face ID、真实账号跨三端同步、NAS 指令执行和长时间后台恢复。模拟器验证不会向生产 Hermes 发送消息。

## 验证和开发

模拟器构建（不需要 Apple 账号）：

```sh
xcodebuild -project ios/MyNotes/MyNotes.xcodeproj -scheme MyNotes \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /private/tmp/mynotes-ios-build CODE_SIGNING_ALLOWED=NO build
```

使用实际存在的模拟器 ID 执行测试：

```sh
xcodebuild -project ios/MyNotes/MyNotes.xcodeproj -scheme MyNotes \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UDID' \
  -derivedDataPath /private/tmp/mynotes-ios-build CODE_SIGNING_ALLOWED=NO test
swift test --package-path macos/AIBuildNotes
```

Debug 运行参数 `--preview` 可打开本机合成数据界面，测试宿主也自动使用演示数据；正常 Debug/Release 启动均连接真实服务，Release 忽略此参数。演示模式用于浏览界面，不用于验证真实网络变更。

测试涵盖媒体尺寸/格式/大小边界、会话草稿隔离、笔记导航、受保护正文隐藏、命令面板，以及共享核心的加密/保存/同步/审批等回归。独立测试模拟器名为 `MyNotes iPhone QA`，未重置已有模拟器。

开发计划与逐次验证记录位于 `Planning/`；具体交付验证结果见 [VALIDATION.md](VALIDATION.md)。

### Hermes 大量消息加载

- 有本地 sequence 时，冷启动直接增量补齐；没有检查点时初始化最近 24 小时，较早历史仍可通过“补同步历史”请求。
- 服务端每页 100 条，客户端处理并写入本页后才继续下一页；事件流不再丢弃超过 1,000 条的旧事件。
- 批量合并建立 ID / sequence 索引，重复回放不触发无变化的界面发布或快照写盘。iOS 对正文不变的 Markdown 视图跳过重复更新。
- 消息界面仍从最近 40 条开始。本地仍是加密整份快照，尚未改成数据库分页；所有 profile 的缓存仍会载入内存。

# iPhone 0.1.0 验证记录

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

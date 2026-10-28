# 实现发现

- 已有 macOS Swift Package 导出 NotesCore，使用 Foundation、CryptoKit、Security 和 Combine；可以添加 iOS 平台支持。
- Android 使用 foreground remoteMessaging service；iOS 此版本不做后台常驻或 APNs，前台重连并补同步。
- 当前已有未提交 Android 变更，本次保留。
- 模拟器查询在沙箱内无法连接 CoreSimulatorService，需要正常宿主权限执行。
- 本机 Xcode 27.1、iOS SDK 27.1；已安装 iOS 26.0/26.1 模拟器。真机查询显示系统 27.2，需要在安装时验证 Xcode 设备支持。
- NotesCore 原先可解密安卓 audio/mp4，但加密器不填写 durationMillis；现增加兼容的可选参数，原图片调用保持不变。
- 免费签名工程不包含 APNs、iCloud、App Groups 或其他付费能力。
- 最终视觉检查发现 iOS 启动参数 `-AppleInterfaceStyle Dark` 没有切换实际外观；不把该轮作为暗色证据。已改用独立模拟器 `simctl ui appearance dark`，并禁用测试并行克隆以验证实际系统外观。
- 聊天 Markdown 原始标题标记已改为标题/列表/代码块渲染；加入不完整流式代码围栏回归。

## 提交前审查修复

- 刷新与编辑绑定可能使用过期选中项，已保留当前选择并校验笔记 ID。
- 自动、手动和后台保存并发请求同一 revision，已合并同一笔记的在途保存，并继续保存期间新增的编辑。
- 录音权限回调晚于取消、重复点击录音、后台保存任务到期、旧会话退出晚于新会话进入均已加生命周期保护。
- 聊天发送、交互、历史刷新明确绑定 profile；附件失败保留本次编辑中的媒体供重试。
- 旧 Node 票据用例存在 Base64URL 末位篡改偶发无效问题，已独立验证并记录在 VALIDATION.md，未混入无关协议改动。

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

## 自动续签

- xcodebuild -allowProvisioningUpdates 支持自动创建和更新签名资源，但不能把重复构建误认为有效期已延长；必须比较 embedded.mobileprovision 的到期时间。
- Apple 无线运行说明：https://help.apple.com/xcode/mac/current/en.lproj/dev3e2f4ee6d.html；已配对设备同网可用 Bonjour 连接。

- 拔线实测 CoreDevice transportType=localNetwork；备份并移走仅本应用描述文件后，Xcode 返回新的 UUID，签名到期从 11-04 15:34 延长至 15:50。无线覆盖安装成功。
- 完整脚本验证曾连续遇到 No Accounts；直接调用无缓存构建也失败。CUA 确认 Mac 已锁屏，需要用户解锁后复测，不能将原因武断归结于 Python 子进程。

- 后续 Mac 已解锁且 Xcode GUI 显示个人团队，Download Manual Profiles 完成后，xcodebuild 仍报 No Accounts；根因尚未确认，需重新认证后复测。
- 自动任务最终状态 PAUSED，用户明确只用手动脚本。桌面入口不依赖 Codex，无需自动任务运行。

## 2026-10-29 iPhone 体验

- 原会话目的地在 List 上注册，选中会话由列表 onAppear、聊天出现/离开、Tab 切换分别改写；应用锁切换会重建导航树。改为模型持有稳定 profile ID 路径，统一根据路径、标签、前后台、锁状态同步可见会话，目的地注册移出惰性列表。
- 聊天视图按 profile ID 隔离，进入后滚动到当前会话底部；加载、空聊天、搜索无结果、会话被移除均有明确状态。
- 应用锁用 ContinuousClock 记录真正进入后台的时间，默认 180 秒，可设 0/180/300 秒。inactive 不计时；重复后台通知不重置起点；冷启动始终锁定；后台返回的认证结果不能解锁。
- 使用系统分组背景、材质、原生导航/选择页及低饱和蓝灰强调色，支持跟随系统、浅色、深色。
- 原生 navigationLink Picker 选择后自动返回，UI 测试不能再额外点击返回；增加设置区块后旧版本信息断言需先滚动。

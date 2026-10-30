# 排查发现

- 当前 Git 工作区开始时干净；没有发现适用的 AGENTS.md。
- HermesChatStore 为 MainActor ObservableObject；需检查选择事件是否带同步磁盘操作。
- 视图默认一次显示最近 160 条；Markdown 在 View body 中解析，需测量切换布局是否放大成本。
- 历史约定是打开后每个 profile 同步最近 24 小时，随后按序号增量同步；需在当前源码验证。
- 当前源码 selectProfile 仅改变 selectedProfileID 和未读计数；selectedMessages 为内存字典读取。切换不调用联网或磁盘读取。
- 时间线带 .id(profile.id)，切换后重建；onAppear 调用 scrollToBottom。显示窗口为 160 条，Markdown 段落和 inline attributed string 均在 View body 解析。
- 安装版为 1.16 (20)，三个本地加密历史文件约 15.5 / 164.9 / 326.1 KiB；暂未读取正文，不能据文件大小直接得出消息条数。
- 实际 App 可访问，显示 3 个 profile、WebSocket 已连接。
- 安装版与工作区 release 可执行文件 Mach-O UUID 相同，可用当前符号定位采样。
- 20 秒采样取得 8141 个主线程样本，7062 个位于 SwiftUI runloop observer、7017 个位于 GraphHost.flushTransactions；SelectionOverlay.updateNSView / NSTextField 排版频繁出现。该采样与 UI 自动化观察重叠，不能直接当作用户点击延迟。
- 切换操作的 Computer Use 返回 noWindowsAvailable，随后状态读取 timeoutReached；因此尚未可靠取得切换后的 profile 或端到端耗时。
- 停止 UI 操作后的 5 秒采样中，2017 个主线程样本有 2010 个在 GraphHost.flushTransactions；没有主线程网络等待或 AX 层次遍历样本。SelectionOverlay / LazyVStack 排版依旧突出。静置仍在反复布局，不能归为一次正常的 Markdown 解析耗时。
- 同期进程 CPU 为 99.6%，physical footprint 从首轮 544 MB 升至 3.1 GB；两个 nettop 间隔样本的收发字节均不变（5652/2924）。
- 缓存大小已按 profile 文件名映射：primary 333953 字节，personal 168852 字节，mkwork 15894 字节。总计 518699 字节（约 0.50 MiB）。未解密，未获取精确消息条数。
- 公共端点无认证探测 0.94 秒返回 401；仅证明入口能返回响应，不是已登录 WebSocket、NAS 或 Hermes 模型响应耗时证据。
- 优先诊断结论：安装版存在持续的主线程布局重算，当前证据不支持网络导致 profile 切换卡顿。精确触发组合仍需隔离实验；文本选择、长文自动换行、LazyVStack 和切换时滚到底部是重点。

## 重启验证与优化范围

- 经用户明确批准重启。重新打开原安装版后，未再执行 profile 切换；约 29 秒时 CPU 99.4%，3 秒采样 500/501 个主线程样本位于 GraphHost.flushTransactions，footprint 907.4 MB。说明重启后仍可复现布局问题。
- 已再次退出卡住的进程以停止资源增长，当前 App 保持关闭；安装包、缓存、钥匙串和业务源码均未修改。
- 第一优先级：隔离文字选择、自动换行、LazyVStack 以及出现时滚动行为，修复持续布局重算。必须保留长文完整显示、整条复制和部分文字选择。
- 第二优先级：首屏从最多 160 条调整为约 30–40 条，更多历史按需加载；不删除历史，不改变云端保留策略。
- 次要优化：缓存 Markdown 解析结果，让 profile 时间线只响应当前会话变化，避免其他 profile 的 typing 或消息触发无关滚动与重绘。
- 验证标准：安装版三个 profile 反复切换、长文/窄窗/部分选择、滚动加载旧消息、接收其他 profile 消息；空闲 CPU 应回落，内存不持续增长。当前仅完成诊断，尚未实施或验证优化收益。

## 优化验证（进行中）

- 首轮最小改动：消息首屏/追加批次 160 → 40；ScrollView 使用 defaultScrollAnchor(.bottom)，移除出现时立即 scrollTo；typing 变化仅观察当前 profile。
- 80 项 Swift 测试、15 项 Node Hermes 合约检查通过，release 构建和签名通过。
- 新包从 output 启动时被钥匙串访问阻塞，未进入聊天界面。已退出该进程，将签名验证通过的新包安装到原路径；旧包移入废纸篓，output 重复包已消除。未修改数据或钥匙串。
- 实际安装版已连续完成工作→主→个人→主→工作→个人六次切换；全部选择正确，未发生 UI 工具超时。
- 首轮修复后采样 physical footprint 163.3 MB（峰值 304.6 MB）；2118 个主线程样本中至少 1948 个处于消息等待，仅少量布局工作。六次切换后 CPU 0.0%、RSS 约 250 MB。

## 最终结果

- 最终仅修改消息窗口和滚动：首屏 40 条、每批追加 40 条；使用初始底部锚点，取消 onAppear 的立即 scrollTo；只因当前 profile 的 typing 变化触发滚动。
- Equatable 正文渲染复用实验在冷启动复测中再次出现布局循环，已完整撤回。最终消息正文渲染代码与原版一致，没有引入解析缓存。
- 最小修复在两次独立启动后正常工作；两轮各六次切换均选择正确且无超时。个人助手通过“加载更早”读出全部 117 条本地历史。
- 最后一次静置采样 footprint 109.0 MB（峰值 218.0 MB）；随后切换、窄栏、选择与复制后 RSS 约 250 MB、CPU 0.0%，未继续增长。不同内存指标不可直接混比。
- 聊天栏从原分栏 420 调整到 540 后，长文自动换行完整；鼠标双击选择 reset、Command-C 复制，粘到空输入框验证成功，立即清空且未发送。已恢复分栏宽度 420。
- 80 项 Swift 测试、15 项 Node Hermes 合约测试和 release 构建/签名验证通过。最终最小修复与第一轮通过版本仅注释有差异。
- 交付到 /Applications/My Notes.app；替换前版本保留于废纸篓，构建目录没有重复 App。当前为本机实际 App 验证，未更改 Cloudflare、NAS、网络协议、历史保留策略或钥匙串。

## 2026-09-29：Hermes v2026.9.24 兼容性审计

- 初始工作区只有此前遗留的三个未跟踪规划文件；本次追加记录，不覆盖旧内容。
- 本地插件清单及 HTTP User-Agent 均为 cloudflare_chat 0.3.6。
- 当前 unittest 套件使用 Hermes 模拟模块，不能单独作为新版本兼容证据。
- 已有真实上游审批脚本 verify_real_hermes_approval.py，可覆盖两个 profile 的 38 个审批场景；需在指定标签重新执行。
- 临时目录有旧版本虚拟环境及 v2026.9.21 审计目录。新标签源码另建目录，避免修改旧审计证据。
- 官方标签为 annotated tag e3dd27ee2d8b011737a4eea8e3eb3d711ab78690，固定 commit f97608f178d1ffeca59860195ab7da295f7c8e5f；已克隆至 /private/tmp/hermes-v2026.9.24-audit/upstream。
- 发现依赖声明冲突：上游 pyproject.toml 固定 cryptography==50.0.0；插件 requirements.txt 为 cryptography>=45,<48。待解析器复现和运行测试，不据此推断全部运行接口失效。
- 旧 sep22 虚拟环境未安装所需依赖；使用新的隔离环境。
- 联合依赖解析已明确失败（cryptography 两个范围交集为空）。为区分运行兼容性，另建按 Hermes core 依赖安装的 Python 3.12.13 环境，使用 cryptography 50.0.0、websockets 15.0.1。
- 该环境中插件 81 项 unittest、真实 Hermes 审批 38 场景、Worker/原生客户端协议 30 项 Node 测试通过。
- 真实 PluginManager 已加载插件且未报告弃用导入。初版审计夹具的合成 agent secret 长度不足、URL 路径不符合 /api/hermes-chat/ws，导致配置检查拒绝；修正夹具后重跑，不属于插件回归。
- 真实运行扩展验证 13 项全部通过：启用/禁用加载、作用域 registry 卸载、基类签名、并发 A/B/A 配置及密钥隔离、实际基类消息收发和忙碌 /status /stop、真实流消费者 finalize、五类附件双向转换、10 MiB 以上直传流程、澄清、命令确认、模型/选项回调、重连 checkpoint、独立 cron 投递。
- 新脚本只替换网络边界和模型处理回调，保留真实 PluginManager、BasePlatformAdapter、GatewayStreamConsumer、profile runtime scope、审批/澄清 resolver。脚本外联由 Python audit hook 阻断。
- 测试夹具追加修正：adapter_factory 是工厂 lambda 而非类型，改为实例化后比较；上游异步写入与逐测试删除目录竞争，改为保留临时合成目录。本次运行测试 13/13 通过。
- 33 个适用于当前主机的 Hermes core 直接依赖版本全部满足。新版弃用导入扫描无命中。
- 安装 dry-run 证明现有 requirements.txt 会把 cryptography 50.0.0 降为 47.0.0（未执行降级）。临时候选范围 >=50,<51 与上游联合解析成功；未修改插件依赖文件。
- 新版 Hermes 依赖读取器只识别 pyproject 或 manifest python_dependencies；本插件读取结果为空。是依赖管理元数据缺口，尚未据此认定当前运行失败。

## 2026-09-29：0.3.7 修复范围

- 用户报告 NAS Hermes 已升级，现有插件仍可使用；授权修复并交付插件包，NAS 部署由用户处理。
- 修复采用 cryptography>=50,<51，保留 websockets>=14,<17；在 plugin.yaml 中同步 python_dependencies，使新版 Hermes 原生依赖流程可读取。
- 运行接口和中继协议没有已复现故障，本次不扩展到 Worker、客户端或聊天处理逻辑。
- 在固定上游 0.21.5 中，插件清单的 requires_hermes 版本门槛通过原生校验；原生依赖声明与 requirements.txt 完全一致，原生候选依赖联合 dry-run 成功。
- 本次源码回归与真实上游集成全部通过；打包后仍需逐文件比对归档，才可交付。
- 两种发布归档逐字节匹配插件源码 6 文件，SHA-256 复核通过；ZIP 解包后的清单经真实 Hermes 原生校验成功。仅测试环境验证，NAS/Linux 真正部署及网络联通由用户验收。

## 2026-09-29 15:07–15:11：会话切换慢与白屏复查

- 当前安装版 UUID 9DC6A94C-BAC3-383C-B9B9-DB065F8D7EAE，仍为最小修复版本，进程已运行约 4.5 小时。
- 实际捕捉工作助手聊天区域空白：AX 消息列表无行，截图仅背景；WebSocket 显示连接。5 秒主线程采样 2189/2189 为正常事件循环等待，CPU 0%，网络两次计数不变。这次白屏不同于上午持续高 CPU 布局循环；不能将两者混为一谈。
- 激活窗口后原工作助手消息恢复。随后 6 次跨三个 profile 切换均显示消息；30 秒采样捕捉到明显 SwiftUI GraphHost 布局事务、LazySubviewPlacements、SelectionOverlay、Markdown 解析与 PNG 解码调用。采样包含 UI 自动化，不能作为准确的单次点击延迟；嵌套栈计数不可相加。
- 独立切换工作助手的 5 个 nettop 计数均为接收 5780、发送 3003，无新增网络字节；现有聊天文字切换不依赖网络。selectProfile 只修改选择及未读状态，selectedMessages 直接取内存字典。附件首次下载另当别论。
- 三个加密历史文件共 580674 字节，约 567 KiB。未解密或输出消息内容。文件小不意味着排版轻：长 Markdown 分成大量可选择 Text 控件。
- .id(profile.id) 会在切换时重建 timeline；Markdown 在 body 中重复解析；图片 NSImage(contentsOf:) 也在 body 内。连续切换采样 footprint 758.5 MB，峰值 1.0 GB；最终 CPU 0%、RSS 560384 KiB。该数据仅表明短时资源开销，不能据此断言泄漏。
- 结论：已采样的会话切换瓶颈指向 App 本地重建/布局，未见网络等待证据；白屏的确切触发条件尚未完全定位。后续优化应针对复用解析结果、限制布局重复工作、缓存/后台生成图片缩略图，并验证窗口激活与滚动恢复。继续减少条数只能缓解。
- 本轮按用户最新要求完成诊断，未改 App 源码、未替换安装包、未发送消息。窗口恢复到用户原先的工作助手，消息可见。

### 第二轮优化交付验证

- 保留首屏/每批 40 条，timeline 改为确定高度的 VStack，避免 LazyVStack 的估算偏移；未使用上次失败的 Equatable 实验。
- Markdown 分段、块和 inline AttributedString 分别使用有数量/成本限制的 NSCache，按内容键复用；新缓存仅在内存。图片使用独立 actor 上的 ImageIO 生成最长边 840px 缩略图并缓存，原图打开/保存路径不变。
- 80 项原有 Swift 测试与新增缓存测试通过；新增测试最终合并为 3 项，覆盖流式更新、样式/链接/换行、大图缩放/复用/原文件完整及缺失文件恢复。15 项 Node 合约通过。release build/codesign 通过。
- 安装后后台启动一度停在现有 CloudflareBillingKeychain.loadToken 系统调用；正常从 Finder 前台打开后恢复，未修改钥匙串。两次正常启动完成后，两轮每轮六次 profile 切换均有消息，窗口隐藏恢复无空白。第二次启动仍有初始历史同步与排版开销，不能声称启动全程瞬时。
- 同样 30 秒、六次切换的采样：新 footprint 243.3 MB、峰值 394.1 MB；旧 footprint 758.5 MB、峰值 1.0 GB。不同启动运行时长会影响绝对内存，不能据此给出精确速度倍数或泄漏结论。新采样不再出现 LazyVStack 布局路径，最终 CPU 回到 0%。
- 个人助手 131 条历史分批加载完成，能滚动到最新；/status 搜索 6/6；文字双击选择、复制粘贴通过并清空草稿，无消息发送。
- 安装路径 /Applications/My Notes.app，旧包已移至废纸篓，output 无重复当前 App。本轮实测未再出现白屏，但不代替长期使用验证。

## 2026-09-30

- 用户澄清右键菜单多个 My Notes；只读进程查询目前只有一个安装版进程。
- WindowGroup 允许多窗口；恢复逻辑按宽高猜测主窗口。多个窗口共享 store，每次选择会刷新所有窗口；新窗口又会 start/refreshProfiles。
- 固定 40 条不限制长 Markdown 总量；显示条数在 onChange 中重置，旧展开状态可能先用于新会话。
- 保持现有 VStack 和文字选择，避免已知 LazyVStack/Equatable 回归。

### 2026-09-30 验证结果

- 86 项 Swift 测试、7 项 Node 合约通过；release build/codesign 通过。安装版签名再次验证通过。旧 App 进废纸篓，output 无重复当前 App。
- 修复前：一个 PID，窗口菜单 3 个 My Notes，AX 身份 main-AppWindow-1/2/3。修复后：一个 PID，AX 身份 main，CoreGraphics 中一个 1160×760 主窗口（另有菜单/工具辅助窗口）。
- 真实六次 profile 切换均选中目标、消息可见且 WebSocket 已连接。三个 profile 的初始可复制文字消息分别 6/9/7 条；按内容预算显示，未删历史。自动化往返约 1.0–1.2s 包含工具等待，不能当作点击延迟或速度倍数。
- 私人助手加载更多后由 9 到 49 条文字消息；切换沐客助手回到其独立的 7 条初始布局。当前停在沐客助手，无测试消息发送。
- 检查时新进程 CPU 0%，RSS 251024 KiB。旧进程基线 RSS 614016 KiB，运行时长和展开历史不同，不能直接归因或宣称精确改进比例。
- Dock/Finder 的 computer-use 查询/剪贴板等待超时，未完成最小化和关窗重开的端到端验证；未通过其他 UI 技术绕行。源码 Window 单实例及实际单主窗口验证不代替长期 Dock 使用验证。


## 2026-10-15：Hermes v0.22.1 插件验证

- 本轮开始时 cloudflare_chat 为 0.3.7；已有插件、说明与测试改动及规划文件，保留原状作为基线。
- 目标固定 commit 297552a9d646119871391d202509822cd86330df；独立审计目录 /private/tmp/hermes-v0.22.1-plugin-audit。
- 之前 0.21.6 验证不替代本次结果。现有真实运行脚本覆盖多 profile、命令、流式、审批、澄清、附件、cron 和重连。

- v0.22.1 联合依赖解析成功，cryptography 50.0.1 / websockets 15.0.1 与当前插件范围匹配。
- 首轮插件单测 81/81、真实审批 38/38、真实运行 13/13、Worker/客户端协议 30/30 均通过。
- 新版原生校验 14/14 通过；一项 warning 列出 adapter.py 对内部审批/澄清/命令 helper 的依赖，不是加载拒绝。隔离审计仍要求 in_process。
- 旧真实运行用合成 handler，不触发新增 SessionAuthority；正在补充真实 GatewayRunner + SQLite authority + 加密 relay 的忙碌 FIFO 测试，仅替换模型执行与外部传输。

- 新增统一网关夹具首轮因构造 GatewayConfig 默认单 profile 模式，覆盖了外层 multiplex secret 状态，合成用户被拒；调整夹具为与实际目标一致的 multiplex_profiles=true 后重测，不改业务授权逻辑。

- 统一网关夹具第二轮暴露 profile_id 需要真实 home 路径，而不能沿用旧测试里的字面 default；源码 capture_provenance 要求按 home 查找 authority，已按实际启动契约修正。诊断确认 allowlist 本身通过，未放宽任何授权。

- 新版统一网关还要求启动时预留的 config._runtime_profile_homes；手工构造 runner 不能仅设置 multiplex=true。夹具现在补齐合成 home 的 reservation 表，保留真实 provenance 校验，不 monkeypatch 授权或 admission。

- 已复现真实插件故障：0.3.7 的 _set_event_typing_epoch 把自定义字段写入 metadata；v0.22.1 session_envelope._native_metadata 对非 WhatsApp 自定义 metadata 返回 None，普通消息被 invalid_params 拒绝。证据 canonical-gateway-reserved.log。
- 最小修复：typing epoch 放到 MessageEvent 的进程内属性，保留原有 epoch helper/队列/typing 逻辑；固定环境中的真实 FIFO + 加密交付单项由失败转为通过。拟交付 0.3.8，最低 Hermes >=0.22.1，依赖范围和中继协议不改。

- 最终 0.3.8：81 项插件回归、38 个真实审批场景、14 项真实运行集成（含真实统一网关 FIFO）、30 项协议检查通过。原 0.3.7 ZIP 在同一最终夹具中因 invalid_params 失败，证明回归用例覆盖真实故障。
- 源码与 ZIP 解包后的原生校验各 14 项通过，均仅有同一组内部 API 耦合提示；依赖声明与原有范围保持一致。
- 0.3.8 ZIP SHA-256 d36849124826b658d7c8721eca2822cff33a6846cfdd8d1957bde3683ae1a388；Linux tar.gz SHA-256 03a43a87032787510d3e1e917cbbb191d6a1ea177018d41b5246141c77aba359。旧 0.3.7 包及校验和仍原样通过。

## 2026-10-19：连接与用量优化

- Android 已有共享连接、20 秒握手看门狗及重连退避，但缺少默认网络回调与前台存活检查。
- Hub 已提供字符串 ping/pong 的 Hibernation 自动响应，可用一次性前台探测，无需新增 HTTP 轮询或 Worker 改动。
- 插件当前每次握手即重置退避，短连接反复失败时会持续 1 秒重试；应仅在稳定运行后重置。
- 流式 edit 每次加密并等待 ACK；仅缓存已确认的相同中间内容，final 始终发送，连接变化时失效，缓存需有界。

- 最终回归证据：87 插件、14 真实运行、38 审批场景、93 Node、源码/归档各14原生检查通过；Android 构建、离线恢复与原有加密存储回归通过。健康探测采用现有 Hub 字符串自动响应，未更改 Worker。
- 交付 Android 2.24 与 2.23 证书 SHA-256 一致，插件 0.3.9 两种格式六文件一致。NAS/手机真实后台恢复仍是用户部署后的验证边界。

## 2026-10-29：Bark 深链接

- `buildBarkPayload` 已透传 url；Hermes 自动通知与管理测试通知均需显式添加。
- iOS 使用 MobileModel.tab/chatPath 作为导航状态；MobileRootView 按锁定、登录、强制改密顺序显示界面。仅切换导航状态不会绕过这些门槛。
- 自定义 scheme 不需 APNs entitlement 或付费开发者账号；通知仍归属 Bark。

## 2026-10-30：iOS 设计审查

- 原生 SwiftUI，现有 --preview 演示模式和 MyNotes iPhone QA 模拟器可用于本地截屏。
- 工作区起始干净；无 AGENTS.md；Product Design 无已保存上下文。
- 待截图确认：笔记空列表统一显示搜索无结果；设置的清空云端记录与本机缓存混排；文件夹缺少当前选择标记。

- 当前 9 个状态截图已捕获并检查，位于 output/ios-design-20261030/before。会话预览露出 Markdown ##；笔记列表默认按钮染色削弱正文层级；文件夹没有当前选择；编辑器附件仅图标；设置把本机缓存与云端删除混排，通知文案仍为旧版。
- 首次截图用例在键盘展开时直接点击隐藏标签栏失败，改为返回会话列表后切换，完整采集通过。原始失败记录保留，错误的 04-notes 截图不作为笔记证据。

- 删除菜单回归暴露整行点击问题：可访问外层宽 400pt，但内层菜单仅 175pt，测试点击整行中心未打开。通过录屏和控件树确认后，为菜单标签增加全宽点击形状；笔记添加附件入口同步采用整行点击。
- 20 项 iOS 单元测试通过；受保护笔记/命令面板、外观/宽限期回归通过。最后验证还包括深色输入提示和清空菜单取消。

- 最终深色提示：语义 secondary 在此输入框切换外观后仍偏暗，改为由 colorScheme 显式选择颜色，最终截图确认修复。正文与聊天配色保持原样。
- 最终截图对照覆盖 9 基线状态 + 3 补充状态，保留所有中间失败证据；报告区分实际截图验证与代码审查，未宣称全无障碍通过。

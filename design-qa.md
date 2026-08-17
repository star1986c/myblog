# Hermes 多 Profile Android 设计验收

## 对比证据

- source visual truth: `/var/folders/5s/wrq7796x2cn790qck6xq5gy00000gn/T/codex-clipboard-ffc6626e-b9e4-4ee7-9321-33f083bf3732.png`
- implementation conversation list: `/private/tmp/my-notes-2.2-conversations.png`
- implementation personal chat: `/private/tmp/my-notes-2.2-personal-chat.png`
- implementation IME state: `/private/tmp/my-notes-2.2-chat-ime.png`
- combined comparison: `/private/tmp/hermes-design-comparison.png`
- source pixels: 2222 × 1672，桌面双栏 Telegram 状态
- implementation pixels: 1280 × 2856，Android 36 模拟器，约 411 × 914 dp，480 dpi
- density normalization: 三张图均等高缩放到 900 px 后在同一张对比图中并排查看；只比较应用内容，不比较桌面窗口装饰与 Android 系统栏
- state: 三个 Hermes profile 的会话列表、`personal` 聊天详情、输入法展开

## Findings

没有可执行的 P0、P1 或 P2 问题。

- 字体与层级：使用系统 Roboto/中文 fallback；会话名、摘要、时间、密钥状态和聊天连接状态层级清楚，未见截断或不可读换行。
- 间距与布局：把桌面双栏有意转译成手机“列表 → 详情”单栏导航；圆形头像、细分隔线、搜索框、固定输入区与左右气泡保持 Telegram 的扫描节奏，48dp 以上触控区域完整。
- 色彩与视觉 token：继续使用 My Notes 已有的青绿色日/夜间语义色，正文和次要文字对比清楚；没有复制 Telegram 品牌蓝或用低对比拟物效果破坏现有产品一致性。
- 图片与图标：使用应用已有矢量聊天、搜索、返回、刷新、更多、图片图标，清晰无位图缩放问题。参考图的品牌头像和聊天墙纸属于方向性素材，未被当作本应用品牌资产复制。
- 文案与内容：明确写出 profile 数量、端到端加密、独立密钥/缓存、末条消息时间和“需密钥/已加密”状态；不会把未连接的 profile 误报为在线。

## Full-view comparison evidence

组合对比显示：参考图的左侧聊天列表被保留为独立的移动会话页，右侧聊天结构被保留为头像/名称/状态顶栏、消息区和底部输入区。差异主要来自桌面双栏到手机单栏，以及沿用 My Notes 品牌色；两项都是明确的产品约束，不是视觉回归。

## Focused region comparison evidence

无需额外局部裁切。900 px 等高组合图中，顶栏、三条会话、气泡正文、时间和输入区均可直接辨认；另外单独检查了 1280 × 2856 原始聊天图和输入法展开图，输入框与发送按钮没有被键盘遮挡。

## Primary interactions tested

- 首页底部 `Hermes` 能打开会话列表，文件夹快捷按钮与文件夹筛选仍存在。
- 点击 `Hermes 个人助手` 能进入对应聊天页；系统返回能回到会话列表。
- 在搜索框输入 profile id `personal` 后，只保留个人助手。
- 点击聊天输入框会弹出输入法，输入区保持在键盘上方。

## Comparison history

- Pass 1: 同屏比较参考图、会话列表和聊天页；未发现 P0/P1/P2，因此无需视觉修复循环。

## Follow-up polish

- P3：未来如果有每个 Hermes profile 的正式头像资产，可替换当前统一的圆形聊天图标，进一步提高快速识别度。
- P3：若用户提供有授权的聊天墙纸，可增加非常轻的背景纹理；当前纯色背景更符合 My Notes 的简洁视觉体系。

## Implementation checklist

- [x] Telegram 式动态会话列表
- [x] 单 Profile 聊天详情与自然返回路径
- [x] 搜索、密钥状态、末条本机加密消息与时间
- [x] 固定输入区和输入法避让
- [x] 真实 Android 36 运行截图与主要交互检查

final result: passed

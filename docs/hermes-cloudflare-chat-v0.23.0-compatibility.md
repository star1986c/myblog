# Hermes v0.22.6 → v0.23.0 升级评估

评估日期：2026-11-06（Asia/Taipei）。本轮仅做源码检查和本机隔离测试，未连接、升级或重启 NAS。

后续修复：同日已完成 Cloudflare Chat 0.3.12，将审批卡片绑定上游 request_id，并通过两个 Hermes 版本的旧卡片、并发及重复点击回归。下文保留 0.3.11 初次评估结果；安装新版后不再受本文已复现的 FIFO 误批问题影响。发布包、验证和部署步骤见 [0.3.12 发布说明](hermes-cloudflare-chat-0.3.12-release.md)。NAS 尚未部署。

## 结论

Hermes v0.23.0 与本地 Cloudflare Chat 0.3.11 的常规功能兼容，可以安排升级；但建议先修复插件的审批请求关联，再用于 NAS 日常运行。仅升级 Hermes 不能让该插件获得新版的旧审批卡片防误批保护。

审批问题在 v0.22.6 和 v0.23.0 上均已通过合成请求复现，属于插件原有问题，不是此次升级引入的回归。暂留旧 Hermes 版本也不会消除它。

## 固定版本与方法

- 上游正式 release：`v0.23.0`，commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`，非 prerelease。
- 发布于 UTC 2026-11-05 21:32:33，即台北时间 2026-11-06 05:32:33。
- 对照：官方 v0.22.6 源码；插件：仓库现有 `cloudflare_chat 0.3.11`，未修改。
- 官方 compare 返回 1,397 个 commits，文件列表被 API 截断为 300 项，因此未用该截断列表代替完整运行代码核查。
- 大型源码压缩包下载较慢，改用官方完整 Git tree：复用与目标 Git blob SHA 一致的旧文件，下载变更文件。共核验 3,166 个选定运行源码、配置及语言资源文件的字节哈希；未下载完整 Desktop、网站或上游测试树。
- macOS arm64、Python 3.14.10、独立 venv 与临时 HERMES_HOME；按上游 pyproject 的 uv overrides 安装 core 依赖。没有使用生产 profile、密钥或真实模型调用。

## 核验结果

| 项目 | 结果 |
|---|---|
| 真实 Hermes v0.23.0 运行集成 | 15/15 通过 |
| default / personal 常规审批 | 各 19，共 38/38 通过 |
| 上游原生插件准入校验 | 15/15 通过 |
| 插件版本门槛 | `requires_hermes: >=0.22.4` 接受新版 |
| 加密 / WebSocket 依赖 | cryptography 50.0.2、websockets 15.0.1，均满足插件范围 |
| 隔离模式 | 继续使用 `plugins.isolation: in_process`；不支持 host |
| 旧卡片误批后续请求 | 两个 Hermes 版本均复现，需修插件 |

运行集成覆盖插件加载、profile/密钥隔离、统一网关 SQLite 排队、忙碌命令、流式 finalize、附件与直传、审批/澄清/选择器、重连及 cron sender。模型执行、Relay/WSS/HTTP/R2 传输使用合成边界，不能证明真实 NAS、模型和 Bark/APNs 的端到端效果。

首次运行集成有一项因临时源码缺少 locales 而失败，文本显示为翻译键。补齐经官方 blob SHA 校验的语言资源后，未修改插件或测试，完整重跑 15/15 通过。

原生校验仍提示插件使用若干 Hermes 私有接口。当前测试通过不代表这些接口在未来版本中稳定。

## 审批问题与建议修复

复现步骤全部在临时 home 中执行，不执行任何命令：

1. 创建请求 A，按真实上游模板发送携带 A request_id 的加密审批卡片。
2. 在其他入口拒绝 A，使其退出 Hermes 待审批队列；插件中的卡片仍未过期。
3. 同一会话创建请求 B。
4. 点击 A 卡片的“仅本次”，B 被标记为批准。

原因：插件 `_send_exec_approval_prompt()` 未保存 `prompt.request_id`；`_dispatch_interaction()` 调用 `resolve_gateway_approval(session_key, choice)`，使用 FIFO 队首。上游 v0.23.0 新增 `resolve_gateway_approval_card()`，但不会自动替第三方插件接入。

建议后续修复：保存并传递上游 request_id，回调按该 ID 精确解析；旧请求不存在时只将旧卡片标记过期。回归应覆盖跨入口处理、超时后新请求、并发请求和重复点击。本次只评估，未修改插件、版本号或打包交付。

## 相对 v0.22.6 的判断

- v0.23.0 发布说明汇总从 v0.22.0 开始的变化，不能将所有亮点视作本次新增。
- `gateway/stream_consumer.py`、`tools/approval_gateway_wait.py`、`agent/secret_scope.py`、`hermes_state_common.py` 与 `hermes_state_schema.py` 与 v0.22.6 字节一致；schema 仍为 32。
- 平台基类、统一网关执行路径、插件加载版本检查及审批检测有实际变化，已结合上述集成测试检查。新版加载检查未拒绝此插件。
- core 直接依赖声明中，此区间实际变更为 nemo-relay 从 `>=0.10,<0.11` 到 `>=0.11,<0.12`。Python 3.14 运行时要求与插件加密依赖未新增变化。
- 尚无证据要求同步更改现有 Worker 或 My Notes 客户端；其真实部署联调本轮未做。

## 部署前与升级后

1. 等待任务与审批结束，备份所有 Hermes home/profile 的配置、密钥、插件、数据库及旧版运行环境。数据库采用停服副本或一致性快照；回退保留程序与数据的配套版本。
2. 确认 NAS 每个启用 profile 的插件确为本次核验的 0.3.11，保持 `in_process`。建议先完成上述审批修复再升级。
3. 使用原安装方式升级。源码安装支持 `hermes update --channel stable`，但它选择执行时的稳定版，不永久锁定 v0.23.0；执行前核对目标。Docker 安装使用已确认可获取且匹配架构的目标镜像，不混用源码更新命令。
4. 检查更新器可访问 GitHub 与 Python 包下载域名，不仅是内部镜像源；保持现有 Webapp 开关，不为本次升级额外启用服务。
5. 升级后逐 profile 验收普通聊天、两条消息排队、长回复最终通知、图片/附件、新审批、`/status`/`/stop`、重连和 Bark。

## 上游报告的适用边界

- #149776 报告整个 profile home 为软链接时，多 profile 路由/旧会话恢复出错。报告环境为 macOS、v0.23.0 之后的开发提交；不能直接认定正式 tag 或 NAS 已受影响，但存在此目录布局时应专项验收。
- #149773 明确使用 v0.23.0，报告仅能访问内部 Python 镜像时，锁文件中的 files.pythonhosted.org URL 导致安装失败。NAS 若可正常访问这些下载域名，则不满足该故障前提。

## 来源与证据

- [官方 v0.23.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0)
- [v0.22.6…v0.23.0 compare](https://github.com/NousResearch/hermes-agent/compare/v0.22.6...v0.23.0)
- [上游审批解析实现](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/tools/approval.py)
- [软链接 profile 报告 #149776](https://github.com/NousResearch/hermes-agent/issues/149776)
- [Python 镜像网络报告 #149773](https://github.com/NousResearch/hermes-agent/issues/149773)
- 本机可复核日志与复现脚本：`output/hermes-v0.23.0-audit/`。
- 隔离源码与 venv：`/private/tmp/hermes-0230-audit/`。

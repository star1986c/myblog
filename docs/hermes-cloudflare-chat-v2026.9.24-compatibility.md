# cloudflare_chat 0.3.6 与 Hermes v2026.9.24 兼容性验证

日期：2026-09-29。

结论：**现有 0.3.6 发布包不能标记为完整兼容：存在已复现的安装依赖冲突。保留 Hermes 要求的依赖版本后，本次覆盖的运行接口和协议检查全部通过。** 没有修改插件业务源码、Worker、原生客户端或 NAS。

## 验证对象与环境

- Hermes：官方 `v2026.9.24`（0.21.5），固定 commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`，不是后续 main。
- 插件：仓库 `integrations/hermes-cloudflare-chat/cloudflare_chat`，版本 0.3.6，最后修改提交 `ca21910`。
- 既有 `output/cloudflare_chat-0.3.6.zip` 的全部 6 个文件逐字节匹配当前插件源码；SHA-256：`5b4d61160d6852fa4995edc000eb6517c65ae3891ecff874c46160a51fc9dd0a`。
- 主机：macOS arm64；隔离 Python 3.12.13，cryptography 50.0.0，websockets 15.0.1。适用于该环境的 33 个 Hermes core 直接依赖全部满足版本约束。
- 只使用临时、合成 profile 和密钥。真实运行扩展脚本阻断外部网络连接；WebSocket relay、HTTP/R2 端点与模型回调使用测试替身。

## 已确认的问题：cryptography 安装约束冲突

| 来源 | 约束 |
|---|---|
| Hermes 标签中的 `pyproject.toml` | `cryptography==50.0.0` |
| 插件 0.3.6 的 `requirements.txt` 第 1 行 | `cryptography>=45,<48` |

两个范围没有交集。`uv pip compile` 联合解析真实上游 pyproject 和插件 requirements 后返回失败：

```text
Because hermes-agent depends on cryptography>=45,<48 and
cryptography==50.0.0, ... requirements are unsatisfiable.
```

在已经保留 50.0.0 的隔离环境中，对插件 requirements 执行安装 dry-run，得到：

```text
Would uninstall: cryptography==50.0.0
Would install:   cryptography==47.0.0
```

没有执行降级。此结果意味着：照插件 README 单独重装旧 requirements 会违反 Hermes 的 core 版本要求；使用同时约束 core 的解析流程则直接拒绝安装。不能以“插件能 import”代替发布包安装兼容性。

候选调整仅在临时文件中验证：将插件要求改为 `cryptography>=50,<51`，保留 `websockets>=14,<17`。与上游联合解析成功（62 个依赖包），以下运行测试也全部在 cryptography 50.0.0 下通过。**仓库 requirements.txt 尚未修改，候选内容不是已发布修复。**

另外，新版 Hermes 的 `read_declaration()` 只读取插件 pyproject 或清单中的 `python_dependencies` / `pip_dependencies`；当前插件只有 requirements.txt，读取结果为空。若后续接入新版自动依赖安装/重建流程，应同步提供原生声明。这是维护元数据缺口，本次没有将其算作已发生的运行故障。

## 验证结果

| 层次 | 结果 | 覆盖与边界 |
|---|---:|---|
| 原有插件回归 | 81/81 通过 | 加密、ACK/HTTPS 回退、接收顺序、去重、重连、typing epoch、交互、附件；其中 Hermes 模块使用既有 stub |
| 真实 Hermes 审批集成 | 38/38 场景通过 | default/personal 各 19 场景；真实能力检测、共享模板、审批队列和 resolver，验证按钮范围、加密回传、resolved 状态及重复点击 |
| 新增真实运行集成 | 13/13 通过 | 见下面的具体列表；实际加载固定标签源码 |
| Worker/客户端协议合约 | 30/30 通过 | 消息与加密 action、流式最终持久化、附件、R2 直传、multiplex relay 和原生客户端能力约定；不是安装版 UI 测试 |
| 新版弃用导入检查 | 0 命中 | 对插件实际目录执行 Hermes `scan_plugin()` |
| 发布包依赖联合解析 | **失败** | 上述 cryptography 版本冲突 |

真实运行集成保留了实际 `PluginManager`、平台注册表、`BasePlatformAdapter`、`GatewayStreamConsumer`、`_profile_runtime_scope` 和交互 resolver，具体验证：

1. 真实插件发现、加载、启用/禁用；两个 profile 的注册表独立，卸载其中一个不清空另一个。
2. 插件覆盖方法能接受对应真实基类的调用参数。
3. 并发 A/B/A profile 作用域：连接标识、授权配置、状态路径、附件缓存、session key 与加密密钥保持隔离；缺配置不借用启动 profile 的值。
4. 加密入站经真实基类处理并回复；default/personal 忙碌时 `/status` 内联回复、`/stop` 取消占用、之后普通消息恢复，ACK 不自阻塞。命令业务处理回调是合成回调，没有调用真实模型。
5. 真实流消费者创建一条消息并持续编辑，最终 `finalize` 指向原 relay sequence，正文正确。
6. 图片、PDF、语音、视频和 ZIP 经真实媒体路径检查、加密上传、消息发送、下载解密，产生对应真实 `MessageEvent`；拒绝把 profile `.env` 当附件发送。
7. 大于 10 MiB 的文件完成 ticket → 分块 PUT → complete → 加密描述符发送，校验长度和 SHA-256；HTTP/R2 为合成响应。
8. 澄清单选、“其他”文字回答及多选文字回退，使用真实澄清状态与 resolver。
9. 命令确认的 once/always/cancel 调用真实 resolver，重复点击不重复执行合成回调。
10. 模型与普通选项选择器向回调传递正确参数，完成加密卡片更新。
11. disconnect 清理连接与锁；重新连接保留 checkpoint，重复历史不再次投递。
12. 独立 cron sender 通过 HTTP 投递结果，不新建 WebSocket，并拒绝目标 profile 不匹配。

上述列表按功能合并描述，因此与 13 个测试方法不是逐项一一对应。

## 证据和复现

证据目录：`output/hermes-v2026.9.24-compatibility/`。

- `summary.json`：结论、计数及各证据文件 SHA-256。
- `environment.json`、`package-comparison.json`：环境约束核对及 ZIP 对照。
- `plugin-unit.log`、`real-approval.log`、`real-runtime.log`、`relay-client-contracts.log`：测试结果。
- `dependency-resolution.log`、`plugin-install-dry-run.log`：原版冲突和降级计划。
- `proposed-requirements.txt`、`proposed-resolution.log`：仅供评估的候选约束。
- `verify_runtime.py`：本次真实运行扩展脚本。

本机固定源码与虚拟环境位于 `/private/tmp/hermes-v2026.9.24-audit/`。复现真实运行扩展检查：

```bash
env -i PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH=/private/tmp/hermes-v2026.9.24-audit/upstream:/Users/star/Documents/myblog/integrations/hermes-cloudflare-chat \
  HERMES_HOME=/private/tmp/hermes-v2026.9.24-audit/repro-user/.hermes \
  AUDIT_PLUGIN_DIR=/Users/star/Documents/myblog/integrations/hermes-cloudflare-chat/cloudflare_chat \
  /private/tmp/hermes-v2026.9.24-audit/venv/bin/python \
  /Users/star/Documents/myblog/output/hermes-v2026.9.24-compatibility/verify_runtime.py
```

其他运行命令为插件 unittest discovery、已有 `verify_real_hermes_approval.py`，以及：

```bash
node --test tests/hermes-chat-protocol.test.mjs \
  tests/hermes-chat-streaming-relay.test.mjs \
  tests/hermes-chat-attachment.test.mjs \
  tests/hermes-chat-direct-upload.test.mjs \
  tests/hermes-chat-multiplex-relay.test.mjs \
  tests/hermes-native-client-parity.test.mjs
```

审计脚本调试期间出现的失败均已区分：合成配置不满足 URL/secret 校验、把 adapter_factory 误当作类型，以及合成目录清理与上游异步写入竞争。修正的是测试夹具；最终 13 项运行日志为全部通过，插件源码没有因此修改。

## 尚未验证的部署层

- NAS 实际安装的 Hermes commit、Python、依赖版本和每个 profile 的插件文件。
- NAS/Linux 上的真实 WSS/TLS、Cloudflare/R2 网络、断网恢复及长时间运行。
- 真实模型与工具执行、真实 cron 调度、宿主 multiplexer 控制命令的完整服务生命周期。
- Android/macOS 安装版中的按钮、媒体展示和多设备同步。

因此，本报告支持“所覆盖的本地运行契约通过”，不支持“NAS 已实测完全兼容”。待修正发布依赖后，部署层仍应验证各 profile 的正常聊天、长回复、忙碌控制命令、审批、附件及重连。现有证据没有显示必须改动 Worker/客户端协议。

官方依据：[目标版本](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24)、[固定标签依赖声明](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/pyproject.toml)、[原生插件依赖读取器](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/hermes_cli/plugin_python_deps.py)。网页版依赖文件一度返回 429，依赖结论以已固定并读取的官方 Git 源码及本地解析结果为据。

## 后续处理（同日）

上述结论针对当时的 0.3.6 快照。随后用户授权升级，仓库修复并打包了
`cloudflare_chat 0.3.7`；其依赖、Hermes 原生声明和打包复验记录见
`output/cloudflare_chat-0.3.7-validation.md`。旧 0.3.6 审计证据和归档保留。

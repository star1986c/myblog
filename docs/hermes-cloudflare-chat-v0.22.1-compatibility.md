# cloudflare_chat 与 Hermes v0.22.1 兼容性验证

日期：2026-10-15。

**结论：Hermes v0.22.1 的统一网关需要将插件从 0.3.7 升级到 0.3.8。**
0.3.7 的普通消息会因自定义 metadata 被持久队列拒绝；0.3.8 已完成最小修复，并通过下列本地检查。

## 固定目标与修复

- Hermes：官方 `v0.22.1`，固定 commit `297552a9d646119871391d202509822cd86330df`。
- 环境：macOS arm64、Python 3.14.8；独立虚拟环境，不使用真实 profile 或凭证。
- 旧版对照：原交付 `cloudflare_chat-0.3.7.zip`，SHA-256 为 `35a59a57949aacc68756373ad699ea875567d0d10424ba495e391bb7d0fe5e96`。
- 新版：`cloudflare_chat 0.3.8`，清单要求 `Hermes >=0.22.1`。

0.3.7 把 `_cloudflare_chat_typing_epoch` 写入 `MessageEvent.metadata`，用于避免旧回合的 typing 清理关闭新回合状态。v0.22.1 的 `gateway/session_envelope.py::_native_metadata` 只允许指定的持久化字段，对普通平台的自定义 metadata 返回拒绝，随后 `_validate_native` 抛出 `invalid_params`。

旧测试使用合成 handler，没有启动 `SessionAuthority`，因此即使 81 项单测、38 个审批场景和原有 13 项运行集成全部通过，也不能发现这个入口故障。本轮新增了真实 `GatewayRunner`、SQLite 持久队列、平台授权及加密 relay 的回归，仅替换模型执行和外部传输。

0.3.8 将 typing epoch 移到 event 的进程内属性，保留原有 epoch 获取、取消与排队逻辑；该属性不进入持久化输入或模型上下文。HTTP User-Agent 和版本同步更新。依赖范围、加密格式及 Worker/客户端协议没有改变。

## 本地验证

证据目录：`output/cloudflare_chat-0.3.8-validation/`。

| 检查 | 结果 | 证据 |
|---|---|---|
| 旧版负对照 | 原 0.3.7 在完整、正确配置的统一网关夹具中因 `invalid_params` 失败 | `negative-control-0.3.7.log` |
| 插件回归 | 81/81 通过，包含 typing 轮次、取消、ACK、附件和重连 | `plugin-unit.log` |
| 真实 Hermes 审批 | default/personal 各 19 场景，38/38 通过 | `real-approval.log` |
| 真实 Hermes 运行集成 | 14/14 通过 | `real-runtime.log` |
| Worker/客户端协议 | 30/30 通过 | `relay-client-contracts.log` |
| core 与插件依赖联合解析 | 成功；cryptography 50.0.1、websockets 15.0.1 | `resolved.txt` |
| 新版 PM 原生声明读取 | 两项依赖与 requirements.txt 一致，安装版本满足范围 | `native-source.json` |
| 源码及 ZIP 解包后的原生 admission 校验 | 各 14/14 通过；各有一组内部 API 耦合提示 | `native-source.json`、`native-packaged.json` |
| 发布包 | ZIP 与 Linux tar.gz 均逐字节匹配相同的 6 个源码文件，SHA-256 复核通过 | `build_package.py`、`../cloudflare_chat-0.3.8-SHA256SUMS.txt` |

新增统一网关检查证明：第一条消息执行中，第二条能够及时入队，接收和 ACK 不被模型执行阻塞；两条消息按顺序各回复一次，持久化记录不包含 typing epoch，最终 typing 为关闭状态。

其余真实运行检查覆盖：default/personal 的插件加载和卸载隔离、基类签名、并发作用域和密钥/路径隔离、普通消息、忙碌时 `/status`/`/stop`、流式同消息 finalize、图片/PDF/音频/视频/ZIP 双向转换、10 MiB 以上附件直传、审批与澄清、命令确认、模型和选项回调、重连 checkpoint、独立 cron sender。新增真实统一网关 FIFO 检查使用默认 profile；两个 profile 的隔离及交互由其余集成场景覆盖。

原生检查的 warning 列出对 `hermes_cli.commands`、审批/澄清 resolver 和模型费用提示等内部接口的调用。这些接口在本轮目标版本验证可用，提示不阻止加载，但不能视为上游长期稳定接口。隔离审计仍要求 `plugins.isolation: in_process`，平台适配器不支持 `host`。

新增夹具初期曾因缺少 multiplex、authority home 和启动 reservation 信息被拒；这些配置修正后，原 0.3.7 仍然复现独立的 metadata 故障。负对照使用最终夹具，不以夹具配置错误作为插件不兼容的证据。

## 复现

固定源码与虚拟环境位于 `/private/tmp/hermes-v0.22.1-plugin-audit/`。真实运行回归脚本已保存到仓库，后续不依赖旧版 output 下的脚本：

```bash
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH=/private/tmp/hermes-v0.22.1-plugin-audit/hermes-agent-297552a9d646119871391d202509822cd86330df:/Users/star/Documents/myblog/integrations/hermes-cloudflare-chat \
  HERMES_HOME=/private/tmp/hermes-v0.22.1-plugin-audit/repro-home \
  AUDIT_PLUGIN_DIR=/Users/star/Documents/myblog/integrations/hermes-cloudflare-chat/cloudflare_chat \
  /private/tmp/hermes-v0.22.1-plugin-audit/venv/bin/python \
  /Users/star/Documents/myblog/integrations/hermes-cloudflare-chat/tests/verify_real_hermes_runtime.py
```

审批测试单独执行 `verify_real_hermes_approval.py`；模拟 Hermes 的 `test_*.py` 单测需在另一进程执行，避免其 stub 污染真实接口检查。`verify_native.py` 可对源码或解包后的插件目录执行相同的原生检查。

## 部署交付与验证边界

- ZIP：`output/cloudflare_chat-0.3.8.zip`
- NAS/Linux tar.gz：`output/cloudflare_chat-0.3.8-linux.tar.gz`
- 校验和：`output/cloudflare_chat-0.3.8-SHA256SUMS.txt`

由用户将包内完整的 `cloudflare_chat/` 替换到每个已启用 profile 的插件目录，保留 profile 外层的 `.env`、密钥和插件启用配置。保持默认的 `in_process` 隔离模式。全部替换后，只重启共同的 Gateway 一次；无需更新 Worker 或 Android/macOS 客户端。0.3.8 的最低 Hermes 版本是 0.22.1。

部署后分别检查每个 profile 的普通聊天、连续两条排队消息、长回复、忙碌时 `/status`/`/stop`、新审批按钮、附件与重连。旧的进行中交互卡片不会跨 Gateway 重启保留，请用新请求测试。

**本轮未连接 NAS，未部署或重启真实服务。** 测试中的模型回调、WSS/HTTP/R2 传输和凭证均为合成；本地通过不等于 Linux/NAS 的实际模型、TLS、Cloudflare/R2 或安装版客户端已验证。

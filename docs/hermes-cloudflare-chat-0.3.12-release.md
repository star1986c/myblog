# Cloudflare Chat 0.3.12：审批请求 ID 关联修复

日期：2026-11-06。源码已修复、验证并生成 ZIP；尚未安装到 NAS，未升级或重启生产 Hermes。

## 修复行为

旧版 0.3.11 只把会话键传给 Hermes 审批解析器，因此点击旧卡片可能处理当前队首的另一条请求。0.3.12 将上游 `ExecApprovalPrompt.request_id` 保存在服务端交互状态，并调用 `resolve_gateway_approval(..., request_id=...)` 精确处理原请求。

- 原请求在其他入口处理或超时退出队列后，点击旧卡片只显示“授权已过期”，不会批准后续请求。
- 同一会话的并发审批可按任意顺序操作，各自只影响对应请求。
- 并发重复点击、原卡片重复点击不会多消费审批；本地已过期卡片不处理任何请求。
- 没有有效请求 ID 时不创建按钮卡片；回调状态缺少 ID 时按过期处理，不退回 FIFO。没有请求 ID 的上游调用会得到失败的 SendResult，由上游处理发送失败。
- ID 留在服务端状态中；Cloudflare/客户端协议、加密格式、依赖和 Bark 分类保持不变。本次无需更新 Worker、iPhone、Android 或 macOS 客户端。

最低 Hermes 版本提高为 `>=0.22.6`，因为该版本已把请求 ID 传给平台审批模板并支持按 ID 解析。实现使用 v0.22.6/v0.23.0 共有接口，不依赖 v0.23.0 新增的包装函数。保持 `plugins.isolation: in_process`。

## 验证

| 检查 | 结果 |
|---|---|
| 0.3.11 负对照 | 新回归准确复现旧卡片批准后续请求 |
| 插件单测 | 93/93 通过 |
| Hermes v0.22.6 真实运行集成 | 15/15 通过 |
| Hermes v0.23.0 真实运行集成 | 15/15 通过 |
| v0.22.6 审批（default/personal） | 38 个常规场景 + 14 个请求关联场景通过 |
| v0.23.0 审批（default/personal） | 38 个常规场景 + 14 个请求关联场景通过 |
| ZIP 解包后原生准入校验 | 两个 Hermes 版本各 15/15 通过，in_process |
| ZIP 可重复性 | 连续两次生成哈希相同，6 个发布文件逐字节匹配，无 macOS 元数据 |

每个 profile 的 7 个关联场景：其他入口已处理、上游超时出队、乱序处理、并发及重放点击、本地卡片过期、缺少请求 ID、服务端卡片状态丢失 ID。上游超时场景模拟等待线程的超时出队状态，不实际等待 720 秒。队列与解析器来自真实 Hermes，卡片和回调经过真实插件加密及 loopback ACK；不执行命令或调用模型。

真实运行集成继续覆盖消息队列、profile 隔离、流式 finalize、附件、澄清、选择器及 cron 等。原生校验仍提示插件依赖部分私有 Hermes 接口；本次通过不代表未来接口稳定。NAS/Linux、真实模型、Cloudflare/R2 和手机推送需部署后验收。

证据：`output/cloudflare_chat-0.3.12-validation/`；持久回归脚本：`integrations/hermes-cloudflare-chat/tests/verify_real_hermes_approval.py`。

## NAS 安装

1. 当前 Hermes v0.22.6 可以直接安装本插件，无需先升到 v0.23.0。
2. 等待任务与审批处理完毕，备份现有插件；解压 `output/cloudflare_chat-0.3.12.zip`。
3. 将完整的 `cloudflare_chat/` 替换到每个启用 profile 的 `plugins/` 下。例如默认 `/root/.hermes/plugins/cloudflare_chat`，命名 profile `/root/.hermes/profiles/personal/plugins/cloudflare_chat`；路径以 NAS 实际 home 为准。
4. 保留插件目录外的 `.env`、密钥和启用配置。确认所有目标 `plugin.yaml` 均为 0.3.12，保持 in_process。
5. 多 profile 共用 Gateway 时全部替换后只重启该 Gateway 一次；旧卡片不跨重启恢复，使用新请求验收。
6. 逐 profile 检查普通回复、长回复完成提醒、附件、审批与重复点击。验证插件后，再按原安装方式升级 Hermes 并重复现场验收。

## 交付与校验

- `output/cloudflare_chat-0.3.12.zip`
- `output/cloudflare_chat-0.3.12-SHA256SUMS.txt`

```text
b5bfd58f7a73198ec85805fa9b1368b5c2c3a898c6341a7f30f6b272744684f6  cloudflare_chat-0.3.12.zip
```

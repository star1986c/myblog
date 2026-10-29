# cloudflare_chat 0.3.11：Bark 完成通知与授权提醒

日期：2026-10-29。Worker 已部署；用户确认自行更新 NAS，更新后再验证真实推送。iPhone 和 macOS 客户端无需重装。

## 行为

- Hermes 的流式初始消息（`expect_edits`）和中间进度（`_interim_send`）静默；持久化最终编辑按原消息 ID 推送一次。
- 普通完整消息及附件继续通知。授权、命令确认及其他需要用户选择的交互及时通知；授权状态的后续编辑不会再次通知。
- 不靠静默超时猜测完成；没有最终事件的中断流不会推送。重传、HTTP ACK 补偿、对象重建和重复最终编辑不会新增重复提醒。
- 只传递 `stream`、`silent`、`approval` 类型提示；正文、文件、命令和授权选项保持端到端加密。提示只接受已认证的 agent；它用于通知策略，不替代客户端的加密校验。
- 15 天 Bark 数据清理及设备偏好不变。投递仍采用已有重试和 D1 去重机制；APNs 成功与 D1 回执之间发生故障时不承诺严格一次投递。

## 部署状态

- Worker：`wispy-cloud-0978`，版本 `560eec77-77f3-4f27-845c-39227bde1533`。使用 `wrangler deploy --keep-vars`，保留 Secrets/变量和每日清理调度；没有新增 D1 迁移。
- **NAS 尚未替换。** 旧插件不携带分类，Worker 为保留授权通知仍沿用旧行为。仅 Worker 部署不表示流式首段静默已在生产生效。
- 插件最低版本声明维持 Hermes `>=0.22.4`；本轮实际兼容性验证使用官方 v0.22.5 源码，通知分类依赖 `expect_edits` / `_interim_send` / `notify` 元数据契约。

## NAS 更新

1. 下载 `output/cloudflare_chat-0.3.11.zip`，核对下方 SHA-256，解包得到 `cloudflare_chat/`。
2. 等待当前授权交互处理完毕，备份并完整替换每个已启用 profile 的插件目录。例如默认 `/root/.hermes/plugins/cloudflare_chat`，命名 profile 为 `/root/.hermes/profiles/<profile>/plugins/cloudflare_chat`；以 NAS 实际 Hermes home 为准。
3. 保留插件目录外的 `.env`、密钥及启用配置，继续使用 `plugins.isolation: in_process`。
4. 所有 profile 更新完成后，重启共同的 multiplex Gateway 一次。各目录 `plugin.yaml` 应为 `0.3.11`。
5. 验收：长回复生成时无 Bark，结束后一次；授权等待时有提醒，处理授权后不会因卡片更新再提醒；普通附件正常通知。逐个启用 profile 检查。用户完成 NAS 更新后再进行真实设备验收。

## 验证

- Node / Worker 全量：291/291；包含真实 room、静默超时、WS/HTTP 重传、对象重建、最终原消息去重、授权与身份校验。
- 插件单测：92/92；包含元数据分类、最终发送、授权优先及 HTTP 补偿保留标记。
- 真实 Hermes v0.22.5 离线运行：15/15，实际 StreamConsumer 的首段确认带 `stream`，最终事件及内容完整。
- 真实授权流程：default / personal 各 19 场景，共 38；插件包原生检查：15/15，`in_process`。
- Worker dry-run 与正式部署成功；ZIP 含 6 个插件文件，解包逐字节匹配源码；无 macOS 元数据，重复构建哈希一致。
- 测试使用合成消息和隔离 home，不向生产 Hermes 或 Bark 发送测试通知，不读取真实聊天内容。NAS/Linux、真实模型和手机通知效果待更新后验证。
- 本机证据：`/private/tmp/bark-final-{node,python,runtime,approval,dry-run,deploy}.log`、`/private/tmp/bark-final-native.json`；打包脚本为 `scripts/package-hermes-cloudflare-chat.py`；以后按 `integrations/hermes-cloudflare-chat/PACKAGING.md` 统一交付 ZIP。

## 校验和

```text
bc946ef1dd397a8e613703f0933729cd3c8b721db3f282cb595d857a337cd281  cloudflare_chat-0.3.11.zip
```

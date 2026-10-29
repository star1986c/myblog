# 发现

- 原逻辑在首个 agent message 入队，1.5 秒后 Bark；所有 edit 均不入队，导致首段就推送。
- Hermes v0.22.5 的 expect_edits 表示流式初始消息，_interim_send 表示中间进度，notify 表示最终发送；插件 send 之前忽略 metadata。
- 授权通过 _send_payload(interaction=...) 发送，正文/interaction 均加密。Worker 不能从密文识别授权，应由认证 agent 提供有限类型提示。
- 只部署 Worker 不足以精准处理旧插件的无标记首段；需要提供更新插件包，不假称线上完全生效。

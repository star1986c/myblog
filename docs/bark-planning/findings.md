# 发现

- 现有 Worker 为 wispy-cloud-0978，src/cloudflare-entry.js 导出 Worker 和两个 Hermes Durable Object；使用 BLOG_DB D1。
- bark-worker 支持自建 Bark 服务，通知由独立 Bark iOS App 接收。需要 register/ping/healthz/info/push 兼容端点及 APNs 身份。
- Hermes 服务端仅能看到加密信封、profile、消息/流式事件。通知仅带助手名称和新回复提示，不读取或上传明文。
- 需要覆盖 WebSocket 与 HTTP agent 两条写入路径，避免流式编辑逐字推送及重试重复提醒。
- Bark 官方客户端 ArchiveProcessor 支持秒为单位的 ttl；默认和最大值 15*86400。手机归档清理时机由 Bark 客户端控制。
- 每个 Durable Object 只有一个 alarm，通知重试与原有聊天历史清理共用调度，取最早时间，避免互相覆盖。
- 新增表与路由独立于笔记/聊天密文；发送成功回执用于去重，队列和回执都不保存明文。
- 所有原有 Cloudflare 变量、Secrets、DO、R2 和 D1 绑定在部署后逐项验证未改变。

# Bark 与 Hermes 通知

在现有 `wispy-cloud-0978` Worker 和 `BLOG_DB` 上提供 Bark 兼容服务，不需要新的 Worker、NAS 插件或 iOS 签名权限。参考 [bark-worker](https://github.com/cwxiaos/bark-worker) 的协议和自托管 APNs 配置，独立实现路由与存储。

## 使用

1. iPhone 安装 Bark 并允许通知。
2. 打开 https://superstar1014.qzz.io/bark-settings/ ，使用现有 My Notes 账号登录。
3. 点击“复制服务器地址”，在 Bark 的服务器设置中添加该地址。地址包含访问凭据，只放到自己的设备上，不公开分享。
4. 返回设置页刷新设备，点击“发送测试通知”。可分别开关三个 Hermes 助手的提醒。

收到完整 Hermes 助手回复后提醒；WebSocket 和 HTTP 入站均支持。配合 cloudflare_chat 0.3.11，流式首段和中间进度静默，最终流式编辑按原消息 ID 提醒一次；重传或再次编辑不会重复提醒。授权、确认及其他交互请求仍及时提醒，普通消息和附件保留通知。没有最终完成事件的中断流不会因超时而推送。

**生效条件：** Worker 与 NAS 每个已启用 profile 的插件必须一起更新。旧插件不携带通知类型，服务端不能从密文精准区分流式首段和授权，仍按原规则处理以避免漏掉授权。通知类型提示不含正文，只有通过 agent 认证的发送方可设置。通知只含助手名称和新回复提示，不解密或发送聊天正文。在其他客户端在线时仍会提醒。Bark 接收通知，与 My Notes 免费签名有效期独立。

## 数据保留

- D1 仅记录设备注册、通知偏好、最近发送状态与用于去重的消息 ID，不存通知正文。
- 发送去重记录、最近发送时间、最近错误状态保留 15 天；每天 UTC 19:00（台北时间次日 03:00）清理超过 15 天的数据。每日批处理可能比满 15 天晚最多约一天执行。
- 注册信息与通知偏好长期保留，手动移除设备时一并删除对应去重记录。
- 每条通知默认携带 `ttl=1296000`，调用方只能缩短有效期，不能超过 15 天。Bark 客户端按自己的清理时机移除过期归档；不会追溯清除以前其他服务器推送的消息。参见 [Bark ttl 参数](https://github.com/Finb/Bark/blob/master/docs/params.md#ttl)。
- DO 持久队列只保存消息 ID、助手 ID 和重试元数据；最多尝试 6 次，超过 1 小时的积压丢弃，不影响聊天消息本身。

## 接口与配置

专属基础地址格式为 `https://域名/bark/<BARK_SERVER_TOKEN>`。支持 `/ping`、`/healthz`、`/info`、`/register`、JSON POST `/push`、POST `/<device_key>`、GET `/<device_key>/<body>`、`/<device_key>/<title>/<body>` 和带 subtitle 的四段路径。路径中的文字需 URL 编码；批量推送支持最多 10 个 `device_keys`。

每个 IP 每分钟最多 60 次请求，最多注册 10 台设备。注册时更新已有 key 的 token 会保留通知偏好。管理 API 使用现有会话及 CSRF 校验；未登录不能获得专属地址或设备信息。

Cloudflare Secrets：`BARK_SERVER_TOKEN`（随机私有访问令牌）、`BARK_APNS_PRIVATE_KEY`、`BARK_APNS_TEAM_ID`、`BARK_APNS_KEY_ID`。后三项采用上游为 Bark 自托管公开的 APNs 身份，只用于 `me.fin.bark`；仍存为 Secrets，仓库不包含密钥。上游撤销 APNs 身份后需要更新，不能将它用于 My Notes 原生 APNs。

部署顺序：应用新增迁移 `0015_bark_push.sql`，设置上述 Secrets，运行 `wrangler deploy --keep-vars`。不要覆盖已有 Hermes/R2/认证 Secrets、DO 迁移或变量。发布前运行 `npm test` 与 `wrangler deploy --dry-run`。

失败处理：网络或 APNs 暂时失败会退避重试；无效设备 token 停用发送并在设置页提示重新注册。APNs 接受后、D1 回执写入前发生故障可能重复提交，使用通知 ID 折叠以减少重复；不承诺严格一次投递。APNs 接受不等于手机已显示，需要实际设备确认。

回滚 Worker 版本可关闭此次新路由与通知逻辑；新增 Bark 表可以保留，不应删除现有笔记或聊天数据。关闭服务时可移除 Bark cron，或撤销 `BARK_SERVER_TOKEN`，不会影响现有聊天服务。

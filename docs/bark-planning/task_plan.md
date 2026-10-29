# Bark 与 Hermes 推送

用户授权：参考 bark-worker，在现有 Cloudflare Worker 部署 Bark 服务，并接入 Hermes 新回复提醒。

1. [complete] 核对 Bark 协议、现有 Worker/DO、部署权限与通知接收方式。
2. [complete] 隔离 Bark 路由与存储、配置页面、Hermes 提醒和回归测试。
3. [complete] 迁移/部署现有 Worker，检查线上接口、绑定与每天清理计划。
4. [complete] iPhone Bark 添加服务器，用户确认测试通知和实际 Hermes 新回复提醒均收到。

新增要求：推送记录保留 15 天，每天 UTC 19:00 自动清理；设备注册与偏好保留。客户端 TTL 限制为 15 天。

保留 Android、旧根规划和其他无关修改；不恢复 iPhone 自动续签。通知不解密聊天正文。

2026-10-29 后续授权：用户要求同时提交并推送 Bark 及此前未提交的代码和文档；按功能拆成提交，排除本机 Xcode 用户配置和构建产物。

# 进度

2026-10-29：阅读上游文档/协议及本地路由；用户已确认同时接入 Hermes 新回复提醒。开始核对现有 Cloudflare 部署权限。

2026-10-29：用户通过外部 Google Chrome 完成 Cloudflare OAuth。实现私有 Bark 路由、D1 设备管理、带 CSRF 的中文设置页，以及 Hermes WebSocket/HTTP 入站持久通知队列、流式去重与失败重试。

新增 15 天保留策略：D1 回执与最近发送/错误状态每天清理；Bark payload 默认且最多 ttl=1296000 秒；设备注册和通知偏好不被周期清理。

验证：npm test 289/289 通过；Wrangler dry-run 成功；本地浏览器验证登录/退出、偏好保存/刷新和模拟测试通知。模拟通知不代表真实手机接收。

线上：仅应用 0015_bark_push.sql，新增 4 个 Bark Secrets；以 --keep-vars 发布到 wispy-cloud-0978，版本 c28b5ff0-c5f1-4001-80c5-5e0a8cdb8eef。原有 20 项绑定逐项相同；原无 cron，现有 0 19 * * * 清理计划。首页/设置页/ping 返回 200，错误 base 返回 404，无效注册返回 400，未登录管理 API 返回 401。Python urllib 请求首页遭到 403，改用 curl 及真实 Chrome 验证正常，未修改站点防护。

部署前版本 a2a5d949-0a28-4ec4-be64-6a8cf8bd0342，配置快照和部署日志保存在 /private/tmp/mynotes-bark-*。12 个预先存在的无关修改 SHA-256 均保持一致；没有提交或推送此次 Bark 修改。

手机验收：用户完成 Bark 注册；通过线上设置页发送真实测试通知，APNs 接受，页面显示成功。用户随后明确确认“测试和 Hermes 提醒都收到了”，完成实际手机与 Hermes 新回复的验证。临时部署密钥文件已删除，线上 Secrets 保留。

最终只读复核：1 台已启用设备、0 个设备错误；实际 Hermes 自动投递回执已写入 1 条，最近发送 UTC 2026-10-29 02:22:38，last_error=NULL。本地 UI 测试服务已停止。

后续提交授权：用户要求提交并推送本次 Bark，以及此前安卓连接恢复与历史文档。提交前再次运行 npm test，289/289 通过；按功能拆分提交，排除本机 xcuserdata 与已有忽略规则覆盖的构建产物和凭据。

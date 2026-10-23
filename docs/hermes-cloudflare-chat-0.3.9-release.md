# cloudflare_chat 0.3.9 / My Notes Android 2.24

日期：2026-10-19。目标：改善锁屏/后台返回后的连接恢复，减少重复连接及流式更新消耗，保持现有免费套餐和功能。NAS 插件由用户部署。

## 交付

- `output/cloudflare_chat-0.3.9-linux.tar.gz`：NAS/Linux 包。
- `output/cloudflare_chat-0.3.9.zip`：相同内容的 ZIP 包。
- `output/My Notes-Android-2.24.apk`：Android versionCode 35，沿用现有 debug 签名，与交付的 2.23 证书相同，可覆盖升级。
- `output/cloudflare_chat-0.3.9-delivery-SHA256SUMS.txt`：三个交付文件的 SHA-256。
- `output/cloudflare_chat-0.3.9-validation/`：构建、回归、真实上游及发布包验证证据。

插件继续要求 Hermes >=0.22.1，依赖 `cryptography>=50,<51`、`websockets>=14,<17`，保留 0.3.8 的统一网关兼容修复。本轮按固定上游 v0.22.1 commit `297552a9d646119871391d202509822cd86330df` 验证，不把最低版本声明视为对未来所有上游版本的承诺。

## 实现

1. **安卓恢复连接**：进程级监听 Activity 恢复和默认网络变化。前台健康检查发送字符串 ping，由现有 Hub 自动回复，不唤醒业务处理；10 秒内去重检查，8 秒未回复后退休连接，走已有退避重连。断网停止自动重试，有效网络恢复/切换时重新连接；合并进行中的认证/连接请求。沿用每 profile 的原序号补拉。
2. **插件重连退避**：基础上限按 1/2/4/8/16/30 秒增长，实际延迟为其 75–100%，最大 30 秒。仅连接持续至少 60 秒后重置；短时握手成功不再打断退避。
3. **重复流式更新去重**：仅缓存同一连接已 ACK 的中间更新摘要，按 chat/目标序号区分，最多 128 项且不落盘。相同中间内容可跳过；final 始终发出。失败、取消、旧连接 ACK 和被后续更新替代的并发 ACK 不会建立错误的去重缓存。

保持现有 WebSocket、加密和消息格式、最终回复持久化、ACK/HTTP 发送兜底、checkpoint、附件、命令、审批和澄清。Worker 源码与线上配置未变，无需重新部署；没有增加 HTTP 轮询或付费服务。减少的是无效请求，无法在没有线上前后样本时给出具体节省百分比；未来免费额度仍受总使用量影响。

## 验证

| 范围 | 结果 |
|---|---|
| 插件 Python 回归 | 87/87，含新增 6 项去重/退避测试 |
| 真实 Hermes 运行 | 14/14，含统一网关 SQLite FIFO、流式、附件、命令、profile 隔离 |
| 真实 Hermes 审批 | default/personal 各 19 个场景，38/38 |
| 相关 Node 协议/客户端合约 | 93/93 |
| 源码及 ZIP 解包后原生插件检查 | 各 14/14，保留既有内部 API 耦合提示 |
| 上游与插件依赖联合解析 | 成功；已安装 cryptography 50.0.1、websockets 15.0.1 满足声明 |
| Android debug 与 instrumentation 构建 | 通过 |
| 独立 API 36 模拟器恢复测试 | 通过：健康/失效探测、重复事件合并、旧 socket 事件隔离、握手期间不探测、按 seq 补拉、离线停止重试、网络恢复/切换、退出后不重连 |
| Android 原有加密和生物认证存储回归 | 通过 |
| APK 签名与版本 | 验证通过；与 2.23 同证书，2.24 / 35 |
| ZIP / tar.gz | 同样六个插件文件，逐字节比对源码、归档完整性和 SHA-256 通过 |

Android 恢复测试执行真实 client/manager 方法，传输由 fake WebSocket 替换，网络恢复事件由夹具注入，认证执行器截获请求，因此没有向线上发送测试聊天或认证请求。该验证不替代用户手机锁屏、厂商省电、真实网络切换及 NAS/TLS 的长期验证。Android 被系统暂停/终止时仍须等待进程恢复，不能保证一直在线。

## 用户部署

1. 确认 NAS Hermes 已到 v0.22.1 或适配版本。
2. 解包后，将完整 `cloudflare_chat/` 目录替换到每个已启用 profile 的插件目录，例如默认 `/root/.hermes/plugins/cloudflare_chat` 和命名 profile `/root/.hermes/profiles/personal/plugins/cloudflare_chat`。
3. 保留各 profile 外层 `.env`、聊天密钥与插件启用配置，保持 `plugins.isolation: in_process`。
4. 各 profile 都替换完后，仅重启共同的 multiplex Gateway 一次。
5. 手机覆盖安装 Android 2.24 APK。插件可兼容旧客户端，但安卓恢复逻辑必须更新 APK 才生效。macOS 无需更新。
6. 分别检查普通聊天、连续消息、长回复完成、忙碌时 `/status`/`/stop`、附件、新审批按钮；手机锁屏后返回和切换网络时，确认连接恢复且没有重复消息。

本轮未连接或部署 NAS、未重启 Gateway、未部署 Worker，也未安装到用户手机。既有未提交兼容性修复保留，本轮未提交或推送 Git。

## 测试环境操作失误

第一次模拟器验证误判了 `-datadir` 对现有 AVD 的隔离效果；实际磁盘仍指向 `Medium_Phone_API_36.0`，随后重置操作清除了该本机模拟器的数据。发现后已停止实例并告知用户，原目录无快照可用于恢复。最终测试使用 `ANDROID_AVD_HOME=/private/tmp/hermes-recovery-android-20261019/avds` 下新建的 `HermesRecoveryQA`，启动后核对 userdata/cache/encryptionkey 的实际路径均在临时目录才进行安装测试。手机和 NAS 未受此操作影响。

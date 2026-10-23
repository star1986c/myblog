# cloudflare_chat 0.3.10：Hermes v0.22.4 连接锁适配

日期：2026-10-23。适用于当前 NAS 插件 0.3.9 的升级；NAS 部署由用户执行。

## 交付

- NAS/Linux：`output/cloudflare_chat-0.3.10-linux.tar.gz`
- ZIP：`output/cloudflare_chat-0.3.10.zip`
- SHA-256：`output/cloudflare_chat-0.3.10-SHA256SUMS.txt`
- 验证证据：`output/cloudflare_chat-0.3.10-validation/`

最低 Hermes 版本为 **0.22.4**。本轮使用官方 v0.22.4 源码，固定 commit
`4d04303818b61bf3aa09278af48356315515965b`，在 macOS / Python 3.14.8 的独立环境验证。
依赖保持 `cryptography>=50,<51`、`websockets>=14,<17`，与目标上游的
cryptography 50.0.1、websockets 15.0.1 联合解析、安装检查通过。

## 修复内容

1. 正确解包 `acquire_scoped_lock()` 返回的 `(acquired, existing)`。
   旧版把非空二元组直接当布尔值，即使获取失败也继续连接；新版遇到锁冲突会停止连接。
2. 使用 `gateway.status_scoped_locks.release_scoped_lock()`，修正已迁移的导入路径。
   旧版捕获导入错误后只清空内存状态，磁盘锁文件仍存在；新版正常断开时释放实际锁文件。
3. 去掉缺失获取锁接口时静默放行的逻辑，避免绕过锁保护。

这些问题不都始于 v0.22.4：获取锁的二元组在 v0.22.1 已存在，释放函数迁移在
v0.22.3 已存在。本次直接适配 v0.22.4，不增加旧接口兼容分支。

相对原 0.3.9 归档，只有 adapter.py、plugin.yaml、README.md 改变。
加密实现、依赖文件及入口文件逐字节相同；0.3.9 重连退避、流式去重和原有协议保持不变。
无需更新 Cloudflare Worker、Android 或 macOS 客户端。

## 验证

| 检查 | 结果 |
|---|---|
| 旧版负对照 | 新增 3 项单测在旧代码上失败；实际锁文件释放检查也复现失败 |
| 插件回归 | 90/90 通过，含锁冲突阻止连接、当前模块释放与缺失接口不放行 |
| 真实上游运行 | 15/15 通过，含普通聊天、SQLite FIFO、流式、附件、命令、profile 隔离 |
| 真实锁检查 | 断开删除锁文件、重连重新取得锁；另一进程获取失败且不删除原持有者的锁 |
| 真实审批 | default / personal 各 19 场景，38/38 通过 |
| Worker / 客户端合约 | 93/93 通过 |
| 原生插件验证 | 源码与 ZIP 解包后各 15/15 通过，要求 in_process |
| 依赖联合检查 | 69 个包兼容，dry-run 无需变更 |
| ZIP 解包后运行集成 | 15/15 通过 |
| 归档检查 | ZIP、tar.gz 均含同样 6 个插件文件，逐字节匹配源码，SHA-256 复核通过 |

原生验证仍报告一组内部 API 耦合提示，包括命令、澄清、费用提示和释放锁接口；这些在
固定目标版本下验证通过，但最低版本声明不代表对未来所有 Hermes 版本的兼容承诺。

运行测试首轮发现原测试在发出回复后立即检查 ACK 队列，偶尔早于接收协程消费 ACK。
已改为在原有 8 秒超时内等待 ACK 和会话完成，没有修改产品 ACK 逻辑。
首轮记录保留在 `runtime-ack-fixture-first-run.log`，最终结果见 `real-runtime.log`。

## NAS 更新步骤

1. 确认 Hermes 已升级到 v0.22.4，再安装插件 0.3.10。
2. 校验下载包的 SHA-256，解包得到完整 `cloudflare_chat/`。
3. 将每个已启用 profile 的插件目录完整替换为新版，例如：
   - 默认：`/root/.hermes/plugins/cloudflare_chat`
   - personal：`/root/.hermes/profiles/personal/plugins/cloudflare_chat`
4. 保留 profile 外层 `.env`、密钥、插件启用配置，保持 `plugins.isolation: in_process`。
5. 全部 profile 替换完成后，只重启共同的 multiplex Gateway 一次。
6. 逐个 profile 检查普通消息、连续两条消息、长回复、附件、忙碌时 `/status` 和 `/stop`，
   并发起新的审批交互。旧的进行中审批不跨重启保留。

不需要重新部署 Worker 或安装手机、桌面客户端。本轮未连接 NAS、未重启真实服务。
模型执行和外部传输为模拟；本地测试不替代 NAS/Linux、真实 TLS、模型和 Cloudflare 链路验证。

## 校验和

```text
d418feb3625fdbba51ceda192c649c916ef6a3eca4bfcd9bd811426627aae821  cloudflare_chat-0.3.10.zip
dcd9111d5ab8e7b508ae27c5d0d180552e0abc7be3e4729242bc7b9b5b8c525b  cloudflare_chat-0.3.10-linux.tar.gz
```

打包脚本和原生验证脚本保存在本次验证目录。真实运行及审批脚本保存在
`integrations/hermes-cloudflare-chat/tests/`；执行时将固定上游目录和插件父目录加入
`PYTHONPATH`，将 `HERMES_HOME` 设为独立 `/private/tmp/` 目录，并通过
`AUDIT_PLUGIN_DIR` 指向待测插件目录。模拟 Hermes 的单测与真实上游测试必须分进程执行。

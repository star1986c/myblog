# iPhone 手动续签维护

桌面 `My Notes iPhone 续签.command` 调用本机
`~/Library/Application Support/MyNotesRenewal/renew.py`。仓库维护源码为
`scripts/renew-mynotes-ios.py`；修改仓库脚本后，需要同步本机副本才会影响桌面操作。
应用继续使用本机配置中已经核准的固定源码快照。

## 2026-11-03 签名缓存修复

此次失败发生在申请新描述文件之后、安装之前。Xcode 的增量构建替换了
`embedded.mobileprovision`，却保留了此前的代码签名，导致 `codesign` 报
`a sealed resource is missing or invalid`。此前脚本只根据描述文件有效期判断
缓存包能否复用，重复双击会继续使用损坏的包。

修复后的处理方式：

- 需要构建时，在续签专用的构建目录执行 `xcodebuild clean build`，保证重新生成并签名安装包。
- 复用待安装包前，检查描述文件身份、目标设备、有效期和完整代码签名，同时核对包内应用标识及版本。
- 缓存包签名或版本检查失败时，自动走清理及重新构建流程；有效缓存仍可直接重试安装。
- 安装前再次验证完整签名及包内版本。重新构建后若仍无效，停止，不循环重建。
- 仅在设备安装返回成功后更新已安装到期记录。失败保留原到期记录，不卸载应用。
- 显式 `--use-prebuilt` 模式只验证指定构建，失败即停止，不自动重新构建。

缓存签名检查日志为 `logs/verify-cached-signature.log`；最终安装前检查日志为
`logs/verify-signature.log`，两者均记录详细的无效文件信息。

## 验证与部署

运行离线测试：

```sh
/opt/homebrew/bin/python3 scripts/test-renew-mynotes-ios.py -v
```

测试包含损坏缓存自动重建、重建仍无效时阻止安装、失败不修改到期记录、有效缓存
重试安装，以及 macOS 上用临时 ad-hoc 签名复现真实资源封印损坏的回归测试。
离线测试不连接 Apple 或手机，不使用个人证书。

同步前取得本机 `run.lock` 的排他锁，并备份原脚本、状态、失败日志及损坏的安装包。
同步后核对脚本哈希，通过桌面同一入口实际续签，再核对设备版本、安装结果、
代码签名和新到期时间。实际续签使用 Xcode 账号及已配对 iPhone。

2026-11-03 实机验证已通过：桌面同一入口检测出旧缓存的
`embedded.mobileprovision` 封印不匹配，自动执行清理和重新构建；日志确认
`CLEAN SUCCEEDED`、新的 `CodeSign` 步骤和 `BUILD SUCCEEDED`。
安装前和安装后完整签名检查均通过，设备查询仍为 **0.1.8 (9)**；通过
`wired` 覆盖安装成功，记录状态为 `renewed / installed`，新签名到期为
**2026-11-10 15:43:17（台北）**。固定快照的 80 个源文件校验仍全部一致，
桌面工具运行副本与仓库修复脚本逐字节一致。15 项离线测试全部通过。
升级前备份位于本机续签目录的
`upgrade-backups/signature-cache-fix-20261103T074306Z/`。

这些保护针对构建及缓存一致性；Xcode 账号、网络、设备连接或系统签名服务异常
仍可能让续签失败，届时以对应日志为准，不把失败计为续签成功。

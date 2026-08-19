# 工作区文档导航

本目录保存 My Notes 移动办公与 AI 工作区的长期文档。根目录 [`README.md`](../README.md) 是项目总览和日常命令入口；这里按用途区分当前规范、运维手册与历史资料。

## 当前文档

| 文档 | 用途 | 维护时机 |
| --- | --- | --- |
| [`../README.md`](../README.md) | 工作区定位、系统结构、模块地图、安全边界与常用命令 | 模块职责、平台支持或主工作流变化时 |
| [`hermes-cloudflare-chat.md`](hermes-cloudflare-chat.md) | Hermes Cloudflare 中继架构、NAS 多 profile 部署、密钥配置、清理和回滚 | Worker、插件、原生端协议或部署流程变化时 |
| [`hermes-native-client-capabilities.json`](hermes-native-client-capabilities.json) | Android / macOS Hermes 功能完成契约，由测试读取 | 任一端新增、删除或改变 Hermes 能力时 |
| [`../integrations/hermes-cloudflare-chat/cloudflare_chat/README.md`](../integrations/hermes-cloudflare-chat/cloudflare_chat/README.md) | NAS 插件安装位置与逐版本升级说明 | 插件发布或升级顺序变化时 |

## 历史资料

[`superpowers/plans/2026-07-06-cloudflare-personal-site.md`](superpowers/plans/2026-07-06-cloudflare-personal-site.md) 记录仓库最初作为 Cloudflare 个人站点时的实施计划。它只用于理解演进历史，不代表当前工作区范围、完成状态或待办清单。

## 文档维护原则

- 根 README 负责回答“这个工作区是什么、有哪些模块、如何开始”。
- 专项手册负责部署参数、故障边界和回滚步骤，避免在根 README 重复维护。
- JSON 能力契约是可执行规范，不是展示型清单；修改后必须运行 `npm test`。
- 已实现能力、计划能力和历史背景必须分开表述。
- 所有示例只使用变量名或占位符，不记录生产 secret、聊天密钥、API Token 或账号敏感信息。

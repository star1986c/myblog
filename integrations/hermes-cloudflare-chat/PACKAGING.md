# 插件更新包规范

用户要求：以后 Cloudflare Chat 插件更新统一交付 **ZIP**，不打包 macOS 信息。

在仓库根目录运行：

```sh
python3 scripts/package-hermes-cloudflare-chat.py
```

- 版本号读取 `cloudflare_chat/plugin.yaml`，输出 `output/cloudflare_chat-<版本>.zip` 和 SHA-256 校验文件。
- ZIP 根目录为 `cloudflare_chat/`，仅包含 README、初始化入口、adapter、crypto codec、manifest、requirements 六个发布文件。
- 不使用 Finder 压缩或递归打包工作区；白名单排除 `.DS_Store`、`__MACOSX`、`._*`、Python 缓存、开发环境和密钥。
- 直接写入文件正文，固定 ZIP 时间与通用文件权限，不携带 macOS 扩展属性、资源叉、用户/组信息、本机路径或 ZIP 额外元数据。
- 生成后自动检查文件清单、CRC、元数据字段与源码逐字节一致性。同样源码重复生成的 ZIP 哈希应相同。
- 后续如需增加发布文件，显式更新脚本白名单。ZIP/校验文件留在忽略的 `output/`，源码和发布说明可提交。

旧版本历史中的 tar.gz 是此前交付记录，后续默认不再生成或交付该格式。

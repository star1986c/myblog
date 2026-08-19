import Foundation

public struct HermesCommand: Equatable, Hashable, Identifiable, Sendable {
  public let name: String
  public let arguments: String
  public let description: String
  public let category: String
  public let featured: Bool
  public let caution: Bool
  public let aliases: [String]

  public var id: String { name }
  public var invocation: String { "/\(name)" }
  public var usage: String {
    arguments.isEmpty ? invocation : "\(invocation) \(arguments)"
  }

  public init(
    _ name: String,
    _ arguments: String = "",
    _ description: String,
    category: String,
    featured: Bool = false,
    caution: Bool = false,
    aliases: [String] = []
  ) {
    self.name = name
    self.arguments = arguments
    self.description = description
    self.category = category
    self.featured = featured
    self.caution = caution
    self.aliases = aliases
  }

  fileprivate func matches(_ rawQuery: String) -> Bool {
    let query = rawQuery.lowercased()
    return query.isEmpty
      || name.lowercased().contains(query)
      || description.lowercased().contains(query)
      || aliases.contains { $0.lowercased().contains(query) }
  }
}

/// Messaging commands mirrored from the Android client and Hermes' messaging reference.
///
/// Runtime-installed skills and user-defined commands remain discoverable through `/commands`.
public enum HermesCommandCatalog {
  public static let officialReference = URL(
    string: "https://hermes-agent.nousresearch.com/docs/reference/slash-commands/"
  )!

  public static let all: [HermesCommand] = [
    command("help", description: "显示当前 Hermes 可用帮助", category: "常用", featured: true),
    command("commands", "[page]", "浏览此 NAS 的全部指令、skills 与快捷命令", category: "常用", featured: true),
    command("status", description: "显示会话、模型、上下文和运行状态", category: "常用", featured: true),
    command("model", "[provider:model]", "查看或切换已在 NAS 配置的模型", category: "常用", featured: true),
    command("sessions", "[all|search <query>]", "浏览或搜索以往会话", category: "常用", featured: true),
    command("stop", description: "停止运行中的 Agent 和后台进程", category: "常用", featured: true, caution: true),
    command("new", "[name]", "开始全新会话，可选会话名称", category: "会话", featured: true, caution: true),
    command("reset", description: "重置当前会话并重新开始", category: "会话", featured: true, caution: true),
    command("retry", description: "重试上一条用户消息", category: "会话"),
    command("undo", "[N]", "撤回最近的用户/助手交换", category: "会话", caution: true),
    command("title", "[name]", "显示或设置当前会话标题", category: "会话"),
    command("resume", "[name]", "恢复之前命名的会话", category: "会话"),
    command("compress", "[here [N] | focus topic]", "压缩上下文并保留关键内容", category: "会话"),
    command("branch", "[name]", "从当前会话创建分支", category: "会话", aliases: ["fork"]),
    command("background", "<prompt>", "在独立后台会话运行任务", category: "会话"),
    command("queue", "<prompt>", "排队下一条任务，不中断当前回复", category: "会话", aliases: ["q"]),
    command("steer", "<prompt>", "在当前运行中注入方向提示", category: "会话"),
    command("agents", description: "显示当前 Agent 和运行任务", category: "会话", aliases: ["tasks"]),
    command("context", "[all]", "查看上下文窗口使用情况", category: "会话", aliases: ["ctx"]),
    command("personality", "[name]", "设置或清除当前会话的助手风格", category: "模型与回复"),
    command("fast", "[normal|fast|status]", "查看或切换快速推理模式", category: "模型与回复"),
    command("reasoning", "[level|show|hide] [--global]", "调整推理强度或显示方式", category: "模型与回复"),
    command("footer", "[on|off|status]", "控制回复底部的模型与上下文信息", category: "模型与回复"),
    command("codex-runtime", "[auto|codex_app_server|on|off]", "设置 OpenAI/Codex 运行方式", category: "模型与回复"),
    command("goal", "<text|status|pause|resume|clear>", "管理跨回合持续目标", category: "任务与自动化"),
    command("subgoal", "<text|remove N|clear>", "给持续目标追加验收条件", category: "任务与自动化"),
    command("heartbeat", "every <interval> <prompt>", "设置当前会话的周期性提示", category: "任务与自动化"),
    command("suggestions", "[accept|dismiss|catalog|clear]", "管理 Hermes 建议的自动化", category: "任务与自动化"),
    command("curator", "[status|run|pin|archive]", "管理后台 skill 维护任务", category: "任务与自动化"),
    command("blueprint", "[name] [slot=value ...]", "通过模板创建自动化", category: "任务与自动化"),
    command("usage", description: "显示 token、费用和会话时长", category: "状态与系统"),
    command("whoami", description: "显示当前消息用户的指令权限", category: "状态与系统"),
    command("insights", "[days]", "查看近期用量分析", category: "状态与系统"),
    command("egress", "[status]", "查看 Docker 出口代理状态", category: "状态与系统"),
    command("diff", "[staged|all|session] [--stat]", "查看工作目录或会话改动", category: "状态与系统"),
    command("rollback", "[number]", "列出或恢复文件系统检查点", category: "状态与系统", caution: true),
    command("reload-mcp", description: "重新加载 MCP 服务配置", category: "状态与系统", aliases: ["reload_mcp"]),
    command("reload-skills", description: "重新扫描已安装或删除的 skills", category: "状态与系统", aliases: ["reload_skills"]),
    command("platform", "<list|pause|resume> [name]", "查看或控制 Gateway 平台 adapter", category: "状态与系统", caution: true),
    command("debug", description: "上传诊断报告并获取分享链接", category: "状态与系统"),
    command("update", description: "更新 Hermes Agent 到最新版", category: "状态与系统", caution: true),
    command("restart", description: "平滑重启 Gateway", category: "状态与系统", caution: true),
    command("approve", "[session|always]", "批准待执行的危险命令", category: "审批与安全", caution: true),
    command("deny", description: "拒绝待执行的危险命令", category: "审批与安全", caution: true),
    command("yolo", description: "切换跳过危险命令审批的模式", category: "审批与安全", caution: true),
  ]

  public static var featured: [HermesCommand] { all.filter(\.featured) }

  public static var categories: [String] {
    all.reduce(into: []) { result, command in
      if !result.contains(command.category) { result.append(command.category) }
    }
  }

  public static func suggestions(for composerText: String, maximum: Int = 8)
    -> [HermesCommand]
  {
    guard composerText.hasPrefix("/") else { return [] }
    let afterSlash = composerText.dropFirst()
    let query = afterSlash.prefix { !$0.isWhitespace }
    return Array(all.lazy.filter { $0.matches(String(query)) }.prefix(max(0, maximum)))
  }

  public static func search(_ query: String) -> [HermesCommand] {
    all.filter { $0.matches(query.trimmingCharacters(in: .whitespacesAndNewlines)) }
  }

  private static func command(
    _ name: String,
    description: String,
    category: String,
    featured: Bool = false,
    caution: Bool = false,
    aliases: [String] = []
  ) -> HermesCommand {
    command(
      name,
      "",
      description,
      category: category,
      featured: featured,
      caution: caution,
      aliases: aliases
    )
  }

  private static func command(
    _ name: String,
    _ arguments: String = "",
    _ description: String,
    category: String,
    featured: Bool = false,
    caution: Bool = false,
    aliases: [String] = []
  ) -> HermesCommand {
    HermesCommand(
      name,
      arguments,
      description,
      category: category,
      featured: featured,
      caution: caution,
      aliases: aliases
    )
  }
}

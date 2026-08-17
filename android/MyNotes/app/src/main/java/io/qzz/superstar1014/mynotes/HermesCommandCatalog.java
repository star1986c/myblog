package io.qzz.superstar1014.mynotes;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Messaging commands from Hermes' official slash-command reference.
 *
 * <p>This deliberately excludes terminal-only commands. Installed skills and user-defined quick
 * commands are runtime-specific, so the catalog links users to /commands instead of pretending a
 * bundled list can know what is installed on their NAS.</p>
 */
final class HermesCommandCatalog {
  static final String OFFICIAL_REFERENCE =
    "https://hermes-agent.nousresearch.com/docs/reference/slash-commands/";

  static final class Action {
    final String label;
    final String prefix;
    final String inputHint;
    final String suffix;

    Action(String label, String prefix, String inputHint, String suffix) {
      this.label = label;
      this.prefix = prefix;
      this.inputHint = inputHint;
      this.suffix = suffix;
    }

    boolean needsInput() {
      return inputHint != null;
    }

    String fixedCommand() {
      return prefix + suffix;
    }

    String commandWith(String input) {
      return prefix + input.trim() + suffix;
    }
  }

  static final class Command {
    final String name;
    final String argsHint;
    final String description;
    final String category;
    final List<String> aliases;
    final List<Action> actions;
    final boolean featured;
    final boolean caution;

    Command(
      String name,
      String argsHint,
      String description,
      String category,
      boolean featured,
      boolean caution,
      List<String> aliases,
      List<Action> actions
    ) {
      this.name = name;
      this.argsHint = argsHint;
      this.description = description;
      this.category = category;
      this.featured = featured;
      this.caution = caution;
      this.aliases = Collections.unmodifiableList(new ArrayList<>(aliases));
      this.actions = Collections.unmodifiableList(new ArrayList<>(actions));
    }

    String invocation() {
      return "/" + name;
    }

    String usage() {
      return invocation() + (argsHint.isEmpty() ? "" : " " + argsHint);
    }

    boolean matches(String rawQuery) {
      String query = rawQuery.toLowerCase(Locale.ROOT);
      if (name.toLowerCase(Locale.ROOT).contains(query)
          || description.toLowerCase(Locale.ROOT).contains(query)) return true;
      for (String alias : aliases) {
        if (alias.toLowerCase(Locale.ROOT).contains(query)) return true;
      }
      return false;
    }
  }

  private static final List<Command> COMMANDS = List.of(
    command("help", "", "显示当前 Hermes 可用帮助", "常用", true, false),
    command("commands", "[page]", "浏览此 NAS 的全部指令、skills 与快捷命令", "常用", true, false,
      actions(
        fixed("查看第 1 页", "/commands"),
        input("打开指定页", "/commands ", "页码，例如 2", "")
      )),
    command("status", "", "显示会话、模型、上下文和运行状态", "常用", true, false),
    command("model", "[provider:model]", "查看或切换已在 NAS 配置的模型", "常用", true, false,
      actions(
        fixed("查看当前与可用模型", "/model"),
        input("切换当前会话模型", "/model ", "provider:model 或模型别名", ""),
        input("切换并保存为默认", "/model ", "provider:model 或模型别名", " --global")
      )),
    command("sessions", "[all|search <query>]", "浏览或搜索以往会话", "常用", true, false,
      actions(
        fixed("浏览当前聊天会话", "/sessions"),
        fixed("查看全部来源（管理员）", "/sessions all"),
        input("按标题或 ID 搜索", "/sessions search ", "会话标题或 ID", "")
      )),
    command("stop", "", "停止运行中的 Agent 和后台进程", "常用", true, true),
    command("new", "[name]", "开始全新会话（别名 /reset）", "会话", true, true,
      aliases("reset"),
      actions(
        fixed("开始未命名新会话", "/new"),
        input("开始并命名会话", "/new ", "新会话名称", "")
      )),
    command("retry", "", "重试上一条用户消息", "会话", false, false),
    command("undo", "[N]", "撤回最近的用户/助手交换", "会话", false, true,
      actions(
        fixed("撤回最近 1 轮", "/undo"),
        input("撤回指定轮数", "/undo ", "轮数，例如 2", "")
      )),
    command("title", "[name]", "显示或设置当前会话标题", "会话", false, false,
      actions(
        fixed("显示当前标题", "/title"),
        input("设置会话标题", "/title ", "会话标题", "")
      )),
    command("resume", "[name]", "恢复之前命名的会话", "会话", false, false,
      actions(
        fixed("浏览可恢复会话", "/resume"),
        input("按名称恢复", "/resume ", "会话名称", "")
      )),
    command("compress", "[here [N] | focus topic]", "压缩上下文并保留关键内容", "会话", false, false,
      actions(
        fixed("压缩全部上下文", "/compress"),
        fixed("保留最近 2 轮", "/compress here 2"),
        input("按重点压缩", "/compress ", "需要重点保留的主题", "")
      )),
    command("branch", "[name]", "从当前会话创建分支（别名 /fork）", "会话", false, false,
      aliases("fork"),
      actions(
        fixed("创建未命名分支", "/branch"),
        input("创建命名分支", "/branch ", "分支会话名称", "")
      )),
    command("background", "<prompt>", "在独立后台会话运行任务", "会话", false, false,
      actions(input("填写后台任务", "/background ", "要在后台执行的任务", ""))),
    command("queue", "<prompt>", "排队下一条任务，不中断当前回复", "会话", false, false,
      aliases("q"), actions(input("填写排队任务", "/queue ", "下一条任务", ""))),
    command("steer", "<prompt>", "在当前运行中注入方向提示", "会话", false, false,
      actions(input("填写引导内容", "/steer ", "希望 Agent 调整的方向", ""))),
    commandAliases("agents", "", "显示当前 Agent 和运行任务（别名 /tasks）", "会话", false, false,
      aliases("tasks")),
    command("context", "[all]", "查看上下文窗口使用情况（别名 /ctx）", "会话", false, false,
      aliases("ctx"), actions(
        fixed("查看上下文概览", "/context"),
        fixed("查看含 skills/tools 的明细", "/context all")
      )),

    command("personality", "[name]", "设置或清除当前会话的助手风格", "模型与回复", false, false,
      actions(
        fixed("查看可用风格", "/personality"),
        fixed("简洁", "/personality concise"),
        fixed("技术", "/personality technical"),
        fixed("教师", "/personality teacher"),
        fixed("清除风格", "/personality none"),
        input("输入其他风格名称", "/personality ", "风格名称", "")
      )),
    command("fast", "[normal|fast|status]", "查看或切换快速推理模式", "模型与回复", false, false,
      actions(
        fixed("查看状态", "/fast status"),
        fixed("快速模式", "/fast fast"),
        fixed("普通模式", "/fast normal")
      )),
    command("reasoning", "[level|show|hide] [--global]", "调整推理强度或显示方式", "模型与回复", false, false,
      actions(
        fixed("显示推理", "/reasoning show"),
        fixed("隐藏推理", "/reasoning hide"),
        fixed("中等强度", "/reasoning medium"),
        fixed("高强度", "/reasoning high"),
        input("自定义级别或参数", "/reasoning ", "例如 xhigh --global", "")
      )),
    command("footer", "[on|off|status]", "控制回复底部的模型与上下文信息", "模型与回复", false, false,
      actions(
        fixed("查看状态", "/footer status"),
        fixed("开启", "/footer on"),
        fixed("关闭", "/footer off")
      )),
    command("codex-runtime", "[auto|codex_app_server|on|off]", "设置 OpenAI/Codex 运行方式", "模型与回复", false, false,
      actions(
        fixed("自动", "/codex-runtime auto"),
        fixed("Codex app-server", "/codex-runtime codex_app_server"),
        fixed("开启", "/codex-runtime on"),
        fixed("关闭", "/codex-runtime off")
      )),

    command("goal", "<text|status|pause|resume|clear>", "管理跨回合持续目标", "任务与自动化", false, false,
      actions(
        fixed("查看目标状态", "/goal status"),
        fixed("暂停目标", "/goal pause"),
        fixed("继续目标", "/goal resume"),
        fixed("清除目标", "/goal clear"),
        input("设置新目标", "/goal ", "持续目标内容", "")
      )),
    command("subgoal", "<text|remove N|clear>", "给当前持续目标追加验收条件", "任务与自动化", false, false,
      actions(
        fixed("列出子目标", "/subgoal"),
        fixed("清除子目标", "/subgoal clear"),
        input("追加子目标", "/subgoal ", "验收条件", ""),
        input("删除指定子目标", "/subgoal remove ", "编号", "")
      )),
    command("heartbeat", "every <interval> <prompt>", "设置当前会话的周期性提示", "任务与自动化", false, false,
      actions(
        fixed("查看状态", "/heartbeat status"),
        fixed("暂停", "/heartbeat pause"),
        fixed("继续", "/heartbeat resume"),
        fixed("清除", "/heartbeat clear"),
        input("设置周期任务", "/heartbeat every ", "例如 30m 检查服务状态", "")
      )),
    command("suggestions", "[accept|dismiss|catalog|clear]", "管理 Hermes 建议的自动化", "任务与自动化", false, false,
      actions(
        fixed("查看建议", "/suggestions"),
        fixed("加入示例目录", "/suggestions catalog"),
        fixed("清理已处理建议", "/suggestions clear"),
        input("接受建议", "/suggestions accept ", "建议 ID", ""),
        input("忽略建议", "/suggestions dismiss ", "建议 ID", "")
      )),
    command("curator", "[status|run|pin|archive]", "管理后台 skill 维护任务", "任务与自动化", false, false,
      actions(
        fixed("查看状态", "/curator status"),
        fixed("立即运行", "/curator run"),
        input("固定条目", "/curator pin ", "条目 ID", ""),
        input("归档条目", "/curator archive ", "条目 ID", "")
      )),
    command("blueprint", "[name] [slot=value ...]", "通过模板创建自动化", "任务与自动化", false, false,
      actions(
        fixed("浏览模板", "/blueprint"),
        input("选择模板", "/blueprint ", "模板名称及可选参数", "")
      )),

    command("usage", "", "显示 token、费用和会话时长", "状态与系统", false, false),
    command("whoami", "", "显示当前消息用户的指令权限", "状态与系统", false, false),
    command("insights", "[days]", "查看近期用量分析", "状态与系统", false, false,
      actions(
        fixed("查看最近 30 天", "/insights"),
        input("指定天数", "/insights ", "天数，例如 7", "")
      )),
    command("egress", "[status]", "查看 Docker 出口代理状态", "状态与系统", false, false),
    command("diff", "[staged|all|session] [--stat]", "查看工作目录或会话改动", "状态与系统", false, false,
      actions(
        fixed("查看未提交改动", "/diff"),
        fixed("查看会话改动统计", "/diff session --stat"),
        input("自定义范围", "/diff ", "例如 all --stat", "")
      )),
    command("rollback", "[number]", "列出或恢复文件系统检查点", "状态与系统", false, true,
      actions(
        fixed("列出检查点", "/rollback"),
        input("恢复检查点", "/rollback ", "检查点编号", "")
      )),
    commandAliases("reload-mcp", "", "重新加载 MCP 服务配置", "状态与系统", false, false,
      aliases("reload_mcp")),
    commandAliases("reload-skills", "", "重新扫描已安装或删除的 skills", "状态与系统", false, false,
      aliases("reload_skills")),
    command("platform", "<list|pause|resume> [name]", "查看或控制 Gateway 平台 adapter", "状态与系统", false, true,
      actions(
        fixed("列出平台状态", "/platform list"),
        input("暂停平台", "/platform pause ", "平台名称", ""),
        input("恢复平台", "/platform resume ", "平台名称", "")
      )),
    command("debug", "", "上传诊断报告并获取分享链接", "状态与系统", false, false),
    command("update", "", "更新 Hermes Agent 到最新版", "状态与系统", false, true),
    command("restart", "", "平滑重启 Gateway", "状态与系统", false, true),
    command("approve", "[session|always]", "批准待执行的危险命令", "审批与安全", false, true,
      actions(
        fixed("仅批准一次", "/approve"),
        fixed("本会话批准", "/approve session"),
        fixed("永久加入允许列表", "/approve always")
      )),
    command("deny", "", "拒绝待执行的危险命令", "审批与安全", false, true),
    command("yolo", "", "切换跳过危险命令审批的模式", "审批与安全", false, true)
  );

  private HermesCommandCatalog() {}

  static List<Command> all() {
    return COMMANDS;
  }

  static List<Command> featured() {
    List<Command> result = new ArrayList<>();
    for (Command command : COMMANDS) {
      if (command.featured) result.add(command);
    }
    return result;
  }

  static List<String> categories() {
    Set<String> categories = new LinkedHashSet<>();
    for (Command command : COMMANDS) categories.add(command.category);
    return new ArrayList<>(categories);
  }

  static List<Command> suggestions(String composerText, int maximum) {
    if (composerText == null || !composerText.startsWith("/")) return List.of();
    String input = composerText.substring(1);
    int whitespace = firstWhitespace(input);
    if (whitespace >= 0) input = input.substring(0, whitespace);
    String query = input.trim();
    List<Command> result = new ArrayList<>();
    for (Command command : COMMANDS) {
      if (!command.matches(query)) continue;
      result.add(command);
      if (result.size() >= maximum) break;
    }
    return result;
  }

  private static int firstWhitespace(String value) {
    for (int index = 0; index < value.length(); index++) {
      if (Character.isWhitespace(value.charAt(index))) return index;
    }
    return -1;
  }

  private static Command command(
    String name,
    String argsHint,
    String description,
    String category,
    boolean featured,
    boolean caution
  ) {
    return new Command(
      name, argsHint, description, category, featured, caution, List.of(), List.of()
    );
  }

  private static Command command(
    String name,
    String argsHint,
    String description,
    String category,
    boolean featured,
    boolean caution,
    List<Action> actions
  ) {
    return new Command(
      name, argsHint, description, category, featured, caution, List.of(), actions
    );
  }

  private static Command commandAliases(
    String name,
    String argsHint,
    String description,
    String category,
    boolean featured,
    boolean caution,
    List<String> aliases
  ) {
    return new Command(
      name, argsHint, description, category, featured, caution, aliases, List.of()
    );
  }

  private static Command command(
    String name,
    String argsHint,
    String description,
    String category,
    boolean featured,
    boolean caution,
    List<String> aliases,
    List<Action> actions
  ) {
    return new Command(
      name, argsHint, description, category, featured, caution, aliases, actions
    );
  }

  private static List<String> aliases(String... aliases) {
    return List.of(aliases);
  }

  private static List<Action> actions(Action... actions) {
    return List.of(actions);
  }

  private static Action fixed(String label, String command) {
    return new Action(label, command, null, "");
  }

  private static Action input(String label, String prefix, String hint, String suffix) {
    return new Action(label, prefix, hint, suffix);
  }
}

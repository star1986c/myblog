
/// Bound initial layout by text volume as well as row count. Keep whole messages,
/// including an oversized newest message, and let explicit paging reach all history.
public enum HermesChatMessageWindow {
  public static let pageSize = 40
  public static let initialTextBudget = 16_000

  public static func visibleCount(in messages: [HermesChatMessage], limit: Int) -> Int {
    guard !messages.isEmpty else { return 0 }
    var initialCount = 0
    var remaining = initialTextBudget
    for message in messages.suffix(pageSize).reversed() {
      // Newlines create separate Markdown/Text layout blocks even in short reports.
      let cost = message.text.utf8.count
        + message.text.utf8.reduce(0) { $0 + ($1 == 10 ? 80 : 0) }
        + message.attachments.count * 1_000
      if initialCount > 0 && cost > remaining { break }
      initialCount += 1
      remaining -= cost
    }
    return min(messages.count, initialCount + max(0, limit - pageSize))
  }
}

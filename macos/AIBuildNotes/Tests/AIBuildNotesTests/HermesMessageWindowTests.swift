import NotesCore
import Testing

@testable import AIBuildNotes

struct HermesMessageWindowTests {
  private func messages(_ texts: [String]) -> [HermesChatMessage] {
    texts.enumerated().map { index, text in
      HermesChatMessage(id: "\(index)", sender: "agent", sentAt: Int64(index), sequence: Int64(index + 1), text: text)
    }
  }

  @Test func shortChatsKeepTheExistingPageSize() {
    #expect(HermesMessageWindow.visibleCount(in: [], limit: 40) == 0)
    let history = messages(Array(repeating: "short", count: 100))
    #expect(HermesMessageWindow.visibleCount(in: history, limit: 40) == 40)
    #expect(HermesMessageWindow.visibleCount(in: history, limit: 80) == 80)
    #expect(HermesMessageWindow.visibleCount(in: history, limit: 120) == 100)
  }

  @Test func reportsBoundLayoutAndAllHistoryRemainsReachable() {
    let report = String(repeating: "报告内容\n", count: 200)
    let history = messages(Array(repeating: report, count: 100) + ["latest"])
    let initial = HermesMessageWindow.visibleCount(in: history, limit: 40)
    #expect(initial == 1)
    #expect(history.suffix(initial).last?.text == "latest")
    #expect(HermesMessageWindow.visibleCount(in: history, limit: 80) == 41)
    #expect(HermesMessageWindow.visibleCount(in: history, limit: 160) == history.count)
    // Switching profiles starts with its own initial budget, even after paging.
    #expect(HermesMessageWindow.visibleCount(in: history, limit: 40) == initial)
  }

  @Test func oversizedNewestMessageIsNeverTruncatedOrHidden() {
    let text = String(repeating: "长文👩🏽‍💻\n", count: 10_000)
    let history = messages(["old", text])
    let count = HermesMessageWindow.visibleCount(in: history, limit: 40)
    #expect(count == 1)
    #expect(history.suffix(count).first?.text == text)
  }
}

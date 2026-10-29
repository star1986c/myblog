import Foundation

/// New profiles bootstrap one day; existing profiles resume from their checkpoint.
struct HermesChatOpeningSync {
  private let since: Int64
  private var completedProfileIDs: Set<String> = []

  init(now: Date = Date()) {
    since = max(1, Int64(now.timeIntervalSince1970 * 1_000) - 86_400_000)
  }

  func sinceMilliseconds(spaceID: String, lastSequence: Int64 = 0) -> Int64? {
    lastSequence > 0 || completedProfileIDs.contains(spaceID) ? nil : since
  }

  mutating func complete(spaceID: String) {
    completedProfileIDs.insert(spaceID)
  }
}

/// Live delivery can interleave with replay. Only replay frames may advance the
/// pagination cursor, otherwise a new live message could skip unfinished pages.
struct HermesChatReplayCursor: Sendable {
  private(set) var sequence: Int64

  init(sequence: Int64) { self.sequence = max(0, sequence) }

  mutating func receive(sequence: Int64, replayed: Bool) {
    if replayed { self.sequence = max(self.sequence, sequence) }
  }
}

/// Hold live durable events until replay completes so a newer live sequence
/// cannot become the persisted checkpoint while older pages are still missing.
struct HermesChatReplayDelivery: Sendable {
  private(set) var isReplaying = true
  private var pending: [HermesChatClientEvent] = []

  mutating func enqueue(_ event: HermesChatClientEvent, replayed: Bool) -> Bool {
    guard isReplaying && !replayed else { return true }
    if case .message(_, let message, _) = event,
      message.replaceSequence > 0 && !message.finalUpdate { return false }
    pending.append(event)
    return false
  }

  mutating func complete() -> [HermesChatClientEvent] {
    isReplaying = false
    let events = pending
    pending = []
    return events
  }
}

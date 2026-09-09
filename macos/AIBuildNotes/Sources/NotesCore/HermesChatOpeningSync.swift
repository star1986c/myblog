import Foundation

/// Keep the opening replay pending per profile until all of its pages have arrived.
struct HermesChatOpeningSync {
  private let since: Int64
  private var completedProfileIDs: Set<String> = []

  init(now: Date = Date()) {
    since = max(1, Int64(now.timeIntervalSince1970 * 1_000) - 86_400_000)
  }

  func sinceMilliseconds(spaceID: String) -> Int64? {
    completedProfileIDs.contains(spaceID) ? nil : since
  }

  mutating func complete(spaceID: String) {
    completedProfileIDs.insert(spaceID)
  }
}

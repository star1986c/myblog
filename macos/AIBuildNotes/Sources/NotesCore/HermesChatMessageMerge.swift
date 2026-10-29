import Foundation

/// The relay stores a final edit as a separate event. A visible bubble always
/// uses the original sequence, even when replay no longer includes that event.
enum HermesChatMessageMerge {
  /// Returns true only when a new logical message was inserted.
  @discardableResult
  static func apply(_ incoming: HermesChatMessage, to messages: inout [HermesChatMessage]) -> Bool {
    let isEdit = incoming.replaceSequence > 0
    let target = isEdit ? incoming.replaceSequence : incoming.sequence
    let matches = messages.indices.filter { index in
      let message = messages[index]
      return message.id == incoming.id
        || (target > 0 && message.sequence == target)
        // Older clients saved orphan finals under the edit's event sequence.
        || (isEdit && incoming.finalUpdate && incoming.sequence > 0
          && message.sequence == incoming.sequence)
    }
    guard !matches.isEmpty else {
      if isEdit && !incoming.finalUpdate { return false }
      var message = incoming
      if isEdit {
        message.sequence = target
        message.lastEditSequence = incoming.sequence
        message.replaceSequence = 0
        message.finalUpdate = false
      }
      messages.append(message)
      return true
    }

    let candidates = matches.map { messages[$0] }
    let newest = candidates.max { revision($0) < revision($1) }!
    var merged: HermesChatMessage
    if isEdit {
      // Keep the original identity if available (including for deletion).
      merged = candidates.first { $0.sequence == target } ?? newest
      merged.text = newest.text
      merged.interaction = newest.interaction
      if !newest.attachments.isEmpty { merged.attachments = newest.attachments }
      merged.lastEditSequence = newest.lastEditSequence
      if !incoming.finalUpdate || incoming.sequence >= revision(newest) {
        merged.text = incoming.text
        if !incoming.attachments.isEmpty { merged.attachments = incoming.attachments }
        merged.interaction = incoming.interaction
        if incoming.finalUpdate { merged.lastEditSequence = incoming.sequence }
      }
      merged.sequence = target
      merged.replaceSequence = 0
      merged.finalUpdate = false
    } else {
      // An original replayed after its final must not roll the reply back.
      merged = incoming
      if revision(newest) > revision(incoming) {
        merged.text = newest.text
        if !newest.attachments.isEmpty { merged.attachments = newest.attachments }
        merged.interaction = newest.interaction
        merged.lastEditSequence = newest.lastEditSequence
        merged.sequence = newest.sequence
      }
    }
    messages[matches[0]] = merged
    for index in matches.dropFirst().reversed() { messages.remove(at: index) }
    return false
  }

  /// Repair legacy repeated IDs/sequences on load without comparing text.
  /// Group first to avoid quadratic work on a large, otherwise healthy cache.
  static func normalize(_ messages: [HermesChatMessage]) -> [HermesChatMessage] {
    let byID = Dictionary(grouping: messages, by: \.id)
    let uniqueIDs = byID.values.map { group in
      group.dropFirst().reduce(into: [group[0]]) { apply($1, to: &$0) }[0]
    }
    let bySequence = Dictionary(grouping: uniqueIDs) { message in
      message.sequence > 0 ? "seq:\(message.sequence)" : "id:\(message.id)"
    }
    return bySequence.values.map { group in
      group.dropFirst().reduce(into: [group[0]]) { apply($1, to: &$0) }[0]
    }.sorted {
      if $0.sentAt != $1.sentAt { return $0.sentAt < $1.sentAt }
      if $0.sequence != $1.sequence { return $0.sequence < $1.sequence }
      return $0.id < $1.id
    }
  }

  private static func revision(_ message: HermesChatMessage) -> Int64 {
    max(message.sequence, message.lastEditSequence ?? 0)
  }
}

import Foundation

public struct HermesChatClientProfile: Sendable {
  public let spaceID: String
  public let crypto: HermesChatCrypto
  public let lastSequence: Int64

  public init(spaceID: String, crypto: HermesChatCrypto, lastSequence: Int64) {
    self.spaceID = spaceID
    self.crypto = crypto
    self.lastSequence = max(0, lastSequence)
  }
}

public enum HermesChatClientEvent: Sendable {
  case ready
  case message(spaceID: String, message: HermesChatMessage)
  case acknowledged(spaceID: String, messageID: String, sequence: Int64)
  case actionAcknowledged(spaceID: String, actionID: String, delivered: Bool)
  case typing(spaceID: String, active: Bool)
  case profileError(spaceID: String, reason: String)
  case disconnected(reason: String)
}

public actor HermesChatClient {
  public static let productionRelayURL = URL(
    string: "wss://h.superstar1014.qzz.io/api/hermes-chat/ws"
  )!

  public nonisolated let events: AsyncStream<HermesChatClientEvent>

  private let continuation: AsyncStream<HermesChatClientEvent>.Continuation
  private let relayURL: URL
  private let session: URLSession
  private var socket: URLSessionWebSocketTask?
  private var profiles: [String: ProfileState] = [:]
  private var receiveTask: Task<Void, Never>?
  private var pingTask: Task<Void, Never>?
  private var generation = 0
  private var closing = false
  private var ready = false

  public init(
    relayURL: URL = productionRelayURL,
    session: URLSession? = nil
  ) {
    self.relayURL = relayURL
    if let session {
      self.session = session
    } else {
      let configuration = URLSessionConfiguration.default
      configuration.waitsForConnectivity = true
      configuration.timeoutIntervalForRequest = 30
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      self.session = URLSession(configuration: configuration)
    }
    let stream = AsyncStream<HermesChatClientEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(1_000)
    )
    events = stream.stream
    continuation = stream.continuation
  }

  deinit {
    continuation.finish()
    socket?.cancel(with: .goingAway, reason: nil)
  }

  public func connect(
    ticket: HermesChatMultiplexTicket,
    profileConfigurations: [HermesChatClientProfile]
  ) {
    closeCurrentSocket(reason: "macOS chat reconnecting")
    let configured = Dictionary(
      uniqueKeysWithValues: profileConfigurations.map {
        ($0.spaceID, ProfileState(crypto: $0.crypto, lastSequence: $0.lastSequence))
      }
    )
    let ticketSpaces = Set(ticket.spaceIds)
    guard !configured.isEmpty, Set(configured.keys) == ticketSpaces else {
      continuation.yield(.disconnected(reason: "Hermes profile ticket 与本机密钥不匹配。"))
      return
    }

    profiles = configured
    closing = false
    ready = false
    generation += 1
    let currentGeneration = generation
    var request = URLRequest(url: relayURL)
    request.timeoutInterval = 30
    request.setValue("Bearer \(ticket.ticket)", forHTTPHeaderField: "Authorization")
    request.setValue("client", forHTTPHeaderField: "X-Hermes-Role")
    request.setValue("multiplex", forHTTPHeaderField: "X-Hermes-Mode")
    request.setValue("My-Notes-macOS/1.6", forHTTPHeaderField: "User-Agent")
    let task = session.webSocketTask(with: request)
    socket = task
    task.resume()
    receiveTask = Task { [weak self] in
      await self?.receiveLoop(socket: task, generation: currentGeneration)
    }
    pingTask = Task { [weak self] in
      await self?.pingLoop(socket: task, generation: currentGeneration)
    }
  }

  public func disconnect() {
    closing = true
    generation += 1
    closeCurrentSocket(reason: "macOS chat closed")
    profiles = [:]
  }

  public func isConnected() -> Bool { ready && socket != nil && !closing }

  public func sendMessage(
    spaceID: String,
    text: String,
    attachments: [HermesChatAttachmentDescriptor]
  ) async throws -> HermesChatMessage {
    let profile = try requireReadyProfile(spaceID)
    let id = UUID().uuidString.lowercased()
    let sentAt = Int64(Date().timeIntervalSince1970 * 1_000)
    let envelope = try profile.crypto.encryptMessageEnvelope(
      sender: "client",
      text: text,
      attachments: attachments,
      messageID: id,
      sentAt: sentAt
    )
    try await sendRouted(
      spaceID: spaceID,
      frame: try Self.outgoingMessageFrame(envelope)
    )
    return HermesChatMessage(
      id: id,
      sender: "client",
      sentAt: sentAt,
      sequence: 0,
      text: text,
      attachments: attachments
    )
  }

  public func sendInteractionAction(
    spaceID: String,
    promptID: String,
    optionID: String
  ) async throws -> String {
    let profile = try requireReadyProfile(spaceID)
    let id = UUID().uuidString.lowercased()
    let envelope = try profile.crypto.encryptInteractionEnvelope(
      promptID: promptID,
      optionID: optionID,
      messageID: id,
      sentAt: Int64(Date().timeIntervalSince1970 * 1_000)
    )
    try await sendRouted(spaceID: spaceID, frame: [
      "v": 1,
      "type": "action",
      "message": try Self.jsonObject(envelope),
    ])
    return id
  }

  public func sendTyping(spaceID: String, active: Bool) async {
    guard ready, var profile = profiles[spaceID], profile.lastTypingActive != active else { return }
    do {
      try await sendRouted(spaceID: spaceID, frame: [
        "v": 1,
        "type": "typing",
        "active": active,
      ])
      profile.lastTypingActive = active
      profiles[spaceID] = profile
    } catch {
      // Typing state is best-effort and must not interrupt message entry.
    }
  }

  private func receiveLoop(socket: URLSessionWebSocketTask, generation: Int) async {
    do {
      while !Task.isCancelled, generation == self.generation {
        let value = try await socket.receive()
        let data: Data
        switch value {
        case .data(let received): data = received
        case .string(let received): data = Data(received.utf8)
        @unknown default: continue
        }
        try await handleIncoming(data, generation: generation)
      }
    } catch {
      guard generation == self.generation, !closing else { return }
      ready = false
      self.socket = nil
      continuation.yield(.disconnected(reason: Self.errorMessage(error)))
    }
  }

  private func pingLoop(socket: URLSessionWebSocketTask, generation: Int) async {
    while !Task.isCancelled, generation == self.generation {
      do {
        try await Task.sleep(for: .seconds(25))
        guard generation == self.generation, !closing else { return }
        try await Self.sendPing(socket)
      } catch {
        if generation == self.generation, !closing {
          socket.cancel(with: .goingAway, reason: nil)
        }
        return
      }
    }
  }

  private func handleIncoming(_ data: Data, generation: Int) async throws {
    guard generation == self.generation,
      let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = frame["type"] as? String
    else { throw HermesChatCryptoError.invalidMessage }

    if type == "ready" {
      guard frame["multiplex"] as? Bool == true else {
        throw HermesChatCryptoError.invalidMessage
      }
      for spaceID in profiles.keys.sorted() { try await sendResume(spaceID: spaceID) }
      ready = true
      continuation.yield(.ready)
      return
    }
    if type == "pong" { return }
    guard let spaceID = frame["spaceId"] as? String, profiles[spaceID] != nil else {
      throw HermesChatCryptoError.invalidMessage
    }

    switch type {
    case "message", "edit":
      guard let rawEnvelope = frame["message"] else {
        throw HermesChatCryptoError.invalidMessage
      }
      let envelopeData = try JSONSerialization.data(withJSONObject: rawEnvelope)
      let envelope = try JSONDecoder().decode(HermesChatMessageEnvelope.self, from: envelopeData)
      let sequence = Self.int64(frame["seq"]) ?? 0
      var profile = try requireProfile(spaceID)
      let message = try profile.crypto.decryptMessageEnvelope(envelope, sequence: sequence)
      if type == "edit" {
        guard let target = Self.int64(frame["targetSeq"]),
          let final = frame["final"] as? Bool,
          message.replaceSequence == target,
          message.finalUpdate == final
        else { throw HermesChatCryptoError.invalidMessage }
      }
      if sequence > 0 {
        profile.lastSequence = max(profile.lastSequence, sequence)
        profiles[spaceID] = profile
      }
      continuation.yield(.message(spaceID: spaceID, message: message))
    case "resume_complete":
      if frame["hasMore"] as? Bool == true { try await sendResume(spaceID: spaceID) }
    case "ack":
      let durable = frame["durable"] as? Bool ?? true
      let id = frame["id"] as? String ?? ""
      if durable {
        let sequence = Self.int64(frame["seq"]) ?? 0
        if sequence > 0, var profile = profiles[spaceID] {
          profile.lastSequence = max(profile.lastSequence, sequence)
          profiles[spaceID] = profile
        }
        continuation.yield(
          .acknowledged(spaceID: spaceID, messageID: id, sequence: sequence)
        )
      } else {
        continuation.yield(
          .actionAcknowledged(
            spaceID: spaceID,
            actionID: id,
            delivered: frame["delivered"] as? Bool ?? false
          )
        )
      }
    case "typing":
      if frame["sender"] as? String == "agent" {
        continuation.yield(
          .typing(spaceID: spaceID, active: frame["active"] as? Bool ?? false)
        )
      }
    case "error":
      continuation.yield(
        .profileError(
          spaceID: spaceID,
          reason: frame["message"] as? String ?? "Cloudflare 拒绝了聊天消息。"
        )
      )
    default:
      throw HermesChatCryptoError.invalidMessage
    }
  }

  private func sendResume(spaceID: String) async throws {
    let profile = try requireProfile(spaceID)
    try await sendRouted(spaceID: spaceID, frame: [
      "v": 1,
      "type": "resume",
      "afterSeq": profile.lastSequence,
    ])
  }

  private func sendRouted(spaceID: String, frame: [String: Any]) async throws {
    guard let socket, !closing else { throw URLError(.notConnectedToInternet) }
    var routed = frame
    routed["spaceId"] = spaceID
    let data = try JSONSerialization.data(withJSONObject: routed)
    guard let text = String(data: data, encoding: .utf8) else {
      throw HermesChatCryptoError.invalidMessage
    }
    try await socket.send(.string(text))
  }

  private func requireReadyProfile(_ spaceID: String) throws -> ProfileState {
    guard ready, socket != nil, !closing else { throw URLError(.notConnectedToInternet) }
    return try requireProfile(spaceID)
  }

  private func requireProfile(_ spaceID: String) throws -> ProfileState {
    guard let profile = profiles[spaceID] else { throw HermesChatCryptoError.invalidKey }
    return profile
  }

  private func closeCurrentSocket(reason: String) {
    receiveTask?.cancel()
    pingTask?.cancel()
    receiveTask = nil
    pingTask = nil
    ready = false
    let old = socket
    socket = nil
    old?.cancel(with: .normalClosure, reason: Data(reason.utf8))
  }

  private static func jsonObject<T: Encodable>(_ value: T) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
  }

  static func outgoingMessageFrame(
    _ envelope: HermesChatMessageEnvelope
  ) throws -> [String: Any] {
    guard let frame = try jsonObject(envelope) as? [String: Any] else {
      throw HermesChatCryptoError.invalidMessage
    }
    return frame
  }

  private static func int64(_ value: Any?) -> Int64? {
    if let value = value as? Int64 { return value }
    if let value = value as? Int { return Int64(value) }
    if let value = value as? NSNumber { return value.int64Value }
    return nil
  }

  private static func sendPing(_ socket: URLSessionWebSocketTask) async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, Error>) in
      socket.sendPing { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
    }
  }

  private static func errorMessage(_ error: Error) -> String {
    if let localized = error as? LocalizedError, let message = localized.errorDescription {
      return message
    }
    let value = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? "Hermes WebSocket 已断开。" : value
  }

  private struct ProfileState: Sendable {
    let crypto: HermesChatCrypto
    var lastSequence: Int64
    var lastTypingActive: Bool?

    init(crypto: HermesChatCrypto, lastSequence: Int64) {
      self.crypto = crypto
      self.lastSequence = max(0, lastSequence)
    }
  }
}

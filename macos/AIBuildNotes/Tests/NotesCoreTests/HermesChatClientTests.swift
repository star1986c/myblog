import Foundation
import Testing

@testable import NotesCore

@Test("Hermes WebSocket ping callback is one-shot")
func hermesPingCallbackIgnoresDuplicateDelivery() async throws {
  try await HermesChatClient.awaitSinglePingResult { completion in
    completion(nil)
    completion(URLError(.cancelled))
  }
}

@Test("Hermes WebSocket ping keeps its first error")
func hermesPingCallbackKeepsFirstError() async {
  do {
    try await HermesChatClient.awaitSinglePingResult { completion in
      completion(URLError(.networkConnectionLost))
      completion(nil)
    }
    Issue.record("Expected the first ping error to be thrown")
  } catch let error as URLError {
    #expect(error.code == .networkConnectionLost)
  } catch {
    Issue.record("Unexpected ping error: \(error)")
  }
}

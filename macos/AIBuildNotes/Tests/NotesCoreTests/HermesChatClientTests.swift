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

@Test("Hermes recent refresh adds a timestamp without changing normal incremental resume")
func hermesRecentResumeFrameIsOptional() {
  let normal = HermesChatClient.resumeFrame(afterSequence: 42)
  #expect(normal["afterSeq"] as? Int64 == 42)
  #expect(normal["since"] == nil)

  let recent = HermesChatClient.resumeFrame(
    afterSequence: 0,
    sinceMilliseconds: 1_800_000_000_000
  )
  #expect(recent["afterSeq"] as? Int64 == 0)
  #expect(recent["since"] as? Int64 == 1_800_000_000_000)
}

@Test("Hermes refresh lookback accepts multiple ranges and clamps unsafe input")
func hermesRefreshLookbackIsConfigurable() {
  #expect(HermesChatStore.refreshLookbackOptions == [1, 2, 3, 7, 14, 30, 90])
  #expect(HermesChatStore.normalizedRefreshLookbackDays(30) == 30)
  #expect(HermesChatStore.normalizedRefreshLookbackDays(0) == 1)
  #expect(HermesChatStore.normalizedRefreshLookbackDays(10_000) == 3_650)
}

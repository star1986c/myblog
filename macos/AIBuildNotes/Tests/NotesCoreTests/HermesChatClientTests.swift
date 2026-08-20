import Foundation
import Testing

@testable import NotesCore

private actor HermesHandshakeProbe {
  private(set) var count = 0

  func fire() { count += 1 }
}

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

@Test("Hermes WebSocket handshake watchdog fires when ready never arrives")
func hermesHandshakeWatchdogFires() async throws {
  let probe = HermesHandshakeProbe()
  let watchdog = HermesChatClient.makeHandshakeWatchdog(timeout: .milliseconds(10)) {
    await probe.fire()
  }

  try await Task.sleep(for: .milliseconds(60))
  #expect(await probe.count == 1)
  watchdog.cancel()
}

@Test("Hermes WebSocket handshake watchdog cancellation suppresses timeout")
func hermesHandshakeWatchdogCanBeCancelled() async throws {
  let probe = HermesHandshakeProbe()
  let watchdog = HermesChatClient.makeHandshakeWatchdog(timeout: .milliseconds(40)) {
    await probe.fire()
  }

  watchdog.cancel()
  try await Task.sleep(for: .milliseconds(80))
  #expect(await probe.count == 0)
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

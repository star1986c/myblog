import Testing

@testable import NotesCore

private func approvalInteraction(
  state: String = "pending",
  expiresAt: Int64
) -> HermesChatInteraction {
  HermesChatInteraction(
    id: "550e8400-e29b-41d4-a716-446655440060",
    kind: "approval",
    state: state,
    expiresAt: expiresAt,
    options: [
      HermesChatInteractionOption(
        id: "once",
        label: "仅本次",
        style: "default",
        selected: false,
        disabled: false,
        wide: false
      )
    ]
  )
}

@Test("Hermes approval remains actionable before its deadline")
func hermesApprovalIsPendingBeforeDeadline() {
  let interaction = approvalInteraction(expiresAt: 1_800_000_000_000)

  #expect(interaction.isPending(at: 1_799_999_999_999))
  #expect(!interaction.isExpired(at: 1_799_999_999_999))
}

@Test("Hermes approval is rejected exactly at its deadline")
func hermesApprovalExpiresAtDeadline() {
  let interaction = approvalInteraction(expiresAt: 1_800_000_000_000)

  #expect(!interaction.isPending(at: 1_800_000_000_000))
  #expect(interaction.isExpired(at: 1_800_000_000_000))
}

@Test("Resolved Hermes interaction never becomes actionable again")
func resolvedHermesInteractionNeverReturnsToPending() {
  let interaction = approvalInteraction(
    state: "resolved",
    expiresAt: 1_800_000_000_000
  )

  #expect(!interaction.isPending(at: 1_799_999_999_999))
  #expect(!interaction.isExpired(at: 1_800_000_000_001))
}

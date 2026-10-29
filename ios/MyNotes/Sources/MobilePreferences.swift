import SwiftUI

/// A route uses the server's stable identifier, never mutable profile labels.
struct MobileChatRoute: Hashable {
  let id: String
}

enum MobileLockDelay: Int, CaseIterable, Identifiable {
  case immediately = 0
  case threeMinutes = 180
  case fiveMinutes = 300
  var id: Int { rawValue }
  var label: String {
    switch self {
    case .immediately: "立即"
    case .threeMinutes: "3 分钟后"
    case .fiveMinutes: "5 分钟后"
    }
  }
}

/// ContinuousClock includes time spent asleep and is unaffected by wall-clock edits.
struct MobileLockGrace {
  private(set) var backgroundedAt: ContinuousClock.Instant?

  mutating func enteredBackground(at now: ContinuousClock.Instant) {
    if backgroundedAt == nil { backgroundedAt = now }
  }

  mutating func returnedToForeground(at now: ContinuousClock.Instant, delay: MobileLockDelay) -> Bool {
    guard let backgroundedAt else { return false }
    self.backgroundedAt = nil
    return backgroundedAt.duration(to: now) >= .seconds(delay.rawValue)
  }

  mutating func reset() { backgroundedAt = nil }
}

enum MobileAppearance: String, CaseIterable, Identifiable {
  case system, light, dark
  var id: String { rawValue }
  var label: String {
    switch self { case .system: "跟随系统"; case .light: "浅色"; case .dark: "深色" }
  }
  var colorScheme: ColorScheme? {
    switch self { case .system: nil; case .light: .light; case .dark: .dark }
  }
}

@MainActor
enum MobileTheme {
  // A restrained blue-gray accent; system surfaces and labels handle contrast,
  // elevation, Dark Mode and increased-contrast accessibility settings.
  static let accent = Color(uiColor: UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0.66, green: 0.77, blue: 0.85, alpha: 1)
      : UIColor(red: 0.25, green: 0.36, blue: 0.45, alpha: 1)
  })
  static let canvas = Color(uiColor: .systemGroupedBackground)
  static let surface = Color(uiColor: .secondarySystemGroupedBackground)
  static let outgoing = Color(uiColor: .tertiarySystemFill)
}

/// Conversation-specific colors; notes and settings keep their system surfaces.
@MainActor
enum MobileChatStyle {
  private static func color(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(uiColor: UIColor { traits in
      let value = traits.userInterfaceStyle == .dark ? dark : light
      return UIColor(red: CGFloat((value >> 16) & 255) / 255,
        green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    })
  }
  static let accent = color(0x0879BC, 0x74C4F4)
  static let wallpaperTop = color(0xE5EDCE, 0x14242A)
  static let wallpaperBottom = color(0xCCE5D9, 0x172D32)
  static let incoming = color(0xFFFFFF, 0x24373E)
  static let outgoing = color(0xDCF4C7, 0x315246)
  static let code = color(0xEAF5F7, 0x1C3039)
  static let codeAccent = color(0x267F94, 0x79C4D6)
  static let input = color(0xFFFFFF, 0x26383F)
}

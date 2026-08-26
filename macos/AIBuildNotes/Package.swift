// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AIBuildNotes",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .library(name: "NotesCore", targets: ["NotesCore"]),
    .executable(name: "AIBuildNotes", targets: ["AIBuildNotes"]),
  ],
  targets: [
    .target(name: "NotesCore"),
    .executableTarget(
      name: "AIBuildNotes",
      dependencies: ["NotesCore"]
    ),
    .testTarget(
      name: "NotesCoreTests",
      dependencies: ["NotesCore"]
    ),
    .testTarget(
      name: "AIBuildNotesTests",
      dependencies: ["AIBuildNotes"]
    ),
  ]
)

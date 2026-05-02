// swift-tools-version:5.9
import PackageDescription

// Synthetic Swift eval corpus. Exists only as input to scripts/eval-retrieve.js
// and scripts/eval-hook.js — see eval-dataset.json. Each Sources/<module> dir
// is a separate target so the corpus exercises multi-target Swift layouts the
// way real SPM packages do.
let package = Package(
  name: "SwiftEval",
  targets: [
    .target(name: "PatientService", path: "Sources/PatientService"),
    .target(name: "UI", path: "Sources/UI"),
    .target(name: "Auth", path: "Sources/Auth"),
    .target(name: "Logging", path: "Sources/Logging"),
    .target(name: "Networking", path: "Sources/Networking"),
  ]
)

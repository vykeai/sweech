// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SweechBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "SweechBar",
            // OnlyMenuBarKit is vendored under Sources/OnlyMenuBarKit/ —
            // small (5 files) so we inline rather than carrying an external
            // SPM dependency on a sibling repo.
            path: "Sources",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Info.plist"])
            ]
        ),
        .testTarget(
            name: "SweechBarTests",
            dependencies: ["SweechBar"],
            path: "Tests"
        ),
    ]
)

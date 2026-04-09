// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SweechBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "SweechBar",
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

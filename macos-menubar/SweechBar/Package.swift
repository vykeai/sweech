// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SweechBar",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../../../../onlystack/libs/desktop-tooling-core/swift/OnlyMenuBarKit"),
    ],
    targets: [
        .executableTarget(
            name: "SweechBar",
            dependencies: ["OnlyMenuBarKit"],
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

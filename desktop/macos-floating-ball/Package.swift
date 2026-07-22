// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "LarkChannelFloatingBall",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "LarkChannelFloatingBall", targets: ["LarkChannelFloatingBall"]),
    ],
    targets: [
        .executableTarget(name: "LarkChannelFloatingBall"),
    ]
)

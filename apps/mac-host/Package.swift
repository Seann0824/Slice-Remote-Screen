// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SliceMacHost",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "slice-mac-host", targets: ["SliceMacHost"])
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "150.0.0")
    ],
    targets: [
        .executableTarget(
            name: "SliceMacHost",
            dependencies: [.product(name: "WebRTC", package: "WebRTC")]
        )
    ]
)

// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SliceMacHost",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "slice-mac-host", targets: ["SliceMacHost"])
    ],
    targets: [
        .executableTarget(name: "SliceMacHost")
    ]
)


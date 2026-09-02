import Foundation
import CoreGraphics

struct TargetFrame: Codable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ frame: CGRect) {
        x = frame.origin.x
        y = frame.origin.y
        width = frame.width
        height = frame.height
    }
}

struct RemoteTarget: Codable, Sendable {
    let kind: String
    let id: UInt32
    let title: String
    let appName: String?
    let bundleIdentifier: String?
    let frame: TargetFrame
}

struct PermissionState: Codable, Sendable {
    let screenRecording: Bool
    let accessibility: Bool
}

struct InstalledApplication: Codable, Sendable {
    let appKey: String
    let appName: String
    let bundleIdentifier: String?
    let path: String
    let isRunning: Bool
    let hasOpenWindow: Bool
}

struct PointerPoint: Codable, Sendable {
    let x: Double
    let y: Double
}

struct PointerGestureRequest: Codable, Sendable {
    let type: String
    let button: String?
    let clickCount: Int?
    let x: Double?
    let y: Double?
    let points: [PointerPoint]?
    let durationMs: Int?
    let deltaX: Double?
    let deltaY: Double?
}

struct PointerControlRequest: Codable, Sendable {
    let type: String
    let button: String?
    let clickCount: Int?
    let x: Double
    let y: Double
    let deltaX: Double?
    let deltaY: Double?

    init(
        type: String,
        button: String?,
        clickCount: Int?,
        x: Double,
        y: Double,
        deltaX: Double? = nil,
        deltaY: Double? = nil
    ) {
        self.type = type
        self.button = button
        self.clickCount = clickCount
        self.x = x
        self.y = y
        self.deltaX = deltaX
        self.deltaY = deltaY
    }
}

enum HostError: LocalizedError {
    case invalidArguments(String)
    case targetNotFound(kind: String, id: UInt32)
    case imageDestinationFailed(String)
    case eventCreationFailed
    case unsupportedKey(String)
    case applicationNotFound(String)
    case applicationCloseFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message): message
        case .targetNotFound(let kind, let id): "Target not found: \(kind):\(id)"
        case .imageDestinationFailed(let path): "Could not create PNG at \(path)"
        case .eventCreationFailed: "Could not create an input event"
        case .unsupportedKey(let key): "Unsupported key: \(key)"
        case .applicationNotFound(let bundleIdentifier): "Application not found: \(bundleIdentifier)"
        case .applicationCloseFailed(let appName): "Could not close application: \(appName)"
        }
    }
}

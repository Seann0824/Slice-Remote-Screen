import AppKit
import Foundation

enum AppIconService {
    @MainActor
    static func data(bundleIdentifier: String?, applicationPath: String?, size: Int) throws -> Data {
        let applicationURL: URL
        if let bundleIdentifier,
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) {
            applicationURL = url
        } else if let applicationPath {
            applicationURL = URL(fileURLWithPath: applicationPath)
        } else {
            throw HostError.applicationNotFound(bundleIdentifier ?? applicationPath ?? "unknown")
        }

        let dimension = max(32, min(size, 512))
        let icon = NSWorkspace.shared.icon(forFile: applicationURL.path)
        let resized = NSImage(size: NSSize(width: dimension, height: dimension))
        resized.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        icon.draw(
            in: NSRect(x: 0, y: 0, width: dimension, height: dimension),
            from: .zero,
            operation: .copy,
            fraction: 1
        )
        resized.unlockFocus()

        guard let tiff = resized.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            throw HostError.imageDestinationFailed(bundleIdentifier ?? applicationPath ?? "unknown")
        }
        return png
    }

    @MainActor
    static func write(bundleIdentifier: String, outputPath: String, size: Int) throws {
        try data(bundleIdentifier: bundleIdentifier, applicationPath: nil, size: size)
            .write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    }
}

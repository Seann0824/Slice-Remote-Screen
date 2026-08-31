@preconcurrency import ScreenCaptureKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum CaptureService {
    static func capture(target: ResolvedTarget, outputPath: String, maxWidth: Int) async throws {
        let configuration = SCStreamConfiguration()
        let safeWidth = max(320, min(maxWidth, 3_840))
        let scale = min(2.0, CGFloat(safeWidth) / max(target.frame.width, 1))
        configuration.width = max(1, Int(target.frame.width * scale))
        configuration.height = max(1, Int(target.frame.height * scale))
        configuration.showsCursor = true
        configuration.capturesAudio = false

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: target.filter,
            configuration: configuration
        )
        let url = URL(fileURLWithPath: outputPath)
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw HostError.imageDestinationFailed(outputPath)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw HostError.imageDestinationFailed(outputPath)
        }
    }
}


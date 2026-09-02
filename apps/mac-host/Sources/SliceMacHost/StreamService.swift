@preconcurrency import ScreenCaptureKit
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

final class StreamFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let output = FileHandle.standardOutput
    private let onPixelBuffer: ((CVPixelBuffer, CMTime) -> Void)?
    private let onStopped: ((Error) -> Void)?

    init(
        onPixelBuffer: ((CVPixelBuffer, CMTime) -> Void)? = nil,
        onStopped: ((Error) -> Void)? = nil
    ) {
        self.onPixelBuffer = onPixelBuffer
        self.onStopped = onStopped
        super.init()
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen,
              sampleBuffer.isValid,
              frameIsComplete(sampleBuffer),
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        if let onPixelBuffer {
            onPixelBuffer(pixelBuffer, CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
            return
        }

        autoreleasepool {
            let image = CIImage(cvPixelBuffer: pixelBuffer)
            guard let cgImage = context.createCGImage(image, from: image.extent),
                  let jpeg = encodeJPEG(cgImage) else { return }
            writeFrame(jpeg)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        if let onStopped {
            onStopped(error)
            return
        }
        let message = "ScreenCaptureKit stream stopped: \(error.localizedDescription)\n"
        FileHandle.standardError.write(Data(message.utf8))
        exit(1)
    }

    private func frameIsComplete(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer,
            createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
        let rawStatus = attachments.first?[.status] else {
            return true
        }
        let statusValue = (rawStatus as? NSNumber)?.intValue ?? (rawStatus as? Int)
        guard let statusValue, let status = SCFrameStatus(rawValue: statusValue) else { return true }
        return status == .complete
    }

    private func encodeJPEG(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else { return nil }
        let properties = [
            kCGImageDestinationLossyCompressionQuality: 0.82,
        ] as CFDictionary
        CGImageDestinationAddImage(destination, image, properties)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    private func writeFrame(_ frame: Data) {
        guard frame.count <= Int(UInt32.max) else { return }
        var size = UInt32(frame.count).bigEndian
        let header = withUnsafeBytes(of: &size) { Data($0) }
        output.write(header)
        output.write(frame)
    }
}

enum StreamService {
    static func run(target: ResolvedTarget, maxWidth: Int, framesPerSecond: Int) async throws {
        let configuration = SCStreamConfiguration()
        let safeWidth = max(320, min(maxWidth, 3_840))
        let scale = min(2.0, CGFloat(safeWidth) / max(target.frame.width, 1))
        configuration.width = max(1, Int(target.frame.width * scale))
        configuration.height = max(1, Int(target.frame.height * scale))
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.minimumFrameInterval = CMTime(
            value: 1,
            timescale: CMTimeScale(max(1, min(framesPerSecond, 30)))
        )
        configuration.queueDepth = 2
        configuration.pixelFormat = kCVPixelFormatType_32BGRA

        let frameOutput = StreamFrameOutput()
        let stream = SCStream(
            filter: target.filter,
            configuration: configuration,
            delegate: frameOutput
        )
        let queue = DispatchQueue(
            label: "com.sliceremotescreen.host.video",
            qos: .userInteractive
        )
        try stream.addStreamOutput(frameOutput, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()

        while !Task.isCancelled {
            try await Task.sleep(for: .seconds(60))
        }
        try await stream.stopCapture()
    }
}

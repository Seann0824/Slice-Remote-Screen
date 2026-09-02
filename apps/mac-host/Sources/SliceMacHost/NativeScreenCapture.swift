@preconcurrency import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
@preconcurrency import WebRTC

final class NativeScreenCapturer: RTCVideoCapturer, @unchecked Sendable {
    private var target: ResolvedTarget
    private let framesPerSecond: Int
    private let source: RTCVideoSource
    private let bridgeCapturer: RTCCameraVideoCapturer
    private var stream: SCStream?
    private var output: StreamFrameOutput?
    private var sampleQueue: DispatchQueue?
    private var screenshotFallbackTask: Task<Void, Never>?
    private(set) var capturedFrameCount = 0
    private var receivedStreamFrame = false
    private var acceptStreamFrames = true
    private let jpegContext = CIContext(options: [.cacheIntermediates: false])
    private let jpegQueue = DispatchQueue(label: "com.sliceremotescreen.native-jpeg", qos: .userInitiated)
    private let jpegStateLock = NSLock()
    private var jpegEncoding = false
    private var lastJpegTimestampNs: Int64 = 0
    // JPEG is only a bootstrap fallback. Keeping it enabled while WebRTC is
    // already delivering video wastes the same P2P bandwidth and adds head
    // of line blocking to the reliable data channel.
    private var jpegFallbackEnabled = true

    var onFirstFrame: (() -> Void)?
    var onJpegFrame: ((Data) -> Void)?

    init(target: ResolvedTarget, source: RTCVideoSource, framesPerSecond: Int = 30) {
        self.target = target
        self.framesPerSecond = framesPerSecond
        self.source = source
        self.bridgeCapturer = RTCCameraVideoCapturer(delegate: source)
        super.init(delegate: source)
    }

    func start() async throws {
        capturedFrameCount = 0
        receivedStreamFrame = false
        acceptStreamFrames = true
        setJpegFallbackEnabled(true)
        let configuration = captureConfiguration(for: target)

        let captureFilter = target.filter
        let captureWidth = configuration.width
        let captureHeight = configuration.height

        let nextOutput = StreamFrameOutput(
            onPixelBuffer: { [weak self] pixelBuffer, presentationTime in
                self?.publish(pixelBuffer, presentationTime: presentationTime)
            },
            onStopped: { [weak self] error in
                NSLog("Native screen capture stopped, switching to screenshot fallback: %@", error.localizedDescription)
                self?.receivedStreamFrame = false
                self?.startScreenshotFallback(
                    filter: captureFilter,
                    width: captureWidth,
                    height: captureHeight,
                    stopWhenStreamArrives: false
                )
            }
        )
        let nextStream = SCStream(filter: target.filter, configuration: configuration, delegate: nextOutput)
        let queue = DispatchQueue(
            label: "com.sliceremotescreen.native-video",
            qos: .userInteractive
        )
        try nextStream.addStreamOutput(nextOutput, type: SCStreamOutputType.screen, sampleHandlerQueue: queue)
        output = nextOutput
        sampleQueue = queue
        stream = nextStream
        var streamStarted = false
        do {
            try await nextStream.startCapture()
            streamStarted = true
        } catch {
            // ScreenCaptureKit can reject SCStream even when screenshot capture
            // is authorized (seen after display reconfiguration and wake). Do
            // not abort WebRTC negotiation: SCScreenshotManager is slower, but
            // it keeps remote control usable instead of producing a black peer.
            NSLog("SCStream failed to start, using screenshot fallback: %@", error.localizedDescription)
            output = nil
            sampleQueue = nil
            stream = nil
        }

        let firstScreenshot = try await SCScreenshotManager.captureImage(
            contentFilter: captureFilter,
            configuration: screenshotConfiguration(width: captureWidth, height: captureHeight)
        )
        guard let firstPixelBuffer = makePixelBuffer(from: firstScreenshot) else {
            throw NativeHostError.webrtc("无法转换首张屏幕画面")
        }
        publish(firstPixelBuffer, fromStream: false)
        startScreenshotFallback(
            filter: captureFilter,
            width: captureWidth,
            height: captureHeight,
            stopWhenStreamArrives: streamStarted
        )
    }

    func stop() async {
        screenshotFallbackTask?.cancel()
        screenshotFallbackTask = nil
        guard let stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
        output = nil
        sampleQueue = nil
    }

    func switchTarget(_ nextTarget: ResolvedTarget) async throws {
        setJpegFallbackEnabled(true)
        if let stream {
            let configuration = captureConfiguration(for: nextTarget)
            screenshotFallbackTask?.cancel()
            screenshotFallbackTask = nil
            receivedStreamFrame = false
            capturedFrameCount = 0
            acceptStreamFrames = false
            target = nextTarget

            // Publish the newly selected window before asking the existing
            // SCStream to reconfigure. updateContentFilter can suspend for a
            // long time; the screenshot loop keeps the selected target usable
            // and is cancelled automatically when SCStream resumes.
            let firstScreenshot = try await SCScreenshotManager.captureImage(
                contentFilter: nextTarget.filter,
                configuration: screenshotConfiguration(
                    width: configuration.width,
                    height: configuration.height
                )
            )
            if let firstPixelBuffer = makePixelBuffer(from: firstScreenshot) {
                publish(firstPixelBuffer, fromStream: false)
            }
            startScreenshotFallback(
                filter: nextTarget.filter,
                width: configuration.width,
                height: configuration.height,
                stopWhenStreamArrives: false
            )

            // Stopping and recreating SCStream while its sample queue is busy
            // can leave stopCapture suspended indefinitely. ScreenCaptureKit
            // supports replacing the filter in-place, which also keeps the
            // WebRTC video source and encoder alive during app switches.
            try await stream.updateContentFilter(nextTarget.filter)
            try await stream.updateConfiguration(configuration)
            acceptStreamFrames = true
            return
        }

        await stop()
        target = nextTarget
        try await start()
    }

    private func captureConfiguration(for target: ResolvedTarget) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        let safeWidth = 1_600
        let scale = min(2.0, CGFloat(safeWidth) / max(target.frame.width, 1))
        let scaledWidth = max(2, Int(target.frame.width * scale))
        let scaledHeight = max(2, Int(target.frame.height * scale))
        // VideoToolbox's H.264 encoder requires even pixel dimensions. An
        // odd scaled height (for example 1600x1039 on this Mac) accepts
        // capture frames but silently produces zero encoded/RTP frames.
        configuration.width = (scaledWidth / 2) * 2
        configuration.height = (scaledHeight / 2) * 2
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.minimumFrameInterval = CMTime(
            value: 1,
            timescale: CMTimeScale(max(1, min(framesPerSecond, 30)))
        )
        configuration.queueDepth = 2
        // WebRTC's native macOS encoder path consumes bi-planar YUV buffers.
        // ScreenCaptureKit happily delivers BGRA, but this framework build
        // never forwards those frames from RTCVideoSource to an encoder.
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        return configuration
    }

    private func publish(
        _ pixelBuffer: CVPixelBuffer,
        presentationTime: CMTime? = nil,
        fromStream: Bool = true
    ) {
        if fromStream && !acceptStreamFrames { return }
        if fromStream {
            receivedStreamFrame = true
            screenshotFallbackTask?.cancel()
            screenshotFallbackTask = nil
        }
        let presentationSeconds = presentationTime.map(CMTimeGetSeconds)
        let timestampNs = presentationSeconds?.isFinite == true
            ? Int64(presentationSeconds! * 1_000_000_000)
            : Int64(CACurrentMediaTime() * 1_000_000_000)
        let buffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let frame = RTCVideoFrame(
            buffer: buffer,
            rotation: ._0,
            timeStampNs: timestampNs
        )
        // Feed the native CVPixelBuffer to WebRTC. The Obj-C WebRTC capture
        // path is designed to accept RTCCVPixelBuffer and convert it on its
        // worker thread. Calling newI420() synchronously on ScreenCaptureKit's
        // sample queue can starve the sender before it emits its first RTP
        // packet (the control channel remains healthy, which looks like a
        // connected-but-black session).
        // Call RTCVideoSource directly. Going back through the inherited
        // Swift delegate property can be a no-op with some prebuilt Obj-C
        // WebRTC frameworks even though the capturer callback itself runs.
        source.capturer(bridgeCapturer, didCapture: frame.newI420())
        scheduleJpegFrame(pixelBuffer, timestampNs: timestampNs)
        capturedFrameCount += 1
        if capturedFrameCount == 1 {
            NSLog("Native screen capture produced the first frame: %dx%d", CVPixelBufferGetWidth(pixelBuffer), CVPixelBufferGetHeight(pixelBuffer))
            onFirstFrame?()
        }
    }

    private func startScreenshotFallback(
        filter: SCContentFilter,
        width: Int,
        height: Int,
        stopWhenStreamArrives: Bool
    ) {
        screenshotFallbackTask?.cancel()
        screenshotFallbackTask = Task { [weak self] in
            guard let self else { return }
            await self.captureScreenshots(
                filter: filter,
                width: width,
                height: height,
                stopWhenStreamArrives: stopWhenStreamArrives
            )
        }
    }

    private func captureScreenshots(
        filter: SCContentFilter,
        width: Int,
        height: Int,
        stopWhenStreamArrives: Bool
    ) async {
        let configuration = screenshotConfiguration(width: width, height: height)

        var didReportError = false
        while !Task.isCancelled && (!stopWhenStreamArrives || !receivedStreamFrame) {
            do {
                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: configuration
                )
                if let pixelBuffer = makePixelBuffer(from: image) {
                    publish(pixelBuffer, fromStream: false)
                }
            } catch {
                if !didReportError {
                    NSLog("Screenshot capture fallback failed: %@", error.localizedDescription)
                    didReportError = true
                }
            }
            try? await Task.sleep(for: .milliseconds(83))
        }
    }

    private func screenshotConfiguration(width: Int, height: Int) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = true
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        return configuration
    }

    private func scheduleJpegFrame(_ pixelBuffer: CVPixelBuffer, timestampNs: Int64) {
        guard onJpegFrame != nil else { return }
        jpegStateLock.lock()
        guard jpegFallbackEnabled else {
            jpegStateLock.unlock()
            return
        }
        let shouldEncode = !jpegEncoding && timestampNs - lastJpegTimestampNs >= 125_000_000
        if shouldEncode {
            jpegEncoding = true
            lastJpegTimestampNs = timestampNs
        }
        jpegStateLock.unlock()
        guard shouldEncode else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)

        jpegQueue.async { [weak self] in
            guard let self else { return }
            defer {
                jpegStateLock.lock()
                jpegEncoding = false
                jpegStateLock.unlock()
            }
            autoreleasepool {
                guard let cgImage = jpegContext.createCGImage(image, from: image.extent),
                      let jpeg = encodeJpeg(cgImage) else { return }
                onJpegFrame?(jpeg)
            }
        }
    }

    private func encodeJpeg(_ image: CGImage) -> Data? {
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

    func setJpegFallbackEnabled(_ enabled: Bool) {
        jpegStateLock.lock()
        jpegFallbackEnabled = enabled
        jpegStateLock.unlock()
    }

    private func makePixelBuffer(from image: CGImage) -> CVPixelBuffer? {
        let attributes = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ] as CFDictionary
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            image.width,
            image.height,
            kCVPixelFormatType_32BGRA,
            attributes,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer),
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue
                | CGImageAlphaInfo.premultipliedFirst.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return pixelBuffer
    }
}

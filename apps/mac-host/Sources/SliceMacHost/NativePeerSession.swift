import Foundation
@preconcurrency import WebRTC

final class NativePeerSession: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
    private let factory: RTCPeerConnectionFactory
    private let peerConnection: RTCPeerConnection
    private let source: RTCVideoSource
    private let capturer: NativeScreenCapturer
    private var videoTrack: RTCVideoTrack?
    private var videoSender: RTCRtpSender?
    private var dataChannel: RTCDataChannel?
    private var frameChannel: RTCDataChannel?
    private let frameSendQueue = DispatchQueue(label: "com.sliceremotescreen.native-frame-channel")
    private var nextFrameId: UInt32 = 0
    private var latestFrameData: Data?
    private var pendingAssets: [(id: String, data: Data)] = []
    private var pendingCandidates: [RTCIceCandidate] = []
    private var hasRemoteDescription = false

    var onSignal: ((String, String?, IceCandidateDescription?) -> Void)?
    var onControl: ((Data) -> Void)?
    var onState: ((RTCPeerConnectionState) -> Void)?
    var onFirstFrame: (() -> Void)?
    var onDiagnostics: ((String) -> Void)?

    init(target: ResolvedTarget, iceServers: [IceServerDescription]) throws {
        _ = RTCInitializeSSL()
        // The zero-argument factory only exposes the platform H.264 codec.
        // On some macOS/WebRTC builds VideoToolbox accepts the negotiated
        // format but encodes zero frames. Keep VP8 as a software fallback so
        // a healthy P2P/data connection cannot degrade into a black screen.
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        encoderFactory.preferredCodec = RTCVideoCodecInfo(name: "VP8")
        factory = RTCPeerConnectionFactory(
            encoderFactory: encoderFactory,
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
        // Use the generic source for an externally-fed capturer. The
        // prebuilt macOS framework's `forScreenCast` source does not attach
        // this custom Obj-C capturer to the sender pipeline.
        source = factory.videoSource()
        capturer = NativeScreenCapturer(target: target, source: source)

        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.bundlePolicy = .maxBundle
        configuration.iceServers = iceServers.map {
            RTCIceServer(
                urlStrings: $0.urls,
                username: $0.username,
                credential: $0.credential
            )
        }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peerConnection = factory.peerConnection(
            with: configuration,
            constraints: constraints,
            delegate: nil
        ) else { throw NativeHostError.webrtc("无法创建 WebRTC 连接") }
        self.peerConnection = peerConnection
        super.init()
        peerConnection.delegate = self
    }

    func answer(offerSDP: String) async throws {
        // Attach the local source before applying the offer so Unified Plan
        // binds the controller's first recvonly video m-line to this sender.
        // Adding a track after setRemoteDescription can produce valid-looking
        // SDP while the native media engine never attaches the source sink.
        let videoTrack = factory.videoTrack(with: source, trackId: "screen")
        videoTrack.isEnabled = true
        guard let videoSender = peerConnection.add(videoTrack, streamIds: ["screen-stream"]) else {
            throw NativeHostError.webrtc("无法把屏幕轨道加入 WebRTC 连接")
        }
        self.videoTrack = videoTrack
        self.videoSender = videoSender
        try await setRemoteDescription(RTCSessionDescription(type: .offer, sdp: offerSDP))
        hasRemoteDescription = true
        guard let videoTransceiver = peerConnection.transceivers.first(where: {
            $0.sender.senderId == videoSender.senderId
        }) else {
            throw NativeHostError.webrtc("无法找到屏幕轨道对应的 WebRTC transceiver")
        }
        var directionError: NSError?
        videoTransceiver.setDirection(.sendOnly, error: &directionError)
        if let directionError { throw directionError }
        capturer.onFirstFrame = { [weak self] in
            self?.onFirstFrame?()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.reportMediaDiagnostics()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                self?.reportMediaDiagnostics()
            }
        }
        capturer.onJpegFrame = { [weak self] data in self?.sendFrame(data) }
        try await flushPendingCandidates()
        let answer = try await createAnswer()
        try await setLocalDescription(answer)
        let senderParameters = videoSender.parameters
        for encoding in senderParameters.encodings {
            encoding.isActive = true
            encoding.maxBitrateBps = 8_000_000
            encoding.maxFramerate = 30
        }
        videoSender.parameters = senderParameters
        onSignal?("signal.answer", answer.sdp, nil)
        // Activate the negotiated sender before feeding frames. Starting
        // ScreenCaptureKit earlier fills RTCVideoSource's pre-negotiation
        // queue and blocks its capture callback after a small number of
        // frames, leaving the sender permanently at zero encoded frames.
        try await capturer.start()
    }

    func addRemoteCandidate(_ description: IceCandidateDescription) {
        guard let mLineIndex = description.sdpMLineIndex else { return }
        let candidate = RTCIceCandidate(
            sdp: description.candidate,
            sdpMLineIndex: Int32(mLineIndex),
            sdpMid: description.sdpMid
        )
        if hasRemoteDescription {
            peerConnection.add(candidate) { _ in }
        } else {
            pendingCandidates.append(candidate)
        }
    }

    func close() async {
        dataChannel?.close()
        frameChannel?.close()
        peerConnection.close()
        await capturer.stop()
    }

    func switchTarget(_ target: ResolvedTarget) async throws {
        try await capturer.switchTarget(target)
    }

    func send(_ data: Data) {
        guard let dataChannel, dataChannel.readyState == .open else { return }
        _ = dataChannel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    /// Large binary responses must not share the ordered control channel.
    /// Base64 JSON both inflates app icons and can head-of-line block input.
    func sendAsset(id: String, data: Data) {
        frameSendQueue.async { [weak self] in
            guard let self else { return }
            guard let frameChannel = self.frameChannel, frameChannel.readyState == .open else {
                self.pendingAssets.append((id, data))
                return
            }
            self.sendAssetNow(id: id, data: data, through: frameChannel)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        onDiagnostics?("ICE 状态：\(String(describing: newState))")
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onSignal?(
            "signal.ice",
            nil,
            IceCandidateDescription(
                candidate: candidate.sdp,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: Int(candidate.sdpMLineIndex)
            )
        )
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        if dataChannel.label == "frames" {
            frameChannel = dataChannel
            frameSendQueue.async { [weak self] in
                guard let self else { return }
                for asset in self.pendingAssets {
                    self.sendAssetNow(id: asset.id, data: asset.data, through: dataChannel)
                }
                self.pendingAssets.removeAll(keepingCapacity: true)
                if let latestFrameData = self.latestFrameData {
                    self.sendFrameNow(latestFrameData)
                }
            }
            return
        }
        self.dataChannel = dataChannel
        dataChannel.delegate = self
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChangeStandardizedIceConnectionState newState: RTCIceConnectionState) {
        onDiagnostics?("ICE 标准状态：\(String(describing: newState))")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        onState?(newState)
        if newState == .connected {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.reportMediaDiagnostics()
            }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove rtpReceiver: RTCRtpReceiver) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChangeLocalCandidate local: RTCIceCandidate, remoteCandidate remote: RTCIceCandidate, lastReceivedMs lastDataReceivedMs: Int32, changeReason reason: String) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didFailToGatherIceCandidate event: RTCIceCandidateErrorEvent) {}

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        onControl?(buffer.data as Data)
    }

    private func createAnswer() async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            let constraints = RTCMediaConstraints(
                mandatoryConstraints: nil,
                optionalConstraints: nil
            )
            peerConnection.answer(for: constraints) { answer, error in
                if let error { continuation.resume(throwing: error) }
                else if let answer { continuation.resume(returning: answer) }
                else { continuation.resume(throwing: NativeHostError.webrtc("WebRTC 没有生成 answer")) }
            }
        }
    }

    private func setRemoteDescription(_ description: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setRemoteDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    private func setLocalDescription(_ description: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    private func flushPendingCandidates() async throws {
        for candidate in pendingCandidates {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                peerConnection.add(candidate) { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                }
            }
        }
        pendingCandidates.removeAll()
    }

    private func reportMediaDiagnostics() {
        peerConnection.statistics { [weak self] report in
            guard let self else { return }
            let outboundVideo = report.statistics.values.first {
                $0.type == "outbound-rtp" && (
                    ($0.values["kind"] as? String) == "video"
                        || ($0.values["mediaType"] as? String) == "video"
                )
            }
            let framesEncoded = (outboundVideo?.values["framesEncoded"] as? NSNumber)?.intValue ?? 0
            let framesSent = (outboundVideo?.values["framesSent"] as? NSNumber)?.intValue ?? 0
            let bytesSent = (outboundVideo?.values["bytesSent"] as? NSNumber)?.intValue ?? 0
            let encodingActive = videoSender?.parameters.encodings.first?.isActive ?? false
            // Stop the JPEG bootstrap stream as soon as the negotiated media
            // track has produced an encoded frame. Otherwise the reliable
            // frames data channel competes with RTP and increases latency.
            if framesEncoded > 0 {
                capturer.setJpegFallbackEnabled(false)
            }
            onDiagnostics?("采集 \(capturer.capturedFrameCount) 帧 · 编码 \(framesEncoded) 帧 · RTP \(framesSent) 帧 / \(bytesSent) 字节 · source \(source.state.rawValue) / active \(encodingActive)")
        }
    }

    private func sendFrame(_ data: Data) {
        frameSendQueue.async { [weak self] in
            guard let self else { return }
            self.latestFrameData = data
            self.sendFrameNow(data)
        }
    }

    private func sendFrameNow(_ data: Data) {
        guard let frameChannel, frameChannel.readyState == .open else { return }
        let chunkPayloadSize = 48 * 1_024
        let chunkCount = max(1, Int(ceil(Double(data.count) / Double(chunkPayloadSize))))
        guard chunkCount <= Int(UInt16.max) else { return }
        let frameId = nextFrameId
        nextFrameId &+= 1

        for chunkIndex in 0..<chunkCount {
            let lower = chunkIndex * chunkPayloadSize
            let upper = min(data.count, lower + chunkPayloadSize)
            var packet = Data(capacity: 12 + upper - lower)
            packet.append(contentsOf: [0x53, 0x4c, 0x46, 0x52]) // SLFR
            var encodedFrameId = frameId.bigEndian
            var encodedChunkIndex = UInt16(chunkIndex).bigEndian
            var encodedChunkCount = UInt16(chunkCount).bigEndian
            withUnsafeBytes(of: &encodedFrameId) { packet.append(contentsOf: $0) }
            withUnsafeBytes(of: &encodedChunkIndex) { packet.append(contentsOf: $0) }
            withUnsafeBytes(of: &encodedChunkCount) { packet.append(contentsOf: $0) }
            packet.append(data[lower..<upper])
            guard frameChannel.sendData(RTCDataBuffer(data: packet, isBinary: true)) else { return }
        }
    }

    private func sendAssetNow(id: String, data: Data, through channel: RTCDataChannel) {
        let idData = Data(id.utf8)
        guard !idData.isEmpty, idData.count <= Int(UInt16.max) else { return }
        let chunkPayloadSize = 48 * 1_024
        let chunkCount = max(1, Int(ceil(Double(data.count) / Double(chunkPayloadSize))))
        guard chunkCount <= Int(UInt16.max) else { return }

        for chunkIndex in 0..<chunkCount {
            let lower = chunkIndex * chunkPayloadSize
            let upper = min(data.count, lower + chunkPayloadSize)
            var packet = Data(capacity: 10 + idData.count + upper - lower)
            packet.append(contentsOf: [0x53, 0x4c, 0x49, 0x43]) // SLIC
            var encodedIdLength = UInt16(idData.count).bigEndian
            var encodedChunkIndex = UInt16(chunkIndex).bigEndian
            var encodedChunkCount = UInt16(chunkCount).bigEndian
            withUnsafeBytes(of: &encodedIdLength) { packet.append(contentsOf: $0) }
            withUnsafeBytes(of: &encodedChunkIndex) { packet.append(contentsOf: $0) }
            withUnsafeBytes(of: &encodedChunkCount) { packet.append(contentsOf: $0) }
            packet.append(idData)
            packet.append(data[lower..<upper])
            guard channel.sendData(RTCDataBuffer(data: packet, isBinary: true)) else { return }
        }
    }
}

extension IceCandidateDescription {
    init(candidate: String, sdpMid: String?, sdpMLineIndex: Int) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
    }
}

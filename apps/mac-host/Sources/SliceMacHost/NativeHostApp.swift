import AppKit
import ApplicationServices
import SwiftUI

enum NativeHostError: LocalizedError {
    case network(String)
    case webrtc(String)
    case permissions(String)

    var errorDescription: String? {
        switch self {
        case .network(let message), .webrtc(let message), .permissions(let message): message
        }
    }
}

@MainActor
final class NativeHostViewModel: ObservableObject {
    let installedAppPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Slice Remote Screen Host.app")
        .path
    @Published var server = "https://remote.englife.space"
    @Published var email = ""
    @Published var password = ""
    @Published var confirmPassword = ""
    @Published var isRegistering = false
    @Published var isAuthenticated = false
    @Published var remoteEnabled = true
    @Published var status = "准备就绪"
    @Published var error = ""
    @Published var screenRecordingGranted = false
    @Published var accessibilityGranted = false

    private var signaling: NativeSignalingClient?
    private var hostSession: NativeHostSession?

    init() {
        server = UserDefaults.standard.string(forKey: "signalingServer") ?? server
        email = UserDefaults.standard.string(forKey: "accountEmail") ?? ""
        remoteEnabled = UserDefaults.standard.object(forKey: "remoteEnabled") as? Bool ?? true
        refreshPermissions()
        restoreSession()
    }

    func authenticate() {
        guard let serverURL = URL(string: server.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            error = "服务端地址无效"
            return
        }
        guard !email.isEmpty, !password.isEmpty else {
            error = "邮箱和密码不能为空"
            return
        }
        if isRegistering && password != confirmPassword {
            error = "两次密码不一致"
            return
        }
        status = isRegistering ? "正在注册…" : "正在登录…"
        error = ""
        let client = NativeSignalingClient(serverURL: serverURL)
        signaling = client
        let loginEmail = email
        let loginPassword = password
        let shouldRegister = isRegistering
        Task { [weak self] in
            do {
                try await client.login(email: loginEmail, password: loginPassword, register: shouldRegister)
                guard let self else { return }
                isAuthenticated = true
                password = ""
                confirmPassword = ""
                UserDefaults.standard.set(serverURL.absoluteString, forKey: "signalingServer")
                UserDefaults.standard.set(email, forKey: "accountEmail")
                status = "账号已登录"
                if remoteEnabled { startRemoteControl() }
            } catch {
                self?.error = error.localizedDescription
                self?.status = "登录失败"
            }
        }
    }

    func setRemoteControl(_ enabled: Bool) {
        remoteEnabled = enabled
        UserDefaults.standard.set(remoteEnabled, forKey: "remoteEnabled")
        if remoteEnabled { startRemoteControl() } else { stopRemoteControl() }
    }

    func openScreenRecordingSettings() {
        requestMissingPermissions(preferredPane: "Privacy_ScreenCapture")
    }

    func openAccessibilitySettings() {
        requestMissingPermissions(preferredPane: "Privacy_Accessibility")
    }

    func requestMissingPermissions(preferredPane: String? = nil) {
        refreshPermissions()
        if !screenRecordingGranted {
            _ = CGRequestScreenCaptureAccess()
            openPrivacySettings(pane: preferredPane ?? "Privacy_ScreenCapture")
        }
        if !accessibilityGranted {
            _ = AXIsProcessTrustedWithOptions(
                ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            )
            if screenRecordingGranted {
                openPrivacySettings(pane: preferredPane ?? "Privacy_Accessibility")
            }
        }
    }

    func refreshPermissions() {
        accessibilityGranted = AXIsProcessTrusted()
        screenRecordingGranted = false
        Task { [weak self] in
            let canCapture = await TargetCatalog.canCapture()
            guard let self else { return }
            screenRecordingGranted = canCapture
            if isAuthenticated && remoteEnabled && hostSession == nil && canCapture && accessibilityGranted {
                startRemoteControl()
            }
        }
    }

    private func restoreSession() {
        guard let url = URL(string: server) else { return }
        let client = NativeSignalingClient(serverURL: url)
        signaling = client
        Task { [weak self] in
            guard let self, await client.hasSession() else { return }
            isAuthenticated = true
            status = "账号已登录"
            if remoteEnabled { startRemoteControl() }
        }
    }

    private func startRemoteControl() {
        guard isAuthenticated, let signaling else { return }
        guard screenRecordingGranted && accessibilityGranted else {
            status = "需要授权屏幕录制和辅助功能"
            return
        }
        hostSession?.stop()
        let session = NativeHostSession(signaling: signaling)
        hostSession = session
        session.onStatus = { [weak self] value in self?.status = value }
        session.onError = { [weak self] value in self?.error = value }
        session.start()
    }

    private func stopRemoteControl() {
        hostSession?.stop()
        hostSession = nil
        signaling?.disconnect()
        status = "远程控制已关闭"
    }

    private func openPrivacySettings(pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
        NSWorkspace.shared.open(url)
    }
}

@MainActor
final class NativeHostSession {
    private let signaling: NativeSignalingClient
    private var peer: NativePeerSession?
    private var target: ResolvedTarget?
    private var inputState = PointerControlState()
    private var pendingCandidates: [IceCandidateDescription] = []
    private var stopped = false
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var offerTask: Task<Void, Never>?
    private var legacyInputReleaseTask: Task<Void, Never>?

    var onStatus: ((String) -> Void)?
    var onError: ((String) -> Void)?

    init(signaling: NativeSignalingClient) {
        self.signaling = signaling
        signaling.onMessage = { [weak self] message in self?.handle(message) }
        signaling.onDisconnect = { [weak self] reason in
            self?.handleSignalingDisconnect(reason)
        }
    }

    func start() {
        stopped = false
        Task { [weak self] in
            do {
                guard let self else { return }
                let targets = try await TargetCatalog.list(appFilter: nil)
                guard let display = targets.first(where: { $0.kind == "display" }) else {
                    throw NativeHostError.permissions("没有找到可共享显示器")
                }
                target = try await TargetCatalog.resolve(kind: display.kind, id: display.id)
                connectSignaling()
            } catch {
                self?.onError?(error.localizedDescription)
            }
        }
    }

    func stop() {
        stopped = true
        legacyInputReleaseTask?.cancel()
        legacyInputReleaseTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        offerTask?.cancel()
        offerTask = nil
        let oldPeer = peer
        peer = nil
        signaling.disconnect()
        Task { await oldPeer?.close() }
    }

    private func handle(_ message: NativeSignalMessage) {
        guard !stopped else { return }
        switch message.type {
        case "host.accepted":
            reconnectAttempt = 0
            onStatus?("已连接信令服务，等待手机打开控制页")
        case "peer.ready":
            onStatus?("手机已就绪，正在协商点对点连接")
        case "peer.left":
            legacyInputReleaseTask?.cancel()
            legacyInputReleaseTask = nil
            let oldPeer = peer
            peer = nil
            Task { await oldPeer?.close() }
            onStatus?("手机已离线，等待下一次连接")
        case "signal.offer":
            guard let sdp = message.sdp else { return }
            offerTask?.cancel()
            offerTask = Task { [weak self] in await self?.acceptOffer(sdp: sdp) }
        case "signal.ice":
            if let candidate = message.candidate {
                if let peer { peer.addRemoteCandidate(candidate) }
                else { pendingCandidates.append(candidate) }
            }
        default:
            break
        }
    }

    private func acceptOffer(sdp: String) async {
        do {
            try Task.checkCancellation()
            guard let target else { throw NativeHostError.permissions("共享目标已失效，请重启应用") }
            let iceServers = try await signaling.iceServers()
            try Task.checkCancellation()
            let oldPeer = peer
            peer = nil
            if let oldPeer { await oldPeer.close() }
            try Task.checkCancellation()
            let session = try NativePeerSession(target: target, iceServers: iceServers)
            peer = session
            pendingCandidates.forEach(session.addRemoteCandidate)
            pendingCandidates.removeAll()
            session.onSignal = { [weak self] type, sdp, candidate in
                self?.signaling.send(type: type, sdp: sdp, candidate: candidate)
            }
            session.onFirstFrame = { [weak self] in
                Task { @MainActor in self?.onStatus?("手机已建立点对点连接，正在传输画面") }
            }
            session.onDiagnostics = { [weak self] message in
                Task { @MainActor in self?.onStatus?(message) }
            }
            session.onControl = { [weak self] data in self?.handleControl(data) }
            session.onState = { [weak self] state in
                if state == .connected { self?.onStatus?("手机已建立点对点连接") }
                if state == .failed { self?.onError?("点对点连接失败") }
            }
            try await session.answer(offerSDP: sdp)
            try Task.checkCancellation()
            onStatus?("已发送 answer，等待点对点连接")
        } catch is CancellationError {
            return
        } catch {
            onError?(error.localizedDescription)
        }
    }

    private func connectSignaling() {
        guard !stopped else { return }
        do {
            try signaling.connectHost()
            onStatus?(reconnectAttempt == 0
                ? "正在连接信令服务…"
                : "正在重新连接信令服务…")
        } catch {
            scheduleReconnect(reason: error.localizedDescription)
        }
    }

    private func handleSignalingDisconnect(_ reason: String) {
        guard !stopped else { return }
        let oldPeer = peer
        peer = nil
        Task { await oldPeer?.close() }
        scheduleReconnect(reason: reason)
    }

    private func scheduleReconnect(reason: String) {
        guard !stopped, reconnectTask == nil else { return }
        let delaySeconds = min(30, max(1, 1 << min(reconnectAttempt, 4)))
        reconnectAttempt += 1
        onStatus?("信令服务断开，\(delaySeconds) 秒后重连：\(reason)")
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delaySeconds))
            guard let self, !Task.isCancelled else { return }
            reconnectTask = nil
            connectSignaling()
        }
    }

    private func handleControl(_ data: Data) {
        let decoder = JSONDecoder()
        if let request = try? decoder.decode(NativeRpcRequest.self, from: data), request.type == "rpc" {
            Task { @MainActor [weak self] in await self?.handleRpc(request) }
            return
        }
        if let envelope = try? decoder.decode(NativeInputEnvelope.self, from: data),
           envelope.type == "input" {
            Task { @MainActor [weak self] in await self?.handleInput(envelope.control) }
            return
        }
        if let envelope = try? decoder.decode(NativeLegacyInputEnvelope.self, from: data),
           envelope.type == "input" {
            Task { @MainActor [weak self] in await self?.handleLegacyInput(envelope) }
            return
        }
        do {
            let message = try decoder.decode(NativeControlMessage.self, from: data)
            Task { @MainActor [weak self] in
                guard let self, let target = self.target else { return }
                do {
                    switch message.type {
                    case "gesture":
                        guard let gesture = message.gesture else { return }
                        try await InputService.gesture(target: target, request: gesture)
                    case "type":
                        try await InputService.type(target: target, text: message.text ?? "")
                    case "key":
                        guard let key = message.key else { return }
                        try await InputService.key(target: target, key: key.key, modifiers: key.modifiers)
                    default:
                        break
                    }
                } catch { self.onError?(error.localizedDescription) }
            }
        } catch {
            onError?("控制指令无效：\(error.localizedDescription)")
        }
    }

    private func handleInput(_ request: PointerControlRequest) async {
        guard let target, let peer else { return }
        legacyInputReleaseTask?.cancel()
        legacyInputReleaseTask = nil
        do {
            inputState = try await InputService.control(target: target, request: request, state: inputState)
            if request.type == "click" {
                sendJson([
                    "type": "input-target",
                    "editable": InputService.focusedElementIsEditable(target)
                ], through: peer)
            }
        } catch { onError?(error.localizedDescription) }
    }

    /// Controllers deployed before the nested input envelope accidentally
    /// overwrote down/move/up with `type: "input"`. Clicks can be identified
    /// by clickCount; pointer-up is recovered by releasing after movement
    /// becomes idle. Remove this path after old web clients are retired.
    private func handleLegacyInput(_ envelope: NativeLegacyInputEnvelope) async {
        guard let target else { return }
        legacyInputReleaseTask?.cancel()
        legacyInputReleaseTask = nil
        do {
            if let clickCount = envelope.clickCount {
                let request = PointerControlRequest(
                    type: "click",
                    button: envelope.button,
                    clickCount: clickCount,
                    x: envelope.x,
                    y: envelope.y
                )
                inputState = try await InputService.control(target: target, request: request, state: inputState)
                if let peer {
                    sendJson([
                        "type": "input-target",
                        "editable": InputService.focusedElementIsEditable(target)
                    ], through: peer)
                }
                return
            }

            if let button = envelope.button, inputState.activeButton == nil {
                let request = PointerControlRequest(
                    type: "down",
                    button: button,
                    clickCount: nil,
                    x: envelope.x,
                    y: envelope.y
                )
                inputState = try await InputService.control(target: target, request: request, state: inputState)
                return
            }

            let move = PointerControlRequest(
                type: "move",
                button: nil,
                clickCount: nil,
                x: envelope.x,
                y: envelope.y
            )
            inputState = try await InputService.control(target: target, request: move, state: inputState)
            guard inputState.activeButton != nil else { return }
            legacyInputReleaseTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(80))
                guard let self, !Task.isCancelled, let target = self.target else { return }
                let up = PointerControlRequest(
                    type: "up",
                    button: nil,
                    clickCount: nil,
                    x: envelope.x,
                    y: envelope.y
                )
                do {
                    self.inputState = try await InputService.control(
                        target: target,
                        request: up,
                        state: self.inputState
                    )
                } catch {
                    self.onError?(error.localizedDescription)
                }
                self.legacyInputReleaseTask = nil
            }
        } catch {
            onError?(error.localizedDescription)
        }
    }

    private func handleRpc(_ request: NativeRpcRequest) async {
        guard let id = request.id, let method = request.method, let peer else { return }
        do {
            switch method {
            case "permissions":
                sendResult(id, PermissionState(
                    screenRecording: await TargetCatalog.canCapture(),
                    accessibility: AXIsProcessTrusted()
                ), through: peer)
            case "request-permissions":
                SliceMacHost.requestPermissions()
                sendResult(id, PermissionState(
                    screenRecording: await TargetCatalog.canCapture(),
                    accessibility: AXIsProcessTrusted()
                ), through: peer)
            case "targets":
                sendResult(id, try await TargetCatalog.list(appFilter: nil), through: peer)
            case "apps":
                sendResult(id, ApplicationCatalog.list(), through: peer)
            case "app-icon":
                guard request.bundleIdentifier != nil || request.path != nil else {
                    throw NativeHostError.network("缺少应用标识")
                }
                let usesBinaryAsset = request.binaryAsset == true
                let icon = try AppIconService.data(
                    bundleIdentifier: request.bundleIdentifier,
                    applicationPath: request.path,
                    // Legacy controllers only understand a single Base64 RPC
                    // result. Keep that packet below WebRTC's conservative
                    // data-channel message limit during rolling upgrades.
                    size: usesBinaryAsset ? 64 : 32
                )
                NSLog(
                    "Remote app icon ready: %@ (%d bytes)",
                    request.bundleIdentifier ?? request.path ?? "unknown",
                    icon.count
                )
                if usesBinaryAsset {
                    peer.sendAsset(id: id, data: icon)
                } else {
                    // Keep an older deployed controller working during a
                    // rolling upgrade. New controllers explicitly request
                    // chunked binary data and avoid the control-channel cost.
                    sendResult(id, icon.base64EncodedString(), through: peer)
                }
            case "select-target":
                guard let kind = request.kind, let targetId = request.targetId else {
                    throw NativeHostError.network("缺少远程目标")
                }
                if target?.descriptor.kind == kind, target?.descriptor.id == targetId {
                    sendResult(id, true, through: peer)
                    return
                }
                let nextTarget = try await TargetCatalog.resolve(kind: kind, id: targetId)
                target = nextTarget
                inputState = PointerControlState()
                sendResult(id, true, through: peer)
                // Target selection is a control-plane acknowledgement. Do not
                // hold the RPC open while ScreenCaptureKit reconfigures; both
                // stopCapture and updateContentFilter can suspend for many
                // seconds on macOS. The existing WebRTC track stays alive and
                // switches content in the background.
                Task { @MainActor [weak self, weak peer] in
                    guard let self, let peer else { return }
                    do {
                        try await peer.switchTarget(nextTarget)
                    } catch {
                        self.onError?("切换共享窗口失败：\(error.localizedDescription)")
                    }
                }
            case "launch-app":
                guard let path = request.path else { throw NativeHostError.network("缺少应用路径") }
                try await ApplicationCatalog.launch(path: path)
                sendResult(id, true, through: peer)
            case "close-app":
                guard let path = request.path else { throw NativeHostError.network("缺少应用路径") }
                try ApplicationCatalog.close(path: path)
                sendResult(id, true, through: peer)
            case "gesture":
                guard let target, let gesture = request.gesture else { throw NativeHostError.network("缺少操作目标") }
                try await InputService.gesture(target: target, request: gesture)
                sendResult(id, true, through: peer)
            case "type":
                guard let target, let text = request.text else { throw NativeHostError.network("缺少输入内容") }
                try await InputService.type(target: target, text: text)
                sendResult(id, true, through: peer)
            case "key":
                guard let target, let key = request.key else { throw NativeHostError.network("缺少按键") }
                try await InputService.key(target: target, key: key.key, modifiers: key.modifiers)
                sendResult(id, true, through: peer)
            default:
                throw NativeHostError.network("不支持的远程操作：\(method)")
            }
        } catch {
            sendError(id, error.localizedDescription, through: peer)
        }
    }

    private func sendResult<T: Encodable>(_ id: String, _ value: T, through peer: NativePeerSession) {
        guard let valueData = try? JSONEncoder().encode(value),
              let valueObject = try? JSONSerialization.jsonObject(with: valueData, options: [.fragmentsAllowed]),
              let responseValue = valueObject as Any? else { return }
        var response = ["type": "rpc.result", "id": id, "ok": true] as [String: Any]
        response["value"] = responseValue
        sendJson(response, through: peer)
    }

    private func sendError(_ id: String, _ message: String, through peer: NativePeerSession) {
        sendJson(["type": "rpc.result", "id": id, "ok": false, "error": message], through: peer)
    }

    private func sendJson(_ value: [String: Any], through peer: NativePeerSession) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        peer.send(data)
    }
}

private struct NativeRpcRequest: Decodable {
    let type: String
    let id: String?
    let method: String?
    let kind: String?
    let targetId: UInt32?
    let path: String?
    let bundleIdentifier: String?
    let binaryAsset: Bool?
    let gesture: PointerGestureRequest?
    let text: String?
    let key: NativeKeyRequest?
}

private struct NativeInputEnvelope: Decodable {
    let type: String
    let control: PointerControlRequest
}

private struct NativeLegacyInputEnvelope: Decodable {
    let type: String
    let button: String?
    let clickCount: Int?
    let x: Double
    let y: Double
}

private struct NativeControlMessage: Decodable {
    let type: String
    let gesture: PointerGestureRequest?
    let text: String?
    let key: NativeKeyRequest?
}

private struct NativeKeyRequest: Decodable {
    let key: String
    let modifiers: [String]
}

struct HostWindowView: View {
    @StateObject private var model = NativeHostViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Slice Remote Screen").font(.title2.bold())
            Text("原生 macOS Host · 不依赖浏览器")
                .foregroundStyle(.secondary)

            GroupBox("Slice 账号") {
                VStack(spacing: 10) {
                    TextField("服务端地址", text: $model.server)
                        .textFieldStyle(.roundedBorder)
                    TextField("邮箱", text: $model.email)
                        .textFieldStyle(.roundedBorder)
                    SecureField("密码（至少 12 位）", text: $model.password)
                        .textFieldStyle(.roundedBorder)
                    if model.isRegistering {
                        SecureField("确认密码", text: $model.confirmPassword)
                            .textFieldStyle(.roundedBorder)
                    }
                    HStack {
                        Button(model.isRegistering ? "切换登录" : "没有账号？注册") {
                            model.isRegistering.toggle()
                        }
                        Spacer()
                        Button(model.isRegistering ? "注册并上线" : "登录并上线") {
                            model.authenticate()
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                }
                .padding(.top, 6)
            }

            GroupBox("远程控制") {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("允许手机远程控制这台 Mac", isOn: Binding(
                        get: { model.remoteEnabled },
                        set: { model.setRemoteControl($0) }
                    ))
                    Text(model.status).font(.callout).foregroundStyle(.secondary)
                    if !model.error.isEmpty {
                        Text(model.error).font(.callout).foregroundStyle(.red)
                    }
                }
                .padding(.top, 6)
            }

            GroupBox("系统权限") {
                VStack(alignment: .leading, spacing: 8) {
                    permissionRow("屏幕录制", granted: model.screenRecordingGranted) {
                        model.openScreenRecordingSettings()
                    }
                    permissionRow("辅助功能", granted: model.accessibilityGranted) {
                        model.openAccessibilitySettings()
                    }
                    Text("列表没有 Slice Remote Screen Host？点击左下角“+”，选择 \(model.installedAppPath)。不要选择仓库里的 dist/SliceRemoteScreenHost.app。开启权限后完全退出并重新打开 Host App，再重新检查。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("重新检查权限") {
                        model.requestMissingPermissions()
                    }
                }
                .padding(.top, 6)
            }
        }
        .padding(24)
        .frame(width: 440)
        .onAppear { model.requestMissingPermissions() }
    }

    @ViewBuilder
    private func permissionRow(_ title: String, granted: Bool, openSettings: @escaping () -> Void) -> some View {
        HStack {
            Image(systemName: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(granted ? .green : .orange)
            Text(title)
            Spacer()
            if !granted { Button("打开设置", action: openSettings) }
        }
    }
}

@MainActor
final class NativeAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let contentView = NSHostingView(rootView: HostWindowView())
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 620),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Slice Remote Screen"
        window.contentView = contentView
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }
}

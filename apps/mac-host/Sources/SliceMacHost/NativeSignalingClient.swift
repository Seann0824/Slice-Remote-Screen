import Foundation

struct IceServerDescription: Decodable, Sendable {
    let urls: [String]
    let username: String?
    let credential: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            urls = [value]
            username = nil
            credential = nil
            return
        }

        let object = try container.decode(Object.self)
        urls = object.urls
        username = object.username
        credential = object.credential
    }

    private struct Object: Decodable {
        let urls: [String]
        let username: String?
        let credential: String?

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let array = try? container.decode([String].self, forKey: .urls) {
                urls = array
            } else {
                urls = [try container.decode(String.self, forKey: .urls)]
            }
            username = try container.decodeIfPresent(String.self, forKey: .username)
            credential = try container.decodeIfPresent(String.self, forKey: .credential)
        }

        private enum CodingKeys: String, CodingKey {
            case urls, username, credential
        }
    }
}

struct NativeSignalMessage: Decodable, Sendable {
    let type: String
    let sdp: String?
    let candidate: IceCandidateDescription?
}

struct IceCandidateDescription: Decodable, Sendable {
    let candidate: String
    let sdpMid: String?
    let sdpMLineIndex: Int?
}

@MainActor
final class NativeSignalingClient {
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private(set) var serverURL: URL
    private var receiveTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?

    var onMessage: ((NativeSignalMessage) -> Void)?
    var onDisconnect: ((String) -> Void)?

    init(serverURL: URL) {
        self.serverURL = serverURL
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        session = URLSession(configuration: configuration)
    }

    func updateServerURL(_ url: URL) {
        serverURL = url
    }

    func login(email: String, password: String, register: Bool) async throws {
        let path = register ? "/api/auth/register" : "/api/auth/login"
        var request = URLRequest(url: serverURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NativeHostError.network("服务端没有返回 HTTP 响应")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorPayload.self, from: data).error)
                ?? "请求失败（(httpResponse.statusCode)）"
            throw NativeHostError.network(message)
        }
    }

    func hasSession() async -> Bool {
        var request = URLRequest(url: serverURL.appendingPathComponent("/api/auth/me"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, response) = try await session.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    func iceServers() async throws -> [IceServerDescription] {
        let (data, response) = try await session.data(
            from: serverURL.appendingPathComponent("/api/ice-servers")
        )
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw NativeHostError.network("无法读取 ICE 配置")
        }
        return try JSONDecoder().decode(IceServerPayload.self, from: data).iceServers
    }

    func connectHost() throws {
        disconnect()
        guard let webSocketURL = webSocketURL(path: "/ws/host") else {
            throw NativeHostError.network("信令服务地址必须使用 HTTP 或 HTTPS")
        }
        var request = URLRequest(url: webSocketURL)
        request.setValue(cookieHeader(), forHTTPHeaderField: "Cookie")
        let nextSocket = session.webSocketTask(with: request)
        socket = nextSocket
        nextSocket.resume()
        receiveTask = Task { [weak self, weak nextSocket] in
            guard let self else { return }
            await self.receiveMessages(from: nextSocket)
        }
        heartbeatTask = Task { [weak self, weak nextSocket] in
            guard let self, let nextSocket else { return }
            await self.keepAlive(nextSocket)
        }
    }

    func send(type: String, sdp: String? = nil, candidate: IceCandidateDescription? = nil) {
        var value: [String: Any] = ["type": type]
        if let sdp { value["sdp"] = sdp }
        if let candidate {
            var candidateValue: [String: Any] = ["candidate": candidate.candidate]
            if let sdpMid = candidate.sdpMid { candidateValue["sdpMid"] = sdpMid }
            if let sdpMLineIndex = candidate.sdpMLineIndex { candidateValue["sdpMLineIndex"] = sdpMLineIndex }
            value["candidate"] = candidateValue
        }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return }
        let currentSocket = socket
        currentSocket?.send(.string(text)) { [weak self, weak currentSocket] error in
            if let error, let currentSocket {
                Task { @MainActor in self?.socketFailed(currentSocket, reason: error.localizedDescription) }
            }
        }
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
    }

    private func receiveMessages(from socket: URLSessionWebSocketTask?) async {
        guard let socket else { return }
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                guard case let .string(text) = message,
                      let data = text.data(using: .utf8) else { continue }
                let signal = try JSONDecoder().decode(NativeSignalMessage.self, from: data)
                onMessage?(signal)
            }
        } catch is CancellationError {
            return
        } catch {
            socketFailed(socket, reason: error.localizedDescription)
        }
    }

    private func keepAlive(_ socket: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(20))
            if Task.isCancelled { return }
            let error = await withCheckedContinuation { continuation in
                socket.sendPing { error in continuation.resume(returning: error) }
            }
            if let error {
                socketFailed(socket, reason: error.localizedDescription)
                return
            }
        }
    }

    private func socketFailed(_ failedSocket: URLSessionWebSocketTask, reason: String) {
        guard socket === failedSocket else { return }
        socket = nil
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        failedSocket.cancel(with: .goingAway, reason: nil)
        onDisconnect?(reason)
    }

    private func webSocketURL(path: String) -> URL? {
        guard var components = URLComponents(url: serverURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url
    }

    private func cookieHeader() -> String {
        HTTPCookieStorage.shared.cookies(for: serverURL)?.map {
            "\($0.name)=\($0.value)"
        }.joined(separator: "; ") ?? ""
    }

    private struct ErrorPayload: Decodable {
        let error: String
    }

    private struct IceServerPayload: Decodable {
        let iceServers: [IceServerDescription]

        enum CodingKeys: String, CodingKey {
            case iceServers = "ice_servers"
        }
    }
}

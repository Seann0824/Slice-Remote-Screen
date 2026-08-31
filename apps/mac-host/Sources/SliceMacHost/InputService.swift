import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum InputService {
    static func activate(_ processID: pid_t?) async throws {
        guard let processID,
              let application = NSRunningApplication(processIdentifier: processID) else { return }
        application.activate()
        try await Task.sleep(for: .milliseconds(90))
    }

    static func click(target: ResolvedTarget, normalizedX: Double, normalizedY: Double) async throws {
        try await activate(target.processID)
        let x = target.frame.minX + target.frame.width * min(max(normalizedX, 0), 1)
        let y = target.frame.minY + target.frame.height * min(max(normalizedY, 0), 1)
        let point = CGPoint(x: x, y: y)
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
              let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw HostError.eventCreationFailed
        }
        move.post(tap: .cghidEventTap)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    static func gesture(target: ResolvedTarget, request: PointerGestureRequest) async throws {
        try await activate(target.processID)
        switch request.type {
        case "click":
            guard let x = request.x, let y = request.y else {
                throw HostError.invalidArguments("Click gesture requires x and y")
            }
            try postClick(at: point(target: target, x: x, y: y), button: request.button ?? "left")
        case "drag":
            guard let points = request.points, points.count >= 2 else {
                throw HostError.invalidArguments("Drag gesture requires at least two points")
            }
            try await postDrag(
                points: points.map { point(target: target, x: $0.x, y: $0.y) },
                button: request.button ?? "left",
                durationMs: min(max(request.durationMs ?? 240, 40), 5_000)
            )
        case "scroll":
            guard let x = request.x, let y = request.y,
                  let deltaX = request.deltaX, let deltaY = request.deltaY else {
                throw HostError.invalidArguments("Scroll gesture requires x, y, deltaX and deltaY")
            }
            try postScroll(at: point(target: target, x: x, y: y), deltaX: deltaX, deltaY: deltaY)
        default:
            throw HostError.invalidArguments("Unsupported pointer gesture: \(request.type)")
        }
    }

    private static func point(target: ResolvedTarget, x: Double, y: Double) -> CGPoint {
        CGPoint(
            x: target.frame.minX + target.frame.width * min(max(x, 0), 1),
            y: target.frame.minY + target.frame.height * min(max(y, 0), 1)
        )
    }

    private static func mouseButton(_ value: String) throws -> CGMouseButton {
        switch value {
        case "left": .left
        case "right": .right
        case "middle": .center
        default: throw HostError.invalidArguments("Unsupported mouse button: \(value)")
        }
    }

    private static func mouseTypes(_ value: String) throws -> (down: CGEventType, dragged: CGEventType, up: CGEventType) {
        switch value {
        case "left": (.leftMouseDown, .leftMouseDragged, .leftMouseUp)
        case "right": (.rightMouseDown, .rightMouseDragged, .rightMouseUp)
        case "middle": (.otherMouseDown, .otherMouseDragged, .otherMouseUp)
        default: throw HostError.invalidArguments("Unsupported mouse button: \(value)")
        }
    }

    private static func postClick(at point: CGPoint, button: String) throws {
        let mouseButton = try mouseButton(button)
        let types = try mouseTypes(button)
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: mouseButton),
              let down = CGEvent(mouseEventSource: nil, mouseType: types.down, mouseCursorPosition: point, mouseButton: mouseButton),
              let up = CGEvent(mouseEventSource: nil, mouseType: types.up, mouseCursorPosition: point, mouseButton: mouseButton) else {
            throw HostError.eventCreationFailed
        }
        move.post(tap: .cghidEventTap)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private static func postDrag(points: [CGPoint], button: String, durationMs: Int) async throws {
        let mouseButton = try mouseButton(button)
        let types = try mouseTypes(button)
        guard let first = points.first, let last = points.last,
              let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: first, mouseButton: mouseButton),
              let down = CGEvent(mouseEventSource: nil, mouseType: types.down, mouseCursorPosition: first, mouseButton: mouseButton) else {
            throw HostError.eventCreationFailed
        }
        move.post(tap: .cghidEventTap)
        down.post(tap: .cghidEventTap)
        let delay = max(1, durationMs / max(1, points.count - 1))
        for point in points.dropFirst() {
            guard let dragged = CGEvent(mouseEventSource: nil, mouseType: types.dragged, mouseCursorPosition: point, mouseButton: mouseButton) else {
                throw HostError.eventCreationFailed
            }
            dragged.post(tap: .cghidEventTap)
            try await Task.sleep(for: .milliseconds(delay))
        }
        guard let up = CGEvent(mouseEventSource: nil, mouseType: types.up, mouseCursorPosition: last, mouseButton: mouseButton) else {
            throw HostError.eventCreationFailed
        }
        up.post(tap: .cghidEventTap)
    }

    private static func postScroll(at point: CGPoint, deltaX: Double, deltaY: Double) throws {
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
              let scroll = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .pixel,
                wheelCount: 2,
                wheel1: Int32(deltaY.rounded()),
                wheel2: Int32(deltaX.rounded()),
                wheel3: 0
              ) else { throw HostError.eventCreationFailed }
        move.post(tap: .cghidEventTap)
        scroll.post(tap: .cghidEventTap)
    }

    static func type(target: ResolvedTarget, text: String) async throws {
        try await activate(target.processID)
        for chunk in text.chunked(maxUTF16Units: 20) {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                throw HostError.eventCreationFailed
            }
            down.keyboardSetUnicodeString(stringLength: chunk.utf16.count, unicodeString: Array(chunk.utf16))
            up.keyboardSetUnicodeString(stringLength: chunk.utf16.count, unicodeString: Array(chunk.utf16))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    static func key(target: ResolvedTarget, key: String, modifiers: [String]) async throws {
        try await activate(target.processID)
        let keyCodes: [String: CGKeyCode] = [
            "enter": 36, "escape": 53, "tab": 48, "space": 49, "delete": 51,
            "left": 123, "right": 124, "down": 125, "up": 126,
        ]
        guard let keyCode = keyCodes[key] else { throw HostError.unsupportedKey(key) }
        var flags = CGEventFlags()
        for modifier in modifiers {
            switch modifier {
            case "command": flags.insert(.maskCommand)
            case "control": flags.insert(.maskControl)
            case "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default: break
            }
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
            throw HostError.eventCreationFailed
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private extension String {
    func chunked(maxUTF16Units: Int) -> [String] {
        var chunks: [String] = []
        var current = ""
        for character in self {
            let candidate = current + String(character)
            if candidate.utf16.count > maxUTF16Units, !current.isEmpty {
                chunks.append(current)
                current = String(character)
            } else {
                current = candidate
            }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}

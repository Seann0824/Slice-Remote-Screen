import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum InputService {
    static func activate(_ target: ResolvedTarget) async throws {
        guard let processID = target.processID,
              let application = NSRunningApplication(processIdentifier: processID) else { return }
        let changedApplication = !application.isActive
        if application.isHidden { application.unhide() }
        if changedApplication {
            application.activate(options: [.activateAllWindows])
            for _ in 0..<16 {
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == processID { break }
                try await Task.sleep(for: .milliseconds(25))
            }
        }
        let changedWindow = raiseWindow(for: target, processID: processID)
        if changedApplication {
            // A fullscreen Space can still be animating after the process becomes frontmost.
            try await Task.sleep(for: .milliseconds(160))
        } else if changedWindow {
            try await Task.sleep(for: .milliseconds(35))
        }
    }

    static func click(target: ResolvedTarget, normalizedX: Double, normalizedY: Double) async throws {
        try await activate(target)
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
        try await activate(target)
        switch request.type {
        case "click":
            guard let x = request.x, let y = request.y else {
                throw HostError.invalidArguments("Click gesture requires x and y")
            }
            try postClick(
                at: point(target: target, x: x, y: y),
                button: request.button ?? "left",
                clickCount: min(max(request.clickCount ?? 1, 1), 2)
            )
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

    static func runInputStream(target: ResolvedTarget) async throws {
        try await activate(target)
        var activeButton: String?
        var lastPoint: CGPoint?

        for try await line in FileHandle.standardInput.bytes.lines {
            guard !line.isEmpty else { continue }
            let request = try JSONDecoder().decode(PointerControlRequest.self, from: Data(line.utf8))
            let point = point(target: target, x: request.x, y: request.y)
            switch request.type {
            case "click":
                try await activate(target)
                try postClick(
                    at: point,
                    button: request.button ?? "left",
                    clickCount: min(max(request.clickCount ?? 1, 1), 2)
                )
                try await Task.sleep(for: .milliseconds(45))
                reportInputTarget(target)
            case "down":
                try await activate(target)
                let button = request.button ?? "left"
                if let activeButton, let lastPoint {
                    try postPointer(type: try mouseTypes(activeButton).up, at: lastPoint, button: activeButton)
                }
                try postPointer(type: try mouseTypes(button).down, at: point, button: button)
                activeButton = button
            case "move":
                let eventType = try activeButton.map { try mouseTypes($0).dragged } ?? .mouseMoved
                try postPointer(type: eventType, at: point, button: activeButton ?? "left")
            case "up":
                let button = activeButton ?? request.button ?? "left"
                try postPointer(type: try mouseTypes(button).up, at: point, button: button)
                activeButton = nil
            default:
                throw HostError.invalidArguments("Unsupported input control: \(request.type)")
            }
            lastPoint = point
        }

        if let activeButton, let lastPoint {
            try postPointer(type: try mouseTypes(activeButton).up, at: lastPoint, button: activeButton)
        }
    }

    private static func point(target: ResolvedTarget, x: Double, y: Double) -> CGPoint {
        CGPoint(
            x: target.frame.minX + target.frame.width * min(max(x, 0), 1),
            y: target.frame.minY + target.frame.height * min(max(y, 0), 1)
        )
    }

    private static func reportInputTarget(_ target: ResolvedTarget) {
        let editable = focusedElementIsEditable(target)
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "type": "input-target",
            "editable": editable,
        ]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    private static func focusedElementIsEditable(_ target: ResolvedTarget) -> Bool {
        guard let processID = target.processID else { return false }
        let applicationElement = AXUIElementCreateApplication(processID)
        var rawFocusedElement: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            applicationElement,
            kAXFocusedUIElementAttribute as CFString,
            &rawFocusedElement
        ) == .success,
        let rawFocusedElement,
        CFGetTypeID(rawFocusedElement) == AXUIElementGetTypeID() else { return false }
        let focusedElement = rawFocusedElement as! AXUIElement

        var rawRole: CFTypeRef?
        let role = AXUIElementCopyAttributeValue(
            focusedElement,
            kAXRoleAttribute as CFString,
            &rawRole
        ) == .success ? rawRole as? String : nil
        let editableRoles = [
            kAXTextFieldRole as String,
            kAXTextAreaRole as String,
            kAXComboBoxRole as String,
            kAXDateFieldRole as String,
            kAXTimeFieldRole as String,
        ]
        if let role, editableRoles.contains(role) { return true }

        var rawSubrole: CFTypeRef?
        let subrole = AXUIElementCopyAttributeValue(
            focusedElement,
            kAXSubroleAttribute as CFString,
            &rawSubrole
        ) == .success ? rawSubrole as? String : nil
        if subrole == (kAXSecureTextFieldSubrole as String)
            || subrole == (kAXSearchFieldSubrole as String) { return true }

        var rawEditable: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            focusedElement,
            kAXIsEditableAttribute as CFString,
            &rawEditable
        ) == .success,
        let editable = (rawEditable as? NSNumber)?.boolValue {
            return editable
        }
        return false
    }

    private static func raiseWindow(for target: ResolvedTarget, processID: pid_t) -> Bool {
        guard target.descriptor.kind == "window" else { return false }
        let applicationElement = AXUIElementCreateApplication(processID)
        var rawWindows: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            applicationElement,
            kAXWindowsAttribute as CFString,
            &rawWindows
        ) == .success,
        let windows = rawWindows as? [AXUIElement],
        !windows.isEmpty else { return false }

        let targetWindow = windows.min { windowScore($0, target: target) < windowScore($1, target: target) }
        guard let targetWindow else { return false }
        var rawFocusedWindow: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            applicationElement,
            kAXFocusedWindowAttribute as CFString,
            &rawFocusedWindow
        ) == .success,
        let focusedWindow = rawFocusedWindow,
        CFEqual(focusedWindow, targetWindow) {
            return false
        }
        AXUIElementPerformAction(targetWindow, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(targetWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(targetWindow, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        return true
    }

    private static func windowScore(_ window: AXUIElement, target: ResolvedTarget) -> Double {
        var score = 0.0
        var rawTitle: CFTypeRef?
        if AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &rawTitle) == .success,
           let title = rawTitle as? String,
           !target.descriptor.title.isEmpty,
           title != target.descriptor.title {
            score += 10_000
        }

        var rawPosition: CFTypeRef?
        var rawSize: CFTypeRef?
        var position = CGPoint.zero
        var size = CGSize.zero
        if AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &rawPosition) == .success,
           let positionValue = rawPosition,
           CFGetTypeID(positionValue) == AXValueGetTypeID() {
            AXValueGetValue(positionValue as! AXValue, .cgPoint, &position)
        }
        if AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &rawSize) == .success,
           let sizeValue = rawSize,
           CFGetTypeID(sizeValue) == AXValueGetTypeID() {
            AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        }
        score += abs(position.x - target.frame.minX)
        score += abs(position.y - target.frame.minY)
        score += abs(size.width - target.frame.width)
        score += abs(size.height - target.frame.height)
        return score
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

    private static func postClick(at point: CGPoint, button: String, clickCount: Int = 1) throws {
        let mouseButton = try mouseButton(button)
        let types = try mouseTypes(button)
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: mouseButton),
              let down = CGEvent(mouseEventSource: nil, mouseType: types.down, mouseCursorPosition: point, mouseButton: mouseButton),
              let up = CGEvent(mouseEventSource: nil, mouseType: types.up, mouseCursorPosition: point, mouseButton: mouseButton) else {
            throw HostError.eventCreationFailed
        }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        move.post(tap: .cghidEventTap)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private static func postPointer(type: CGEventType, at point: CGPoint, button: String) throws {
        let mouseButton = try mouseButton(button)
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: mouseButton) else {
            throw HostError.eventCreationFailed
        }
        event.post(tap: .cghidEventTap)
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
        try await activate(target)
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
        try await activate(target)
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

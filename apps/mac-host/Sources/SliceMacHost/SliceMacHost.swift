import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

@main
@MainActor
struct SliceMacHost {
    static func main() async {
        if CommandLine.arguments.count == 1,
           let bundleIdentifier = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(
               withBundleIdentifier: bundleIdentifier
           ).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [.activateAllWindows])
            return
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)

        do {
            if CommandLine.arguments.count == 1 {
                let delegate = NativeAppDelegate()
                application.delegate = delegate
                application.setActivationPolicy(.regular)
                application.run()
                return
            }
            let arguments = try Arguments(Array(CommandLine.arguments.dropFirst()))
            try await run(arguments)
        } catch {
            let message = error.localizedDescription
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(1)
        }
    }

    static func run(_ arguments: Arguments) async throws {
        switch arguments.command {
        case "permissions":
            if arguments.hasFlag("request") {
                requestPermissions()
            }
            try printJSON(PermissionState(
                screenRecording: await TargetCatalog.canCapture(),
                accessibility: AXIsProcessTrusted()
            ))

        case "list-targets":
            try printJSON(try await TargetCatalog.list(appFilter: arguments.value("app")))

        case "list-apps":
            try printJSON(ApplicationCatalog.list())

        case "launch-app":
            try await ApplicationCatalog.launch(path: arguments.require("path"))
            try printJSON(["ok": true])

        case "close-app":
            try ApplicationCatalog.close(path: arguments.require("path"))
            try printJSON(["ok": true])

        case "app-icon":
            try AppIconService.write(
                bundleIdentifier: arguments.require("bundle-id"),
                outputPath: arguments.require("output"),
                size: arguments.value("size").flatMap(Int.init) ?? 128
            )

        case "capture":
            let spec = try arguments.target()
            let target = try await TargetCatalog.resolve(kind: spec.kind, id: spec.id)
            let output = try arguments.require("output")
            let maxWidth = arguments.value("max-width").flatMap(Int.init) ?? 1_600
            try await CaptureService.capture(target: target, outputPath: output, maxWidth: maxWidth)

        case "stream":
            let spec = try arguments.target()
            let target = try await TargetCatalog.resolve(kind: spec.kind, id: spec.id)
            let maxWidth = arguments.value("max-width").flatMap(Int.init) ?? 1_600
            let framesPerSecond = arguments.value("fps").flatMap(Int.init) ?? 15
            try await StreamService.run(
                target: target,
                maxWidth: maxWidth,
                framesPerSecond: framesPerSecond
            )

        case "input-stream":
            let spec = try arguments.target()
            let target = try await TargetCatalog.resolve(kind: spec.kind, id: spec.id)
            try await InputService.runInputStream(target: target)

        case "click":
            let spec = try arguments.target()
            guard let x = Double(try arguments.require("x")),
                  let y = Double(try arguments.require("y")),
                  (0...1).contains(x), (0...1).contains(y) else {
                throw HostError.invalidArguments("--x and --y must be between 0 and 1")
            }
            let target = try await TargetCatalog.resolve(kind: spec.kind, id: spec.id)
            try await InputService.click(target: target, normalizedX: x, normalizedY: y)
            try printJSON(["ok": true])

        case "gesture":
            let spec = try arguments.target()
            let target = try await TargetCatalog.resolve(kind: spec.kind, id: spec.id)
            let payload = Data(try arguments.require("payload").utf8)
            let request = try JSONDecoder().decode(PointerGestureRequest.self, from: payload)
            try await InputService.gesture(target: target, request: request)
            try printJSON(["ok": true])

        case "type":
            let spec = try arguments.target()
            let target = try await TargetCatalog.resolve(kind: spec.kind, id: spec.id)
            try await InputService.type(target: target, text: try arguments.require("text"))
            try printJSON(["ok": true])

        case "key":
            let spec = try arguments.target()
            let target = try await TargetCatalog.resolve(kind: spec.kind, id: spec.id)
            let modifiers = arguments.value("modifiers")?.split(separator: ",").map(String.init) ?? []
            try await InputService.key(
                target: target,
                key: try arguments.require("key"),
                modifiers: modifiers
            )
            try printJSON(["ok": true])

        default:
            throw HostError.invalidArguments(Arguments.usage)
        }
    }

    static func requestPermissions() {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            openPrivacySettings(pane: "Privacy_ScreenCapture")
        }
        if !AXIsProcessTrusted() {
            _ = AXIsProcessTrustedWithOptions(
                ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            )
            if CGPreflightScreenCaptureAccess() {
                openPrivacySettings(pane: "Privacy_Accessibility")
            }
        }
    }

    static func openPrivacySettings(pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    static func printJSON<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

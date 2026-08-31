@preconcurrency import ScreenCaptureKit
import AppKit

struct ResolvedTarget {
    let descriptor: RemoteTarget
    let filter: SCContentFilter
    let frame: CGRect
    let processID: pid_t?
}

enum TargetCatalog {
    static func content() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    }

    static func canCapture() async -> Bool {
        guard CGPreflightScreenCaptureAccess() else { return false }
        do {
            _ = try await content()
            return true
        } catch {
            return false
        }
    }

    static func list(appFilter: String?) async throws -> [RemoteTarget] {
        let shareable = try await content()
        let needle = appFilter?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let displays = shareable.displays.map { display in
            RemoteTarget(
                kind: "display",
                id: display.displayID,
                title: "显示器 \(display.displayID)",
                appName: nil,
                bundleIdentifier: nil,
                frame: TargetFrame(display.frame)
            )
        }

        let windows = shareable.windows.compactMap { window -> RemoteTarget? in
            guard window.frame.width >= 160, window.frame.height >= 120 else { return nil }
            let appName = window.owningApplication?.applicationName
            let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let needle, !needle.isEmpty {
                let haystack = "\(appName ?? "") \(title ?? "")".lowercased()
                guard haystack.contains(needle) else { return nil }
            }
            return RemoteTarget(
                kind: "window",
                id: window.windowID,
                title: title?.isEmpty == false ? title! : (appName ?? "未命名窗口"),
                appName: appName,
                bundleIdentifier: window.owningApplication?.bundleIdentifier,
                frame: TargetFrame(window.frame)
            )
        }

        return displays + windows.sorted {
            let left = "\($0.appName ?? "") \($0.title)"
            let right = "\($1.appName ?? "") \($1.title)"
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
    }

    static func resolve(kind: String, id: UInt32) async throws -> ResolvedTarget {
        let shareable = try await content()
        if kind == "window", let window = shareable.windows.first(where: { $0.windowID == id }) {
            let descriptor = RemoteTarget(
                kind: "window",
                id: window.windowID,
                title: window.title ?? window.owningApplication?.applicationName ?? "未命名窗口",
                appName: window.owningApplication?.applicationName,
                bundleIdentifier: window.owningApplication?.bundleIdentifier,
                frame: TargetFrame(window.frame)
            )
            return ResolvedTarget(
                descriptor: descriptor,
                filter: SCContentFilter(desktopIndependentWindow: window),
                frame: window.frame,
                processID: window.owningApplication?.processID
            )
        }

        if kind == "display", let display = shareable.displays.first(where: { $0.displayID == id }) {
            let descriptor = RemoteTarget(
                kind: "display",
                id: display.displayID,
                title: "显示器 \(display.displayID)",
                appName: nil,
                bundleIdentifier: nil,
                frame: TargetFrame(display.frame)
            )
            return ResolvedTarget(
                descriptor: descriptor,
                filter: SCContentFilter(display: display, excludingWindows: []),
                frame: display.frame,
                processID: nil
            )
        }

        throw HostError.targetNotFound(kind: kind, id: id)
    }
}

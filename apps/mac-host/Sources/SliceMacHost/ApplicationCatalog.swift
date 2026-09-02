import AppKit
import Foundation

enum ApplicationCatalog {
    private static let roots = [
        "/Applications",
        "/System/Applications",
        "/System/Library/CoreServices/Applications",
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path,
    ]

    @MainActor
    static func list() -> [InstalledApplication] {
        let runningBundleIdentifiers = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        let runningPaths = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleURL?.standardizedFileURL.path))
        var applications: [String: InstalledApplication] = [:]

        for root in roots where FileManager.default.fileExists(atPath: root) {
            guard let enumerator = FileManager.default.enumerator(
                at: URL(fileURLWithPath: root),
                includingPropertiesForKeys: [.isApplicationKey, .isDirectoryKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            ) else { continue }

            for case let url as URL in enumerator where url.pathExtension.lowercased() == "app" {
                let standardizedURL = url.standardizedFileURL
                let bundle = Bundle(url: standardizedURL)
                let bundleIdentifier = bundle?.bundleIdentifier
                let displayName = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? standardizedURL.deletingPathExtension().lastPathComponent
                let appKey = bundleIdentifier ?? standardizedURL.path
                applications[appKey] = InstalledApplication(
                    appKey: appKey,
                    appName: displayName,
                    bundleIdentifier: bundleIdentifier,
                    path: standardizedURL.path,
                    isRunning: bundleIdentifier.map(runningBundleIdentifiers.contains) ?? runningPaths.contains(standardizedURL.path),
                    hasOpenWindow: false
                )
            }
        }

        return applications.values.sorted {
            $0.appName.localizedCaseInsensitiveCompare($1.appName) == .orderedAscending
        }
    }

    @MainActor
    static func launch(path: String) async throws {
        guard let application = list().first(where: { $0.path == URL(fileURLWithPath: path).standardizedFileURL.path }) else {
            throw HostError.applicationNotFound(path)
        }
        try await NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: application.path),
            configuration: NSWorkspace.OpenConfiguration()
        )
    }

    @MainActor
    static func close(path: String) throws {
        guard let application = list().first(where: { $0.path == URL(fileURLWithPath: path).standardizedFileURL.path }) else {
            throw HostError.applicationNotFound(path)
        }
        guard let runningApplication = NSWorkspace.shared.runningApplications.first(where: { running in
            if let bundleIdentifier = application.bundleIdentifier {
                return running.bundleIdentifier == bundleIdentifier
            }
            return running.bundleURL?.standardizedFileURL.path == application.path
        }) else {
            return
        }
        guard runningApplication.terminate() else {
            throw HostError.applicationCloseFailed(application.appName)
        }
    }
}

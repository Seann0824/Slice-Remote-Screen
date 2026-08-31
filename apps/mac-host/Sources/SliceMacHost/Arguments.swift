import Foundation

struct Arguments {
    let command: String
    private let values: [String: String]
    private let flags: Set<String>

    init(_ raw: [String]) throws {
        guard let command = raw.first else {
            throw HostError.invalidArguments(Self.usage)
        }
        self.command = command

        var values: [String: String] = [:]
        var flags = Set<String>()
        var index = 1
        while index < raw.count {
            let token = raw[index]
            guard token.hasPrefix("--") else {
                throw HostError.invalidArguments("Unexpected argument: \(token)")
            }
            if index + 1 < raw.count, !raw[index + 1].hasPrefix("--") {
                values[token] = raw[index + 1]
                index += 2
            } else {
                flags.insert(token)
                index += 1
            }
        }
        self.values = values
        self.flags = flags
    }

    func value(_ name: String) -> String? { values["--\(name)"] }
    func hasFlag(_ name: String) -> Bool { flags.contains("--\(name)") }

    func require(_ name: String) throws -> String {
        guard let value = value(name) else {
            throw HostError.invalidArguments("Missing --\(name)")
        }
        return value
    }

    func target() throws -> (kind: String, id: UInt32) {
        let kind = try require("kind")
        guard kind == "window" || kind == "display" else {
            throw HostError.invalidArguments("--kind must be window or display")
        }
        guard let id = UInt32(try require("id")) else {
            throw HostError.invalidArguments("--id must be an unsigned integer")
        }
        return (kind, id)
    }

    static let usage = """
    slice-mac-host commands:
      permissions [--request]
      list-targets [--app APP_NAME]
      list-apps
      launch-app --path APPLICATION_PATH
      close-app --path APPLICATION_PATH
      app-icon --bundle-id BUNDLE_ID --output FILE [--size 128]
      capture --kind window|display --id ID --output FILE [--max-width 1600]
      stream --kind window|display --id ID [--max-width 1600] [--fps 15]
      input-stream --kind window|display --id ID
      click --kind window|display --id ID --x 0...1 --y 0...1
      gesture --kind window|display --id ID --payload JSON
      type --kind window|display --id ID --text TEXT
      key --kind window|display --id ID --key KEY [--modifiers command,shift]
    """
}

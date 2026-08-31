#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
swift_package="${repo_root}/apps/mac-host"
app_bundle="${repo_root}/dist/SliceRemoteScreenHost.app"
bundle_contents="${app_bundle}/Contents"
bundle_macos="${bundle_contents}/MacOS"

swift build --package-path "${swift_package}"

mkdir -p "${bundle_macos}" "${bundle_contents}/Resources"
install -m 755 \
  "${swift_package}/.build/debug/slice-mac-host" \
  "${bundle_macos}/slice-mac-host"
install -m 644 \
  "${swift_package}/Resources/Info.plist" \
  "${bundle_contents}/Info.plist"

codesign --force --deep --sign - --timestamp=none "${app_bundle}"
codesign --verify --deep --strict "${app_bundle}"

echo "Built ${app_bundle}"


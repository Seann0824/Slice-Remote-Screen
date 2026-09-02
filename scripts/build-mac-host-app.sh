#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
swift_package="${repo_root}/apps/mac-host"
app_bundle="${repo_root}/dist/SliceRemoteScreenHost.app"
bundle_contents="${app_bundle}/Contents"
bundle_macos="${bundle_contents}/MacOS"
bundle_frameworks="${bundle_contents}/Frameworks"
webrtc_framework="${swift_package}/.build/arm64-apple-macosx/debug/WebRTC.framework"
bundle_identifier="com.sliceremotescreen.host"

swift build --package-path "${swift_package}"

[[ -d "${webrtc_framework}" ]] || {
  echo "错误：WebRTC.framework 构建产物不存在。" >&2
  exit 1
}

mkdir -p "${bundle_macos}" "${bundle_frameworks}" "${bundle_contents}/Resources"
install -m 755 \
  "${swift_package}/.build/debug/slice-mac-host" \
  "${bundle_macos}/slice-mac-host"
install -m 644 \
  "${swift_package}/Resources/Info.plist" \
  "${bundle_contents}/Info.plist"
rm -rf "${bundle_frameworks}/WebRTC.framework"
ditto "${webrtc_framework}" "${bundle_frameworks}/WebRTC.framework"
install_name_tool \
  -change "@rpath/WebRTC.framework/WebRTC" \
  "@executable_path/../Frameworks/WebRTC.framework/WebRTC" \
  "${bundle_macos}/slice-mac-host"

signing_identity="${SLICE_MAC_SIGNING_IDENTITY:-}"
if [[ -z "${signing_identity}" ]]; then
  signing_identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F '"' '/\) / { print $2; exit }')"
fi

if [[ -n "${signing_identity}" ]]; then
  echo "使用签名身份：${signing_identity}"
  codesign --force --sign "${signing_identity}" --timestamp=none "${bundle_frameworks}/WebRTC.framework"
  codesign --force --sign "${signing_identity}" --timestamp=none "${app_bundle}"
else
  # An ordinary ad-hoc signature uses the current CDHash as its designated
  # requirement, which makes macOS TCC treat every rebuild as a new app.
  # Keeping the requirement at the stable bundle identifier lets local builds
  # reuse Screen Recording and Accessibility grants across code changes.
  echo "未找到 Apple 签名证书，使用稳定的本地签名要求。"
  codesign --force --sign - --timestamp=none "${bundle_frameworks}/WebRTC.framework"
  codesign --force --sign - \
    --requirements="=designated => identifier \"${bundle_identifier}\"" \
    --timestamp=none "${app_bundle}"
fi
codesign --verify --deep --strict "${app_bundle}"

echo "Built ${app_bundle}"

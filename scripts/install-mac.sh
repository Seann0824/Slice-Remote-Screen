#!/usr/bin/env bash
set -euo pipefail

# Install the native macOS Host App. The app owns the UI, WebRTC, capture,
# input, account session and remote-control switch.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
app_install="${HOME}/Applications/Slice Remote Screen Host.app"
app_binary="${app_install}/Contents/MacOS/slice-mac-host"
build_binary="${repo_root}/dist/SliceRemoteScreenHost.app/Contents/MacOS/slice-mac-host"
legacy_label="space.englife.slice-remote-screen.host"
legacy_plist="${HOME}/Library/LaunchAgents/${legacy_label}.plist"
open_host=1
refresh_app=0
signaling_server="${SLICE_SIGNALING_SERVER:-}"

usage() {
  cat >&2 <<'EOF'
首次安装：pnpm run install:mac
高级用法：pnpm run install:mac -- --server https://remote.example.com [--no-open] [--refresh-app]

安装完成后直接双击“Slice Remote Screen Host.app”，在原生窗口登录 Slice 账号。
也可以通过 SLICE_SIGNALING_SERVER 环境变量提供服务器地址。
重复运行会复用已安装的 Host App；只有原生代码更新时才需要加 --refresh-app。
EOF
}

[[ "${1:-}" == "--" ]] && shift

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --server)
      [[ "$#" -ge 2 ]] || { usage; exit 2; }
      signaling_server="$2"
      shift 2
      ;;
    --no-open)
      open_host=0
      shift
      ;;
    --refresh-app)
      refresh_app=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$signaling_server" ]]; then
  signaling_server="${SLICE_DEFAULT_SIGNALING_SERVER:-https://remote.englife.space}"
fi

[[ "$(uname -s)" == "Darwin" ]] || { echo "错误：安装器只支持 macOS。" >&2; exit 1; }
command -v swift >/dev/null 2>&1 || { echo "错误：缺少 Swift/Xcode Command Line Tools。" >&2; exit 1; }

[[ "$signaling_server" =~ ^https?://[^[:space:]]+$ ]] \
  || { echo "错误：--server 必须是 HTTP(S) URL。" >&2; exit 1; }

stop_host_binary() {
  local binary_path="$1"
  local host_pid
  while IFS= read -r host_pid; do
    [[ -n "$host_pid" ]] && kill "$host_pid" 2>/dev/null || true
  done < <(pgrep -f -x "$binary_path" 2>/dev/null || true)
}

if [[ "${refresh_app}" -eq 1 ]]; then
  # Two Host copies signed with the same bundle id continuously evict each
  # other from the account's single signaling slot. Stop both exact binaries
  # before replacing the app; broad pkill patterns are intentionally avoided.
  stop_host_binary "$app_binary"
  stop_host_binary "$build_binary"
fi

cd "$repo_root"
# Remove the old Node/launchd host if this Mac was upgraded from the browser architecture.
launchctl bootout "gui/${UID}/${legacy_label}" 2>/dev/null || true
rm -f "${legacy_plist}"
echo "构建原生 macOS Host App……"
bash "${script_dir}/build-mac-host-app.sh"

source_app="${repo_root}/dist/SliceRemoteScreenHost.app"
[[ -x "${source_app}/Contents/MacOS/slice-mac-host" ]] || { echo "错误：Host 构建产物不存在。" >&2; exit 1; }

mkdir -p "${HOME}/Applications"
if [[ ! -x "${app_install}/Contents/MacOS/slice-mac-host" || "${refresh_app}" -eq 1 ]]; then
  rm -rf "${app_install}"
  ditto "${source_app}" "${app_install}"
else
  echo "复用已安装的 Host App（如原生代码有更新，请加 --refresh-app）。"
fi

# Store only the public endpoint. The native app keeps account cookies in its
# own cookie store; no token or password is written by the installer.
defaults write com.sliceremotescreen.host signalingServer -string "$signaling_server"

echo "原生 Host App 已安装：${app_install}"

if (( open_host )); then
  bash "${script_dir}/open-host.sh"
else
  echo "已跳过打开 App；需要时执行 pnpm run open:host。"
fi

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

fail() {
  echo "错误：$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令 $1，请先安装它。"
}

require_version() {
  local command_name="$1"
  local minimum_major="$2"
  local actual_major
  actual_major="$($command_name --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  [[ "${actual_major}" =~ ^[0-9]+$ ]] || fail "无法识别 ${command_name} 版本。"
  (( actual_major >= minimum_major )) || fail "${command_name} 版本过低，需要主版本 >= ${minimum_major}。"
}

[[ "$(uname -s)" == "Darwin" ]] || fail "Slice Remote Screen 的 macOS Host 依赖 ScreenCaptureKit，只支持在 macOS 上部署。"
require_command sw_vers
require_command node
require_command pnpm
require_command swift
require_command openssl
macos_major="$(sw_vers -productVersion | cut -d. -f1)"
[[ "${macos_major}" =~ ^[0-9]+$ ]] || fail "无法识别 macOS 版本。"
(( macos_major >= 14 )) || fail "macOS 版本过低，需要 macOS 14 或更高。"
require_version node 22
require_version pnpm 10

cd "${repo_root}"
echo "安装锁定依赖……"
pnpm install --frozen-lockfile

echo "构建 Web、API 和 macOS Host……"
pnpm build

if [[ "${SLICE_SKIP_PERMISSIONS:-0}" != "1" ]]; then
  echo "请求 macOS 屏幕录制和辅助功能权限……"
  "${repo_root}/dist/SliceRemoteScreenHost.app/Contents/MacOS/slice-mac-host" permissions --request
fi

echo "部署完成，启动本机服务。"
exec bash "${script_dir}/start.sh" "$@"

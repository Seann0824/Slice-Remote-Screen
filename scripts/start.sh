#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
environment_file="${repo_root}/.env"
lan_mode=0

if [[ "${1:-}" == "--lan" ]]; then
  lan_mode=1
  shift
fi
[[ "$#" -eq 0 ]] || { echo "用法：$0 [--lan]" >&2; exit 2; }

if [[ -f "${environment_file}" ]]; then
  set -a
  # .env is an operator-owned shell fragment, not an untrusted download.
  source "${environment_file}"
  set +a
fi

[[ -x "${repo_root}/dist/SliceRemoteScreenHost.app/Contents/MacOS/slice-mac-host" ]] \
  || { echo "尚未构建 Host，请先运行 pnpm run bootstrap。" >&2; exit 1; }
[[ -f "${repo_root}/apps/mobile-web/dist/index.html" ]] \
  || { echo "尚未构建 Web，请先运行 pnpm run bootstrap。" >&2; exit 1; }

if (( lan_mode )); then
  export SLICE_HOST="0.0.0.0"
  export SLICE_TOKEN="${SLICE_TOKEN:-$(openssl rand -hex 32)}"
else
  export SLICE_HOST="${SLICE_HOST:-127.0.0.1}"
fi

cd "${repo_root}"
exec pnpm --filter @slice/local-host start

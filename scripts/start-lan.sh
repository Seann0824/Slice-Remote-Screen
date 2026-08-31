#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

export SLICE_HOST="0.0.0.0"
export SLICE_TOKEN="${SLICE_TOKEN:-$(openssl rand -hex 16)}"

cd "${repo_root}"
pnpm build

echo "Starting LAN host with token authentication."
echo "Do not expose port 4173 to the public internet."
exec pnpm --filter @slice/local-host start


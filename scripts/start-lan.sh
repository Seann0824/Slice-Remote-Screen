#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "启动局域网 Host（Bearer token 鉴权）。"
echo "不要把 4173 端口暴露到公网；代码更新后请先运行 pnpm run bootstrap。"
exec bash "${script_dir}/start.sh" --lan

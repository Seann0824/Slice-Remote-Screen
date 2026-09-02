#!/usr/bin/env bash
set -euo pipefail

app_install="${HOME}/Applications/Slice Remote Screen Host.app"

if [[ -x "${app_install}/Contents/MacOS/slice-mac-host" ]]; then
  open "${app_install}"
  exit 0
fi

echo "错误：未找到原生 Host App。请先运行 pnpm run install:mac。" >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail

support_dir="${HOME}/Library/Application Support/Slice Remote Screen"
app_install="${HOME}/Applications/Slice Remote Screen Host.app"
label="space.englife.slice-remote-screen.host"
plist_path="${HOME}/Library/LaunchAgents/${label}.plist"
purge=0

[[ "${1:-}" == "--" ]] && shift

if [[ "${1:-}" == "--purge" ]]; then
  purge=1
  shift
fi
[[ "$#" -eq 0 ]] || { echo "用法：pnpm run uninstall:mac [-- --purge]" >&2; exit 2; }

launchctl bootout "gui/${UID}/${label}" 2>/dev/null || true
rm -f "${plist_path}"
rm -rf "${app_install}"
defaults delete com.sliceremotescreen.host signalingServer 2>/dev/null || true

if (( purge )); then
  rm -rf "${support_dir}"
  echo "已卸载 Host App 和 Slice Remote Screen 配置/日志。"
else
  echo "已卸载 Host App；本机配置、用户配置和日志已保留在：${support_dir}"
  echo "如确认要删除这些数据，再运行：pnpm run uninstall:mac -- --purge"
fi

#!/usr/bin/env bash
# 用 Cloudflare 快速隧道把本机服务临时暴露到公网（HTTPS 域名，手机也能当服务器）
# 前置：已安装 cloudflared（https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] 没装 cloudflared。装法："
  echo "  Debian/Ubuntu: 下载 https://github.com/cloudflare/cloudflared/releases 的 *_linux_amd64.deb 后 dpkg -i"
  echo "  macOS:          brew install cloudflared"
  echo "  Windows:        winget install --id Cloudflare.cloudflared"
  exit 1
fi

PORT="${PORT:-8080}"
echo "[tunnel] 先把服务跑起来：npm start（另开一个终端）"
echo "[tunnel] 正在建立临时公网地址，指向 http://localhost:${PORT} …"
echo "[tunnel] 拿到 https://xxxx.trycloudflare.com 后，把它发给朋友即可。"
echo
exec cloudflared tunnel --url "http://localhost:${PORT}"

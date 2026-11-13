#!/usr/bin/env bash
# 一键启动：缺依赖就装、缺证书就生成
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没装 Node.js，请先装 Node 18+（https://nodejs.org）"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[1/3] 安装依赖…"
  npm install --omit=dev || npm install
else
  echo "[1/3] 依赖已存在"
fi

if [ ! -f certs/cert.pem ]; then
  echo "[2/3] 生成自签证书…"
  ./gen-cert.sh || echo "[提醒] 证书生成失败，只能用 http（屏幕共享会不可用）"
else
  echo "[2/3] 证书已存在"
fi

echo "[3/3] 启动服务…"
echo "  本机:      http://localhost:8080"
echo "  局域网HTTPS: https://<这台电脑的IP>:8443"
node server.js

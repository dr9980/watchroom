#!/usr/bin/env bash
# 生成自签证书（Let's Encrypt 之前的临时方案）
# 用法: ./gen-cert.sh [额外域名或IP ...]
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs

IPS=("$@")
# 自动收集本机 IPv4
while read -r ip; do
  [ -n "$ip" ] && IPS+=("$ip")
done < <(node -e "
const os=require('os');const s=new Set();
for(const k of Object.keys(os.networkInterfaces()))for(const n of os.networkInterfaces()[k]||[])if(n.family==='IPv4'&&!n.internal)s.add(n.address);
console.log([...s].join('\n'));
" 2>/dev/null || true)

SAN="DNS:localhost,IP:127.0.0.1"
i=1
for ip in "${IPS[@]:-}"; do
  [ -z "$ip" ] && continue
  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SAN="$SAN,IP:$ip"
  else
    SAN="$SAN,DNS:$ip"
  fi
  i=$((i+1))
done

echo "[gen-cert] SAN = $SAN"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=watchroom" \
  -addext "subjectAltName=$SAN" >/dev/null 2>&1

chmod 600 certs/key.pem
echo "[gen-cert] 已生成 certs/cert.pem 和 certs/key.pem"
echo "[gen-cert] 重启服务后访问 https://<本机IP>:8443（首次需点「继续访问」）"

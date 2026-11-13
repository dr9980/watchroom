@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] 安装依赖...
if not exist node_modules ( call npm install --omit=dev || call npm install )
echo [2/3] 生成自签证书（需要 openssl，没有就用 http 模式）...
if not exist certs\cert.pem (
  where openssl >nul 2>nul && (
    if not exist certs mkdir certs
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -keyout certs\key.pem -out certs\cert.pem -subj "/CN=watchroom" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >nul 2>nul
  ) || echo [提醒] 没找到 openssl：只能用 http，屏幕共享会不可用
)
echo [3/3] 启动服务...
echo   本机浏览器打开: http://localhost:8080
echo   局域网: https://<本机IP>:8443  (需要证书)
node server.js
pause

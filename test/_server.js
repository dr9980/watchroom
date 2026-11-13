'use strict';
/* 测试用：拉起一个独立 server 实例 */
const { spawn } = require('child_process');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(base, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return true;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('server 启动超时: ' + base);
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), TLS_PORT: String(port + 100), TLS_KEY: '/nonexistent', TLS_CERT: '/nonexistent' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitHealth(base);
  return { child, base };
}

module.exports = { startServer };

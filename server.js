'use strict';
/*
 * 私人观影房 — 网页版（房主 + 观众都用浏览器）
 * 信令 + 房间管理 + 静态托管。媒体走 WebRTC mesh P2P，不经服务器转发。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const TLS_PORT = Number(process.env.TLS_PORT || 8443);
const MAX_VIEWERS = Number(process.env.MAX_VIEWERS || 10);
const ROOM_TTL = 2 * 3600 * 1000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** @type {Map<string, Room>} */
const rooms = new Map();

/* ---------------- helpers ---------------- */

function roomCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
  return s;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32);
  return salt.toString('hex') + ':' + h.toString('hex');
}

function checkPassword(pw, rec) {
  if (!rec) return true;
  const [saltHex, hashHex] = rec.split(':');
  const h = crypto.scryptSync(String(pw || ''), Buffer.from(saltHex, 'hex'), 32);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

function cleanName(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
}

function publicMember(m) {
  return { id: m.id, name: m.name, role: m.role, mic: !!m.mic, muted: !!m.muted, joinedAt: m.joinedAt };
}

function send(conn, obj) {
  if (conn && conn.ws && conn.ws.readyState === 1) {
    try { conn.ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function broadcast(room, obj, exceptId) {
  const raw = JSON.stringify(obj);
  for (const m of room.members.values()) {
    if (m.id === exceptId) continue;
    if (m.ws && m.ws.readyState === 1) {
      try { m.ws.send(raw); } catch (_) {}
    }
  }
}

function roomSummary(room) {
  return {
    code: room.code,
    state: room.state,
    hasPassword: !!room.pass,
    maxViewers: MAX_VIEWERS,
    viewers: [...room.members.values()].filter((m) => m.role === 'viewer').length,
  };
}

function iceConfig() {
  const iceServers = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  } else if (process.env.NO_PUBLIC_TURN !== '1') {
    // 公开的免费 TURN（best-effort），跨运营商/4G 场景下能救一部分连不上的情况。
    // 生产环境请换成自己的 coturn，并设 TURN_URL 覆盖。
    iceServers.push({
      urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443'],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }
  return { iceServers, publicTurn: !process.env.TURN_URL && process.env.NO_PUBLIC_TURN !== '1' };
}

/* ---------------- room lifecycle ---------------- */

function createRoom(conn, msg) {
  const name = cleanName(msg.name);
  if (!name) return send(conn, { t: 'error', code: 'bad_name', msg: '请填写昵称' });

  let code;
  do { code = roomCode(); } while (rooms.has(code));

  const room = {
    code,
    pass: msg.password ? hashPassword(msg.password) : null,
    hostId: null,
    state: 'waiting',
    members: new Map(),
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(code, room);
  attach(conn, room, 'host', name);
  send(conn, { t: 'ready', you: publicMember(room.members.get(conn.id)), room: roomSummary(room), members: [...room.members.values()].map(publicMember) });
}

function joinRoom(conn, msg) {
  const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const room = rooms.get(code);
  if (!room) return send(conn, { t: 'error', code: 'no_room', msg: '房间不存在或已结束' });
  if (room.state === 'ended') return send(conn, { t: 'error', code: 'ended', msg: '房间已结束' });

  const name = cleanName(msg.name);
  if (!name) return send(conn, { t: 'error', code: 'bad_name', msg: '请填写昵称' });

  const viewers = [...room.members.values()].filter((m) => m.role === 'viewer').length;
  if (viewers >= MAX_VIEWERS) {
    return send(conn, { t: 'error', code: 'full', msg: `人数已满（最多 ${MAX_VIEWERS} 名观众）` });
  }
  if (!checkPassword(msg.password, room.pass)) {
    return send(conn, { t: 'error', code: 'bad_password', msg: '密码错误' });
  }

  let finalName = name;
  const taken = new Set([...room.members.values()].map((m) => m.name));
  for (let i = 2; taken.has(finalName) && i < 100; i++) finalName = `${name}(${i})`;

  attach(conn, room, 'viewer', finalName);
  const me = room.members.get(conn.id);
  send(conn, { t: 'ready', you: publicMember(me), room: roomSummary(room), members: [...room.members.values()].map(publicMember) });
  broadcast(room, { t: 'peer-joined', member: publicMember(me) }, conn.id);
}

function attach(conn, room, role, name) {
  conn.room = room;
  conn.role = role;
  if (role === 'host') room.hostId = conn.id;
  room.members.set(conn.id, {
    id: conn.id,
    name,
    role,
    mic: false,
    muted: false,
    joinedAt: Date.now(),
    ws: conn.ws,
  });
  room.lastActive = Date.now();
}

function detach(conn) {
  const room = conn.room;
  if (!room) return;
  conn.room = null;
  const m = room.members.get(conn.id);
  if (!m) return;
  room.members.delete(conn.id);
  room.lastActive = Date.now();

  if (m.role === 'host') {
    // 房主离开 = 房间结束
    room.state = 'ended';
    broadcast(room, { t: 'state', state: 'ended', reason: 'host_left' });
    setTimeout(() => rooms.delete(room.code), 30 * 1000);
    return;
  }
  broadcast(room, { t: 'peer-left', id: conn.id, name: m.name });
  if (room.members.size === 0) rooms.delete(room.code);
}

/* ---------------- message handling ---------------- */

function handle(conn, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || typeof msg.t !== 'string') return;
  const room = conn.room;

  switch (msg.t) {
    case 'create':
      if (room) return;
      return createRoom(conn, msg);

    case 'join':
      if (room) return;
      return joinRoom(conn, msg);

    case 'signal': {
      if (!room) return;
      const to = room.members.get(msg.to);
      if (!to || to.id === conn.id) return;
      return send(to, { t: 'signal', from: conn.id, data: msg.data });
    }

    case 'state': {
      if (!room || conn.role !== 'host') return;
      const s = String(msg.state || '');
      if (!['waiting', 'live', 'paused', 'ended'].includes(s)) return;
      room.state = s;
      room.lastActive = Date.now();
      broadcast(room, { t: 'state', state: s });
      if (s === 'ended') setTimeout(() => rooms.delete(room.code), 30 * 1000);
      return;
    }

    case 'chat': {
      if (!room) return;
      const now = Date.now();
      conn.chatTimes = (conn.chatTimes || []).filter((x) => now - x < 3000);
      if (conn.chatTimes.length >= 10) return;
      conn.chatTimes.push(now);
      const text = String(msg.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 200);
      if (!text) return;
      const m = room.members.get(conn.id);
      return broadcast(room, { t: 'chat', from: conn.id, name: m ? m.name : '', role: m ? m.role : 'viewer', kind: msg.kind === 'danmaku' ? 'danmaku' : 'chat', text, at: now });
    }

    case 'mic': {
      if (!room) return;
      const m = room.members.get(conn.id);
      if (!m) return;
      m.mic = !!msg.on && !m.muted;
      return broadcast(room, { t: 'member', id: m.id, mic: m.mic, muted: m.muted });
    }

    case 'mute': {
      if (!room || conn.role !== 'host') return;
      const target = room.members.get(msg.to);
      if (!target || target.role === 'host') return;
      target.muted = !!msg.on;
      if (target.muted) target.mic = false;
      broadcast(room, { t: 'member', id: target.id, mic: target.mic, muted: target.muted });
      return send(target, { t: 'force-mute', on: target.muted });
    }

    case 'kick': {
      if (!room || conn.role !== 'host') return;
      const target = room.members.get(msg.to);
      if (!target || target.role === 'host') return;
      send(target, { t: 'kicked', msg: '你已被房主移出房间' });
      const ws = target.ws;
      room.members.delete(target.id);
      broadcast(room, { t: 'peer-left', id: target.id, name: target.name });
      try { ws.close(4001, 'kicked'); } catch (_) {}
      return;
    }

    case 'leave':
      return detach(conn);

    case 'ping':
      return send(conn, { t: 'pong', at: Date.now() });

    default:
      return;
  }
}

/* ---------------- static files ---------------- */

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { urlPath = '/'; }

  if (urlPath === '/api/config') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    return res.end(JSON.stringify(iceConfig()));
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'content-type': MIME['.txt'] });
    return res.end('ok');
  }
  if (urlPath.startsWith('/api/room/')) {
    const room = rooms.get(urlPath.slice('/api/room/'.length).toUpperCase());
    res.writeHead(room ? 200 : 404, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    return res.end(JSON.stringify(room ? roomSummary(room) : { error: 'not_found' }));
  }

  let fileRel;
  if (urlPath === '/' || urlPath === '') fileRel = 'index.html';
  else if (/^\/r\/[A-Za-z0-9]+$/.test(urlPath) || urlPath === '/room.html') fileRel = 'room.html';
  else fileRel = urlPath.replace(/^\/+/, '');

  const filePath = path.join(PUBLIC, path.normalize(fileRel));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': MIME['.txt'] });
      return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- servers ---------------- */

function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

  wss.on('connection', (ws) => {
    const conn = { id: crypto.randomUUID(), ws, room: null, role: null, alive: true };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      try { handle(conn, data.toString()); } catch (e) { console.error('handle error', e); }
    });
    ws.on('close', () => detach(conn));
    ws.on('error', () => {});
    send(conn, { t: 'hello', id: conn.id, maxViewers: MAX_VIEWERS });
  });

  const timer = setInterval(() => {
    // 心跳 + 过期房间清理
    for (const r of rooms.values()) {
      if (r.state === 'ended' && Date.now() - r.lastActive > 60 * 1000) rooms.delete(r.code);
      if (Date.now() - r.createdAt > ROOM_TTL && Date.now() - r.lastActive > 10 * 60 * 1000) {
        broadcast(r, { t: 'state', state: 'ended', reason: 'timeout' });
        rooms.delete(r.code);
      }
    }
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    });
  }, 30 * 1000);

  wss.on('close', () => clearInterval(timer));
  return wss;
}

function lanUrls(proto, port) {
  const out = [`${proto}://localhost:${port}`];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`${proto}://${ni.address}:${port}`);
    }
  }
  return out;
}

const httpServer = http.createServer(serveStatic);
attachWs(httpServer);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[watchroom] HTTP  : ${lanUrls('http', PORT).join('  ')}`);
  console.log('[watchroom] 局域网 http 只能看/聊，屏幕共享和麦克风需要 HTTPS 或 localhost');
});

const keyPath = process.env.TLS_KEY || path.join(__dirname, 'certs', 'key.pem');
const certPath = process.env.TLS_CERT || path.join(__dirname, 'certs', 'cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const httpsServer = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, serveStatic);
  attachWs(httpsServer);
  httpsServer.listen(TLS_PORT, '0.0.0.0', () => {
    console.log(`[watchroom] HTTPS : ${lanUrls('https', TLS_PORT).join('  ')}`);
    console.log('[watchroom] 自签证书：手机/电脑首次打开需点「继续访问」');
  });
} else {
  console.log('[watchroom] 未找到证书，仅 HTTP。运行 ./gen-cert.sh 生成自签证书后重启即可开 HTTPS');
}

process.on('SIGINT', () => { console.log('\n[watchroom] bye'); process.exit(0); });

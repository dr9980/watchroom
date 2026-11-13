'use strict';
/* 信令与房间规则测试：不需要浏览器，用 ws 客户端模拟房主和观众 */
const { WebSocket } = require('ws');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const WS = BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function client() {
  const ws = new WebSocket(WS);
  const c = { ws, msgs: [], waiters: [], closed: false };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    c.msgs.push(m);
    for (const w of c.waiters.slice()) {
      if (w.pred(m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(m); }
    }
  });
  ws.on('close', () => { c.closed = true; });
  c.opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find(pred);
    if (hit) return resolve(hit);
    const w = { pred, resolve };
    c.waiters.push(w);
    setTimeout(() => reject(new Error('timeout waiting')), ms);
  });
  c.has = (pred) => c.msgs.some(pred);
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n[1] 静态资源');
  for (const [p, code] of [['/', 200], ['/style.css', 200], ['/room.css', 200], ['/index.js', 200], ['/room.js', 200], ['/r/TESTCODE', 200], ['/api/config', 200], ['/healthz', 200], ['/nope.js', 404]]) {
    const r = await fetch(BASE + p);
    ok(r.status === code, `GET ${p} -> ${r.status}`);
  }
  const cfg = await (await fetch(BASE + '/api/config')).json();
  ok(Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0, 'config 有 ICE 服务器', cfg);
  const htmlish = await (await fetch(BASE + '/r/TESTCODE')).text();
  ok(htmlish.includes('room.js'), '/r/CODE 返回房间页');

  console.log('\n[2] 建房 + 加入');
  const host = client();
  await host.opened;
  await host.wait((m) => m.t === 'hello');
  host.send({ t: 'create', name: '房主甲', password: 'pw123' });
  const ready = await host.wait((m) => m.t === 'ready');
  const code = ready.room.code;
  ok(/^[A-Z0-9]{8}$/.test(code), `房间码 8 位且高熵: ${code}`);
  ok(ready.you.role === 'host', '创建者是房主');
  ok(ready.room.hasPassword === true, '房间带密码标记');

  console.log('\n[3] 密码与人数限制');
  const bad = client(); await bad.opened;
  bad.send({ t: 'join', code, name: '路人', password: 'wrong' });
  const err1 = await bad.wait((m) => m.t === 'error');
  ok(err1.code === 'bad_password', '密码错误被拒', err1);
  bad.ws.close();

  const v1 = client(); await v1.opened;
  v1.send({ t: 'join', code, name: '观众1', password: 'pw123' });
  const r1 = await v1.wait((m) => m.t === 'ready');
  ok(r1.you.role === 'viewer', '观众身份正确');
  ok(r1.members.length === 2, '观众看到 2 名成员', r1.members.map((m) => m.name));
  const joinedNotice = await host.wait((m) => m.t === 'peer-joined');
  ok(joinedNotice.member.name === '观众1', '房主收到 peer-joined');

  const rename = client(); await rename.opened;
  rename.send({ t: 'join', code, name: '观众1', password: 'pw123' });
  const rr = await rename.wait((m) => m.t === 'ready');
  ok(rr.you.name === '观众1(2)', '重名自动加后缀', rr.you.name);
  rename.ws.close();
  await sleep(150);

  const others = [];
  for (let i = 2; i <= 10; i++) {
    const c = client(); await c.opened;
    c.send({ t: 'join', code, name: '观众' + i, password: 'pw123' });
    await c.wait((m) => m.t === 'ready');
    others.push(c);
  }
  const v11 = client(); await v11.opened;
  v11.send({ t: 'join', code, name: '第11个', password: 'pw123' });
  const err2 = await v11.wait((m) => m.t === 'error');
  ok(err2.code === 'full', '第 11 名观众被拒（上限 10）', err2);
  v11.ws.close();

  console.log('\n[4] 消息与信令');
  v1.send({ t: 'chat', text: '大家好', kind: 'chat' });
  const chat = await host.wait((m) => m.t === 'chat');
  ok(chat.text === '大家好' && chat.name === '观众1', '聊天广播到房主', chat);
  const dm = await host.wait((m) => m.t === 'chat' && m.kind === 'danmaku', 3000).catch(() => null);
  ok(dm === null, '普通聊天不会被当成弹幕');

  v1.send({ t: 'chat', text: '飘过', kind: 'danmaku' });
  const dm2 = await host.wait((m) => m.t === 'chat' && m.kind === 'danmaku');
  ok(dm2.kind === 'danmaku', '弹幕带 kind=danmaku');

  const longText = 'x'.repeat(500);
  v1.send({ t: 'chat', text: longText });
  const longChat = await host.wait((m) => m.t === 'chat' && m.text.length > 100);
  ok(longChat.text.length === 200, '超长消息按 200 字截断', longChat.text.length);

  v1.send({ t: 'signal', to: ready.you.id, data: { description: { type: 'offer', sdp: 'fake-sdp' } } });
  const sig = await host.wait((m) => m.t === 'signal' && m.data && m.data.description);
  ok(sig.from === r1.you.id, 'SDP 定向转发到房主', sig.from);

  console.log('\n[5] 房主权限');
  v1.send({ t: 'state', state: 'ended' });
  ok(!(await v1.wait((m) => m.t === 'state' && m.state === 'ended', 800).catch(() => null)), '观众不能改房间状态');

  host.send({ t: 'state', state: 'live' });
  const st = await v1.wait((m) => m.t === 'state' && m.state === 'live');
  ok(st.state === 'live', '房主可切到共享中');

  host.send({ t: 'mute', to: r1.you.id, on: true });
  const muted = await v1.wait((m) => m.t === 'force-mute' && m.on === true);
  ok(!!muted, '禁言通知到达观众');
  const mem = await v1.wait((m) => m.t === 'member' && m.muted === true);
  ok(mem.muted === true, '成员状态广播 muted');

  v1.send({ t: 'mic', on: true });
  const micBlocked = await host.wait((m) => m.t === 'member' && m.id === r1.you.id && m.mic === false && m.muted === true);
  ok(micBlocked.mic === false, '被禁言时无法开麦');

  host.send({ t: 'mute', to: r1.you.id, on: false });
  await v1.wait((m) => m.t === 'force-mute' && m.on === false);
  v1.send({ t: 'mic', on: true });
  const micBack = await host.wait((m) => m.t === 'member' && m.id === r1.you.id && m.mic === true);
  ok(micBack.mic === true, '解除禁言后可开麦');

  host.send({ t: 'kick', to: r1.you.id });
  const kicked = await v1.wait((m) => m.t === 'kicked');
  ok(!!kicked, '被移出通知');
  await sleep(200);
  ok(v1.closed === true, '被移出后连接关闭');
  const left = await host.wait((m) => m.t === 'peer-left' && m.id === r1.you.id);
  ok(!!left, '房主收到 peer-left');

  console.log('\n[6] 房主离开 = 房间结束');
  host.send({ t: 'state', state: 'ended' });
  await others[0].wait((m) => m.t === 'state' && m.state === 'ended');
  ok(true, '观众收到 ended');
  host.ws.close();
  await sleep(200);

  const gone = client(); await gone.opened;
  gone.send({ t: 'join', code, name: '迟到的人', password: 'pw123' });
  const err3 = await gone.wait((m) => m.t === 'error');
  ok(['no_room', 'ended'].includes(err3.code), '结束后无法再加入', err3);

  for (const c of others) c.ws.close();
  gone.ws.close();

  await sleep(200);
  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });

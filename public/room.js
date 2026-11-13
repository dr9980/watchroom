'use strict';
/* 私人观影房 — 网页版客户端（mesh WebRTC + 信令） */

const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const pathCode = (location.pathname.match(/^\/r\/([A-Za-z0-9]+)/) || [])[1] || '';
const hostIntent = qs.get('host') === '1';

function readStore(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return null; }
}

const boot = hostIntent ? readStore('wr.create') : readStore('wr.join');
if (!boot) { location.replace('/'); throw new Error('no boot config'); }

const S = {
  ws: null,
  id: null,
  role: hostIntent ? 'host' : 'viewer',
  name: boot.name || '我',
  pass: boot.pass || '',
  code: (pathCode || boot.code || '').toUpperCase(),
  state: 'waiting',
  members: new Map(),
  peers: new Map(),
  capture: null,
  captureKind: null,
  facing: 'environment',
  mic: null,
  micOn: false,
  danmakuOn: true,
  stageStream: null,
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }],
  reconnect: 0,
  closedByMe: false,
  ended: false,
};

const MAX_VIEWERS = 10;

/* ---------------- 小工具 ---------------- */

function send(obj) {
  if (S.ws && S.ws.readyState === 1) {
    try { S.ws.send(JSON.stringify(obj)); return true; } catch (_) {}
  }
  return false;
}

let toastTimer = null;
function toast(text, ms = 2600) {
  const el = $('#stage-toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lanHint() {
  $('#role-hint').textContent = S.role === 'host'
    ? (supportsScreenShare()
      ? '房主：可以「共享屏幕」（电脑）或「共享摄像头」（手机）。共享屏幕时勾选「分享标签页音频」才有声音。'
      : '房主：这台设备用「共享摄像头」（手机浏览器不能共享屏幕）。把链接发给朋友即可一起看。')
    : (window.isSecureContext ? '观众：点「开麦」可以说话，发消息会出现在聊天区和画面上。' : '当前不是 HTTPS：只能观看和聊天，开麦会被浏览器拦截。');
}

/* ---------------- WebSocket ---------------- */

function wsUrl() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

function connect() {
  const ws = new WebSocket(wsUrl());
  S.ws = ws;

  ws.onopen = () => {
    setConn(true);
    if (S.role === 'host') {
      if (!S.code) send({ t: 'create', name: S.name, password: S.pass });
      else send({ t: 'join', code: S.code, name: S.name, password: S.pass });
    } else {
      send({ t: 'join', code: S.code, name: S.name, password: S.pass });
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    onServer(msg);
  };

  ws.onclose = () => {
    setConn(false);
    if (S.closedByMe || S.ended) return;
    resetPeers();
    if (S.role === 'host') {
      toast('和服务器断开了，请刷新页面重新开房', 5000);
      return;
    }
    S.reconnect += 1;
    if (S.reconnect > 6) { toast('连接已断开，请刷新页面'); return; }
    setTimeout(connect, Math.min(1500 * S.reconnect, 8000));
  };

  ws.onerror = () => {};
}

function onServer(msg) {
  switch (msg.t) {
    case 'hello':
      S.id = msg.id;
      break;

    case 'ready': {
      S.reconnect = 0;
      S.id = msg.you.id;
      S.role = msg.you.role;
      S.code = msg.room.code;
      S.state = msg.room.state;
      S.members = new Map(msg.members.map((m) => [m.id, m]));
      $('#room-code').textContent = S.code;
      $('#host-controls').classList.toggle('hidden', S.role !== 'host');
      $('#watermark').textContent = `${S.code} · ${S.name}`;
      lanHint();
      renderAll();
      if (S.role === 'host' && history.replaceState) {
        history.replaceState(null, '', `/r/${S.code}`);
      }
      // 和已在房间的人建立连接
      for (const m of S.members.values()) {
        if (m.id !== S.id) addPeer(m.id);
      }
      // 房主创建房间后替换地址，方便直接复制
      if (S.role === 'host') sessionStorage.removeItem('wr.create');
      break;
    }

    case 'peer-joined': {
      S.members.set(msg.member.id, msg.member);
      addPeer(msg.member.id);
      renderMembers();
      renderAll();
      addSys(`${msg.member.name} 加入了房间`);
      break;
    }

    case 'peer-left': {
      removePeer(msg.id);
      S.members.delete(msg.id);
      renderAll();
      if (msg.name) addSys(`${msg.name} 离开了房间`);
      break;
    }

    case 'signal':
      handleSignal(msg.from, msg.data);
      break;

    case 'state': {
      S.state = msg.state;
      if (msg.state !== 'live' && msg.state !== 'paused' && S.role !== 'host') {
        S.stageStream = null;
        const v = $('#screen');
        if (v) v.srcObject = null;
      }
      renderState();
      if (S.role === 'viewer') {
        if (msg.state === 'paused') toast('房主已暂停共享');
        if (msg.state === 'live') toast('房主继续共享了');
      }
      if (msg.state === 'ended') {
        S.ended = true;
        toast('房间已结束');
        closeAllPeers();
      }
      break;
    }

    case 'chat': {
      if (msg.kind === 'danmaku') addDanmaku(msg.name, msg.text);
      addChat(msg);
      break;
    }

    case 'member': {
      const m = S.members.get(msg.id);
      if (m) { m.mic = msg.mic; m.muted = msg.muted; }
      renderMembers();
      break;
    }

    case 'force-mute': {
      if (S.mic) S.mic.getAudioTracks().forEach((t) => (t.enabled = false));
      S.micOn = false;
      renderMic();
      toast(msg.on ? '你已被房主禁言' : '房主已解除对你的禁言');
      break;
    }

    case 'kicked': {
      S.closedByMe = true;
      toast(msg.msg || '你已被移出房间');
      setTimeout(() => location.replace('/'), 1800);
      break;
    }

    case 'error': {
      const map = {
        full: '人数已满（最多 10 名观众）',
        bad_password: '密码错误',
        no_room: '房间不存在',
        ended: '房间已结束',
      };
      toast(msg.msg || map[msg.code] || '出错了', 3200);
      if (['full', 'bad_password', 'no_room', 'ended', 'bad_name'].includes(msg.code)) {
        S.closedByMe = true;
        setTimeout(() => location.replace('/?r=' + encodeURIComponent(S.code)), 2200);
      }
      break;
    }
  }
}

function setConn(on) {
  const d = $('#conn-dot');
  d.classList.toggle('on', on);
  d.classList.toggle('off', !on);
}

/* ---------------- 渲染 ---------------- */

function renderAll() {
  renderState();
  renderMembers();
}

function renderState() {
  const b = $('#state-badge');
  const label = { waiting: '等待中', live: '共享中', paused: '已暂停', ended: '已结束' }[S.state] || S.state;
  b.textContent = label;
  b.className = 'badge ' + (S.state === 'live' ? 'live' : S.state === 'paused' ? 'paused' : S.state === 'ended' ? 'ended' : '');

  const hasVideo = !!((S.stageStream && S.stageStream.getVideoTracks().length) || (S.role === 'host' && S.capture));
  $('#stage-empty').classList.toggle('hidden', hasVideo || S.state === 'live');

  if (S.state === 'ended') $('#stage-empty').textContent = '房间已结束';
  else if (S.state === 'paused') $('#stage-empty').textContent = '房主已暂停共享';
  else if (S.role === 'viewer') $('#stage-empty').textContent = hasVideo ? '' : '等待房主开始共享…';

  const viewers = [...S.members.values()].filter((m) => m.role === 'viewer').length;
  $('#count-badge').textContent = `${viewers}/${MAX_VIEWERS}`;
  $('#member-count').textContent = String(S.members.size);

  if (S.role === 'host') {
    const sharing = !!S.capture;
    const paused = sharing && S.state === 'paused';
    const canScreen = supportsScreenShare();
    $('#btn-share-screen').classList.toggle('hidden', sharing || !canScreen);
    $('#btn-share-camera').classList.toggle('hidden', sharing);
    $('#btn-switch-cam').classList.toggle('hidden', !(sharing && S.captureKind === 'camera'));
    $('#btn-pause').classList.toggle('hidden', !sharing || paused);
    $('#btn-resume').classList.toggle('hidden', !paused);
    $('#btn-stop').classList.toggle('hidden', !sharing);
    $('#btn-end').classList.toggle('hidden', S.state === 'ended');
    $('#btn-share-screen').disabled = S.state === 'ended';
    $('#btn-share-camera').disabled = S.state === 'ended';
  }
  renderMic();
}

function renderMembers() {
  const list = $('#member-list');
  const rows = [];
  for (const m of S.members.values()) {
    const tags = [];
    if (m.role === 'host') tags.push('<span class="tag host">房主</span>');
    tags.push(m.mic ? '<span class="tag mic">开麦</span>' : '<span class="tag">闭麦</span>');
    if (m.muted) tags.push('<span class="tag muted">已禁言</span>');

    let actions = '';
    if (S.role === 'host' && m.role !== 'host' && m.id !== S.id) {
      actions = `<button data-act="mute" data-id="${esc(m.id)}">${m.muted ? '解除' : '禁言'}</button>
                 <button data-act="kick" data-id="${esc(m.id)}">移出</button>`;
    }
    rows.push(`<div class="member"><span class="nm">${esc(m.name)}${m.id === S.id ? '（你）' : ''}</span>${tags.join('')}${actions}</div>`);
  }
  list.innerHTML = rows.join('') || '<p class="hint">还没有人</p>';
  $('#member-count').textContent = String(S.members.size);
  $('#count-badge').textContent = `${[...S.members.values()].filter((m) => m.role === 'viewer').length}/${MAX_VIEWERS}`;
}

function renderMic() {
  const b = $('#btn-mic');
  if (!b) return;
  b.textContent = S.micOn ? '闭麦' : '开麦';
  b.classList.toggle('primary', !S.micOn);
}

function addSys(text) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function addChat(msg) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="who">${esc(msg.name)}${msg.role === 'host' ? ' · 房主' : ''}</span>${esc(msg.text)}`;
  log.appendChild(div);
  while (log.children.length > 300) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

const danmakuLanes = new Set();
function addDanmaku(name, text) {
  if (!S.danmakuOn) return;
  const layer = $('#danmaku-layer');
  const el = document.createElement('div');
  el.className = 'dm';
  el.innerHTML = `<span class="who">${esc(name)}</span>${esc(text)}`;
  const laneCount = 8;
  let lane = Math.floor(Math.random() * laneCount);
  for (let i = 0; i < laneCount; i++) {
    const l = (lane + i) % laneCount;
    if (!danmakuLanes.has(l)) { lane = l; break; }
  }
  danmakuLanes.add(lane);
  el.style.top = `${6 + lane * 11}%`;
  const dur = Math.min(14, 7 + el.textContent.length * 0.08);
  el.style.animationDuration = dur + 's';
  layer.appendChild(el);
  setTimeout(() => { danmakuLanes.delete(lane); el.remove(); }, dur * 1000 + 200);
}

/* ---------------- WebRTC mesh ---------------- */

function isHostPeer(id) {
  const m = S.members.get(id);
  return !!m && m.role === 'host';
}

function addPeer(id) {
  if (!id || id === S.id || S.peers.has(id)) return S.peers.get(id);
  const polite = S.id > id; // 小 id 为 impolite，负责发 offer
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  const peer = { id, pc, polite, makingOffer: false, ignoreOffer: false, answering: false, audioEl: null };
  S.peers.set(id, peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ t: 'signal', to: id, data: { description: pc.localDescription } });
    } catch (e) {
      console.warn('negotiation error', e);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ t: 'signal', to: id, data: { candidate } });
  };

  pc.ontrack = (ev) => {
    const track = ev.track;
    const stream = (ev.streams && ev.streams[0]) || new MediaStream([track]);
    attachRemote(peer, track, stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      toast('有一条连接失败，正在尝试重连（可能需要 TURN 服务器）');
      try { pc.restartIce(); } catch (_) {}
    }
  };

  // 双方都先放上本地轨道；没轨道的一方等对方 offer（perfect negotiation 处理碰撞）
  ensureLocalTracks(peer);
  return peer;
}

function ensureLocalTracks(peer) {
  const pc = peer.pc;
  const streams = [];
  if (S.capture) streams.push(S.capture);
  if (S.mic) streams.push(S.mic);
  for (const st of streams) {
    for (const tr of st.getTracks()) {
      if (pc.getSenders().some((s) => s.track === tr)) continue;
      try { pc.addTrack(tr, st); } catch (e) { console.warn(e); }
    }
  }
}

async function handleSignal(from, data) {
  if (!from) return;
  let peer = S.peers.get(from);
  if (!peer) {
    if (!S.members.has(from)) S.members.set(from, { id: from, name: '成员', role: 'viewer', mic: false, muted: false });
    peer = addPeer(from);
  }
  const pc = peer.pc;

  try {
    if (data.description) {
      const desc = data.description;
      const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.answering);
      const collision = desc.type === 'offer' && !ready;
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;

      if (collision) {
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      }
      peer.answering = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      peer.answering = false;

      if (desc.type === 'offer') {
        ensureLocalTracks(peer);
        await pc.setLocalDescription();
        send({ t: 'signal', to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) console.warn(e); }
    }
  } catch (e) {
    console.warn('signal error', e);
  }
}

function attachRemote(peer, track, stream) {
  const hostSide = isHostPeer(peer.id);
  if (track.kind === 'video' || (hostSide && track.kind === 'audio')) {
    if (!S.stageStream) S.stageStream = new MediaStream();
    if (!S.stageStream.getTracks().some((t) => t.id === track.id)) S.stageStream.addTrack(track);
    const v = $('#screen');
    if (v.srcObject !== S.stageStream) v.srcObject = S.stageStream;
    v.muted = S.role === 'host';
    const pl = v.play();
    if (pl && pl.catch) {
      pl.catch(() => {
        toast('点一下画面打开声音');
        $('#stage').addEventListener('click', () => {
          const p2 = v.play();
          if (p2 && p2.catch) p2.catch(() => {});
        }, { once: true });
      });
    }
    renderState();
  } else {
    let el = document.getElementById('au-' + peer.id);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'au-' + peer.id;
      el.autoplay = true;
      document.body.appendChild(el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    const pa = el.play();
    if (pa && pa.catch) pa.catch(() => {});
  }
}

function removePeer(id) {
  const peer = S.peers.get(id);
  if (!peer) return;
  try { peer.pc.close(); } catch (_) {}
  S.peers.delete(id);
  const el = document.getElementById('au-' + id);
  if (el) el.remove();
  if (S.peers.size === 0) {
    S.stageStream = null;
    const v = $('#screen');
    if (v) v.srcObject = null;
  }
  renderState();
}

function resetPeers() {
  for (const id of [...S.peers.keys()]) removePeer(id);
  S.members.clear();
  S.stageStream = null;
}

function closeAllPeers() {
  for (const id of [...S.peers.keys()]) removePeer(id);
}

/* ---------------- 房主：共享屏幕 / 共享摄像头 ---------------- */

function supportsScreenShare() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function attachCapture(stream, kind) {
  S.capture = stream;
  S.captureKind = kind;
  const v = $('#screen');
  v.muted = true;
  v.srcObject = stream;
  const pv = v.play();
  if (pv && pv.catch) pv.catch(() => {});

  for (const peer of S.peers.values()) ensureLocalTracks(peer);
  send({ t: 'state', state: 'live' });
  S.state = 'live';
  $('#stage-empty').classList.add('hidden');
  renderState();
  lanHint();
}

async function startScreenShare() {
  if (!supportsScreenShare()) {
    return toast('这台设备不支持共享屏幕（手机浏览器都不支持），用「共享摄像头」', 4000);
  }
  const ok = confirm(
    '隐私提醒：接下来会把整块屏幕/某个标签页分享给房间里的朋友。\n\n' +
    '通知、微信消息、验证码、弹窗都会被看到。\n' +
    '建议只共享某个标签页，并勾选「分享标签页音频」。\n\n继续？'
  );
  if (!ok) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    return toast('没有拿到屏幕授权：' + (e && e.name === 'NotAllowedError' ? '你取消了' : e.message), 3500);
  }

  const vt = stream.getVideoTracks()[0];
  if (vt) vt.onended = () => stopCapture(true);
  if (!stream.getAudioTracks().length) {
    toast('这次没有分享到系统声音，观众只能听到你开麦的声音', 4000);
  }
  attachCapture(stream, 'screen');
}

async function startCameraShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return toast('这个浏览器不支持摄像头', 4000);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: S.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const why = e && e.name === 'NotAllowedError' ? '摄像头权限被拒绝' : '打开摄像头失败：' + e.message;
    return toast(why, 4000);
  }
  attachCapture(stream, 'camera');
}

async function switchCamera() {
  if (S.captureKind !== 'camera' || !navigator.mediaDevices) return;
  S.facing = S.facing === 'environment' ? 'user' : 'environment';
  let next;
  try {
    next = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: S.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    S.facing = S.facing === 'environment' ? 'user' : 'environment';
    return toast('切换摄像头失败：' + e.message, 3000);
  }
  const nv = next.getVideoTracks()[0];
  const old = S.capture.getVideoTracks()[0];
  for (const peer of S.peers.values()) {
    peer.pc.getSenders().forEach((sender) => {
      if (sender.track === old && sender.replaceTrack) sender.replaceTrack(nv).catch(() => {});
    });
  }
  if (old) {
    S.capture.removeTrack(old);
    old.stop();
  }
  S.capture.addTrack(nv);
  $('#screen').srcObject = S.capture;
  toast(S.facing === 'environment' ? '已切到后置摄像头' : '已切到前置摄像头');
}

function pauseShare() {
  if (!S.capture) return;
  S.capture.getVideoTracks().forEach((t) => (t.enabled = false));
  S.capture.getAudioTracks().forEach((t) => (t.enabled = false));
  send({ t: 'state', state: 'paused' });
  S.state = 'paused';
  renderState();
}

function resumeShare() {
  if (!S.capture) return;
  S.capture.getVideoTracks().forEach((t) => (t.enabled = true));
  S.capture.getAudioTracks().forEach((t) => (t.enabled = true));
  send({ t: 'state', state: 'live' });
  S.state = 'live';
  renderState();
}

function stopCapture(fromTrackEnd) {
  if (!S.capture) return;
  const tracks = S.capture.getTracks();
  for (const peer of S.peers.values()) {
    peer.pc.getSenders().forEach((s) => {
      if (s.track && tracks.includes(s.track)) {
        try { peer.pc.removeTrack(s); } catch (_) {}
      }
    });
  }
  tracks.forEach((t) => t.stop());
  S.capture = null;
  S.captureKind = null;
  $('#screen').srcObject = null;
  $('#screen').muted = true;
  send({ t: 'state', state: 'waiting' });
  S.state = 'waiting';
  $('#stage-empty').textContent = '等待房主开始共享…';
  renderState();
  if (!fromTrackEnd) toast('已停止共享');
  lanHint();
}

/* ---------------- 麦克风 ---------------- */

async function toggleMic() {
  if (S.state === 'ended') return;
  if (!S.micOn) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('浏览器不支持麦克风');
    try {
      if (!S.mic) {
        S.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }
      S.mic.getAudioTracks().forEach((t) => (t.enabled = true));
      for (const peer of S.peers.values()) ensureLocalTracks(peer);
      S.micOn = true;
      send({ t: 'mic', on: true });
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? '麦克风权限被拒绝' : '打开麦克风失败：' + e.message, 3500);
    }
  } else {
    if (S.mic) S.mic.getAudioTracks().forEach((t) => (t.enabled = false));
    S.micOn = false;
    send({ t: 'mic', on: false });
  }
  renderMic();
}

/* ---------------- 事件绑定 ---------------- */

$('#btn-copy').addEventListener('click', async () => {
  const link = `${location.origin}/r/${S.code}${S.code ? '' : ''}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('邀请链接已复制：' + link, 3000);
  } catch (_) {
    prompt('复制这个链接发给朋友：', link);
  }
});

$('#btn-leave').addEventListener('click', () => {
  S.closedByMe = true;
  send({ t: 'leave' });
  try { S.ws && S.ws.close(); } catch (_) {}
  location.replace('/');
});

$('#btn-share-screen').addEventListener('click', startScreenShare);
$('#btn-share-camera').addEventListener('click', startCameraShare);
$('#btn-switch-cam').addEventListener('click', switchCamera);
$('#btn-pause').addEventListener('click', pauseShare);
$('#btn-resume').addEventListener('click', resumeShare);
$('#btn-stop').addEventListener('click', () => stopCapture(false));
$('#btn-end').addEventListener('click', () => {
  if (!confirm('结束房间？所有观众会被断开。')) return;
  send({ t: 'state', state: 'ended' });
  S.ended = true;
  S.closedByMe = true;
  toast('房间已结束');
  setTimeout(() => location.replace('/'), 1200);
});

$('#btn-mic').addEventListener('click', toggleMic);

$('#btn-danmaku').addEventListener('click', () => {
  S.danmakuOn = !S.danmakuOn;
  const b = $('#btn-danmaku');
  b.textContent = '弹幕 ' + (S.danmakuOn ? '开' : '关');
  b.classList.toggle('active', S.danmakuOn);
  $('#danmaku-layer').style.display = S.danmakuOn ? '' : 'none';
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-text');
  const text = input.value.trim();
  if (!text) return;
  send({ t: 'chat', text, kind: 'chat' });
  input.value = '';
});

$('#btn-dm-send').addEventListener('click', () => {
  const input = $('#chat-text');
  const text = input.value.trim();
  if (!text) return;
  if (!S.danmakuOn) toast('弹幕已关闭，先点「弹幕 开」');
  send({ t: 'chat', text, kind: 'danmaku' });
  input.value = '';
});

$('#member-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const m = S.members.get(id);
  if (!m) return;
  if (b.dataset.act === 'mute') send({ t: 'mute', to: id, on: !m.muted });
  if (b.dataset.act === 'kick') {
    if (confirm(`把 ${m.name} 移出房间？`)) send({ t: 'kick', to: id });
  }
});

document.querySelectorAll('.side-tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    const pane = b.dataset.pane;
    document.querySelectorAll('.side-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.pane === pane));
    $('#pane-chat').classList.toggle('hidden', pane !== 'chat');
    $('#pane-members').classList.toggle('hidden', pane !== 'members');
  });
});

window.addEventListener('beforeunload', () => {
  S.closedByMe = true;
  send({ t: 'leave' });
});

/* ---------------- 启动 ---------------- */

(async function boot_() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.iceServers && cfg.iceServers.length) S.iceServers = cfg.iceServers;
    }
  } catch (_) {}
  $('#room-code').textContent = S.code || '------';
  $('#watermark').textContent = S.name;
  renderState();
  connect();
})();

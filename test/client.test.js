'use strict';
/* 浏览器端冒烟测试：用 jsdom 跑真实页面 + 真实 WebSocket，WebRTC/媒体接口用假实现 */
const { JSDOM, VirtualConsole } = require('jsdom');
const { startServer } = require('./_server');

const PORT = Number(process.env.TEST_PORT || 8099);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 4000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(50);
  }
  throw new Error('超时: ' + label);
}

class FakeTrack {
  constructor(kind) { this.kind = kind; this.id = kind + '-' + Math.random().toString(36).slice(2); this.enabled = true; this.stopped = false; }
  stop() { this.stopped = true; }
  addEventListener() {}
  dispatchEvent() { return true; }
}
class FakeStream {
  constructor(tracks) { this._t = tracks || []; }
  getTracks() { return this._t; }
  getVideoTracks() { return this._t.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this._t.filter((t) => t.kind === 'audio'); }
  addTrack(t) { this._t.push(t); }
  removeTrack(t) { this._t = this._t.filter((x) => x !== t); }
}

class FakePC {
  constructor() {
    this.senders = [];
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }
  addTrack(track, stream) { this.senders.push({ track, stream }); this._fire(); }
  removeTrack(sender) { this.senders = this.senders.filter((s) => s !== sender); this._fire(); }
  getSenders() { return this.senders.map((s) => ({ track: s.track })); }
  _fire() { if (this.onnegotiationneeded) setTimeout(() => this.onnegotiationneeded && this.onnegotiationneeded(), 0); }
  async setLocalDescription(desc) {
    const d = desc || (this.signalingState === 'have-remote-offer'
      ? { type: 'answer', sdp: 'v=0 fake-answer' }
      : { type: 'offer', sdp: 'v=0 fake-offer' });
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() { return true; }
  restartIce() {}
  close() { this.connectionState = 'closed'; }
}

function makeWindow(html, url, session, opts = {}) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!String(e.message).includes('Not implemented')) console.log('  [jsdom]', e.message); });
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.RTCPeerConnection = FakePC;
      window.confirm = () => true;
      window.fetch = (u, o) => fetch(new URL(u, BASE), o);
      Object.defineProperty(window, 'isSecureContext', { value: true });
      const md = {
        async getUserMedia(c) {
          const wantVideo = !!(c && c.video);
          return new FakeStream(wantVideo ? [new FakeTrack('video'), new FakeTrack('audio')] : [new FakeTrack('audio')]);
        },
      };
      if (!opts.mobile) {
        md.getDisplayMedia = async () => new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
      }
      Object.defineProperty(window.navigator, 'mediaDevices', { value: md });
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
      window.sessionStorage.setItem(session.key, JSON.stringify(session.value));
    },
  });
  return dom;
}

(async () => {
  const { child: srv } = await startServer(PORT);

  try {
    console.log('\n[1] 房主页');
    const hostHtml = await (await fetch(BASE + '/room.html?host=1')).text();
    const hostDom = makeWindow(hostHtml, BASE + '/room.html?host=1', { key: 'wr.create', value: { name: '房主甲', pass: '' } });
    const H = hostDom.window;

    await waitFor(() => /^[A-Z0-9]{8}$/.test(H.document.querySelector('#room-code').textContent), 5000, '房主拿到房间码');
    const code = H.document.querySelector('#room-code').textContent;
    ok(true, '房主建房成功: ' + code);
    ok(!H.document.querySelector('#host-controls').classList.contains('hidden'), '房主看到房主控件');
    ok(H.document.querySelector('#state-badge').textContent === '等待中', '初始状态=等待中', H.document.querySelector('#state-badge').textContent);

    H.document.querySelector('#btn-share-screen').click();
    await waitFor(() => H.document.querySelector('#state-badge').textContent === '共享中', 4000, '切到共享中');
    ok(true, '开始共享后状态=共享中');
    ok(!H.document.querySelector('#btn-pause').classList.contains('hidden'), '出现暂停按钮');
    ok(H.document.querySelector('#stage-empty').classList.contains('hidden'), '房主预览不被蒙层挡住');

    console.log('\n[2] 观众加入');
    const viewerHtml = await (await fetch(BASE + '/room.html')).text();
    const viewerDom = makeWindow(viewerHtml, BASE + '/r/' + code, { key: 'wr.join', value: { code, name: '观众A', pass: '' } });
    const V = viewerDom.window;
    await waitFor(() => V.document.querySelector('#member-count').textContent === '2', 5000, '观众进房');
    ok(true, '观众加入，成员数=2');
    ok(V.document.querySelector('#host-controls').classList.contains('hidden'), '观众看不到房主控件');
    ok(V.document.querySelector('#state-badge').textContent === '共享中', '观众看到共享中状态');

    await waitFor(() => H.document.querySelector('#member-count').textContent === '2', 4000, '房主看到 2 人');
    ok(true, '房主成员列表更新为 2 人');
    ok(H.document.querySelector('#chat-log').textContent.includes('观众A 加入了房间'), '房主收到加入提示');

    console.log('\n[3] 聊天与弹幕');
    const vInput = V.document.querySelector('#chat-text');
    vInput.value = '这片好看';
    V.document.querySelector('#chat-form').dispatchEvent(new V.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => V.document.querySelector('#chat-log').textContent.includes('这片好看'), 3000, '自己看到自己的消息');
    await waitFor(() => H.document.querySelector('#chat-log').textContent.includes('这片好看'), 3000, '房主收到消息');
    ok(true, '聊天双向到达');

    vInput.value = '飘一条';
    V.document.querySelector('#btn-dm-send').click();
    await waitFor(() => H.document.querySelector('#danmaku-layer').children.length > 0, 3000, '弹幕出现');
    ok(true, '弹幕显示在画面上');
    ok(H.document.querySelector('#chat-log').textContent.includes('飘一条'), '弹幕同时留在聊天记录里（可回看）');

    console.log('\n[4] 麦克风与禁言');
    V.document.querySelector('#btn-mic').click();
    await waitFor(() => V.document.querySelector('#btn-mic').textContent === '闭麦', 3000, '开麦');
    ok(true, '观众开麦成功');
    await waitFor(() => {
      const rows = H.document.querySelectorAll('#member-list .member');
      return [...rows].some((r) => r.textContent.includes('观众A') && r.textContent.includes('开麦'));
    }, 3000, '房主看到开麦状态');
    ok(true, '房主看到观众开麦');

    const muteBtn = [...H.document.querySelectorAll('#member-list button[data-act="mute"]')][0];
    ok(!!muteBtn, '房主有禁言按钮');
    muteBtn.click();
    await waitFor(() => V.document.querySelector('#btn-mic').textContent === '开麦', 3000, '被禁言自动闭麦');
    ok(true, '被禁言后自动闭麦');
    ok(V.document.querySelector('#member-list').textContent.includes('已禁言') || H.document.querySelector('#member-list').textContent.includes('已禁言'), '禁言状态可见');

    console.log('\n[5] 暂停 / 恢复 / 停止');
    H.document.querySelector('#btn-pause').click();
    await waitFor(() => V.document.querySelector('#state-badge').textContent === '已暂停', 3000, '观众看到已暂停');
    ok(true, '暂停同步到观众');
    H.document.querySelector('#btn-resume').click();
    await waitFor(() => V.document.querySelector('#state-badge').textContent === '共享中', 3000, '观众看到恢复');
    ok(true, '恢复同步到观众');
    H.document.querySelector('#btn-stop').click();
    await waitFor(() => V.document.querySelector('#state-badge').textContent === '等待中', 3000, '观众看到等待中');
    ok(true, '停止共享同步到观众');

    console.log('\n[6] 手机房主：摄像头模式');
    const phoneDom = makeWindow(hostHtml, BASE + '/room.html?host=1', { key: 'wr.create', value: { name: '手机房主', pass: '' } }, { mobile: true });
    const P = phoneDom.window;
    await waitFor(() => P.document.querySelectorAll('#room-code')[0].textContent.length === 8, 5000, '手机房主建房');
    const phoneCode = P.document.querySelector('#room-code').textContent;
    ok(true, '手机房主建房: ' + phoneCode);
    ok(P.document.querySelector('#btn-share-screen').classList.contains('hidden'), '手机上看不到「共享屏幕」');
    ok(P.document.querySelector('#btn-share-camera').classList.contains('hidden') === false, '手机上有「共享摄像头」');
    P.document.querySelector('#btn-share-camera').click();
    await waitFor(() => P.document.querySelector('#state-badge').textContent === '共享中', 4000, '摄像头共享开始');
    ok(true, '摄像头共享进入直播状态');
    ok(!P.document.querySelector('#btn-switch-cam').classList.contains('hidden'), '摄像头模式下有切换镜头');

    const v2Dom = makeWindow(viewerHtml, BASE + '/r/' + phoneCode, { key: 'wr.join', value: { code: phoneCode, name: '手机观众', pass: '' } });
    const V2 = v2Dom.window;
    await waitFor(() => V2.document.querySelector('#state-badge').textContent === '共享中', 5000, '观众看到摄像头直播');
    ok(true, '观众用链接进来能看到手机摄像头的直播');
    V2.document.querySelector('#btn-mic').click();
    await waitFor(() => V2.document.querySelector('#btn-mic').textContent === '闭麦', 3000, '手机观众开麦');
    ok(true, '手机观众能开麦');
    v2Dom.window.close();

    console.log('\n[7] 移出成员 / 结束房间');
    const kickBtn = [...H.document.querySelectorAll('#member-list button[data-act="kick"]')][0];
    ok(!!kickBtn, '房主有移出按钮');
    kickBtn.click();
    await waitFor(() => V.document.querySelector('#stage-toast').textContent.includes('移出'), 3000, '被移出提示');
    ok(true, '移出后观众收到提示');

    hostDom.window.close();
    viewerDom.window.close();
  } finally {
    srv.kill('SIGKILL');
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e.message); process.exit(1); });

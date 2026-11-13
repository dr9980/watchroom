'use strict';
const $ = (s) => document.querySelector(s);

const store = {
  get name() { return localStorage.getItem('wr.name') || ''; },
  set name(v) { localStorage.setItem('wr.name', v); },
};

function parseRoomInput(v) {
  const raw = String(v || '').trim();
  let m = raw.match(/[?&]r=([A-Za-z0-9]+)/);
  if (m) return m[1].toUpperCase();
  m = raw.match(/\/r\/([A-Za-z0-9]+)/);
  if (m) return m[1].toUpperCase();
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function goJoin(code, name, pass) {
  sessionStorage.setItem('wr.join', JSON.stringify({ code, name, pass }));
  location.href = '/r/' + encodeURIComponent(code);
}

/* 预填 */
const urlCode = parseRoomInput(new URLSearchParams(location.search).get('r') || '');
if (urlCode) $('#join-code').value = urlCode;
$('#join-name').value = store.name;
$('#create-name').value = store.name;

if (!window.isSecureContext) {
  $('#secure-hint').textContent = '当前不是 HTTPS / localhost：可以观看和聊天，但开麦、共享屏幕会被浏览器拦截。';
}

/* tab 切换 */
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    $('#join-panel').classList.toggle('hidden', tab !== 'join');
    $('#create-panel').classList.toggle('hidden', tab !== 'create');
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  });
});
if (!$('#join-code').value && location.hash === '#create') {
  document.querySelector('.tabs button[data-tab="create"]').click();
}

/* 加入 */
$('#btn-join').addEventListener('click', () => {
  const code = parseRoomInput($('#join-code').value);
  const name = $('#join-name').value.trim();
  const pass = $('#join-pass').value;
  if (!code) return ($('#join-err').textContent = '请输入房间码或邀请链接');
  if (!name) return ($('#join-err').textContent = '请输入昵称');
  store.name = name;
  goJoin(code, name, pass);
});
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

/* 创建 */
$('#btn-create').addEventListener('click', () => {
  const name = $('#create-name').value.trim();
  const pass = $('#create-pass').value;
  if (!name) return ($('#create-err').textContent = '请输入昵称');
  store.name = name;
  // 房间由 room.js 通过 WS 创建，先把意图存到 sessionStorage
  sessionStorage.setItem('wr.create', JSON.stringify({ name, pass }));
  sessionStorage.removeItem('wr.join');
  location.href = '/room.html?host=1';
});

[![ci](https://github.com/dr9980/watchroom/actions/workflows/ci.yml/badge.svg)](https://github.com/dr9980/watchroom/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Tests](https://img.shields.io/badge/tests-67%20passing-brightgreen)

# 私人观影房 · 网页版

把正在播的内容实时分享给朋友：**房主用浏览器开房，朋友点链接就能在网页里看**，还能开麦聊天、发文字评论和弹幕。

- 电脑当房主 → **共享屏幕**（标签页/窗口/整屏 + 系统声音）
- 手机当房主 → **共享摄像头 + 麦克风**（手机浏览器不支持采屏，这是系统限制）
- 观众 → 手机/电脑浏览器打开链接就行，不用装 App

对应产品需求文档里的 MVP，房主端从安卓原生 App 换成了浏览器。

## 1. 能做什么

| 需求 | 实现 |
| --- | --- |
| 创建房间、邀请链接 | 8 位高熵房间码（`ABCDEFGHJKM…`，排除易混字符）+ `/r/CODE` |
| 两种共享模式 | 电脑「共享屏幕」`getDisplayMedia`；手机「共享摄像头」`getUserMedia`，可切换前后镜头 |
| 房间密码 | 可选，服务端 scrypt 加盐校验 |
| 人数上限 | 房主 1 + 观众 10，第 11 人被拒 |
| 暂停 / 恢复 / 停止 | 房主一键控制，观众端同步提示 + 蒙层 |
| 语音 | 每人可开麦/闭麦，mesh 音频互通，默认闭麦防啸叫 |
| 禁言 / 移出 | 房主在成员列表操作，被禁言者强制闭麦 |
| 文字聊天 | WebSocket 广播，200 字截断，3 秒 10 条限流 |
| 弹幕 | 叠加画面，可开关，8 条轨道 |
| 隐私提示 | 共享屏幕前强提示；画面右下角房间码 + 昵称水印 |
| 断线重连 | 观众自动重连 6 次；房主断了提示刷新重开 |

非目标（和需求文档一致）：iOS 原生、公开房间、录制回放、绕过 DRM、多人同时共享。

## 2. 快速开始

```bash
cd watchroom
npm install
./start.sh          # 或 npm start；start.sh 会顺手生成自签证书
```

浏览器打开 `http://localhost:8080` → 「我要开房」→ 进房后点 **共享屏幕** 或 **共享摄像头**。

## 3. 手机当房主（共享摄像头）

1. 手机和电脑连同一个 Wi-Fi（或服务部署在公网，见第 6 节）
2. 手机浏览器打开 `https://<电脑IP>:8443`，证书警告点「高级 → 继续前往」
3. 「我要开房」→ 填昵称 → 进房点 **共享摄像头**
4. 点「复制邀请链接」发给朋友；朋友用手机/电脑打开链接即可观看、开麦、发弹幕

**为什么手机不能共享屏幕**：Android/iOS 的 Chrome/Safari/微信浏览器都没实现 `getDisplayMedia`（这是浏览器安全限制，不是本项目的问题）。要在手机上共享真·屏幕，只能写安卓原生 App（`MediaProjection`），本项目不做。

## 4. 局域网 HTTPS

浏览器只在 **HTTPS 或 localhost** 下给屏幕/摄像头/麦克风权限，局域网必须自签证书：

```bash
./gen-cert.sh      # 自动把本机 IPv4 写进证书 SAN
npm start
```

首次访问点 **高级 → 继续前往**（自签证书，别用于正式公网）。

## 5. 观众加入

打开 `https://<房主地址>/r/CODE`，或用首页输入房间码：

1. 昵称必填，有密码就填密码
2. 进房后：右侧「聊天」发评论，输入框旁边「弹幕」发弹幕，底部「开麦」说话
3. 手机竖屏会自动上下分栏（上面画面，下面聊天）

观众自己也用链接，最多 10 个。

## 6. 让别人从外网打开链接

三选一：

1. **部署到云服务器**（最稳）：`docker compose up -d --build`，前面挂 Caddy/Nginx 配正式 HTTPS
2. **临时隧道**（最快，任何设备都能当服务器，包括这台手机）：
   ```bash
   ./tunnel.sh        # 需要 cloudflared，给你一个 https://xxx.trycloudflare.com
   ```
   然后把这个 https 地址发人；手机开摄像头当房主也能这么用
3. 同一 Wi-Fi：直接用 `https://<局域网IP>:8443`

⚠️ 跨运营商/4G 时 P2P 大概 20–40% 需要 TURN 才能连通（现象：进房了但黑屏）。本项目默认挂了一个公开免费 TURN（`openrelay.metered.ca`）救急；正式用请自建 coturn：

```bash
docker run -d --network=host coturn/coturn -n --lt-cred-mech \
  --user=wr:YOURPASS --realm=example.com --external-ip=<公网IP>
TURN_URL=turn:<公网IP>:3478 TURN_USER=wr TURN_PASS=YOURPASS npm start
# 不想用公开 TURN：NO_PUBLIC_TURN=1 npm start
```

## 7. 目录结构

```
watchroom/
├── server.js              # HTTP/HTTPS + WebSocket 信令 + 房间管理
├── public/
│   ├── index.html|js      # 建房 / 加入
│   ├── room.html|js|css   # 房间页（WebRTC mesh、聊天、弹幕）
│   └── style.css
├── test/
│   ├── signaling.test.js  # 36 项：房间规则与信令
│   └── client.test.js     # 31 项：jsdom 浏览器端冒烟
├── start.sh / start.bat   # 一键启动
├── gen-cert.sh            # 自签证书
├── tunnel.sh              # Cloudflare 临时公网
├── Dockerfile / docker-compose.yml
└── .github/workflows/ci.yml
```

## 8. 架构

```
浏览器房主 ──WebRTC(屏幕或摄像头+声音)──┐
   │                                   ├─ 观众浏览器 ×10
   └── WebSocket 信令 ── Node 服务 ─────┘
```

- `server.js`：静态托管 + 信令 + 房间状态（内存，无数据库）
- `public/index.html|js`：建房 / 加入
- `public/room.html|js|css`：房间页，WebRTC mesh、perfect negotiation、聊天、弹幕
- 媒体是 **P2P mesh**：房主上行 = 观众数 × 码率。720p 约 1.5–3 Mbps/人，**手机 4G 当房主建议 3–5 人以内**；同 Wi-Fi 可到 10 人

## 9. 测试

```bash
npm test
# 1) test/signaling.test.js — 36 项：静态资源/建房/密码/人数上限/聊天/弹幕/信令/禁言/移出/结束
# 2) test/client.test.js    — 31 项：jsdom 跑真实页面 + 真实 WebSocket，验证电脑共享屏幕、手机共享摄像头、加入、聊天、弹幕、开麦、禁言、暂停、停止、移出
```

jsdom 里 WebRTC/摄像头是假实现，真机浏览器仍要手动点一遍。

## 10. 已知限制

1. 上行带宽是 mesh 的硬上限：手机 4G 当房主别超过 3–5 人
2. 电脑共享「整个屏幕」会暴露通知、微信消息、验证码——所以才保留强提示和水印
3. DRM 内容共享出来是黑屏/静音，无解，不绕过
4. 房间在内存里，服务重启即清空（单实例）
5. 观众自动重连后重新建连，短暂黑屏正常
6. 手机无法共享屏幕（浏览器限制），只能共享摄像头

---

仅供私有小范围使用。**只分享自有、授权或无版权内容**，不要公开转播受版权保护的影视。

# Slice Remote Screen P2P 连接调研

版本：0.1  
日期：2026-09-01  
范围：macOS Host 与手机 Web/PWA 之间的公网实时画面和控制连接

## 1. 结论

你的理解基本对，但“通过服务器建立连接”不能理解成“画面先传到服务器，再由服务器转发”。正确方案是：

1. 两端先通过信令服务器发现对方并交换 WebRTC SDP、ICE candidate；
2. ICE 使用本机地址、STUN 得到的公网映射地址和 TURN 中继地址寻找可用路径；
3. 能直连就让视频和控制数据直接在 Mac 与手机之间传输；
4. 直连失败才走 TURN，中继的是端到端加密后的数据。

IETF 对 WebRTC 的描述明确区分了两条路径：信令经过服务器，媒体尽量在两端之间直接传输；具体信令协议不属于 WebRTC 标准，由产品自己定义。[RFC 8825](https://www.rfc-editor.org/rfc/rfc8825.html#section-3.2) [WebRTC 官方入门](https://webrtc.org/getting-started/peer-connections)

因此我们实际需要的不是“一台万能服务器”，而是三项逻辑能力：

| 能力 | 是否必需 | 是否承载画面 | 职责 |
|---|---:|---:|---|
| Signaling / Rendezvous | 必需 | 否 | 设备在线、会话授权、交换 offer/answer 和 ICE candidate |
| STUN | 公网基本必需 | 否 | 帮端点发现 NAT 映射后的公网地址，供 ICE 尝试直连 |
| TURN | 正式产品必需 | 仅直连失败时 | 中继加密后的 WebRTC 数据 |

只做 STUN、不做 TURN 的方案是半成品。家庭网络可能能用，遇到公司防火墙、运营商 CGNAT、对称 NAT 或禁 UDP 网络就会随机失败。TURN 标准本身也明确指出：ICE 应先尝试直连，找不到直连路径时才使用高成本中继。[RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html#section-2) [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html#section-2.1)

对本项目的推荐是：

- 传输：WebRTC；
- Mac：原生 libwebrtc，直接接收 ScreenCaptureKit 的 `CVPixelBuffer`；
- 手机：浏览器原生 `RTCPeerConnection`；
- 信令：TypeScript + HTTPS/WSS，自定义最小协议；
- STUN/TURN：coturn，生产环境同时提供 UDP 和 TLS/TCP 入口；
- 控制：WebRTC DataChannel；
- 产品表述：**优先 P2P 直连，失败时端到端加密中继**，不要虚假宣传“任何时候都纯 P2P”。

## 2. 为什么两个设备不能直接互连

现实网络里，两端通常都没有可被公网主动访问的固定地址：

- 家庭路由器和公司网使用 NAT；
- 蜂窝网络常使用运营商级 NAT；
- 防火墙会拒绝没有状态的入站包；
- IP、端口和网络会在 Wi-Fi/蜂窝切换时变化；
- 某些网络彻底禁用 UDP，只放行 443/TCP。

Mac 和手机因此必须先交换“我可能从这些地址到达”的候选地址，再对候选地址组合做连通性检查。ICE 就是负责候选收集、排序、检查和选路的机制；它使用 STUN，并把 TURN 作为兜底。[RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html)

### 2.1 三类关键 ICE candidate

| Candidate | 来源 | 含义 |
|---|---|---|
| `host` | 本机网卡 | 同一局域网或可直接路由时使用 |
| `srflx` | STUN | NAT 映射后的公网 IP/端口，可用于打洞直连 |
| `relay` | TURN | TURN 服务器分配的中继地址 |

实际选中的 candidate pair 决定会话是局域网直连、公网打洞直连还是 TURN 中继。不能靠“请求了 TURN 凭证”判断是否正在中继，必须从 WebRTC stats 里的 selected candidate pair 和 candidate type 判断。[W3C WebRTC](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-getstats) [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/#dom-rtctransportstats-selectedcandidatepairid)

## 3. 推荐架构

```text
                         ┌────────────────────────┐
                         │ Signaling API / WSS    │
                         │ 设备、在线、授权、信令 │
                         └───────▲────────▲───────┘
                                 │        │
                           HTTPS/WSS    HTTPS/WSS
                                 │        │
┌──────────────────┐             │        │             ┌──────────────────┐
│ macOS Host       │─────────────┘        └─────────────│ 手机 Web/PWA     │
│ ScreenCaptureKit │                                      │ RTCPeerConnection│
│ libwebrtc        │◄════════ WebRTC 直连 ══════════════►│ video + data     │
└────────┬─────────┘                                      └────────┬─────────┘
         │                                                         │
         └────────── WebRTC 加密流 ──► TURN ◄── WebRTC 加密流 ─────┘
                                  仅直连失败时
```

### 3.1 控制面与数据面

控制面经过我们的服务器：

- 登录、设备列表与在线状态；
- 一次性配对和设备撤销；
- 会话创建和权限检查；
- SDP offer/answer；
- Trickle ICE candidate；
- 短期 TURN 凭证签发；
- 只含元数据的审计记录。

数据面走 WebRTC：

- H.264 主视频；
- 鼠标、键盘、手势和 Action；
- 窗口、权限和 Profile 状态；
- 心跳、延迟测量和会话关闭。

服务器不应接收解码后的画面，不应执行输入动作，也不应持有设备私钥。否则这就不是“撮合服务”，而是高风险的远控中枢。

### 3.2 连接时序

```text
手机                  信令服务器                   Mac Host
 │  登录、选择设备          │                          │
 │ ───────────────────────► │                          │
 │  创建会话                │ ───── session.request ─► │
 │                          │ ◄──── SDP offer + 签名 ─ │
 │ ◄──── SDP offer + 签名 ─ │                          │
 │  验签，生成 SDP answer   │                          │
 │ ─── SDP answer + 签名 ─► │ ───────────────────────► │
 │ ◄───── trickle ICE candidates 双向交换 ───────────► │
 │                                                     │
 │ ◄════════ ICE 检查并选出 direct / relay 路径 ═════► │
 │ ◄════ DTLS-SRTP 视频 + DTLS DataChannel 加密流 ═══► │
```

使用 Trickle ICE，候选一产生就发送，不要等全部候选收集完再开始协商，否则白白增加首连延迟。[WebRTC 官方入门](https://webrtc.org/getting-started/peer-connections#trickle-ice)

### 3.3 信令协议建议

信令走一条经过鉴权的 WSS。V1 只允许手机发起、单用户、单控制端，先避免双向同时 offer 的 glare 问题。

建议消息：

```text
device.online
device.offline
session.request
session.accept
session.reject
signal.offer
signal.answer
signal.ice-candidate
signal.ice-restart
session.close
```

每条消息至少带：

```json
{
  "protocolVersion": 1,
  "messageId": "uuid",
  "sessionId": "uuid",
  "fromDeviceId": "device-id",
  "toDeviceId": "device-id",
  "sequence": 42,
  "expiresAt": 1788192060000,
  "type": "signal.offer",
  "body": {}
}
```

服务器必须检查会话归属、设备授权、消息大小、过期时间和速率。SDP 与 ICE candidate 不写普通应用日志。

## 4. TURN 不是可选优化

STUN 只帮助发现地址和尝试直连，不能保证穿透。TURN 让双方都主动连向公网服务器，由服务器转发数据，所以成功率高，但代价也真实存在：

- 多一段网络路径，延迟和抖动通常更高；
- TURN 服务器承受持续带宽，而信令服务器只承受少量消息；
- 中继区域离用户太远会直接拖垮远控手感；
- 服务端需要防盗用、限额、监控和抗滥用。

TURN 支持客户端到服务器之间使用 UDP、TCP、TLS-over-TCP 或 DTLS-over-UDP；支持 TCP/TLS 的一个重要原因就是部分防火墙会完全阻断 UDP。[RFC 8656 3.1](https://www.rfc-editor.org/rfc/rfc8656.html#section-3.1)

### 4.1 部署入口

生产建议至少提供：

| 服务 | 推荐入口 | 用途 |
|---|---|---|
| Signaling | `wss://api.example.com:443` | 所有设备主动建立长连接 |
| STUN/TURN UDP | `turn.example.com:3478/udp` | 首选，延迟最低 |
| TURN TLS | `turns.example.com:443/tcp` | UDP 被封时兜底 |
| TURN relay ports | 一段受控 UDP 端口范围 | coturn 分配 relay address |

想同时让 HTTPS/WSS 和 TURN TLS 都占 443，最好给 TURN 独立公网 IP。硬在同一个 IP 上做协议分流能做，但会把部署和排障搞复杂，V1 没必要犯蠢。

### 4.2 凭证

绝不能把 coturn 静态用户名密码写进 PWA。浏览器代码对用户完全可见，固定凭证等于公开中继服务器。

推荐使用 coturn 的 time-limited credential 方案：

1. 已认证设备向 Signaling API 请求 TURN 配置；
2. API 使用服务端共享密钥生成短期用户名和 HMAC 密码；
3. 凭证绑定用户/设备，5—10 分钟内只用于创建新会话；
4. coturn 配置用户并发、总并发和带宽上限；
5. 记录 allocation 数量和字节数，不记录媒体内容。

coturn 官方文档明确说明 WebRTC 客户端应从 Web 服务器取得短期凭证，并给出了基于时间戳和 HMAC 的生成方式。[coturn TURN REST API](https://github.com/coturn/coturn/blob/master/README.turnserver#L3288-L3373)

浏览器最终拿到的配置大致如下，用户名和密码必须由 API 动态返回：

```ts
const peer = new RTCPeerConnection({
  iceServers: [
    { urls: ["stun:turn.example.com:3478"] },
    {
      urls: [
        "turn:turn.example.com:3478?transport=udp",
        "turns:turns.example.com:443?transport=tcp",
      ],
      username: temporaryUsername,
      credential: temporaryCredential,
    },
  ],
});
```

### 4.3 带宽成本

不要把 TURN 当“小流量兜底”后就不算账。以单路 4 Mbit/s 视频为例：

```text
单向媒体载荷 ≈ 4 × 3600 ÷ 8 = 1.8 GB/小时
TURN 网卡聚合流量 ≈ 一进一出 = 3.6 GB/小时
```

这还没算 RTP、DTLS、TURN 和重传开销。8 Mbit/s 时数字再翻倍。云厂商通常主要按公网出站计费，但容量规划要按 TURN 同时处理的入站与出站吞吐来算。直连率不是面子指标，它直接决定毛利。

## 5. 安全边界

WebRTC 强制媒体使用 SRTP、数据通道使用 DTLS，因此 TURN 看到的是加密包，不能直接读取画面和输入内容。[RFC 8827 6.5](https://www.rfc-editor.org/rfc/rfc8827.html#section-6.5)

但“WebRTC 自带加密”不等于整个产品已经安全：

- 信令服务器仍能看到设备关系、SDP、候选地址、时间和流量元数据；
- 如果没有设备身份绑定，恶意或被攻陷的信令服务可以替换 SDP/DTLS fingerprint，尝试中间人攻击；
- TURN 能看到通信双方 IP、包大小、流量和时序；
- 已配对设备被盗后仍可合法发起控制；
- 远控输入本身就是高权限能力，重放和乱序会造成误操作。

推荐方案：

1. Mac 首次启动生成设备签名密钥，私钥存 Keychain；V1 优先选浏览器 Web Crypto 与 Apple CryptoKit 都成熟支持的 P-256 ECDSA，是否改用 Ed25519 先做兼容测试；
2. 手机配对时生成自己的设备密钥并交换公钥；
3. SDP 信令包签署 `sessionId + peerIds + nonce + expiresAt + SHA-256(sdp)`；
4. 双方验签并确认 SDP 中 DTLS fingerprint 未被替换；
5. DataChannel 打开后再完成一次绑定当前 session 的挑战响应；
6. 验证完成前，Mac 不启动画面采集、不接受任何输入；
7. 点击、键盘和 Action 使用可靠有序通道，并带 sequence/messageId 去重；
8. 断线或 ICE 状态异常时立即暂停输入，不缓存点击等网络恢复后补发；
9. Mac 菜单栏显示活跃控制会话，并提供立即断开和撤销设备。

直接“签整个 SDP 字符串”容易被序列化差异坑死，所以签 SDP 的哈希和固定字段，不要自己发明脆弱的文本规范化算法。

## 6. 与当前仓库的差距

当前链路是：

```text
ScreenCaptureKit
  → Swift CLI 将每帧编码成 JPEG
  → stdout length-prefix
  → Node local-host
  → WebSocket
  → 浏览器 createImageBitmap + Canvas
```

对应代码：

- `apps/mac-host/Sources/SliceMacHost/StreamService.swift`：逐帧 JPEG；
- `apps/local-host/src/server.ts`：启动 Swift 子进程并转发 WebSocket；
- `apps/mobile-web/src/api.ts`：连接 `/api/stream`；
- `apps/mobile-web/src/components/use-remote-stream.ts`：逐帧解码到 Canvas。

这个结构适合证明局域网闭环，不适合正式 WebRTC：

- Host 是按命令启动的短命 CLI，不是维护设备身份、WSS 和 PeerConnection 的常驻进程；
- JPEG 每帧独立压缩，没有视频时域压缩，带宽和功耗都烂；
- 帧从 Swift 复制到 Node 再发出，Node 成了无意义的数据搬运层；
- WebSocket 没有 WebRTC 的拥塞控制、码率自适应、NAT 穿透和 ICE 重连；
- 当前 URL token + HTTP 只够可信局域网测试，不能平移到公网。

正确改造不是在 Node 的 `/api/stream` 外面再套一层 P2P，而是：

```text
SCStream CVPixelBuffer
  → Mac 常驻 Host 内的 libwebrtc video source
  → H.264 / VideoToolbox
  → WebRTC PeerConnection
  → 浏览器 <video>
```

Node `local-host` 可以暂时保留为本地配置页和开发调试入口，但不再经过视频数据面。长期应由正式 Mac App 自己管理生命周期、配对、信令和 PeerConnection。

Google WebRTC 源码目前包含 macOS framework target、ObjC PeerConnection API 和 VideoToolbox H.264 编解码实现，但官方 native code 的构建链很重，API 和二进制分发也不如浏览器 API 稳定。必须先做集成 spike，再锁定 WebRTC commit/release 和可复现的 `WebRTC.xcframework` 构建；不能随手依赖一个来路不明、长期不更新的预编译包。[WebRTC macOS build target](https://webrtc.googlesource.com/src/+/main/sdk/BUILD.gn) [WebRTC native development](https://webrtc.googlesource.com/src/+/main/docs/native-code/development/)

## 7. DataChannel 设计

V1 建议只建两条通道：

| 通道 | 配置 | 内容 |
|---|---|---|
| `control` | ordered + reliable | 会话鉴权、点击、键盘、拖拽边界、Action、状态 |
| `pointer` | unordered + `maxRetransmits: 0` | 只传可丢弃的 hover/pointer move |

不要把点击或键盘放进不可靠通道；丢一次可能产生不可恢复的错误状态。也不要同时在两条通道拆一个拖拽手势，因为跨通道没有全局顺序保证。WebRTC DataChannel 基于 SCTP，可分别配置有序/无序和可靠/不可靠传输。[RFC 8831 6.4](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.4)

V1 的缩略图先别塞 DataChannel。单路主视频先跑稳；后续需要多 Slice 缩略图时，再单独评估低优先级通道、HTTP 拉取或视频合成，避免大图片阻塞控制消息。

## 8. 失败恢复

必须区分三类故障：

| 故障 | 处理 |
|---|---|
| 信令 WSS 断开，WebRTC 仍连通 | 当前会话继续；后台重连信令，不影响数据面 |
| ICE `disconnected/failed` | 立即暂停输入，短暂等待后执行 ICE restart |
| PeerConnection/DTLS 失败 | 关闭旧会话，重新鉴权并建立新 PeerConnection |

Wi-Fi 与蜂窝切换、Mac 唤醒和路由器重映射都可能触发 ICE restart。恢复期间不允许把点击和按键排队后一次性补发，那会把远端机器点烂。

## 9. 可观测性与验收

通过 `getStats()` 和 Native WebRTC stats 记录：

- selected candidate type：`host` / `srflx` / `relay`；
- transport protocol：UDP / TCP；
- signaling 建连耗时、ICE 耗时、DTLS 耗时、首帧耗时；
- RTT、抖动、丢包、实际码率、可用出站码率；
- 编码 FPS、编码耗时、关键帧次数和丢帧；
- ICE restart 次数、失败原因和 TURN region；
- DataChannel 往返时间和输入确认延迟。

远端遥测不要上传原始 IP、SDP、ICE candidate、输入正文和截图。candidate type、区域和聚合性能足够排障。

首版网络验收矩阵：

1. 同一 Wi-Fi，验证 `host` 直连；
2. 家庭宽带 Mac + 手机 4G/5G，验证 `srflx` 直连；
3. 双侧 CGNAT 或强制 `iceTransportPolicy: "relay"`，验证 TURN；
4. 禁 UDP 网络，验证 TURN TLS/TCP；
5. IPv6-only / NAT64；
6. Wi-Fi 切蜂窝、Mac 睡眠再唤醒；
7. 50/100/200 ms RTT，1%/3%/5% 丢包；
8. TURN 凭证过期、设备撤销、信令重连和重复消息；
9. Safari iOS 与 Chrome Android 各跑 60 分钟。

建议验收线：

| 指标 | 首版目标 |
|---|---|
| 公网会话建立成功率 | 测试矩阵中不低于 99%，包含 TURN |
| 首帧时间 | 局域网 P95 < 2 秒；公网 P95 < 5 秒 |
| 网络恢复 | 可用网络恢复后 5 秒内重新出画面 |
| 错误输入 | 0；断线时宁可拒绝 |
| 连续会话 | 60 分钟无崩溃、无失控输入 |

直连率不要先拍脑袋承诺百分比。上线后按网络类型、地区和运营商实测；它是 TURN 成本与体验指标，不是固定协议能力。

## 10. 方案对比

| 方案 | 优点 | 致命问题 | 判断 |
|---|---|---|---|
| WebRTC + ICE/STUN/TURN | 浏览器原生、端到端加密、拥塞控制、直连与中继统一 | Native 集成和 TURN 运维有成本 | 推荐 |
| Tailscale/ZeroTier + 当前 HTTP/WS | 开发最快，穿透由 VPN 解决 | 要求用户额外安装和登录，不能成为消费产品默认链路 | 仅开发/早期用户 |
| 所有画面走 WebSocket 中继 | 实现简单、连通稳定 | 带宽全压服务器、延迟高、自己承担拥塞控制 | 烂方案，不选 |
| 自研 UDP 打洞 | 可完全控制协议 | NAT、拥塞、加密、浏览器兼容都要重造 | 别犯蠢，不选 |
| SFU/媒体服务器 | 多人和多路转发成熟 | 单用户远控仍强制绕服务器，成本和延迟不值 | 未来多人场景再评估 |

## 11. 实施顺序与工作量

### Phase 0：Native WebRTC spike，3—5 个工作日

- 构建并嵌入固定版本的 macOS `WebRTC.xcframework`；
- 浏览器与 Mac 用最小信令建立 PeerConnection；
- 发送测试视频和可靠 DataChannel；
- 验证 H.264 协商、硬件编码、签名后的 App 可运行；
- 输出依赖版本、许可证、包体积、构建时间和崩溃风险。

退出条件：真实 Mac App 向 Safari/Chrome 连续发 1080p/30fps 30 分钟。这个 spike 不过，后面排期全是扯淡。

### Phase 1：重构 Mac Host，5—8 个工作日

- 把短命 CLI 改成长驻 App/service；
- `SCStream CVPixelBuffer` 直接进入 WebRTC video source；
- 建立 `control` DataChannel；
- 保留现有 JPEG/WS 作为开发诊断路径，不作为公网 fallback。

### Phase 2：信令与 TURN，5—8 个工作日

- 新增 `apps/signaling-server`；
- 设备在线、会话路由、offer/answer、Trickle ICE；
- coturn UDP + TLS/TCP、短期凭证和配额；
- ICE restart、强制 relay 测试和基础指标。

### Phase 3：配对、安全与网络硬化，7—12 个工作日

- 设备密钥、二维码配对、撤销；
- 签名的 SDP envelope 和 DataChannel 二次握手；
- 网络切换、睡眠唤醒、断线输入熔断；
- 完整网络矩阵、审计和告警。

单人合理估算是 **4—6 个工程周**，前提是 Phase 0 没踩进 libwebrtc 构建深坑。两周可以做“我手机连上了”的演示，做不出可信的公网远控产品。

## 12. 最终决策

采用以下基线：

```text
Mac persistent Host + libwebrtc
Phone browser RTCPeerConnection
TypeScript HTTPS/WSS signaling
coturn STUN/TURN
H.264 video + reliable DataChannel control
paired device keys + signed signaling envelope
direct first, encrypted relay fallback
```

现在最该做的不是先写完整信令后台，而是先完成 macOS libwebrtc spike。最大技术未知数不是 STUN/TURN，也不是 WSS，而是当前 SwiftPM/ad-hoc App 构建体系里，能否稳定集成、锁定和分发 macOS WebRTC framework，并让 ScreenCaptureKit 的像素缓冲走硬件 H.264 编码。先把这个未知数打掉，再扩服务器。

## 参考资料

- [RFC 8445: Interactive Connectivity Establishment (ICE)](https://www.rfc-editor.org/rfc/rfc8445.html)
- [RFC 8489: Session Traversal Utilities for NAT (STUN)](https://www.rfc-editor.org/rfc/rfc8489.html)
- [RFC 8656: Traversal Using Relays around NAT (TURN)](https://www.rfc-editor.org/rfc/rfc8656.html)
- [RFC 8825: Overview of WebRTC Protocols](https://www.rfc-editor.org/rfc/rfc8825.html)
- [RFC 8827: WebRTC Security Architecture](https://www.rfc-editor.org/rfc/rfc8827.html)
- [RFC 8831: WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831.html)
- [WebRTC: Getting started with peer connections](https://webrtc.org/getting-started/peer-connections)
- [W3C WebRTC API](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [coturn](https://github.com/coturn/coturn)
- [Google WebRTC native source and documentation](https://webrtc.googlesource.com/src/)

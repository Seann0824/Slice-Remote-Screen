# Slice Remote Screen 技术方案

版本：0.1  
日期：2026-09-01  
目标平台：macOS 被控端 + 手机 Web/PWA 控制端

## 1. 技术目标

构建一套自己掌握的远程控制核心，同时支持三种产品形态：

1. 完整远控：展示并操作整个电脑桌面；
2. App 快捷模式：展示并操作指定应用窗口或局部区域；
3. AI Computer Use：让模型通过同一套观察与动作接口识别、创建和修复快捷操作。

三者不能是三套系统。它们必须共用画面采集、编码传输、输入注入、设备认证和会话管理能力。

```text
                  ┌───────────────────┐
                  │ 手机完整远控界面   │
                  └─────────┬─────────┘
                            │
┌───────────────────┐       │       ┌───────────────────┐
│ 手机快捷 App 界面  │───────┼───────│ AI Computer Use   │
└───────────────────┘       │       └───────────────────┘
                            ▼
                 Remote Control Core
          采集 / 编码 / 传输 / 输入 / 认证 / 状态
                            │
                            ▼
                         macOS
```

## 2. 非目标

V1 不做以下事情：

- 不自己实现视频编码器；
- 不自己实现拥塞控制、STUN、TURN 或 ICE；
- 不做 Windows 和 Linux 被控端；
- 不做多人同时控制；
- 不做系统登录界面和 FileVault 解锁；
- 不尝试绕过 DRM、密码管理器和系统安全窗口；
- 不让 AI 参与每次普通快捷操作；
- 不提供任意远程 Shell 或任意脚本执行；
- 不做硬件 VPN 盒子。

自己做的是产品核心和系统编排，不是重新发明所有底层协议。

## 3. 总体架构

```text
┌──────────────────────────── 手机端 ────────────────────────────┐
│ PWA                                                         │
│ ├── Device UI：设备、在线状态、配对                           │
│ ├── Remote UI：完整桌面、窗口、局部区域                       │
│ ├── Shortcut UI：按钮、输入框、开关、状态卡片                 │
│ ├── WebRTC Client：视频、音频、DataChannel                    │
│ └── Profile Renderer：根据 App Profile 渲染手机布局           │
└───────────────────────────┬──────────────────────────────────┘
                            │
                 HTTPS / WSS / WebRTC
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ 可选协调服务                                                  │
│ ├── 设备在线与信令                                            │
│ ├── WebRTC SDP / ICE 交换                                    │
│ ├── 一次性配对                                                │
│ └── TURN 凭证签发                                             │
│ 不保存画面，不执行动作，不持有设备控制密钥                    │
└───────────────────────────┬──────────────────────────────────┘
                            │
                    WebRTC P2P / TURN
                            │
┌───────────────────────────▼────────────── macOS Host ─────────┐
│ Host App                                                     │
│ ├── Session Gateway                                          │
│ ├── Capture Graph                                            │
│ ├── Encoder                                                   │
│ ├── Input Router                                              │
│ ├── Window & App Registry                                     │
│ ├── App Profile Engine                                        │
│ ├── Accessibility Engine                                      │
│ ├── Visual Anchor Engine                                      │
│ ├── Action Executor & Validator                               │
│ ├── AI Adapter（可选）                                        │
│ ├── Permission & Pairing                                      │
│ └── Local Audit Log                                           │
└───────────────────────────────────────────────────────────────┘
```

## 4. 核心技术选型

| 能力 | V1 方案 | 原因 |
|---|---|---|
| Mac 应用 | Swift + SwiftUI | 权限、系统 API、签名和后台常驻最直接 |
| 屏幕与窗口采集 | ScreenCaptureKit | 原生支持 display/window，性能和权限路径明确 |
| 视频编码 | VideoToolbox H.264 | Apple Silicon 硬件编码，浏览器兼容性最好 |
| 实时传输 | WebRTC | 自带加密、拥塞控制、ICE、DataChannel 和浏览器客户端 |
| 中继 | coturn | 成熟的 TURN/STUN 实现，可自托管 |
| 输入注入 | CGEvent | 键盘、鼠标、滚轮和拖拽基础能力 |
| 语义操作 | AXUIElement，优先评估 AXorcist | 可发现元素、执行 AXPress/设置输入值并观察状态 |
| App 识别 | NSWorkspace + bundle identifier + PID | 不依赖窗口标题猜应用 |
| 数据库 | SQLite | Profile、设备、动作和审计记录需要事务与迁移 |
| 控制协议 | 版本化 JSON；高频指针事件后续转二进制 | V1 易调试，避免过早引入复杂 IDL |
| 手机端 | React 18 + TypeScript + Vite + 响应式 PWA | iOS/Android 共用，WebRTC 原生可用，迭代快 |
| Web 设计系统 | Big Minds 的 Tailwind 4 + Radix/shadcn 设计系统 | 直接复用已验证的 token、主题、组件和交互规范，不再另造一套 |
| AI 接口 | Provider-neutral Adapter | 不把产品绑死在某个模型或厂商 |

### 4.1 编码格式

V1 只承诺 H.264：

- 浏览器和 WebRTC 支持最稳定；
- VideoToolbox 硬件编码成熟；
- 便于控制码率、关键帧和低延迟参数；
- HEVC、AV1 和多编码协商放到后续。

不要一开始追求所有编码格式。那是性能优化，不是产品成立条件。

V1 优先把 ScreenCaptureKit 输出的 `CVPixelBuffer` 交给 libwebrtc 的视频源，并验证其 H.264 编码路径实际使用 VideoToolbox。除非性能测试证明必须自定义编码器，否则不要同时维护一套手写 `VTCompressionSession` 和一套 WebRTC 编码管线。

### 4.2 分发方式

macOS Host 需要屏幕录制和辅助功能权限，不适合把 App Sandbox 当硬约束。建议：

- Developer ID 签名；
- Apple 公证；
- DMG 或 Sparkle 更新；
- 登录后自动启动的 LaunchAgent；
- V1 保持单一签名 App/Helper 边界，避免 TCC 权限被多个进程切碎。

## 5. Remote Control Core

### 5.1 统一目标模型

所有采集和输入都作用于 `RemoteTarget`：

```swift
enum RemoteTarget {
    case display(displayID: UInt32)
    case window(windowID: UInt32, appPID: pid_t)
    case region(parent: ParentTarget, normalizedRect: CGRect)
}
```

区域坐标必须相对于父 display 或 window 归一化到 `0...1`。禁止把固定屏幕像素作为持久化真相。

### 5.2 Capture Graph

Capture Graph 负责把 ScreenCaptureKit 的源转换为不同消费者需要的画面：

```text
SCStream
  → Frame Normalizer
      → Active Remote View（30/60 fps H.264）
      → Slice Preview（0.5—2 fps JPEG/WebP）
      → AI Observation（按需 PNG/JPEG）
      → Action Validation（动作前后局部帧）
```

规则：

- 同一窗口只建立一个基础采集源，多个 Slice 从同一帧裁剪；
- 只有当前展开的视图使用高帧率视频；
- 首页多个快捷卡片默认使用低频快照或语义状态；
- 切换桌面、窗口和区域时优先复用同一 WebRTC PeerConnection，并替换视频源；
- App 最小化、窗口关闭或尺寸变化时发出明确状态，不发送旧画面冒充在线。

### 5.3 为什么 V1 不同时推多路视频

手机同时解码多个 WebRTC 视频轨道会增加功耗、带宽和崩溃概率。V1 使用：

- 一路主视频：当前完整桌面、窗口或活动区域；
- 多个低频缩略图：通过 DataChannel 或 HTTPS 发送；
- 多个语义状态：通过控制通道发送文本或数值。

后续只有真实用户明确需要多个实时区域时，才增加多轨或服务端合成 atlas。

### 5.4 后续考虑：多应用同画布

Post-V1 可以支持一个远程画布同时呈现多个应用窗口，但这属于新的跨应用画布模型，不是给现有 `NormalizedRegion` 增加一个字段就结束。

#### 目标模型

```text
CanvasProfile
├── CanvasItem: Codex window
├── CanvasItem: Terminal window
├── CanvasItem: Browser window
└── CanvasItem: Editor window
```

建议新增独立的 `CanvasProfile`：

```json
{
  "version": 1,
  "id": "canvas.dev-workspace",
  "items": [
    {
      "id": "item.codex",
      "source": {
        "appKey": "com.openai.codex",
        "bundleIdentifier": "com.openai.codex",
        "windowMatcher": { "titleContains": "Codex" }
      },
      "crop": { "x": 0, "y": 0, "width": 1, "height": 1 },
      "layout": { "x": 0.02, "y": 0.02, "width": 0.47, "height": 0.46 },
      "zIndex": 1,
      "mediaPolicy": "live"
    }
  ]
}
```

#### 采集与合成

- ScreenCaptureKit 支持枚举应用、窗口和显示器，并可用独立窗口创建内容过滤器；因此多窗口采集在 macOS 能力上可行。[Apple：ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- 正式架构使用独立 window source，不使用整屏流的固定像素裁剪作为多应用画布的基础。整屏裁剪无法稳定处理窗口遮挡、移动、跨 Space 和最小化。
- 第一阶段可以在手机端合成 2–4 路低频 JPEG 流，当前聚焦项切换到高帧率流，用于验证产品需求。
- 验证通过后，改为 Mac 端统一 `CanvasSession`：一个持久进程管理多路 `SCStream`，输出带 `sourceId` 的帧；再评估客户端多轨 WebRTC 或 host-side atlas。
- 每个 source 必须有独立的在线、尺寸变化、窗口关闭和重新匹配状态，不能用另一窗口的旧画面冒充在线。

#### 输入与焦点

现有输入协议的坐标只有相对于单个 target 的 `x/y`。多应用画布需要改为：

```json
{
  "type": "pointer.down",
  "sourceId": "item.codex",
  "x": 0.82,
  "y": 0.44
}
```

- pointer down 到 up 期间锁定 `sourceId`，避免拖拽过程中切换目标。
- 点击画布项时激活并抬升对应窗口；键盘和文本输入只发给当前焦点项。
- 语义操作优先使用 AXUIElement，像素级操作才使用 CGEvent；两个 API 都需要按目标应用验证。
- 多应用“同时显示”可行，但 macOS 键盘焦点仍然是串行的，不能承诺多个应用同时接收键盘输入。

#### 持久化与失效处理

窗口 ID 只作为当前会话的寻址信息，不作为持久化身份。恢复画布时按 bundle identifier、窗口标题/角色和 Accessibility 层级重新匹配；匹配失败时单项显示失效状态，并提供重新绑定或展开完整应用窗口的入口。

该能力暂不进入 V1 验收范围。进入实现前必须先验证：2–4 路窗口的 CPU、内存、带宽、手机端解码功耗、窗口切换延迟，以及点击/拖拽/键盘焦点不会误路由。

### 5.5 输入路由

输入协议使用归一化坐标：

```json
{
  "type": "pointer.tap",
  "targetId": "slice.codex.composer",
  "x": 0.82,
  "y": 0.44,
  "button": "left"
}
```

Host 端执行以下转换：

```text
手机控件坐标
  → Slice 归一化坐标
  → 父窗口坐标
  → macOS 逻辑桌面坐标
  → 当前显示器缩放与坐标系转换
  → CGEvent 或 Accessibility 动作
```

必须处理：

- Retina 物理像素与逻辑坐标；
- 多显示器原点可能为负；
- 手机端 object-fit 造成的 letterbox；
- 横竖屏切换；
- 窗口移动和缩放；
- Slice 裁剪与视频编码尺寸变化；
- 滚动、长按、双击、拖拽和组合键。

坐标转换应是纯函数并具备完整单元测试。这里出错会造成最危险的误操作。

### 5.6 前台与后台输入

输入执行分三档：

1. 语义后台操作：使用 AXPress、AXValue 等操作，不依赖鼠标位置；
2. 指定进程事件：研究并尝试将事件发给目标 PID，但必须按应用验证；
3. 前台像素操作：激活目标窗口后使用 CGEvent，执行完成后按策略恢复焦点。

每个 Action 声明 `focusPolicy`：

```text
backgroundOnly
activateTarget
activateAndRestore
requireUserForeground
```

不能假装所有 macOS 应用都支持后台鼠标事件。做不到就明确激活窗口或拒绝执行。

## 6. App 区域切分

### 6.1 切分不是简单截图裁剪

用户体验上是“框选区域”，底层保存的是多层锚定信息：

```text
应用身份
  + 窗口匹配规则
  + 窗口内归一化区域
  + Accessibility 元素定位器
  + 可选视觉锚点
  + 允许的交互动作
```

纯坐标区域只能作为最后兜底。

### 6.2 App Profile

```json
{
  "id": "profile.codex.default",
  "schemaVersion": 1,
  "app": {
    "bundleIdentifier": "com.openai.codex",
    "displayName": "Codex"
  },
  "windowMatcher": {
    "role": "AXWindow",
    "titleContains": "Codex"
  },
  "slices": [],
  "actions": [],
  "layouts": [],
  "updatedAt": "2026-08-31T00:00:00Z"
}
```

### 6.3 Slice

```json
{
  "id": "slice.codex.composer",
  "name": "输入区域",
  "parent": "matchedWindow",
  "normalizedRect": [0.08, 0.72, 0.84, 0.22],
  "locator": {
    "role": "AXTextArea",
    "identifier": "composer",
    "ancestorPath": [
      { "role": "AXGroup", "titleContains": "Chat" }
    ]
  },
  "mediaPolicy": {
    "mode": "snapshot",
    "maxFps": 1,
    "maxWidth": 720
  },
  "interactionPolicy": "textAndPointer"
}
```

`mediaPolicy.mode` 支持：

- `none`：只显示按钮；
- `status`：只传语义文本或数值；
- `snapshot`：低频局部快照；
- `live`：展开后切换为主视频；
- `onDemand`：用户按住或打开时才采集。

### 6.4 Action

```json
{
  "id": "action.codex.send",
  "name": "发送",
  "targetSliceId": "slice.codex.composer",
  "executorChain": [
    {
      "type": "accessibility",
      "operation": "press",
      "locator": {
        "role": "AXButton",
        "identifier": "send-button"
      }
    },
    {
      "type": "pixelFallback",
      "normalizedPoint": [0.95, 0.82]
    }
  ],
  "preconditions": {
    "targetCount": 1,
    "mustBeEnabled": true
  },
  "postconditions": {
    "localRegionChanged": true
  },
  "risk": "normal",
  "confirmation": "none",
  "focusPolicy": "activateAndRestore"
}
```

Pixel fallback 默认关闭。只有用户明确允许并通过视觉校验时才执行。

### 6.5 App Profile 生命周期

```text
选择 App
  → 选择窗口
  → 框选区域或点选 AX 元素
  → 选择控件类型
  → 本地测试
  → 保存 Profile
  → 发布到手机
  → 每次执行重新定位和校验
  → 失效后提示修复或展开完整窗口
```

App Profile 状态：

```text
draft → validated → active → degraded → broken → repaired
```

## 7. 手机端设计

### 7.1 页面结构

```text
设备首页
├── 设备在线状态
├── 快捷 App 列表
├── 最近使用动作
└── 完整远控入口

快捷 App 页面
├── LiveSlice（0..n 个）
├── 添加 / 删除 / 排序区域
└── 展开：完整 App → 完整桌面
```

### 7.2 控件协议

V1 主体控件：

- `LiveSlice`：同一 App 视频源的实时裁剪面，直接接收触控；
- `RemoteCanvas`：完整视频和手势交互。

`Button`、`TextInput`、`Toggle` 和 `StatusCard` 可以作为后续语义增强，但不是快捷 App 的主体，也不能取代实时区域。

手机端只是渲染 Profile，不写死 Codex 或其他 App。

### 7.3 手势

V1 固定以下映射，允许用户切换触控模式：

| 手势 | 直接触控模式 | 触控板模式 |
|---|---|---|
| 单击 | 点击当前位置 | 左键点击 |
| 拖动 | 直接拖拽 | 移动指针 |
| 双击 | 双击 | 双击 |
| 双指滚动 | 滚动 | 滚动 |
| 长按 | 右键 | 鼠标按住 |
| 双指缩放 | 缩放视图 | 缩放视图 |

### 7.4 设计系统复用

Web/PWA 不重新设计，直接以 Big Minds 设计系统为上游：

- 规范：`/Users/sean/Desktop/repo/big-minds/docs/design-system.md`；
- token 与主题：`big-minds/app/src/styles/index.css`；
- UI primitives：`big-minds/app/src/components/ui/`；
- 主题运行时：`big-minds/app/src/lib/theme.ts` 与 `ThemeProvider.tsx`。

这里的“直接用”是复用设计语言和可移植代码，不是在运行时 import 本机绝对路径，也不做跨仓库 symlink。绝对路径依赖换台电脑、CI 或开源发布就会直接失效。

当前仓库建立独立的 `packages/design-system`：

```text
packages/design-system/
├── src/styles/tokens.css       # 语义颜色、字体、圆角、阴影、动效
├── src/styles/base.css         # reset、焦点、reduced-motion
├── src/components/ui/          # 通用 Radix/shadcn primitives
├── src/theme/                  # 主题初始化与 ThemeProvider
└── UPSTREAM.md                 # 上游路径、commit 与同步说明
```

复用范围：

- `canvas/surface/inset/quiet/selected/overlay` 表面层级；
- `ink/muted/line/line-strong/accent/link/danger` 语义 token；
- control/card/overlay/sheet 圆角、overlay/sheet 阴影与 `ease-product` 动效；
- Button、Card、Dialog、Input、Textarea、Tabs、ToggleGroup、Select、Popover、DropdownMenu、ScrollArea、Alert、Badge、Empty、Skeleton、Separator、Toaster；
- 亮暗主题、键盘焦点、触控尺寸与 reduced-motion 行为。

明确不复用：

- `.article-body`、BlockNote override、分享卡主题等内容产品专用 CSS；
- Conversations、Workspace、PageLayout 等 Big Minds 业务组件和信息架构；
- Big Minds Logo、文案和 `shiwen.theme` 存储键；
- 旧的 `panel/subtle/subtle-alt` 迁移别名。

Slice Remote Screen 自己只补业务组件：`RemoteCanvas`、`DeviceCard`、`ConnectionStatus`、`ShortcutAppCard`、`SlicePreview`、`RemoteDock`、`ViewSwitcher`、`PairingSheet` 和 `PermissionDialog`。这些组件必须消费上游语义 token 和 primitives，不准写私有颜色、随手造圆角或局部 `dark:` 分支。

详细映射和同步策略见 [DESIGN_SYSTEM_INTEGRATION.md](./DESIGN_SYSTEM_INTEGRATION.md)。

## 8. 通信协议

### 8.1 通道划分

```text
HTTPS/WSS
├── 登录与设备列表
├── 配对
├── WebRTC 信令
└── Profile 同步

WebRTC Media
├── H.264 主视频
└── 音频（后续）

WebRTC DataChannel
├── 输入事件
├── Action 请求与结果
├── 窗口和 Profile 状态
├── Slice 缩略图
└── 心跳与延迟统计
```

### 8.2 消息包络

```json
{
  "protocolVersion": 1,
  "messageId": "uuid",
  "sessionId": "uuid",
  "sequence": 42,
  "timestamp": 1788192000000,
  "type": "action.execute",
  "body": {}
}
```

要求：

- `protocolVersion` 必须显式；
- 每个 session 的 `sequence` 单调递增；
- 重复消息按 `messageId` 去重；
- 高风险动作令牌短期有效；
- 指针移动事件允许合并和丢弃，点击与键盘事件不允许静默丢失；
- Action 执行必须返回最终状态，而不是只返回“已收到”。

### 8.3 主要消息

```text
device.hello
device.state
window.list
profile.list
profile.get
view.subscribe
view.changed
pointer.move
pointer.tap
pointer.drag
pointer.scroll
keyboard.type
keyboard.key
action.execute
action.result
slice.snapshot
permission.required
session.pause
session.close
```

## 9. 连接、信令与中继

详细的协议原理、服务器职责、TURN 成本、安全边界、当前仓库差距和实施顺序见 [P2P 连接调研](./P2P_CONNECTION_RESEARCH.md)。

### 9.1 连接路径

```text
优先：局域网 / ICE 直连
其次：公网 NAT 穿透
最后：TURN 中继
```

协调服务只负责在线状态和 WebRTC 信令。媒体经过 TURN 时仍由 DTLS-SRTP 加密。

### 9.2 开源与自托管

仓库应提供：

- Host App；
- PWA；
- Signaling Server；
- coturn 示例配置；
- Docker Compose 自托管方案；
- 协议文档；
- Profile schema 与迁移工具。

官方可以提供托管协调和 TURN，但自托管不能被故意做残。

### 9.3 离线与局域网模式

V1 开发阶段允许通过 Tailscale 或同一局域网验证。正式版本仍应实现标准 WebRTC ICE/TURN，不能把 VPN 当产品必需条件。

## 10. 配对与安全

### 10.1 设备身份

Host 首次运行生成设备密钥对，私钥进入 Keychain。手机首次配对也生成设备密钥。

二维码包含：

```text
deviceId
hostPublicKey
signalingEndpoint
singleUsePairingToken
expiresAt
```

流程：

1. Mac 显示 60 秒有效二维码；
2. 手机扫码并提交一次性挑战；
3. Mac 明确显示手机名称并要求确认；
4. 双方保存对方公钥；
5. 后续会话使用挑战签名验证设备；
6. 用户可在 Mac 上立即撤销手机授权。

信令服务器不能替换通信双方。Host 必须使用设备私钥签署 SDP、DTLS fingerprint、会话 ID 和过期时间，手机验证签名后才建立 PeerConnection；手机的应答也执行同样校验。TURN 凭证必须短期有效。

### 10.2 权限级别

```text
viewOnly
shortcutOnly
windowControl
fullDesktopControl
profileEdit
```

设备权限和单次会话权限取交集。不能因为手机曾经获得完整权限，就默认允许未来新增的高风险动作。

### 10.3 高风险操作

以下操作默认要求二次确认或禁止自动化：

- 删除文件或数据；
- 安装软件；
- 系统设置与权限变更；
- 密码、支付和密钥相关界面；
- 发送公开消息或对外发布；
- 关闭安全软件；
- AI 自动修复后首次执行。

检测到 macOS Secure Input、受保护窗口或屏幕采集返回黑帧时，应停止输入和采集并明确报错，不能继续对不可见目标盲点。

### 10.4 本地控制

- 菜单栏常驻显示是否有远程会话；
- 一键暂停所有远程输入；
- 全局紧急断开快捷键；
- 新设备和新会话通知；
- 审计日志默认本地保存；
- 任何匿名遥测默认关闭。

## 11. Action 执行与验证

### 11.1 执行器优先级

```text
1. 原生应用 API / URL Scheme（用户显式配置时）
2. Accessibility 语义动作
3. Apple Events / Shortcuts
4. 键盘快捷键
5. 视觉锚定后的像素操作
6. 裸坐标操作，默认禁止用于持久快捷动作
```

产品本体建立在远控上，不代表所有快捷动作都必须模拟鼠标。能用更稳定的执行方式就应该用。

### 11.2 执行状态

```text
queued
locating
validating
awaitingConfirmation
executing
verifying
succeeded
failedBeforeEffect
effectUncertain
rejected
canceled
```

`effectUncertain` 不能自动重试，否则可能造成重复发送、重复提交或重复删除。

### 11.3 前后校验

可用校验手段：

- AX 元素 enabled/value 状态；
- 目标元素是否仍唯一；
- 局部画面是否变化；
- 预期文本或图标是否出现；
- 窗口是否打开、关闭或切换；
- 用户定义的成功状态。

## 12. AI Computer Use

### 12.1 角色

AI 只负责：

- 自动建议 App 切分区域；
- 将自然语言映射到画面或 AX 元素；
- 为候选区域生成控件名称和类型；
- 修复失效 Locator；
- 把人工远控轨迹总结为 Action；
- 在用户主动选择 AI 模式时执行临时复杂任务。

普通快捷操作不调用模型。

### 12.2 Provider-neutral 接口

```swift
protocol ComputerUseProvider {
    func ground(
        instruction: String,
        screenshot: Data,
        accessibilitySnapshot: AXSnapshot?
    ) async throws -> [GroundedCandidate]

    func proposeProfile(
        observation: AppObservation
    ) async throws -> AppProfileProposal

    func repairLocator(
        broken: Locator,
        observation: AppObservation
    ) async throws -> [LocatorProposal]

    func summarizeTrajectory(
        trajectory: UserTrajectory
    ) async throws -> ActionProposal
}
```

### 12.3 AI 安全约束

- AI 输出永远是 Proposal，不直接进入 active Profile；
- 新建或修复结果必须经过用户确认和本地测试；
- 发送给云模型的截图必须明确提示，并允许局部裁剪和遮挡；
- 默认不上传完整桌面，只上传所选 App 或 Slice；
- 保存 AI 决策来源、模型版本和用户确认记录；
- 模型无法唯一定位时必须失败，不能猜。

## 13. 数据存储

SQLite 主要表：

```text
devices
pairing_sessions
app_profiles
profile_versions
slices
actions
layouts
action_runs
remote_sessions
audit_events
ai_proposals
```

原则：

- Profile 每次修改生成版本；
- 允许回滚；
- 密钥和敏感令牌只进入 Keychain；
- 审计日志不记录密码和完整输入正文；
- 截图和 trajectory 默认短期保存并由用户显式开启；
- Schema migration 纳入版本控制。

## 14. 进程模型

### V1

```text
SliceRemoteScreen.app
├── SwiftUI 菜单栏与配置 UI
├── ScreenCaptureKit
├── WebRTC
├── Input/AX Engine
└── SQLite
```

先保持单一签名应用边界，减少 TCC、代码签名和 XPC 调试成本。

### 后续

稳定后再拆分：

```text
UI App
  ↕ XPC
Host Agent
  ↕
Network/Media Service
```

拆分理由必须是稳定性、权限隔离或多用户需求，不能为了“架构漂亮”提前找麻烦。

## 15. 可观测性

本地记录：

- 采集 FPS、编码耗时和丢帧；
- WebRTC RTT、抖动、丢包和码率；
- 输入事件端到端延迟；
- 目标定位与 Action 成功率；
- PeerConnection 状态变化；
- 重连次数与原因；
- 权限错误；
- App Profile 降级和失效原因。

日志包含 `sessionId`、`profileId` 和 `actionRunId`，但不包含敏感正文和原始截图。

## 16. 性能目标

首版验收目标：

| 指标 | 目标 |
|---|---|
| 局域网完整桌面延迟 | 中位数低于 150 ms |
| 局域网输入确认延迟 | P95 低于 120 ms |
| 1080p 视频 | 30 fps 稳定运行 |
| 活动 Slice | 最高 30 fps |
| 非活动 Slice 缩略图 | 0.5—2 fps |
| 视图切换 | 1 秒内出现首帧 |
| 断网重连 | 网络恢复后 5 秒内 |
| 连续会话 | 60 分钟无崩溃、无失控输入 |
| 快捷 Action 成功率 | 不低于 95% |
| 错误目标点击 | 0；宁可失败 |

公网延迟不做脱离网络条件的虚假承诺，应按直连和 TURN 分开统计。

## 17. 测试方案

### 17.1 单元测试

- Retina、多显示器和负坐标转换；
- object-fit 与 letterbox 反算；
- Slice 到窗口再到桌面的坐标转换；
- 消息去重、乱序和超时；
- Profile schema migration；
- Locator 唯一匹配；
- 风险策略与权限交集；
- Action 状态机。

### 17.2 集成测试

- ScreenCaptureKit display/window/region 采集；
- 窗口移动、缩放、最小化、关闭和重开；
- CGEvent 点击、拖拽、滚动、输入和组合键；
- Accessibility 权限撤销与恢复；
- VideoToolbox 编码器重建；
- WebRTC 直连、TURN、断线和重连；
- Safari/Chrome 手机浏览器；
- App Profile 从 active 进入 degraded/broken。

### 17.3 端到端用例

1. 手机连接 Mac 并打开完整桌面；
2. 从完整桌面进入 Codex 窗口；
3. 从窗口进入输入区域 Slice；
4. 输入文字并执行发送；
5. 确认动作结果；
6. 移动和缩放 Codex 窗口后再次执行；
7. 修改界面使定位器失效；
8. 系统拒绝误点并提供完整窗口；
9. AI 提议修复，用户确认后恢复快捷动作。

### 17.4 网络测试

- 50/100/200 ms RTT；
- 1%/3%/5% 丢包；
- Wi-Fi 与蜂窝网络切换；
- ICE 直连转 TURN；
- 前后台切换和手机锁屏；
- 短断网与长断网。

## 18. 开源策略

自己开发并不代表可以随意复制其他项目代码。

建议在第一行第三方代码进入仓库前决定许可证：

- 如果追求最大采用和商业集成：Apache-2.0；
- 如果要防止云厂商闭源托管改版：AGPL-3.0；
- 如果想分层：协议、SDK 与客户端 Apache-2.0，官方协调服务单独选择许可证。

无论选择哪种：

- 建立 `THIRD_PARTY_NOTICES`；
- 自动生成 SBOM；
- CI 做依赖许可证扫描；
- 不直接复制 RustDesk、Sunshine 等 copyleft 代码，除非项目许可证明确兼容；
- WebRTC、coturn 和其他依赖也必须锁定版本并核对许可证；
- 首次接收外部贡献前确定 CLA 或 DCO 策略。

许可证不是 README 最后一行的小事，晚决定会导致整仓重写。

## 19. 实施阶段

### 阶段 0：核心可行性，5 个工作日

交付：

- 枚举 display/window；
- ScreenCaptureKit 采集完整桌面、单窗口和归一化区域；
- 本地预览；
- CGEvent 点击、输入、滚动；
- 完整坐标转换测试；
- Codex 窗口内三个区域可稳定操作。

退出条件：窗口移动和缩放后，区域操作仍正确；误点击为 0。

### 阶段 1：局域网完整远控，2 周

交付：

- VideoToolbox H.264；
- WebRTC PeerConnection；
- 从 Big Minds 抽取并落地 `packages/design-system`；
- PWA RemoteCanvas；
- 完整桌面和窗口切换；
- 触控、键盘和剪贴板文本；
- 基础权限与会话状态。

退出条件：手机在局域网连续控制 60 分钟，1080p/30 fps 稳定，无失控输入。

### 阶段 2：快捷 App 闭环，2 周

交付：

- App Profile 编辑器；
- Slice 框选和实时交互；
- 单路应用采集源、多区域共享裁剪；
- 区域局部坐标到应用坐标的统一变换；
- Accessibility / 视觉锚点重定位；
- 局部、窗口、桌面逐级展开。

退出条件：Codex 至少三个实时区域可稳定显示和操作，窗口移动后坐标仍正确，界面失配时不误操作。

### 阶段 3：公网连接与安全，2 周

交付：

- Signaling Server；
- ICE/STUN/TURN；
- 二维码配对和设备密钥；
- 权限级别；
- 审计、暂停和撤权；
- 断线重连。

退出条件：不同网络下完成直连和 TURN 会话；未配对设备无法观察或控制。

### 阶段 4：AI 辅助，指标成立后再做

交付：

- ComputerUseProvider；
- 自动区域建议；
- Locator 修复 Proposal；
- trajectory 转 Action Proposal；
- 用户确认与回滚。

没有前面三阶段的稳定底座，AI 只会把故障包装得更花哨。

## 20. 仓库建议结构

```text
slice-remote-screen/
├── apps/
│   ├── mac-host/               # Swift/SwiftUI
│   ├── mobile-web/             # TypeScript PWA
│   └── signaling-server/       # 信令与设备在线
├── packages/
│   ├── protocol/               # 消息 schema 与测试向量
│   ├── profile-schema/         # App Profile schema
│   ├── design-system/          # Big Minds 设计系统的可版本化抽取
│   └── remote-ui/              # RemoteCanvas 与远控业务组件
├── infra/
│   ├── coturn/
│   └── docker-compose/
├── docs/
│   ├── architecture/
│   ├── protocol/
│   ├── security/
│   └── profiles/
├── tests/
│   ├── protocol-fixtures/
│   └── e2e/
├── PRODUCT_PLAN.md
├── TECHNICAL_DESIGN.md
├── DESIGN_SYSTEM_INTEGRATION.md
└── GITHUB_RESEARCH.md
```

macOS 核心代码先留在 Xcode/Swift Package 体系内，不要为了单仓库统一构建，硬塞进一套脆弱的跨语言构建脚本。

## 21. 立即执行

第一批代码只做一个垂直闭环：

```text
Mac 枚举 Codex 窗口
  → ScreenCaptureKit 捕获窗口
  → 裁剪输入区域
  → 本地网页显示
  → 网页点击/输入
  → Mac 正确执行
  → 窗口移动后仍然正确
```

这个闭环通过后再接 WebRTC、公网和 AI。连窗口移动后的局部点击都做不稳，其他宏大架构全是扯淡。

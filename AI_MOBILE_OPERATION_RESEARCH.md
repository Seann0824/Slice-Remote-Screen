# AI 虚拟移动操作层调研与实施方案

版本：0.1  
日期：2026-09-01  
适用项目：Slice Remote Screen

## 1. 结论

这个方向可行，但核心不是让 AI 实时识别每一次操作，而是把电脑窗口当成一块远程触控屏，将手机手势直接映射为电脑输入。

正确的产品结构是：

> 手机手势通过低延迟链路直接控制电脑；AI 只在实时操作链路之外提供区域识别、配置生成、轨迹总结和失效修复。

远端目标仍然是 macOS 桌面 UI，因此模型执行时应该使用桌面动作语义。手机只是显示和输入适配器，不能因为入口在手机上，就让模型使用 Android 式 `back`、`open_app` 或含义模糊的 `long_press` 去操作 macOS。

真正值得建立的资产不是“让 AI 模拟手指”，而是三部分：

1. 低延迟、确定性的手机手势到电脑输入映射；
2. 完整桌面、应用窗口和局部区域共用的坐标与传输协议；
3. 可选的 AI 异步增强能力，用于自动生成、验证和修复 Mobile App Profile。

普通高频操作绝对不能调用模型。实时操作必须走 `Pointer Events → 归一化坐标 → 远程输入通道 → CGEvent/AX` 的确定性链路。AI 应主要用于创建 Profile、修复失效定位器和总结人工轨迹；只有用户明确进入 AI 模式时，才处理临时复杂任务。

### 1.1 实时链路与 AI 旁路

```text
实时主链路：

手指触摸
    → 手机本地手势识别
    → 归一化坐标与动作
    → WebRTC DataChannel / 低延迟控制通道
    → Mac Host
    → CGEvent 或已知 AX 动作
    → 电脑立即响应

AI 异步旁路：

窗口截图 + AX Snapshot + 人工轨迹
    → AI 分析
    → 区域、控件或快捷动作 Proposal
    → 用户确认
    → 保存为确定性 Profile
```

AI 不得位于手势实时链路中。把每次触摸都变成“截图、上传、模型识别、返回动作、执行、重新截图”，会把几十毫秒级的远控输入膨胀成秒级交互，产品会直接失去可操作性。

## 2. 产品定义

### 2.1 核心形态

```text
macOS 桌面应用
    ↓ ScreenCaptureKit + Accessibility
窗口画面 + AX 语义树
    ↓
AI 分析与提议
    ↓
Mobile App Profile
├── LiveSlice：局部实时画面
├── Button：确定性按钮
├── TextInput：文本输入
├── ScrollPad：滚动区域
├── StatusCard：状态展示
└── 降级入口：完整 App / 完整桌面
    ↓
手机端渲染与操作
    ↓
统一动作协议
    ↓
AX 语义执行 / CGEvent 像素执行
```

### 2.2 与普通远控和 Computer Use 的区别

普通远控解决“人从远端操作完整桌面”。

Computer Use 解决“模型根据截图临时操作界面”。

Slice 应解决的是：

> 把一次视觉或人工操作沉淀成稳定、可复用、适合手机的应用控制面板，同时始终保留完整远控兜底。

这才是产品差异。只给现有远控接口套一个模型循环，最后只会变成另一个通用桌面 Agent。

### 2.3 首要产品形态：电脑作为远程触控屏

用户不需要先让 AI 理解界面才能操作。只要远端画面已经显示在手机上，手指就应该直接作用于画面对应位置。

```text
手机看到哪里
    → 手指点哪里
    → Mac 就在对应位置执行鼠标或滚动事件
```

这层能力必须满足：

- 不依赖 AI；
- 不依赖 App Profile；
- 不依赖 Accessibility Tree；
- 对完整桌面、单个窗口和局部区域使用同一套坐标换算；
- App Profile 失效时仍然可以直接操作；
- AI 服务不可用时不影响任何普通远控操作。

App Profile 和 AI 都是增强层，不能成为用户操作电脑的前置条件。

## 3. 当前仓库基础

项目已经具备最小闭环，不是从零开始。

### 3.1 已实现

- `packages/protocol` 已定义归一化坐标的 `click / drag / scroll`；
- 手机 `RemoteCanvas` 已将触控点换算成目标窗口归一化坐标；
- 已实现单指移动光标、轻触点击、长按右键、长按后拖拽和双指滚动；
- Mac Host 已通过 CGEvent 执行点击、拖拽、滚动、文本和快捷键；
- 窗口目标开始输入前会激活所属 App，并通过 AX Raise 将对应窗口切到前台；
- ScreenCaptureKit 已提供窗口和桌面观察画面；
- App Profile 已能保存窗口内归一化区域；
- 技术方案已经预留 Provider-neutral 的 `ComputerUseProvider`。

### 3.2 主要缺口

当前动作层还不能直接作为成熟的 AI Computer Use Harness：

- 缺少 `doubleClick`、纯指针移动、`pointerDown`、`pointerUp`、`wait` 和 `cancel`；
- 动作结果只有请求成功或失败，没有完整执行状态和后置验证；
- 没有 `frameId`，无法判断 AI 是否正在根据过期截图点击；
- 没有动作序列号、幂等键和批次失败策略；
- 当前 Host 会激活目标应用，会打断电脑前台用户；
- 当前主要依赖裸坐标，没有 Accessibility 语义执行器；
- 没有 AI trajectory、截图历史、动作回放和人工审计界面；
- 没有提示注入识别和高风险动作确认策略。

## 4. 外部技术现状

### 4.1 OpenAI Computer Use

OpenAI 的 Computer Use 采用标准闭环：

```text
任务 + 当前截图
    → 模型返回动作批次
    → Harness 顺序执行
    → 获取新截图
    → 返回模型继续判断
```

内置动作包括：

- `click`；
- `double_click`；
- `scroll`；
- `type`；
- `wait`；
- `keypress`；
- `drag`；
- `move`；
- `screenshot`。

官方明确支持在现有 Playwright、Selenium、VNC 或 MCP Harness 上建立自定义工具层。这证明 Slice 不需要采用某个模型厂商的执行器，只需要把自己的远控核心适配为模型可调用的 Harness。

参考：[OpenAI Computer Use](https://developers.openai.com/api/docs/guides/tools-computer-use)

### 4.2 Claude Computer Use

Claude 的 Computer Use 已提供 17 个成员动作，包括：

- 左、右、中键和多次点击；
- 鼠标移动；
- 鼠标按下与抬起；
- 拖拽；
- 滚动；
- 文本和按键；
- 光标位置；
- 全屏截图与局部放大观察。

Claude 官方特别指出，macOS Retina 截图通常使用设备像素，而输入事件使用逻辑坐标。如果不处理设备像素比，点击位置会产生系统性偏移。

参考：[Claude Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

### 4.3 Gemini Computer Use

Gemini 已明确区分三种动作环境：

- Browser；
- Mobile；
- Desktop。

其动作坐标使用 `0—999` 归一化空间，并由客户端换算到实际视口。Mobile 环境含 `open_app`、`list_apps`、`go_back`、`long_press`；Desktop 环境则包含鼠标移动、多次点击、按下、抬起、滚动和快捷键。

这对 Slice 的直接启示是：

- 统一协议使用归一化坐标是正确方向；
- 模型环境应由远端目标决定，而不是由控制端设备决定；
- macOS 窗口应该暴露 Desktop 动作语义；
- Mobile 动作语义只适用于手机 UI 本身或未来真实 Android 被控端。

参考：[Gemini Computer Use](https://ai.google.dev/gemini-api/docs/computer-use)

### 4.4 Apple 原生能力

ScreenCaptureKit 可以持续获取显示器、应用和窗口画面，并在帧元数据中提供内容矩形、内容缩放和显示缩放信息。Slice 应把这些信息纳入 Observation，而不是只传一张没有坐标上下文的图片。

AXUIElement 可以读取元素属性、查询支持的动作、设置值并执行 `AXPress` 等语义动作。语义操作应该优先于 CGEvent，因为它比坐标更稳定，也更容易验证结果。

参考：

- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)

### 4.5 Web 移动手势

W3C Pointer Events 提供统一的鼠标、触控和笔输入模型，并包含 Pointer Capture、并发指针、合并事件和 `touch-action` 控制。

现有 React 前端继续使用 Pointer Events 即可，不需要再引入一套只支持 Touch Events 的手势底座。

参考：[W3C Pointer Events](https://www.w3.org/TR/pointerevents4/)

## 5. 推荐总体架构

```text
实时触控快速路径：

手机 Pointer Events
    → 本地手势解释
    → 归一化轻量输入事件
    → 低延迟可靠传输
    → Input Router
    → CGEvent

异步增强路径：

Mobile Profile 控件 / AI Provider
    → Canonical Action Protocol
    → Policy / Risk / Stale-frame Gate
    → AX / Shortcut / CGEvent / App API
    → ActionResult + Observation
```

关键原则：

1. 人类实时手势走快速路径，不等待 AI、AX Tree 或执行后截图；
2. 手机端必须本地完成点击、拖拽、滚动和长按识别；
3. AI Provider 不得进入视频渲染或手势发送主循环；
4. Profile 控件和 AI 动作才进入完整的策略、验证和审计链路；
5. AI 执行器优先选择语义操作，裸坐标只作降级；
6. AI 动作必须明确它依据的是哪一帧观察结果。

实时触控快速路径仍需认证、会话权限和基本边界检查，但不能为了完整审计而阻塞每一个手势事件。连续指针和滚动事件应允许合并；点击、按键、鼠标抬起等状态改变事件必须可靠有序。

## 6. Canonical Observation Protocol

本节主要服务于 AI、Profile 生成和需要验证的确定性 Action，不属于普通手势的实时必经路径。用户直接触控时使用当前视频帧和目标几何完成坐标映射即可，不能等待新的 Observation 才允许点击。

### 6.1 Observation

建议数据结构：

```json
{
  "observationId": "obs-uuid",
  "sessionId": "session-uuid",
  "target": {
    "targetId": "window:123",
    "kind": "window",
    "bundleIdentifier": "com.openai.codex",
    "windowId": 123
  },
  "capturedAt": 1788192000000,
  "image": {
    "width": 1440,
    "height": 900,
    "contentRect": [0, 0, 1440, 900],
    "format": "png",
    "scaleFactor": 2
  },
  "targetGeometry": {
    "logicalFrame": [120, 80, 720, 450],
    "revision": 42
  },
  "accessibility": {
    "snapshotId": "ax-uuid",
    "treeHash": "sha256"
  },
  "privacy": {
    "redactedRegions": [],
    "containsSecureInput": false
  }
}
```

要求：

- 截图尺寸、逻辑窗口尺寸和缩放因子必须同时存在；
- 每次窗口移动、缩放、切换或重新捕获时增加 `revision`；
- AI 动作必须引用 `observationId`；
- 检测到 Secure Input、黑帧或受保护窗口时停止执行；
- 默认只观察目标窗口或 Slice，不上传完整桌面。

## 7. Canonical Action Protocol

完整 Canonical Action 用于 AI 和可审计快捷操作。高频人工手势可以使用同语义的精简传输格式，避免为每个 `pointerMove` 附带大段意图、风险和 Observation 信息。

### 7.1 动作包络

```json
{
  "protocolVersion": 1,
  "actionId": "action-uuid",
  "sessionId": "session-uuid",
  "source": "human | profile | ai",
  "targetId": "window:123",
  "basedOnObservationId": "obs-uuid",
  "sequence": 43,
  "intent": "点击发送按钮",
  "risk": "normal",
  "action": {
    "type": "tap",
    "point": { "x": 0.92, "y": 0.84 },
    "button": "left"
  }
}
```

### 7.2 最小动作集合

```text
observe
tap
doubleTap
pointerMove
pointerDown
pointerUp
drag
scroll
type
keyChord
wait
cancel
```

后续可以增加：

```text
accessibilityPress
accessibilitySetValue
launchApplication
activateWindow
selectMenuItem
executeProfileAction
```

### 7.3 为什么必须有 pointerDown / pointerUp

单一 `drag(start, end)` 无法覆盖以下场景：

- 长按后等待菜单出现；
- 按住鼠标跨过复杂路径；
- 拖到屏幕边缘触发自动滚动；
- 按住修饰键进行多选；
- 模型分多步完成拖拽。

但分离动作也会产生“鼠标按下后连接断开”的风险。Host 必须维护按键状态，并在超时、取消、断线或会话结束时强制释放所有按键。

### 7.4 ActionResult

```json
{
  "actionId": "action-uuid",
  "status": "succeeded | rejected | failedBeforeEffect | effectUncertain | canceled",
  "executor": "accessibility | cgevent | shortcut | appApi",
  "startedAt": 1788192000100,
  "finishedAt": 1788192000280,
  "effect": {
    "windowRevisionChanged": false,
    "accessibilityChanged": true,
    "pixelsChanged": true
  },
  "nextObservationId": "obs-next-uuid",
  "error": null
}
```

`effectUncertain` 不得自动重试，否则可能造成重复发送、重复付款、重复删除或重复提交。

## 8. 手机手势映射

### 8.1 推荐默认映射

| 手机手势 | Canonical Action | macOS 执行 | 备注 |
|---|---|---|---|
| 单击 | `tap` | AXPress 或左键 | AX 唯一命中时优先 |
| 双击 | `doubleTap` | 双击 | 不拆成两次网络点击 |
| 长按后松开 | `tap(button=right)` | 右键 | 不得在按住瞬间提前触发 |
| 长按后移动 | `drag` | 鼠标拖拽 | 只有明确进入按住状态才发送 `pointerDown` |
| 单指移动 | `pointerMove` | 移动鼠标 | 默认行为，禁止偷偷补 `pointerDown` |
| 双指滑动 | `scroll` | 像素滚动 | 连续增量发送或合并 |
| 双指缩放 | 本地 viewport zoom | 不发送远端动作 | 默认不能映射 Cmd+/- |
| 文本提交 | `type` | AXValue 或 CGEvent | 不逐个模拟手机键盘点击 |
| 返回手势 | Profile-defined | Escape 或 App 动作 | 禁止全局默认映射 |

### 8.2 两种交互模式

必须明确区分：

#### 直接触控模式

- 手指位置就是远端点击位置；
- 单指移动并释放形成拖拽；
- 适合按钮和局部 LiveSlice；
- 小型桌面控件容易误点。

#### 触控板模式

- 手指滑动只移动远端指针；
- 轻触任意位置表示点击当前指针；
- 双指滚动；
- 更适合完整桌面和精细操作。

当前实现默认采用触控板优先的混合方式：轻触仍点击手指对应位置，单指移动只移动光标，长按后移动才拖拽。不能把普通移动解释成“按下并移动”，否则用户只是定位鼠标也会误拖窗口、文本或文件。

AI 不应该接收未经解释的“手机 swipe”。Adapter 必须先根据当前模式把它解析成明确的 `drag`、`pointerMove` 或 `scroll`。

## 9. AI 生成 Mobile App Profile

### 9.1 生成流程

```text
选择目标 App
    ↓
获取窗口截图 + AX Snapshot
    ↓
合并视觉候选与 AX 元素
    ↓
AI 生成 Mobile Profile Proposal
    ↓
本地规则检查
    ↓
手机预览
    ↓
用户逐项测试和确认
    ↓
保存为 validated Profile
```

### 9.2 AI 应生成的内容

每个候选控件包含：

```json
{
  "id": "control.codex.send",
  "type": "button",
  "label": "发送",
  "locator": {
    "role": "AXButton",
    "identifier": "send-button",
    "title": "Send",
    "ancestorPath": []
  },
  "fallback": {
    "normalizedRect": [0.90, 0.80, 0.08, 0.12]
  },
  "operation": {
    "type": "press"
  },
  "postcondition": {
    "localRegionChanged": true
  },
  "risk": "normal",
  "confidence": 0.93,
  "requiresUserValidation": true
}
```

### 9.3 控件类型

- `LiveSlice`：局部实时画面，允许直接手势；
- `Button`：执行确定性动作；
- `TextInput`：向目标输入框设置或输入文本；
- `ScrollPad`：绑定指定滚动区域；
- `StatusCard`：显示 AXValue、OCR 或视觉状态；
- `Toggle`：只有状态可读取、动作可验证时才生成；
- `OpenFullApp`：降级到完整窗口；
- `OpenDesktop`：最终远控兜底。

### 9.4 AI 不得直接决定的内容

- 删除、付款、发送公开内容等高风险动作的免确认策略；
- Secure Input 或密码区域的自动操作；
- 在多个相似元素中猜一个目标；
- 把临时像素坐标直接保存为 active Profile；
- 在没有后置验证时声明动作成功。

## 10. AI 临时自主操作模式

AI 可以在用户主动选择时处理一次性复杂任务，但它不应成为普通 Profile 操作的必经路径。

### 10.1 执行循环

```text
用户任务
    ↓
Observation
    ↓
模型返回一个动作或短批次
    ↓
本地策略检查
    ↓
必要时请求用户确认
    ↓
顺序执行
    ↓
动作后 Observation
    ↓
验证并继续，或终止
```

### 10.2 批次规则

- 只允许连续执行低风险、可逆动作；
- 批次中任一动作失败，停止后续动作；
- 点击后页面可能跳转时，应立即重新观察；
- 输入敏感数据前必须确认，不能等提交时才确认；
- 高风险动作必须在即将执行时确认；
- 任何 `effectUncertain` 都终止自动循环。

## 11. 坐标与时序设计

### 11.1 坐标链路

```text
模型截图坐标
    → Observation 图像归一化坐标
    → Slice / Window 归一化坐标
    → macOS 窗口逻辑坐标
    → 全局桌面逻辑坐标
    → CGEvent
```

必须覆盖：

- Retina 设备像素与逻辑像素；
- 多显示器负坐标；
- 窗口阴影、标题栏和内容矩形；
- 手机画面 letterbox；
- Slice 二次裁剪；
- 视频编码分辨率变化；
- 旋转和横竖屏切换；
- 窗口在观察后移动或缩放。

所有变换都应该由纯函数实现，并以属性测试覆盖边界值和往返误差。

### 11.2 目标窗口前台化

窗口捕获不等于窗口可点击。ScreenCaptureKit 可以持续捕获被其他窗口遮挡的目标，但全局 CGEvent 最终只会命中当前桌面最上层窗口。如果 Mac 上的控制浏览器被最大化或进入全屏，而目标 App 没有先切到前台，用户在手机上看到的是目标 App，实际点击却会落到浏览器。这会造成“画面还在，但另一个 App 无法操作”的假象。

窗口目标的输入起点必须执行：

```text
确认目标进程
    → 激活 / 取消隐藏目标 App
    → 等待它成为 frontmost application
    → 通过 AXRaise 聚焦对应窗口
    → 再发送 CGEvent
```

这段等待只应发生在 App 或目标窗口真正切换时。连续拖拽和后续点击不得重复等待，否则会人为制造触控延迟。完整桌面模式不强制激活某个 App，事件应继续作用于当前可见的最上层窗口。

### 11.3 过期观察拒绝

以下任一条件成立时，应拒绝坐标动作并要求重新观察：

- `basedOnObservationId` 不存在；
- 目标窗口 revision 已变化；
- 目标窗口已关闭、最小化或被替换；
- 动作超过允许的观察时效；
- 截图尺寸和当前捕获尺寸不一致；
- AX 命中结果从唯一变成多个；
- 出现新的系统弹窗、权限窗口或 Secure Input。

普通指针移动可以宽松处理，提交、删除等动作必须严格处理。

## 12. 执行器优先级

```text
1. App 原生 API / URL Scheme
2. Accessibility 语义动作
3. Apple Events / Shortcuts
4. 键盘快捷键
5. 视觉锚定后的 CGEvent
6. 裸坐标 CGEvent
```

这不是为了架构漂亮，而是为了可靠性。

例如发送按钮通过 AXPress 执行时，可以检查元素是否 enabled、目标是否唯一以及按钮状态是否变化。裸坐标只能证明鼠标事件发出去了，不能证明点中了什么。

## 13. 安全设计

### 13.1 提示注入

网页、邮件、聊天和文档中的文字都属于不可信屏幕内容。模型可能把界面中的恶意指令当成任务要求。

规则：

- 只有用户直接输入的指令构成授权；
- 屏幕内容只能作为数据，不能扩大权限；
- AI 不得因为页面写着“必须立即点击”就获得执行授权；
- 检测到疑似提示注入时暂停并提示用户；
- 默认限制可操作 App 和动作种类。

### 13.2 风险等级

```text
safe
normal
sensitive
destructive
forbidden
```

示例：

- 查看状态：`safe`；
- 切换普通标签：`normal`；
- 发送消息、上传文件：`sensitive`；
- 删除数据、修改权限、付款：`destructive`；
- 密码、密钥、安全设置自动化：默认 `forbidden`。

### 13.3 本地保护

- 菜单栏持续显示 AI 或远控会话状态；
- 提供全局紧急断开快捷键；
- 断线立即释放所有鼠标和键盘状态；
- 审计记录动作来源、意图、目标、结果和模型版本；
- 日志不保存密码和完整敏感输入；
- 云模型截图上传需要明确开关和可见提示；
- 默认只上传选定窗口或 Slice。

## 14. 性能与传输

AI 原型可以继续使用当前按需 PNG 和 15fps JPEG 流，但这不代表媒体链路已经够用。

### AI Observation

- 不需要每帧发送给模型；
- 动作前、动作后和不确定时按需截图；
- 小目标优先发送局部原始分辨率截图；
- 只保留最近少量截图，避免上下文和成本持续增长；
- 相同静态区域可以通过哈希避免重复上传。

### 人类实时远控

- 仍应迁移到 VideoToolbox H.264 + WebRTC；
- 指针移动可以合并或丢弃；
- 点击、键盘和 Action 必须可靠有序；
- 视频帧和动作通道必须共享时间戳或 revision，避免画面与输入状态错位。

不能因为 AI 只需要截图，就把 WebRTC 优先级降掉。AI 和人类远控解决的是两种延迟需求。

## 15. 实施路线

### P0：远程触控补全，2—4 天

- 保持手机手势直接映射 CGEvent；
- 增加双击、指针移动、鼠标按下、鼠标抬起和取消；
- 明确直接触控模式和触控板模式；
- 双指缩放只缩放手机视图，不操作远端应用；
- 为小控件增加本地放大镜或局部放大；
- 拆分可合并的连续事件与必须可靠的状态事件；
- Host 维护按键状态并支持紧急释放；
- 窗口输入前激活目标 App 并 AXRaise 对应窗口，覆盖浏览器最大化和全屏 Space；
- 完成坐标、Retina、多屏和断线测试。

退出条件：关闭所有 AI 能力后，用户仍能在手机上连续完成点击、拖拽、滚动、右键、文本输入和精细定位。

### P1：低延迟媒体与输入通道，1—2 周

- 将 JPEG 帧流替换为 VideoToolbox H.264 + WebRTC；
- 手势与键盘进入 WebRTC DataChannel；
- 指针移动和滚动事件允许合并；
- 点击、按键和抬起事件可靠有序；
- 视频帧、目标 geometry 和输入事件携带可关联时间戳；
- 验证局域网和 TURN 中继下的触控延迟。

退出条件：局域网内的普通点击反馈接近本地触控体验，连续拖拽和滚动没有明显断裂或积压。

### P2：确定性 Profile 增强，3—5 天

- 为高频按钮和输入框增加可选 AX Locator；
- 实现 AXPress、AXValue 和唯一目标校验；
- 动作失败时自动降级到 LiveSlice 或完整窗口；
- 记录人工手势 trajectory，供后续 AI 总结；
- 保持未配置 App 仍可完整触控。

退出条件：Profile 提供更方便的手机控件，但删除 Profile 后完整触控能力完全不受影响。

### P3：AI Profile Builder，后续

- 实现 Provider Adapter；
- 将截图和 AX Snapshot 发送给一个模型；
- 生成 Mobile Profile Proposal；
- 手机端显示候选控件和绑定范围；
- 用户测试、确认后保存；
- 保存模型来源和 Profile 版本。

退出条件：用户能从一个未配置 App 自动得到可编辑的手机控制面板，并成功验证至少三个控件。

### P4：临时 AI Agent Mode，最后再做

- 多轮 Observe / Act 循环；
- 批次执行和失败中止；
- 风险确认；
- 提示注入检测；
- 任务取消、超时和恢复；
- Operator timeline 和回放。

这个阶段不能抢在 P0—P3 前面。否则只是让模型高速调用一套不稳定的裸坐标接口，还平白增加秒级延迟。

## 16. 推荐的首个验证场景

继续使用 Codex 作为技术探针：

1. AI 识别任务列表、任务状态、输入框、发送按钮、停止按钮；
2. 生成一个包含 LiveSlice、TextInput、Button 和 StatusCard 的 Mobile Profile；
3. 用户在手机预览并逐项测试；
4. 保存后，普通发送和停止操作不再调用模型；
5. 调整 Codex 窗口大小并重启应用，验证 AX Locator；
6. 人工破坏一个 Locator，再让 AI 给出修复 Proposal；
7. 用户确认修复后重新激活 Profile。

这个场景能同时验证：

- 自动界面切分；
- 手机控件生成；
- 手势和确定性动作共用协议；
- Locator 稳定性；
- AI 修复能力；
- 完整远控降级路径。

## 17. 最终判断

值得做，但必须把重点放对：

- 不是训练一个会模拟手指的模型；
- 不是把 Android 手势生硬翻译成 Mac 鼠标；
- 不是让每次点击都经过 AI；
- 不是用模型掩盖坐标、权限和输入注入不稳定。

正确路线是：

```text
先建立可靠的远控动作平面
    → 再让 AI 理解桌面 UI
    → 生成适合手机的 Profile
    → 用户验证后确定性运行
    → 失效时由 AI 修复
    → 复杂任务才进入临时 Agent 模式
```

如果这套动作平面和验证机制做稳，后续接 OpenAI、Claude、Gemini 或本地 GUI 模型都只是 Adapter 问题。反过来先接模型，得到的只会是一个能演示、不能信任的玩具。

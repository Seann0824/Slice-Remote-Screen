# GitHub 同类项目调研

调研日期：2026-08-31

## 1. 先把产品定义说清楚

我们的目标不是在手机上显示一块缩小的电脑屏幕，而是：

> 从桌面应用中选择可操作区域或语义元素，把它保存为可复用动作，再把这些动作重新编排成手机上的按钮、输入框、开关和状态卡片。

完整链路是：

```text
桌面应用
  → 识别窗口和可交互元素
  → 用户选择并绑定动作
  → 保存稳定定位规则
  → 发布成手机控件
  → 手机触发
  → Mac 重新定位元素并安全执行
```

这里最难的不是手机按钮，而是应用重启、窗口移动、界面变化后，仍能安全地重新找到同一个操作目标。

## 2. 调研结论

GitHub 上没有发现一个成熟项目完整实现“圈选任意桌面应用元素 → 持久化 → 自动发布成手机控件”这条链路。

但相关能力已经分别存在于三类项目中：

1. Macro Deck、Deckboard、Bitfocus Companion 已经证明“手机/浏览器作为可定制按钮面板”成立；
2. OculOS、AXorcist、xa11y 已经实现桌面 Accessibility Tree 的查询和操作；
3. OpenAdapt 已经实现录制桌面操作并编译成可重放工作流。

所以这不是从零发明技术。真正的产品空间是把三部分拼成一个普通用户能用的闭环，尤其是“点选元素、生成可靠定位器、发布到手机、失效后安全停止”。

## 3. 最值得看的项目

### 3.1 OculOS：概念上最接近的桌面执行后端

仓库：[huseyinstif/oculos](https://github.com/huseyinstif/oculos)

它通过系统可访问性树读取窗口、按钮、输入框和菜单，并暴露 REST API、WebSocket、MCP、元素检查器和操作录制器。支持点击、输入、聚焦、选择和批量动作。

可以直接借鉴：

- `/windows`、`/tree`、`/find`、`/interact` 这组 API 分层；
- 桌面元素检查器与高亮交互；
- 录制一组动作并导出的思路；
- REST + WebSocket 的本地服务形态；
- Accessibility 优先、截图和坐标兜底的路线。

致命缺口：

- 元素 ID 是每次扫描随机生成的 session UUID，不能直接用于持久化动作；
- 没有手机动作面板和“发布动作”模型；
- 默认只是本机服务，不具备产品需要的设备认证、配对和权限体系；
- 仓库很年轻，macOS 实现明显不够扎实；
- 源码里的 macOS 几何读取仍很粗糙，README 也把 macOS 元素高亮列为未完成。

判断：非常适合抄 API 和检查器思路，也适合做一次快速实验；不建议不加审查地把整个项目当生产底座。

### 3.2 AXorcist：macOS V1 最合适的原生基础库

仓库：[openclaw/AXorcist](https://github.com/openclaw/AXorcist)

这是 Swift 封装的 macOS Accessibility 库，提供元素查询、路径定位、模糊匹配、执行动作、批量命令、事件观察和权限处理。

可以直接借鉴或依赖：

- Swift 原生接入，和 SwiftUI 菜单栏应用组合最省事；
- 根据 role、identifier、title、description 等属性构建定位器；
- 支持路径提示和多条件匹配；
- `getElementAtPoint` 很适合实现“鼠标指到哪个元素就选哪个”；
- 每次执行时重新查询元素，而不是保存内存对象或屏幕坐标；
- MIT 许可证，作为 Swift Package 引入比较干净。

缺口：

- 它只是 macOS 自动化库，没有手机端、网络、动作存储和发布机制；
- 模糊匹配如果使用不当会点错目标，产品层必须要求唯一匹配并做执行前校验；
- 仅适合 macOS，未来跨平台需要替换执行层或增加其他后端。

判断：如果 V1 坚持 macOS-only，这是目前最合理的执行层候选。

### 3.3 xa11y：未来跨平台最值得观察的执行层

仓库：[xa11y/xa11y](https://github.com/xa11y/xa11y)

它提供类似 Playwright 的桌面 Accessibility API，支持 macOS AXUIElement、Windows UI Automation 和 Linux AT-SPI，并用 CSS 风格选择器定位元素，例如：

```text
button[name='Submit']
window group > button
text_field[name^='Search']
```

可以直接借鉴：

- 把持久化目标表达成可读、可测试的 selector；
- 每次动作执行时重新解析 selector；
- 元素未命中时提供候选项和诊断信息；
- Rust 核心，同时提供 Python 和 JavaScript 绑定；
- 已经包含跨平台后端、截图、事件、MCP 和集成测试结构。

缺口：

- 项目也很年轻；
- Rust 与原生 SwiftUI 应用的集成、打包、签名会增加工程复杂度；
- CSS 风格 selector 仍不足以独自解决应用升级后的目标漂移；
- 没有手机控制面板和面向普通用户的动作创作流程。

判断：先别为了“未来跨平台”把 V1 搞复杂。可以借它的 selector 和错误诊断设计；真正开始做 Windows 时再评估是否切换到它。

### 3.4 Macro Deck：手机控制面的最佳产品参考

仓库：[Macro-Deck-App/Macro-Deck](https://github.com/Macro-Deck-App/Macro-Deck)  
客户端：[Macro-Deck-App/Macro-Deck-Client-App](https://github.com/Macro-Deck-App/Macro-Deck-Client-App)

Macro Deck 把手机、平板或浏览器变成可定制宏键盘，支持按钮网格、图标、多个 profile、文件夹、变量、插件和 Web 客户端。客户端使用 WebSocket，并包含二维码连接、掉线处理和控件网格等完整代码。

可以直接借鉴：

- 手机按钮网格和 profile/folder 信息架构；
- 电脑端配置、手机端只负责触发的职责划分；
- 二维码配对、连接状态、断线页面；
- 控件数据结构和 WebSocket 消息协议；
- 插件与动作类型扩展机制。

缺口：

- 电脑端核心目前是 Windows；
- 动作主要是预设宏、插件和快捷键，不会让用户从任意应用里点选一个 UI 元素；
- 没有 Accessibility Tree 定位和元素失效诊断。

判断：不要 fork 它的 Windows 主程序。重点研究它的手机客户端、控件协议和动作编排体验。

### 3.5 Deckboard：验证需求，但代码复用价值低

仓库：[rivafarabi/deckboard](https://github.com/rivafarabi/deckboard)

Deckboard 的产品描述非常接近“手机作为电脑快捷操作面板”：用户创建带图片和名称的宏按钮，通过局域网或二维码连接电脑，支持快捷键、打开目录、媒体控制和 OBS 等动作。

问题是仓库基本只有文档和发布内容，缺少可直接研究的完整源码，且不支持 macOS。

判断：只能当竞品和需求验证，别把时间浪费在代码复用上。

### 3.6 Bitfocus Companion：成熟的动作/控件插件生态参考

仓库：[bitfocus/companion](https://github.com/bitfocus/companion)

Companion 面向直播和专业设备控制，把大量软件与硬件动作统一映射到 Stream Deck 等控制面。它最有价值的不是桌面自动化，而是成熟的“连接、动作、反馈、变量、按钮”模型。

可以借鉴：

- 一个按钮不仅能执行动作，也能接收状态反馈；
- 应用连接器与通用控制面解耦；
- 动作、变量、反馈条件和按钮显示的分层；
- 大规模插件生态如何组织。

缺口：

- 主要依赖第三方设备或软件提供的明确协议；
- 不解决任意桌面应用元素的自动发现与持久化。

判断：适合参考长期插件架构，V1 不要照着做成一个庞大平台。

### 3.7 OpenAdapt：后续“录一次，以后重复执行”的参考

仓库：[OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt)

OpenAdapt 记录用户的 GUI 演示，再编译成可重复执行、带结果验证的工作流。它覆盖浏览器、原生桌面、RDP 和 Citrix，强调执行完成不等于业务结果成功。

可以借鉴：

- 用户演示一次动作，再生成可复用工作流；
- 关键动作前后验证界面或业务状态；
- 失败时区分“未执行”“结果不确定”“执行但未验证”；
- 高风险动作不能盲目重试。

缺口：

- 系统复杂度远高于我们的 V1；
- 目标偏企业级 agent 执行与审计，不是轻量手机快捷按钮；
- 把它直接集成进来会把产品做成 RPA 平台，纯属自找麻烦。

判断：只吸收验证和错误状态设计，别在 V1 引入整套工作流编译器。

### 3.8 Hammerspoon：最快的脚本探针，不是产品底座

仓库：[Hammerspoon/hammerspoon](https://github.com/Hammerspoon/hammerspoon)

Hammerspoon 能通过 Lua 快速控制 macOS 窗口、键盘、鼠标和系统能力，生态成熟。

判断：适合一两天内验证快捷键、窗口激活和本地 HTTP 控制，不适合承担可靠的元素定位、普通用户配置和产品分发。

### 3.9 OpenAI CUA Sample App：参考标准 Computer Use 循环

仓库：[openai/openai-cua-sample-app](https://github.com/openai/openai-cua-sample-app)

它展示了标准 Computer Use 循环：截屏发给模型，模型返回点击、拖拽、输入、等待等动作，执行动作，再把新截图交回模型。项目还包含 operator console、事件流、回放数据和结果验证。

可以直接借鉴：

- 统一的 screenshot/action 协议；
- 连续动作批次、执行超时和中止；
- 每轮截图、事件和动作的 trajectory；
- 人类可以看懂的 operator console；
- 任务完成必须验证，不能把“点击结束”当成功。

缺口：示例重点是浏览器 agent，不是远程桌面产品，也不负责把操作沉淀为快捷 App。

### 3.10 Claude Quickstarts：macOS Computer Use 工程细节参考

仓库：[anthropics/claude-quickstarts](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-best-practices)

其中的 macOS Computer Use 示例实现了截图尺寸归一化、Retina 坐标换算、鼠标键盘动作、批量调用、轨迹记录、权限预检和调试面板。

这对我们的远控底座非常有用，因为“模型看到的图片坐标”“手机区域坐标”和“Mac 逻辑坐标”必须严格换算。这里算错一点，点击就会漂。

可以直接借鉴：

- 截图缩放与坐标反算；
- Retina 物理像素和逻辑像素处理；
- 动作失败后停止后续批次；
- trajectory viewer 与人工复盘；
- Screen Recording、Accessibility 权限预检；
- 对真实桌面使用 Computer Use 的安全警告和隔离原则。

### 3.11 OmniParser：自动切分交互区域的核心视觉参考

仓库：[microsoft/OmniParser](https://github.com/microsoft/OmniParser)

OmniParser 把一张 UI 截图解析成可交互区域、边界框和图标语义描述。它正好对应我们后期的“自动切分”：当 Accessibility Tree 不完整时，从画面中检测按钮、图标、输入区域和其他可交互对象。

可以直接借鉴：

- 从截图生成候选交互区域；
- 给候选区域生成语义说明；
- 判断区域是否可交互；
- 将视觉框与 Accessibility 元素合并；
- 生成供用户确认的快捷控件建议。

问题：模型和不同权重的许可证需要逐项核对；视觉框也会误判，不能未经用户确认就生成永久快捷动作。

### 3.12 UI-TARS Desktop：本地和远程 Computer Use 产品形态参考

仓库：[bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop)

UI-TARS Desktop 同时包含本地电脑、远程电脑和浏览器 operator，展示了多模态模型、事件流、执行器和可视化 agent UI 怎么组合。

可以直接借鉴：

- 本地与远程执行器使用统一 action contract；
- GUI Agent、DOM/Accessibility 和视觉定位的混合策略；
- 远程 operator 的状态与执行过程展示；
- 模型、执行器和前端之间使用事件流解耦。

判断：架构和 UI 值得看，整套引入太重。我们的主体是快捷 App，不是通用自主 agent。

### 3.13 Cua 与 macOS Harness：远控执行底座的重要参考

仓库：[trycua/cua](https://github.com/trycua/cua)  
仓库：[browser-use/macos-harness](https://github.com/browser-use/macos-harness)

Cua Driver 和 macOS Harness 都在研究一个很关键的能力：后台截取指定应用窗口，并把点击、键盘等输入直接发给目标应用，尽量不抢用户真实鼠标和前台焦点。

这和我们的底层能力高度重合。快捷 App 如果每次执行都抢走 Mac 当前焦点，产品会非常烦人；如果能对指定窗口后台采集和输入，完整远控、局部远控和 AI Computer Use 都能共用。

可以直接借鉴：

- `see / click / key / type / ax / script` 这类最小动作协议；
- 指定应用或进程的窗口采集；
- 后台输入与可视化虚拟指针；
- Accessibility、Apple Events 和像素操作的混合；
- MCP/SDK 与底层驱动解耦。

判断：这类项目比普通 RPA 更贴近我们的“远控核心”。正式实现底层前，应该专门做一次源码与许可证审计。

### 3.14 OSWorld：后续自动化可靠性测试参考

仓库：[xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld)

OSWorld 不是产品组件，而是真实电脑任务的 agent 评测环境。后续可以参考它构造回归用例：应用重启、窗口移动、分辨率变化、弹窗出现和控件状态变化后，快捷动作是否仍能正确完成。

## 4. Computer Use 在产品中的位置

Computer Use 不应该替代确定性快捷操作，也不应该成为每次点击都必须经过的昂贵中转。合理结构是：

```text
第一层：确定性快捷路径
  已保存 App Profile → 重新定位 → 校验唯一目标 → 直接执行

第二层：AI 识别与修复路径
  自动发现区域 / 理解图标 / 修复失效定位器 / 生成新快捷动作

第三层：完整远控路径
  用户查看完整窗口或桌面并直接操作
```

三层共用同一个远控核心：

```text
Remote Control Core
├── captureDesktop()
├── captureWindow(app)
├── captureRegion(app, rect)
├── click(target, point)
├── drag(target, path)
├── scroll(target, delta)
├── type(target, text)
├── key(target, chord)
└── observeAfterAction()
```

人、手机快捷控件和 AI 都只是这个核心的不同调用者。

### AI 最值得做的五件事

1. 用户添加快捷 App 时，自动识别主要交互区域并建议手机控件；
2. 用户说“把这个发送按钮加到手机”，模型把自然语言落到具体区域；
3. Accessibility Tree 缺失时，用视觉模型补充边界框和语义标签；
4. App 升级导致定位器失效时，模型寻找候选新位置，交给用户确认修复；
5. 把一次人工远控操作的 trajectory 总结成可重复快捷动作。

### AI 不该做的事

- 每次普通快捷点击都重新截图、调用模型、猜坐标；
- 没有唯一目标时擅自点击“看起来差不多”的按钮；
- 绕过高风险动作确认；
- 把模型输出的临时坐标直接当成永久 App Profile；
- 用 AI 掩盖远控采集、坐标换算和输入注入不稳定的问题。

## 5. 能否直接组合现有项目

最现实的组合不是 fork 一个大项目，而是：

```text
Mac 原生应用
├── 远控核心
│   ├── 参考 Cua Driver / macOS Harness：窗口采集与后台输入
│   └── 自己集成：完整桌面、应用窗口、区域流和设备会话
├── 快捷 App 层
│   ├── AXorcist：元素发现、定位、动作执行
│   ├── 自己实现：App Profile、持久化、唯一匹配和安全校验
│   └── 参考 Macro Deck Client：手机控件网格和连接交互
└── 可选 AI 层
    ├── 参考 OmniParser：视觉区域切分
    ├── 参考 OpenAI / Claude 示例：Computer Use action loop
    └── 自己实现：定位修复、用户确认和轨迹转快捷动作
```

OculOS 可以作为技术探针和 API 参考，xa11y 可以作为跨平台备选，OpenAdapt 只参考工作流验证。Computer Use 模型必须是可插拔增强层，不能绑死底层远控协议。

## 6. 推荐的持久化模型

不能保存 OculOS 那种临时元素 UUID，也不能只保存坐标。应该保存能重新解析的定位规则：

```json
{
  "app": {
    "bundleIdentifier": "com.openai.codex"
  },
  "window": {
    "role": "AXWindow",
    "titleContains": "Codex"
  },
  "target": {
    "role": "AXButton",
    "identifier": "send-button",
    "title": "Send",
    "ancestorPath": [
      { "role": "AXGroup", "identifier": "composer" }
    ],
    "fallbackRelativeRect": [0.90, 0.82, 0.08, 0.12]
  },
  "operation": "press",
  "validation": {
    "mustBeEnabled": true,
    "mustMatchExactlyOne": true
  }
}
```

执行顺序：

1. 根据 bundle identifier 找应用；
2. 根据窗口角色和标题规则找窗口；
3. 优先使用 identifier、role 和 ancestor path 找元素；
4. 找不到时再尝试标题或描述；
5. 相对位置只用于缩小候选范围，不能直接盲点；
6. 找到多个候选时拒绝执行；
7. 执行前检查角色、可用状态和动作类型；
8. 执行后检查预期状态变化。

## 7. 建议技术路线

### V0：两天技术探针

使用 AXorcist CLI/Swift Package：

1. 枚举 Codex 的窗口与 Accessibility Tree；
2. 实现鼠标悬停高亮当前元素；
3. 选择三个目标：发送按钮、输入框、停止/继续按钮；
4. 保存 selector，而不是保存元素对象；
5. 重启 Codex、移动窗口、改变窗口大小后重新执行；
6. 连续执行 50 次，记录成功、未命中、多候选和误操作。

通过标准：成功率不低于 95%，误操作为 0。宁可拒绝执行，也不能点错。

### V1：手机动作发布闭环

```text
SwiftUI 菜单栏应用
  + AXorcist 执行层
  + SQLite/JSON 动作库
  + 本地 HTTPS/WebSocket
  + PWA 手机控制页
```

先做四种手机控件：

- Button：点击或快捷键；
- TextInput：向指定输入框发送文字；
- Toggle：读取并切换开关状态；
- StatusCard：显示文本、进度或在线状态，不执行动作。

### V2：自动切分

只有手动选择证明有持续使用价值后，才增加：

- 自动过滤出可交互 Accessibility 元素；
- 根据角色自动推荐手机控件类型；
- 根据窗口布局自动分组；
- OCR/视觉识别补足没有 Accessibility Tree 的应用；
- 分享应用模板和定位规则。

## 8. 最终判断

这个方向不是没人做，而是现有项目都只做了一半：

- 宏键盘项目解决“手机按钮”，但不知道按钮对应桌面应用里的哪个语义元素；
- 桌面自动化项目知道元素在哪里，但没有普通用户能理解的手机发布流程；
- RPA 项目能录制工作流，但太重，也没有把高频动作做成轻量移动控件。

我们的机会就是补上中间那层：

> 让用户像裁剪截图一样选择桌面应用的操作区域，但实际保存的是可恢复的语义定位器，并自动生成适合手机使用的控件。

底层当然是完整远程控制，但产品不能只卖“远程控制电脑”，否则会立刻掉进 AnyDesk、RustDesk、KDE Connect 和远程桌面的烂仗里。准确定位应该是：

> 保留完整远控能力，并把桌面应用的交互区域切分、重组和发布到手机。

## 9. 开源远程控制底座补充调研

### 9.1 RustDesk：完整远控产品的第一参考

仓库：[rustdesk/rustdesk](https://github.com/rustdesk/rustdesk)  
服务端：[rustdesk/rustdesk-server](https://github.com/rustdesk/rustdesk-server)

RustDesk 是目前最接近 ToDesk/TeamViewer 产品形态的开源项目，包含桌面和移动客户端、屏幕采集、视频编码、鼠标键盘控制、剪贴板、文件传输、直连打洞、中继和自建服务器。

最值得研究：

- 客户端、被控端、rendezvous 和 relay 的完整链路；
- 直连失败后的中继降级；
- 屏幕采集、编码和输入服务如何拆分；
- Flutter 多端 UI 与 Rust 核心的组合；
- 设备 ID、连接授权、无人值守和会话状态。

问题：代码体量大，强行 fork 后很容易被上游拖死；客户端和协议围绕完整桌面设计，局部 App 重组仍然要自己做；主项目和服务端使用 AGPL-3.0，商业闭源产品不能装作没看见许可证。

判断：完整产品和网络架构的第一参考，不应未经许可证与模块边界审计就直接作为底座。

### 9.2 Sunshine + Moonlight：低延迟画面与输入参考

主机端：[LizardByte/Sunshine](https://github.com/LizardByte/Sunshine)  
iOS 客户端：[moonlight-stream/moonlight-ios](https://github.com/moonlight-stream/moonlight-ios)

Sunshine/Moonlight 原本面向游戏串流，核心优势是低延迟采集、硬件编码、网络自适应和多端输入。Sunshine 已包含 macOS ScreenCaptureKit 与 VideoToolbox 路线。

最值得研究：

- ScreenCaptureKit → VideoToolbox → 网络发送的低延迟管线；
- 码率、帧率、关键帧和弱网处理；
- 移动端触控、键鼠和手柄输入协议；
- 客户端配对和会话恢复；
- 指定应用启动与流媒体会话管理。

问题：产品模型偏游戏和整屏串流，不解决 App Profile、局部控件和语义动作；主机与客户端使用 GPL-3.0。

判断：性能和媒体管线参考价值很高，产品架构不能照搬。

### 9.3 macrdp + IronRDP：macOS 原生远控的重要候选

macOS 服务端：[clintcan/macrdp](https://github.com/clintcan/macrdp)  
RDP 协议库：[Devolutions/IronRDP](https://github.com/Devolutions/IronRDP)

macrdp 是基于 IronRDP 的原生 macOS RDP 服务端，已经覆盖屏幕、键鼠、剪贴板、文件、音频、H.264、认证和虚拟显示器。IronRDP 则提供模块化 Rust RDP 协议栈、WebAssembly 和客户端/服务端能力。

最值得研究：

- macOS 屏幕采集、输入转发、H.264 与权限处理；
- Retina、动态分辨率和虚拟显示器；
- RDP 的输入、剪贴板、音频和文件通道；
- IronRDP 的模块化协议层和 WebAssembly 客户端；
- MIT/Apache-2.0 双许可证带来的集成空间。

问题：macrdp 仍是 v0、小团队项目，当前强调可信局域网/VPN，且存在单会话、无多显示器等限制；RDP 天生以完整桌面为中心，局部窗口和手机快捷控件仍需自建。

判断：如果不想碰 AGPL/GPL，这是值得认真做技术探针的路线，但绝不能因为许可证漂亮就误判成熟度。

### 9.4 noVNC 与 Apache Guacamole：浏览器端快速原型

仓库：[novnc/noVNC](https://github.com/novnc/noVNC)  
客户端：[apache/guacamole-client](https://github.com/apache/guacamole-client)  
代理服务：[apache/guacamole-server](https://github.com/apache/guacamole-server)

noVNC 是可嵌入网页的 VNC 客户端，支持移动浏览器、缩放、剪裁、触控手势、剪贴板和多种编码。Guacamole 则通过代理把 VNC、RDP、SSH 等协议统一到浏览器。

最值得研究：

- PWA/网页里承载完整远控；
- 手机触控到鼠标动作的映射；
- WebSocket 连接和会话恢复；
- 将完整画面嵌入我们的逐级展开界面；
- Guacamole 的协议适配和网关分层。

问题：VNC 的交互和画面效率通常不如现代低延迟媒体管线；Guacamole 架构偏企业网关，拿来做轻量消费产品会很重。

判断：最适合快速验证“手机网页打开完整远控”，不一定适合作为最终体验。

### 9.5 MeshCentral：设备与会话管理参考

仓库：[Ylianst/MeshCentral](https://github.com/Ylianst/MeshCentral)

MeshCentral 是完整的 Web 设备管理平台，包含 agent、远程桌面、终端、文件管理、证书、2FA、浏览器到 agent 的中继和 WebRTC。

判断：重点参考设备注册、权限、会话审计、WebRTC 和中继，不要把整套 RMM 管理平台塞进 V1。

### 9.6 TigerVNC：传统协议实现参考

仓库：[TigerVNC/tigervnc](https://github.com/TigerVNC/tigervnc)

TigerVNC 是成熟的跨平台 VNC 实现，适合了解传统 framebuffer 更新、输入和编码。但它对“应用窗口切分、后台操作和手机控件重组”帮助有限。

### 9.7 路线选择

```text
最快得到完整远控产品
  → 研究或临时集成 RustDesk

最低延迟媒体链路
  → 研究 Sunshine / Moonlight

许可证友好的 macOS 原生技术探针
  → macrdp + IronRDP

最快得到网页远控原型
  → noVNC 或 Guacamole

最贴合最终产品、但工作量最大
  → ScreenCaptureKit + VideoToolbox/WebRTC + CGEvent 自建核心
```

最终产品未必能直接选一个项目 fork。我们的需求同时包含完整桌面、指定应用窗口、局部区域流、后台输入、AI Computer Use 和手机快捷控件，现有远控项目没有一个完整覆盖。

合理做法是先做三组技术探针：

1. RustDesk：验证复用完整远控栈需要改多少代码；
2. macrdp/IronRDP：验证许可证友好路线能否满足 macOS、手机和局部画面；
3. ScreenCaptureKit + WebRTC：验证自建最小核心的真实工作量和延迟。

完成探针后再选底座。现在拍脑袋认定某个开源仓库，十有八九会把项目绑死在错误协议和许可证上。

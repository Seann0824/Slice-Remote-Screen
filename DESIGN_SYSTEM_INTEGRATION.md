# Big Minds 设计系统接入方案

更新日期：2026-09-01

## 1. 决策

Slice Remote Screen 的 Web/PWA 直接采用 Big Minds 的设计系统，不再做第二套视觉规范。

当前上游：

- 仓库：`/Users/sean/Desktop/repo/big-minds`；
- 记录版本：`d58f18400e936699d7ad7d67d0183244618ac11f`；
- 设计规范：`docs/design-system.md`；
- 实现源：`app/src/styles/index.css`、`app/src/components/ui/`、`app/src/lib/theme.ts`。

Big Minds 当前不是一个可安装的设计系统 package。直接从另一个仓库 import 绝对路径或做 symlink 是破方案：本机能跑，CI、发布、其他贡献者环境全会炸。因此先抽取一份受版本控制的副本到当前仓库；以后两个项目都需要持续同步时，再把它提升为独立共享 package。

## 2. 保留什么

### 设计原则

- 温暖的近白 canvas，暗色主题保持相同语义层级；
- 连续工作台，不把每块内容都塞进带边框卡片；
- 低对比分隔线和浅 selected fill；
- 永久表面不用阴影，阴影只服务 Dialog、Sheet、Popover 等浮层；
- 主色只用于当前唯一主要动作，远控画面与数据仪表保持中性；
- 120—160ms 用于 hover/press/focus，200—260ms 用于面板切换，260—360ms 用于浮层；
- 标题可用 Songti，正文和操作使用 sans，延迟、帧率、设备 ID 等机器信息使用 mono。

### 代码资产

- Tailwind 4 CSS-first 语义 token；
- 亮暗主题和首屏防闪初始化；
- Radix primitives、shadcn new-york 组件结构和 Lucide 图标；
- Button、Card、Dialog、Input、Textarea、Tabs、ToggleGroup、Select、Popover、DropdownMenu、ScrollArea、Alert、Badge、Empty、Skeleton、Separator、Toaster、ConfirmDialog；
- 焦点可见性、触控目标、reduced-motion、Dialog/Sheet 响应式行为。

## 3. 不带什么

下面这些属于 Big Minds 产品，不属于设计系统：

- `.article-body` 的外部富文本样式；
- BlockNote 编辑器 override；
- 分享卡静态主题；
- Conversations、Workspace、Library 等领域组件；
- Big Minds 的 Logo、导航结构和产品文案；
- 旧产品名相关的品牌化存储键；
- `panel/subtle/subtle-alt` 旧迁移别名。

不做筛选就整包复制，会把无关 CSS、业务耦合和品牌残留全拖进来。这不是复用，是搬垃圾。

## 4. 当前仓库边界

```text
apps/mobile-web
    │
    ├── @slice/design-system
    │     ├── styles
    │     ├── theme
    │     └── ui primitives
    │
    ├── @slice/remote-ui
    │     ├── RemoteCanvas
    │     ├── DeviceCard
    │     ├── ConnectionStatus
    │     ├── ShortcutAppCard
    │     ├── SlicePreview
    │     ├── RemoteDock
    │     ├── ViewSwitcher
    │     ├── PairingSheet
    │     └── PermissionDialog
    │
    ├── @slice/protocol
    └── @slice/profile-schema
```

`design-system` 只知道通用视觉和交互；`remote-ui` 知道远控领域；页面负责数据获取、会话状态和路由。别把 WebRTC、设备状态机或 Profile 协议塞进 Button、Dialog 这种基础组件。

## 5. 页面映射

| Slice 界面 | Big Minds 设计语义 | 实现规则 |
|---|---|---|
| 设备首页 | canvas + 连续工作台 | 设备和快捷 App 用分组与 separator，避免卡片套卡片 |
| 当前设备 | selected | 浅选中态，不用高饱和整块底色 |
| 主连接按钮 | primary/accent | 同一屏只保留一个主要动作 |
| 在线、连接中、断开 | Badge + mono 元信息 | 状态文字必须存在，不能只靠颜色 |
| 快捷 App | surface/quiet | 常用操作直接可点，二级操作进菜单或 Sheet |
| 局部画面 | SlicePreview | 固定媒体画布，不跟随主题反色 |
| 完整窗口/桌面 | RemoteCanvas | 画面优先，控制层按需浮现，避免常驻厚重边框 |
| 层级切换 | Tabs 或 ViewSwitcher | 清楚显示“快捷 → 局部 → 窗口 → 桌面”当前位置 |
| 手机导航 | 轻量 RemoteDock | 最多 4 个稳定入口，不复制 Big Minds 的业务路由 |
| 配对与权限 | Dialog/移动端 Sheet | 标题、说明、风险和确认操作完整；危险操作使用 danger |
| 延迟/帧率/分辨率 | utility mono | 降级为辅助信息，不抢主任务注意力 |

## 6. 主题约束

- `html` 使用 `data-theme="light|dark"`；
- 主题存储键改为 `slice-remote-screen.theme`，不能沿用旧产品名的存储键；
- 入口脚本在 React mount 前执行主题初始化，避免首屏闪烁；
- 新组件只用语义 token，不写十六进制颜色、不写 `rgb()`、不随手用 Tailwind 原始色阶；
- 不为暗色主题在组件内堆 `dark:`，差异统一放在主题 token；
- 新增连接成功、警告等状态色时，必须在亮暗主题同时定义语义 token，并补文字或图标，不能只靠颜色表达。

## 7. 抽取流程

第一轮创建 `apps/mobile-web` 时执行：

1. 建立 `packages/design-system`，复制筛选后的 token、base styles、主题运行时和所需 primitives；
2. 将 Big Minds 路径和 commit 写入 `UPSTREAM.md`；
3. 把品牌化名称、路径 alias 和存储键改为 Slice 自己的值；
4. 删除内容产品、BlockNote 和分享卡专用 CSS；
5. 建立设计系统静态检查，禁止私有颜色、任意圆角、局部 dark 分支和旧迁移 token；
6. 为亮色、暗色、窄屏和 reduced-motion 各做一组组件截图测试；
7. 再开始写 `remote-ui` 业务组件。

上游同步必须是显式变更：记录新旧 commit，查看 token 和 component diff，通过视觉回归后合入。禁止启动时自动复制，也禁止静默跟随 Big Minds 工作区未提交文件。

## 8. 验收标准

- 手机端没有第二套颜色、圆角、阴影或主题实现；
- 亮暗主题无闪烁，媒体画面不被反色；
- 360px 宽度下主要远控动作单手可达，Dialog 转为底部 Sheet；
- 所有图标按钮有可访问名称，状态不只靠颜色；
- 键盘焦点可见，reduced-motion 生效；
- Big Minds 仓库不在时，Slice 仍能独立安装、构建和测试；
- `design-system` 不依赖 WebRTC、Profile 或任何远控业务代码。

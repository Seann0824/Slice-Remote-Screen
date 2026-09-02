# Slice Remote Screen

把 Mac 上的应用窗口投到手机浏览器，并从手机执行点击、拖拽、滚轮、文本输入和快捷键。

这是一个 macOS 原生 Host App + React 手机控制端项目。Host App 直接运行 WebRTC、ScreenCaptureKit 和 CGEvent，不包装浏览器，也不依赖本机 Node API。公网服务只负责账号、设备状态和 SDP/ICE 信令。

## 一键部署

环境要求：

- macOS 14+
- Swift 6 / Xcode Command Line Tools
- pnpm 10（仅从源码运行安装脚本时需要）

从干净的 macOS 环境开始：

```bash
git clone <your-repository-url> slice-remote-screen
cd slice-remote-screen
pnpm run install:mac
```

安装器会构建并安装 `~/Applications/Slice Remote Screen Host.app`，打开真正的 App 后由 App 自己请求屏幕录制和辅助功能权限。权限由 macOS 强制要求手动确认，脚本不能替用户点击授权。

### 安装 macOS Host App

安装器默认使用 `https://remote.englife.space`：

```bash
pnpm run install:mac
```

安装完成后会打开原生 Host App。输入邮箱和密码即可注册或登录，登录成功后当前 Mac 自动绑定到该账号，不需要复制或填写 token。

需要自定义服务器时，使用高级参数：

```bash
pnpm run install:mac -- --server https://remote.example.com
```

服务器地址默认值可以通过 `SLICE_DEFAULT_SIGNALING_SERVER` 覆盖，也可以加 `--no-open` 跳过自动打开 App。重复运行安装器会复用已安装的 Host App；只有原生 Swift 代码更新时才使用 `--refresh-app`。

安装完成后不需要再运行命令。直接双击 `~/Applications/Slice Remote Screen Host.app`，原生窗口会自动恢复账号会话并连接信令服务。App 内的“允许手机远程控制这台 Mac”开关会真实断开或恢复信令、WebRTC 和画面采集。

首次请求权限时，App 会自动打开 macOS 对应的“屏幕录制”或“辅助功能”设置页。macOS 仍要求你手动勾选权限，这是系统限制。

如果列表里没有 `Slice Remote Screen Host`，点击左下角“+”，按 `Command-Shift-G`，输入 `/Users/你的用户名/Applications/Slice Remote Screen Host.app`，点击“打开”后开启开关。不要选择仓库里的 `dist/SliceRemoteScreenHost.app`。开启权限后完全退出并重新打开 Host App，再点击“重新检查权限”；macOS 的录屏授权对正在运行的旧进程不会立即生效。

需要重新打开原生 App 时执行：

```bash
pnpm run open:host
```

卸载 App 但保留配置：

```bash
pnpm run uninstall:mac
```

确认连同本机配置、用户配置和日志一起删除：

```bash
pnpm run uninstall:mac -- --purge
```

当前安装器适合开源项目源码安装；它还不是签名的 DMG/PKG 分发包。macOS 不允许应用静默授予屏幕录制和辅助功能权限，首次安装必须由用户在系统设置中确认。生产分发应使用固定的 Apple Developer ID 签名，否则替换 ad-hoc 签名的二进制可能被 macOS 视为新程序。

开发构建会优先使用 `SLICE_MAC_SIGNING_IDENTITY` 或钥匙串中的第一个代码签名身份；没有证书时使用固定 Bundle ID 的本地 ad-hoc designated requirement，避免每次重编译都生成新的 TCC 身份。正式发布仍应配置 Apple Developer ID：

```bash
SLICE_MAC_SIGNING_IDENTITY="Developer ID Application: Example, Inc. (TEAMID)" pnpm run install:mac -- --refresh-app
```

账号和登录会话都保存在 signaling 的持久化 JSON 文件中；会话有效期为 30 天，服务重启后不需要重新登录。服务端只保存会话令牌的哈希，不保存密码。主动退出或会话过期后才需要重新登录。每个账号最多绑定一个 Mac，控制端和 Host 必须登录同一账号。

## 配置

复制 `.env.example` 为 `.env`。启动脚本会自动加载它：

```bash
cp .env.example .env
```

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SLICE_HOST` | `127.0.0.1` | 旧版本机 API 监听地址，仅开发模式使用 |
| `SLICE_PORT` | `4173` | 旧版本机 API 端口，仅开发模式使用 |
| `SLICE_PROFILE_PATH` | macOS Application Support | 旧版本机 API 配置位置 |

`.env` 含有访问凭据，不要提交。仓库只提交 `.env.example`。

## 公网 P2P 服务端

公网模式需要一台有公网 IP 的服务器。服务端只负责控制面：账号鉴权、Mac 自动绑定、在线状态和 SDP/ICE 转发。视频和输入走 WebRTC，优先两端直连，直连失败时才走 coturn；服务端不会收到解码后的视频。

当前服务端支持多账户，但还是轻量 MVP：每个账号绑定一个 Mac，可打开多个控制端。它还没有邮箱验证、找回密码、限流和后台管理，别把注册接口裸奔到不可信的公网环境。

### Docker Compose

服务器上准备 Docker Compose、域名和公网 IP：

```bash
cp .env.server.example .env.server
openssl rand -hex 32  # 填入 TURN_SECRET
docker compose --env-file .env.server up -d --build
```

编辑 `.env.server`，至少填写：

- `SIGNALING_ALLOWED_ORIGINS`：部署 Web 的 Origin，例如 `https://app.example.com`；原生 Host App 不需要加入本地 Origin；
- `TURN_SECRET`：必须和 coturn 使用的 secret 一致；
- `TURN_URLS`：公网可访问的 TURN 地址；
- `TURN_EXTERNAL_IP`：服务器公网 IP；
- `SIGNALING_PUBLISHED_PORT` / `TURN_PUBLISHED_PORT`：宿主机对外端口，已有服务占用默认端口时修改。

用 Nginx/Caddy 把 `https://app.example.com` 反向代理到 `127.0.0.1:8787`，必须保留 WebSocket Upgrade。示例见 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)。生产不要直接暴露明文 8787。

控制端打开：

```text
https://app.example.com/remote/
```

这里打开的是完整的应用蜂巢、窗口画布和区域操作 WebUI。它会登录同一 Slice 账号，通过 WebRTC DataChannel 获取 Mac 的应用目录、切换窗口、启动/关闭应用并发送输入；画面优先通过 WebRTC VideoTrack 传输，原生编码器不可用时会自动降级到独立的 P2P JPEG 帧通道，控制通道不会被画面数据阻塞。

`/remote/?mode=controller` 仍保留为极简全屏控制页，`/remote/?mode=host` 仅用于浏览器 Host 调试，不是日常控制入口。

控制端和原生 Host App 首次使用时可以注册账号，之后登录同一个账号。Host 登录后，服务端会自动登记当前 Mac，控制端随后可以直接连接，不再需要粘贴任何 token：

直接打开 `Slice Remote Screen Host.app`，在窗口中填写 `https://app.example.com`。

TURN relay 端口 `49160-49260/udp` 也必须在防火墙和云安全组放行。只开 3478 却不开放 relay 端口，TURN 配了也等于没配。

## 开发

```bash
pnpm install

# 终端一：公网信令服务
pnpm dev:signaling

# 终端二：Vite Web 开发服务器
pnpm dev:web
```

开发 Web 地址是 `http://127.0.0.1:5173/remote/`。原生 Host App 通过窗口中的服务端地址直接连接公网信令服务。

普通 Web 构建默认保留原来的本地/LAN 控制模式；显式加 `?mode=p2p` 可进入完整 P2P 控制端。Docker 信令镜像构建时默认进入 P2P，仍可用 `?mode=local` 调试旧本地链路。两种模式共用同一套应用蜂巢、全屏 App、区域画布和输入交互，只替换底层传输客户端。

提交前运行：

```bash
pnpm check
pnpm test
pnpm build
```

## 架构

```text
手机浏览器 ── HTTPS/WSS ──┐
                          ├─ signaling-server：鉴权、配对、SDP/ICE 转发
Mac 原生 Host App ─WSS ──┘                 │
          │                                │
          └────────── WebRTC 视频/输入 ─────┘
                         （直连或 coturn 中继）

SliceRemoteScreenHost.app
  ├─ SwiftUI：登录、状态和远程控制开关
  ├─ URLSession：账号会话和 WebSocket 信令
  ├─ WebRTC.framework：视频轨道和 DataChannel
  ├─ ScreenCaptureKit：屏幕与窗口采集
  └─ CGEvent：鼠标、键盘和文本输入
```

- `apps/mac-host`：SwiftUI、账号会话、WebRTC、屏幕采集、输入和 macOS 权限边界。
- `apps/local-host`：旧版本机 HTTP API 和 JPEG 帧流，仅用于兼容开发脚本，不参与原生 App 安装。
- `apps/mobile-web`：React 移动端控制台。
- `apps/signaling-server`：公网鉴权、设备配对、在线状态和 WebRTC 信令；不处理视频帧。
- `packages/protocol`：前后端共享的 Zod 协议 schema。
- `packages/design-system`：Web UI 组件和主题。

代码约定很简单：协议变化先改 `packages/protocol`；跨边界数据必须 schema 校验；路径和端口来自配置；非显而易见的权限、鉴权和帧协议逻辑必须写清楚原因，不写无意义的逐行注释。

## 当前限制

- 原生 Host 画面链路是 `ScreenCaptureKit → WebRTC VideoTrack`，视频不经过公网信令服务。
- P2P 模式默认使用 STUN；服务端配置 `TURN_URLS` 和 `TURN_SECRET` 后会提供临时 TURN 凭证。对称 NAT、企业防火墙或 UDP 受限网络仍可能连接失败。
- 尚无音频、剪贴板同步、Developer ID 签名、菜单栏生命周期和自动更新。
- LAN 模式只适合可信局域网测试，不是公网产品。

## 开源协作

请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题不要公开提 issue，按 [SECURITY.md](SECURITY.md) 联系维护者。

本项目采用 [MIT License](LICENSE)。

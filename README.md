# Slice Remote Screen

把 Mac 上的应用窗口投到手机浏览器，并从手机执行点击、拖拽、滚轮、文本输入和快捷键。

这是一个 macOS 原生 Host + Node API + React Web 控制台项目。它依赖 ScreenCaptureKit 和 macOS TCC 权限，所以部署目标是 **macOS 主机**；把它硬塞进 Linux Docker 容器不能提供屏幕录制和辅助功能权限，项目不提供这种伪部署方案。

## 一键部署

环境要求：

- macOS 14+
- Node.js 22+
- pnpm 10
- Swift 6 / Xcode Command Line Tools

从干净的 macOS 环境开始：

```bash
git clone <your-repository-url> slice-remote-screen
cd slice-remote-screen
pnpm run bootstrap
```

`bootstrap` 会完成依赖安装、协议/API/Web 构建、macOS Host `.app` 组装与 ad-hoc 签名，并请求屏幕录制和辅助功能权限。服务随后监听 `127.0.0.1:4173`，打开：

```text
http://127.0.0.1:4173/remote/
```

手机访问同一局域网时：

```bash
pnpm run bootstrap -- --lan
```

LAN 模式监听 `0.0.0.0`，没有显式 token 时自动生成随机 token，并把带 token 的地址打印到终端。不要把 4173 端口转发到公网：当前是 HTTP + bearer token，不能抵抗同网段窃听。公网使用必须增加 HTTPS、设备配对和更严格的会话管理。

如果权限弹窗被跳过或授权给了旧二进制，在“系统设置 → 隐私与安全性”中给 **Slice Remote Screen Host** 授权，然后重新启动服务。代码更新后重新执行 `pnpm run bootstrap`；平时无需重复构建：

```bash
pnpm start       # 仅本机
pnpm start:lan   # 局域网，自动生成 token
```

## 配置

复制 `.env.example` 为 `.env`。启动脚本会自动加载它：

```bash
cp .env.example .env
```

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SLICE_HOST` | `127.0.0.1` | 监听地址；非 loopback 必须配置 token |
| `SLICE_PORT` | `4173` | API 和静态 Web 端口 |
| `SLICE_TOKEN` | 空 | 非本机监听时至少 16 个字符 |
| `SLICE_NATIVE_BINARY` | 构建产物路径 | 覆盖 macOS Host 可执行文件路径 |
| `SLICE_WEB_ROOT` | `apps/mobile-web/dist` | 覆盖静态 Web 根目录 |
| `SLICE_PROFILE_PATH` | macOS Application Support | App 区域配置保存位置 |

`.env` 含有访问凭据，不要提交。仓库只提交 `.env.example`。

## 公网 P2P 服务端

公网模式需要一台有公网 IP 的服务器。服务端只负责控制面：管理员鉴权、Mac 设备配对、在线状态和 SDP/ICE 转发。视频和输入走 WebRTC，优先两端直连，直连失败时才走 coturn；服务端不会收到解码后的视频。

当前服务端是单租户 MVP：一个管理员、一个 Mac、一个控制端。它不是多用户 SaaS，别把这个破版本直接拿去给一堆陌生用户共用。

### Docker Compose

服务器上准备 Docker Compose、域名和公网 IP：

```bash
cp .env.server.example .env.server
openssl rand -hex 32  # 填入 SIGNALING_ADMIN_TOKEN
openssl rand -hex 32  # 填入 TURN_SECRET
docker compose up -d --build
```

编辑 `.env.server`，至少填写：

- `SIGNALING_ADMIN_TOKEN`：控制端登录 token；
- `SIGNALING_ALLOWED_ORIGINS`：部署 Web 的 HTTPS Origin；
- `TURN_SECRET`：必须和 coturn 使用的 secret 一致；
- `TURN_URLS`：公网可访问的 TURN 地址；
- `TURN_EXTERNAL_IP`：服务器公网 IP。

用 Nginx/Caddy 把 `https://app.example.com` 反向代理到 `127.0.0.1:8787`，必须保留 WebSocket Upgrade。示例见 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)。生产不要直接暴露明文 8787。

控制端打开：

```text
https://app.example.com/remote/?mode=controller&token=<SIGNALING_ADMIN_TOKEN>
```

生成设备密钥后，Mac 本地打开下面的地址，把 `<DEVICE_TOKEN>` 换成刚生成的密钥：

```text
http://127.0.0.1:4173/remote/?mode=host&server=https://app.example.com&token=<DEVICE_TOKEN>
```

TURN relay 端口 `49160-49260/udp` 也必须在防火墙和云安全组放行。只开 3478 却不开放 relay 端口，TURN 配了也等于没配。

## 开发

```bash
pnpm install

# 终端一：API + macOS Host
pnpm dev:api

# 终端二：Vite Web 开发服务器
pnpm dev:web
```

开发 Web 地址是 `http://127.0.0.1:5173/remote/`，Vite 会把 `/remote/api` 和 WebSocket 代理到 4173。

提交前运行：

```bash
pnpm check
pnpm test
pnpm build
```

## 架构

```text
手机浏览器
  ├─ HTTP API / WebSocket
  └─ WebRTC 信令（可选 P2P 模式）
          ↓
Node local-host
          ↓ 子进程 + 长度前缀帧协议
SliceRemoteScreenHost.app
  ├─ ScreenCaptureKit：屏幕与窗口采集
  └─ CGEvent：鼠标、键盘和文本输入
```

- `apps/mac-host`：Swift 原生能力和 macOS 权限边界。
- `apps/local-host`：HTTP API、WebSocket 帧流、鉴权、配置持久化。
- `apps/mobile-web`：React 移动端控制台。
- `packages/protocol`：前后端共享的 Zod 协议 schema。
- `packages/design-system`：Web UI 组件和主题。

代码约定很简单：协议变化先改 `packages/protocol`；跨边界数据必须 schema 校验；路径和端口来自配置；非显而易见的权限、鉴权和帧协议逻辑必须写清楚原因，不写无意义的逐行注释。

## 当前限制

- 当前画面链路是 `ScreenCaptureKit → JPEG → WebSocket → Canvas`，用于验证交互链路，不适合长期高画质远控。
- P2P 模式只使用 STUN，没有 TURN；对称 NAT 或企业网络可能连接失败。
- 尚无音频、剪贴板同步、Developer ID 签名、菜单栏生命周期和自动更新。
- LAN 模式只适合可信局域网测试，不是公网产品。

## 开源协作

请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题不要公开提 issue，按 [SECURITY.md](SECURITY.md) 联系维护者。

本项目采用 [MIT License](LICENSE)。

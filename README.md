# Slice Remote Screen

当前 MVP 已经是一条可运行的本地闭环，不是静态原型：

```text
手机/浏览器控制台
  → HTTP 控制 API + WebSocket 画面流
  → 稳定 bundle ID 的 macOS Host.app
  → ScreenCaptureKit 持续 SCStream
  → 15fps JPEG 帧流
  → CGEvent 点击、文本和快捷键
```

支持：

- 枚举完整显示器和可见应用窗口；
- 从 macOS `.app` 提取真实应用图标，并以蜂窝盘选择应用；
- 持续采集指定窗口或完整桌面；
- 在远程画面上按归一化坐标点击；
- 为每个应用保存多个归一化实时交互区域；
- 多个区域复用同一条应用视频流，只在手机端裁剪；
- 将区域内点击换算回应用窗口坐标；
- 将单击、双击、长按、拖拽、双指滚动和鼠标实时输入映射到电脑；
- 完整窗口与多个局部区域复用通用归一化输入协议；
- 在“应用 → 交互区域 → 完整 App → 完整桌面”之间切换；
- Big Minds 设计系统的亮暗主题和移动端布局；
- 局域网暴露时强制 token。

## 环境

- macOS 14 或更高；
- Swift 6 / Xcode Command Line Tools；
- Node.js 22；
- pnpm 10。

完整 Xcode 目前不是硬依赖。构建脚本会把 Swift Package 产物组装并 ad-hoc 签名为 `dist/SliceRemoteScreenHost.app`，避免 macOS 26 把每次截图子进程识别成不稳定的裸 CLI。

## 本机运行

```bash
pnpm install
pnpm build
pnpm host:permissions
pnpm mvp
```

在 macOS 系统设置中给 `slice-mac-host` 或启动它的终端授权：

1. 隐私与安全性 → 屏幕与系统音频录制 → Slice Remote Screen Host；
2. 隐私与安全性 → 辅助功能 → Slice Remote Screen Host。

如果以前只给 Terminal、Codex 或旧裸二进制授权，那份权限不算。必须给新的 `Slice Remote Screen Host.app` 授权。授权后完全退出 Host，再运行 `pnpm mvp`。日常启动只需运行 `pnpm mvp`，它不会重复构建或重签 Host；代码更新后才运行 `pnpm mvp:build`。打开：

```text
http://127.0.0.1:4173/remote/
```

## 拾文点对点连接

Mac 端继续运行 `pnpm mvp`，然后打开：

```text
http://127.0.0.1:4173/remote/?mode=host
```

首次使用时，在拾文 `/remote` 生成 Mac 绑定密钥，填到 Mac 页面并点击“保存并上线”。密钥会保存
在本机浏览器中；以后运行 `pnpm mvp` 并打开 Host 页面后，Mac 会自动向拾文报到，不需要再次输入。
拾文服务器只转发 WebRTC offer、answer 和 ICE，画面与控制数据通过 WebRTC 直接在手机和 Mac
之间传输。这里只使用 STUN 发现公网地址，没有 TURN、媒体中转、Docker 或额外服务。

## 手机局域网访问

直接启动局域网模式；脚本会生成随机 token 并监听 `0.0.0.0`：

```bash
pnpm mvp:lan
```

终端会打印带 token 的手机访问地址。当前链路是 HTTP + bearer token，只适合可信局域网测试。别在酒店、公司公共网络或公网端口转发上裸跑；token 在纯 HTTP 下不能抵抗同网段窃听。公网版本必须上 HTTPS、设备配对和 WebRTC DTLS。

`pnpm mvp` 故意只监听 `127.0.0.1`，用于本机开发；手机访问必须使用 `pnpm mvp:lan`。

## 开发

```bash
# 终端一：本地 API
pnpm dev:api

# 终端二：Vite 前端
pnpm dev:web
```

Vite 地址为 `http://127.0.0.1:5173/remote/`，`/remote/api` 会去掉挂载前缀后代理到
`4173`。

## 验证

```bash
pnpm check
pnpm test
pnpm build
```

## 目录

```text
apps/mac-host             Swift / ScreenCaptureKit / CGEvent
apps/local-host           本地 HTTP API 与静态页面服务
apps/mobile-web           React 移动控制台
packages/protocol         Zod 协议 schema
packages/design-system    从 Big Minds 筛选抽取的设计系统
```

## 当前限制

- 画面已改为持续 `SCStream → JPEG → WebSocket → Canvas`，默认 15fps；它比旧 PNG 轮询快得多，但仍不是最终的硬件视频链路；
- 已支持点击、双击、拖拽、滚轮、长按右键、文本和基础组合键；尚无可视化组合键编辑器、剪贴板同步和音频；
- App Profile 与自定义区域保存在 Mac Host 的 Application Support，电脑端配置后手机直接读取；
- Host 已组装为 ad-hoc 签名 `.app` 以稳定 TCC 身份，但还没有正式 Developer ID 签名、菜单栏生命周期和自动更新；
- 纯 P2P 模式没有 TURN；对称 NAT 或严格企业网络下可能无法建立连接。

下一步应把 Canvas/JPEG 画面源替换为 `VideoToolbox H.264 → WebRTC`，加入拥塞控制和关键帧请求；
JPEG 只能验证链路，带宽和耗电都不适合长期远控。

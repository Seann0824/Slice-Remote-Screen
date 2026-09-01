# Contributing

## 开始之前

项目目前只支持 macOS，因为原生 Host 使用 ScreenCaptureKit、ApplicationServices 和 CGEvent。提交前准备 Node.js 22、pnpm 10 和 Swift 6。

```bash
pnpm install
pnpm check
pnpm test
```

## 代码要求

- 保持函数和变量名表达真实意图；不要用 `data`、`value`、`handleThing` 这类垃圾命名掩盖业务含义。
- 协议边界使用 `packages/protocol` 的 schema 校验，不要在前后端各写一套互相漂移的类型。
- 鉴权、权限、子进程和二进制帧协议的注释解释“为什么”，不要复述代码做了什么。
- 改动交互或协议时补测试；不要为了让测试变绿删掉安全校验。
- 不提交 `.env`、token、macOS 构建产物或个人配置文件。

## Pull Request

描述改动原因、验证命令和 macOS 权限相关的人工验证步骤。PR 必须说明是否改变 API、WebSocket 消息或本地持久化格式。

# 来源

独立插件实现：潘涛 Studio，2026-11-12，为潘涛本机 Buzz 使用准备。

宿主契约与行为依据：

- [官方 Plugin architecture（固定 267.1 源码）](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/docs/plugin-architecture.md)
- [公开作者类型](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/src/plugins/author.ts)
- [频道面板契约](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/src/features/panels/service.ts)
- [宿主精确消息读取](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/src/features/relay/session.ts)

运行时复用宿主提供的 React 与 conversation.ui，不附带第三方运行库或上游图片资源。
媒体 URI 校验按宿主规范实现；无客户端私有模块的运行时导入。

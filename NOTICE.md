# 来源

独立插件实现：潘涛 Studio，2026-11-12，为潘涛本机 Buzz 使用准备。

宿主契约与行为依据：

- [官方 Plugin architecture（固定 267.1 源码）](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/docs/plugin-architecture.md)
- [公开作者类型](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/src/plugins/author.ts)
- [频道面板契约](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/src/features/panels/service.ts)
- [宿主精确消息读取](https://github.com/block/buzz-app/blob/0c66ed068a5d60139a8041558993b45f3351069a/src/features/relay/session.ts)

运行时复用宿主提供的 React 与 conversation.ui，不附带第三方运行库或上游图片资源。
媒体 URI 校验按宿主规范实现；无客户端私有模块的运行时导入。


Tabler Icons — Copyright (c) 2020-2026 Paweł Kuna. MIT License.
https://github.com/tabler/tabler-icons

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

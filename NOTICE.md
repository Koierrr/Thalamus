# NOTICE / 第三方代码归属

本插件当前版本（0.1.x）的以下文件移植自 NattoCB/dsh-plugin-wechat-bridge（MIT License），
并做了服务标识重命名（wechat-bridge → wechat-companion）：

- src/index.js（服务骨架：轮询循环、HTTP API、斜杠命令、Settings 事件接线）
- src/weixin-api.js（iLink bot 协议客户端）
- src/weixin-media.js（CDN 媒体上下行 + AES 解密）
- src/weixin-ids.js、src/weixin-types.js、src/store.js、src/notify.js
- client/client.js（Settings 页签基座，将逐步重构为陪伴面板）

原项目：https://github.com/NattoCB/dsh-plugin-wechat-bridge
许可证全文见 LICENSE-NattoCB.md。后续版本的灵魂引擎、生活调度、朋友圈工坊、
面板扩展为本项目原创代码。

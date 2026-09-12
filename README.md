# Thalamus · 最深处的那个房间

> **θάλαμος** —— 荷马史诗里，屋子里最深处的那个房间；也是大脑中接住情绪的那枚丘脑。
> 这里住着一个她。

一个 DeepSeek Harness (DSH) 插件：让一个独立的微信号成为一个有性格、有生活、
会对主人特殊的 AI 伴侣。个人娱乐项目，非商用。

> 包名 `dsh-wechat-companion`，仓库名 **Thalamus**。

## 能力蓝图
- **消息收发**：微信 iLink 官方 bot 通道（ilinkai.weixin.qq.com，扫码绑定，
  不 hook 客户端）——协议层移植自 NattoCB/dsh-plugin-wechat-bridge (MIT)。
- **她的灵魂**：人设（可编辑）、长期记忆、情绪状态、对 ownerPeerId（主人）特殊对待。
- **模型服务**：OpenAI 兼容中转站（硅基流动等），填 BaseURL+Key 拉取模型列表，
  按 对话/生图/TTS 三角色下拉选模型。
- **她的生活**：作息表、主动找主人、朋友圈工坊（联网找灵感→写文案→虚拟形象AI生图→
  PC客户端UI自动化发布，低频）。
- **她的房间**（二期）：安卓/PWA 网页，真语音通话、推送、相册。

## 路线图（当前进度见 todo）
阶段0 侦察与版本对齐 ✅ → 阶段1 骨架+收发+灵魂+后台（进行中）
→ 阶段2 主动消息+朋友圈 → 阶段3 TTS语音条 → 阶段4 她的房间

## 开发约定
- 语言：JS (ESM)，服务端 cordis service + 客户端 Settings 页签（React）。
- 安装：复制本目录到 ~/.dsh/profiles/desktop/node_modules/，
  在 ~/.dsh/profiles/desktop/package.json 的 dependencies 加
  "dsh-wechat-companion": "file:<本目录>"，并在 dsh.profile.bundles 注册，
  重启 DSH Desktop 生效。
- 配置：~/.dsh/settings.yaml 的 wechat-companion: 段，热重载。
- 状态：~/.dsh/wechat-companion/state.json（账号token、记忆索引、作息表）。

## 安全与合规
- 仅用于用户本人的小号，个人娱乐。封号风险自知，操作保持低频拟人。
- token 明文风险：后续版本加密落盘。
- 黑白名单 fail-closed 的反面：本插件默认回复所有人（用户明确需求），
  ownerPeerId 特殊；敏感指令（操控电脑类）永不允许来自微信。

// dsh-wechat-companion
//
// A DSH cordis bundle that bridges WeChat (ilink bot) private-chat messages into
// a DSH agent session, and sends the agent's reply back as plain text.
//
// One session per peer per calendar day (local timezone): the first inbound
// message after local midnight lazily creates that day's session, titled
// "<YYYY-MM-DD>". Days without conversation never materialize a session.
//
// One-way session notifications (opt-in, settings `notifyEnabled`): every
// TOP-LEVEL DSH session's finished turn pings the allowlisted peers with a
// short fixed-template message. Strictly outbound — never written into any
// session, so the daily bridge conversation and the notifications cannot
// pollute each other.
//
// Runtime enable/disable (hot plug):
//   - Boot reads settings `wechatCompanion.enabled`. If true, the poll loop starts.
//   - The `settings/updated` event re-reads the flag and starts/stops live.
//   - The `/wechat` slash command toggles enable/disable/status without editing
//     files, and writes the flag back to settings.yaml so it persists.
//
// Ported from CodePilot's bridge subsystem (src/lib/bridge/adapters/weixin/*).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { Store } from './store.js';
import {
  getUpdates,
  sendMessage,
  sendTextMessage,
  sendTyping,
  getConfig,
  startLoginQr,
  pollLoginQrStatus,
} from './weixin-api.js';
import { encodeWeixinChatId, decodeWeixinChatId } from './weixin-ids.js';
import { ERRCODE_SESSION_EXPIRED } from './weixin-types.js';
import { downloadMediaFromItem, uploadMediaToCdn } from './weixin-media.js';
import { filterCommands, emptyUsage, usageLine, CMD_KIND, RECENT_KEEP } from './commands.js';
import { matchStickerName, readSticker, listStickers, addSticker, removeSticker, setStickerEnabled } from './stickers.js';
import { Promises } from './promises.js';
import { longingCurve, longingLine } from './longing.js';
import { birthdayInfo } from './birthday.js';
import { parseInboundText } from './inbound.js';
import { proactiveLimit, toneForToday, nowDoing, COMMON_SENSE } from './soul.js';
import { inferJob, JOB_TYPES, guessJobType } from './job.js';
import { formatTurnErrorReply, formatTurnNotification, shouldNotifySession, stripMarkup, findWorkspaceIdForSession, isWorkspaceMuted } from './notify.js';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ModelRouter, fetchModels, embedText } from './model-router.js';
import { Soul } from './soul.js';
import { MemoryEmbed } from './memory-embed.js';
import { reviewReply as selfCheckReview } from './selfcheck.js';
import { Life } from './life.js';
import { MomentsWorkshop } from './moments.js';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { isSilk, silkToWav } from './audio.js';
import { PersonaWorkshop } from './persona-workshop.js';
import QRCode from 'qrcode';
import { spawn } from 'node:child_process';
import { MemoryClient } from './memory-client.js';
import { todayState, applyDayEvent, DAY_EVENT_LABEL } from './daily.js';
import { decideRename } from './rename.js';
import { runModelTest } from './model-test.js';
import { AvatarWorkshop, ANGLES } from './avatar.js';
import { WorldEngine } from './world-engine.js';
import { Deform } from './deform.js';
import { FEATURE_STATUS, featureGroups } from './feature-status.js';

const name = 'wechat-companion';
// kebab-case required by DSH settings namespace validation.
const SETTINGS_NS = 'wechat-companion';
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(false),
  mediaEnabled: z.boolean().default(true),
  defaultProvider: z.string().default(''),
  defaultModel: z.string().default(''),
  // Fail-closed inbound allowlist: comma-separated WeChat ids (from_user_id).
  // An unset/blank value means NOBODY may drive the agent. Plain string on
  // purpose so the Settings UI renders it as a regular text field.
  allowedPeers: z.string().default(''),
  // One-way session turn-end notifications to the allowlisted peers. Default
  // ON: the Settings tab renders a toggle (persisted via settings.yaml).
  notifyEnabled: z.boolean().default(true),
  // Workspaces whose sessions never trigger one-way notifications. Stored as
  // [{id,title}] so the Settings UI can render labels without re-fetching;
  // membership checks use `id`. Empty = notify everywhere.
  notifyMutedWorkspaces: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
});

/**
 * Leading system-reminder injected into every WeChat session. The interactive
 * option UI (the `ask_user_question` tool) is fully wired here — the same
 * `userQuestions` provider that powers normal GUI sessions is live in the
 * `dsh web` process — but its human-answer channel is the DSH web GUI, not
 * WeChat. Options render in the browser; the phone peer sees nothing and
 * cannot click, so unless someone operates the desktop UI the agent blocks
 * forever and the WeChat reply never arrives. Instruct the model to inline
 * questions + options as plain text on the WeChat side instead.
 */
const WECHAT_INTERACTION_GUARD = [
  '<system-reminder>',
  'WeChat bridge session — interactive option UI is routed to the DSH web GUI, NOT to WeChat.',
  '',
  'This session is driven by a WeChat private-chat message and replies as plain text. The `ask_user_question` tool works here, but its answer channel is the DSH web browser UI: the options render there, the phone user neither sees nor can click them. If nobody operates the desktop UI, the agent blocks forever and the WeChat reply never arrives.',
  '',
  'HARD RULE:',
  '- NEVER call `ask_user_question` or any tool that renders interactive options/buttons for this WeChat session — the answer lives on the desktop GUI, not on the phone.',
  '- When you need the user to choose, decide, or confirm, put the question AND every candidate option directly into your WeChat text reply (e.g. numbered or lettered options, each with a one-line explanation), and ask the user to reply with their selection as a normal WeChat message.',
  '- The user\'s next plain-text message automatically drives this same daily session again, so the conversation continues naturally — no UI click required.',
  '- Open questions are fine as plain text; just never route them through the interactive option-rendering tool.',
  '',
  '微信(手机)侧看不到也不会渲染 DSH 界面里的可点击选项:选项只弹在浏览器 GUI 上,手机用户无法点选,无人操作电脑界面时 agent 会一直阻塞、微信回复永远到不了。请勿使用 `ask_user_question` 之类的交互式选项工具;需要用户选择时,把问题和各个选项直接写成纯文本回复,让用户以普通微信消息回复即可;下一条消息会自动继续当天会话。',
  '</system-reminder>',
].join('\n');

/** Local-calendar day key YYYY-MM-DD in this machine's timezone. */
function localDateKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function chunkText(text, limit) {
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

const DSH_DOT_DIR = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');

// 控制台 HTML 的绝对路径。必须在模块作用域算好：请求处理函数里有一个局部变量也叫 path（路由字符串），
// 会在那个作用域里遮蔽 node:path 模块，直接用 path.join 会抛 "path.join is not a function" 被下面的
// try/catch 静默吞掉 —— 结果永远伺服启动时烘焙的那份旧 console.html，改前端必须重启 DSH 才生效。
// 请求处理函数里有一个局部变量也叫 path（路由字符串），会遮蔽 node:path ——
// 处理函数内一律用 joinPath/absPath 这类模块作用域别名，别再直接写 path.join。
const joinPath = (...parts) => path.join(...parts);
const dirNameOf = (f) => path.dirname(f);
const CONSOLE_FILE = joinPath(dirNameOf(fileURLToPath(import.meta.url)), 'console.html');

let CONSOLE_HTML = '';
try { CONSOLE_HTML = fs.readFileSync(CONSOLE_FILE, 'utf8'); } catch (err) { CONSOLE_HTML = '<h1>console.html 缺失</h1>'; }

const ROOM_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN"><head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>她的房间</title>',
  '<style>',
  'body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f2f3f5}',
  'header{padding:10px 14px;background:#ededed;font-size:14px;color:#555;text-align:center;position:sticky;top:0}',
  '#chat{padding:12px;display:flex;flex-direction:column;gap:8px;min-height:72vh}',
  '.b{max-width:78%;padding:8px 12px;border-radius:10px;font-size:15px;line-height:1.45;white-space:pre-wrap;word-break:break-word}',
  '.her{background:#fff;align-self:flex-start}',
  '.me{background:#95ec69;align-self:flex-end}',
  '.err{color:#c00;align-self:center;font-size:12px}',
  '#f{display:flex;gap:8px;padding:10px;position:sticky;bottom:0;background:#f2f3f5}',
  '#t{flex:1;padding:10px;border:none;border-radius:8px;font-size:15px;outline:none}',
  'button{padding:10px 16px;border:none;background:#07c160;color:#fff;border-radius:8px;font-size:15px}',
  '</style></head><body>',
  '<header>她的房间 · <span id="hn">…</span><a href="/wechat-companion/console" target="_blank" style="float:right;color:#576b95;font-size:13px;text-decoration:none">后台</a></header>',
  '<div id="chat"></div>',
  '<form id="f"><input id="t" placeholder="跟她说点什么…" autocomplete="off"><button>发送</button></form>',
  '<script>',
  'var chat=document.getElementById("chat");',
  'function bubble(c,t){var d=document.createElement("div");d.className="b "+c;d.textContent=t;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;}',
  'function ckey(){try{return localStorage.getItem("ckey")||""}catch(e){return ""}}',
  'function j(m,p,b){var k=ckey();return fetch("/wechat-companion/"+p+(k?((p.indexOf("?")<0?"?":"&")+"key="+encodeURIComponent(k)):""),{method:m,headers:b?{"content-type":"application/json"}:undefined,body:b?JSON.stringify(b):undefined}).then(function(r){return r.json()})}',
  '(function(){try{var m=/[?&]key=([^&]*)/.exec(location.search);if(m){localStorage.setItem("ckey",decodeURIComponent(m[1]));history.replaceState(null,"",location.pathname)}}catch(e){}})();',
  'j("GET","panel/persona").then(function(p){document.getElementById("hn").textContent=(p.persona&&p.persona.name)||"她";});',
  'j("GET","panel/mem-engine").then(function(r){if(r.running)document.getElementById("hn").textContent+=" · 记忆引擎✅";}).catch(function(){});',
  'bubble("her","我在这儿呢 ~ 点下面跟我说话吧");',
  'document.getElementById("f").onsubmit=function(e){e.preventDefault();var inp=document.getElementById("t");var t=inp.value.trim();if(!t)return;bubble("me",t);inp.value="";',
  ' j("POST","panel/soul-test",{text:t,record:true,peerKey:"room"}).then(function(r){(r.chunks||[]).forEach(function(c){bubble("her",c)});if(r.error)bubble("err",r.error)}).catch(function(){bubble("err","网络异常，稍后再试")});};',
  '</script></body></html>',
].join('\n');

export const apply = (ctx, config) => {
  new WeixinBridgeService(ctx, config);
};

class WeixinBridgeService {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config || {};
    this.store = new Store(this.config.dataDir || '');
    this.companionDir = path.join(
      DSH_DOT_DIR,
      'wechat-companion',
    );
    this.router = new ModelRouter(() => this._modelConfig());
    this.embed = new MemoryEmbed({
      dir: this.companionDir,
      ollamaUrl: (this._modelConfig().embed && this._modelConfig().embed.url) || (this._modelConfig().ollama && this._modelConfig().ollama.url) || 'http://127.0.0.1:11434',
      embedModel: (this._modelConfig().embed && (this._modelConfig().embed.model || this._modelConfig().embed.embedModel)) || (this._modelConfig().ollama && this._modelConfig().ollama.embedModel) || 'bge-m3',
      embedFn: (text) => this._embedTextFor(text),
      logger: (m) => this.ctx.logger?.info?.(m),
    });
    this._activity = [];
    this.memClient = new MemoryClient(() => {
      const m = this._modelConfig().memory || {};
      return m.sidecarUrl || 'http://127.0.0.1:43122';
    });
    this._memEngineSpawned = false;
    this._memEngineWasUp = false;
    this._memRestarting = false;
    this._svcLastJson = '';
    this._wxautoCounts = null;
    this.soul = new Soul({
      dir: this.companionDir,
      router: this.router,
      embed: this.embed,
      memory: this.memClient,
      behavior: () => {
        const c = this._modelConfig();
        // 第三次改版：「他是谁」退场（她从零认识你，认知全部来自记忆）
        return { ...(c.behavior || {}), memory: c.memory || {}, params: c.params || {} };
      },
      logger: (m) => this.ctx.logger?.info?.(m),
    });
    this.life = new Life({ dir: this.companionDir, config: () => this._modelConfig(), logger: (m) => this.ctx.logger?.info?.(m) });
    // 承诺闭环（批 E3 / A8）：到期职责的唯一权威；独立状态文件，复用现有 60 秒心跳
    this.promises = new Promises({
      dir: this.companionDir,
      soul: this.soul,
      config: () => this._modelConfig(),
      logger: (m) => this.ctx.logger?.info?.(m),
      activity: (t) => this.activity(t),
    });
    this.moments = new MomentsWorkshop({ dir: this.companionDir, router: () => this.router, soul: this.soul, config: () => this._modelConfig(), logger: (m) => this.ctx.logger?.info?.(m) });
    this.workshop = new PersonaWorkshop({ soul: this.soul, router: () => this.router, config: () => this._modelConfig(), sessionFile: path.join(this.companionDir, 'workshop-sessions.json'), logger: (m) => this.ctx.logger?.info?.(m) });
    this.world = new WorldEngine({ dir: this.companionDir, router: () => this.router, config: () => this._modelConfig(), soul: this.soul, logger: (m) => this.ctx.logger?.info?.(m) });
    this.avatar = new AvatarWorkshop({ dir: this.companionDir, routerGet: () => this.router, soul: this.soul, cfgGet: () => this._modelConfig(), logger: (m) => this.ctx.logger?.info?.(m) });
    this.deform = new Deform(this.companionDir, (m) => this.ctx.logger?.info?.(m), () => this._modelConfig(), () => (this.soul && this.soul.getPersona ? this.soul.getPersona().traits : null));
    this.soul.deform = this.deform;
    this._worldBusy = false;
    this._renameBusy = false;
    this._lifeTimer = null;
    this._lastInboundAt = null;
    this._inboundCount = 0;
    this._intServer = null;
    this._intPort = null;
    const tryListen = (port) => {
      const srv = http.createServer((req, res) => {
        try { var u = req.url || '/'; if (u.indexOf('/wechat-companion') !== 0) u = '/wechat-companion' + u; req.url = u; this.httpHandler(req, res); } catch (e) { try { res.writeHead(500); res.end('err'); } catch {} }
      });
      srv.on('error', () => { if (port < 43124) tryListen(port + 1); else this.ctx.logger?.warn?.('[wechat-companion] 独立后台端口全部占用'); });
      srv.listen(port, '127.0.0.1', () => {
        this._intServer = srv;
        this._intPort = port;
        this.ctx.logger?.info?.('[wechat-companion] 独立后台已就绪: http://127.0.0.1:' + port + '/console');
      });
    };
    tryListen(43121);
    void this.embed.warmup();
    void this._ensureMemoryEngine();
    this.running = false;
    this._stop = null;
    this._loginSessions = new Map(); // qr sessionId -> { qrcode, qrImage, status, ... }
    this._pauses = new Map(); // accountId -> resumeAt
    this._accountHealth = new Map(); // accountId -> { state, at } (e.g. session-expired)
    this._notifyBacklog = []; // {peer, text, at} — pushes that failed on a stale context_token
    this._lastNotifyResult = null; // { at, ok, failed, error } — surfaced via /status
    this._typingTickets = new Map(); // `accountId:peer` -> ticket
    this._driveQueues = new Map(); // chatId -> promise chain (serializes _driveAgent per chat)
    // Cross-process poll lock: only one DSH process may poll WeChat accounts.
    // A second process (launchd keep-alive racing a manual restart) would
    // otherwise poll the same account twice and interleave writes into the
    // same session log — the seq-gap corruption trigger.
    this._pollLockPath = path.join(
      DSH_DOT_DIR,
      'wechat-companion', 'poll.lock',
    );
    this._pollLockHeld = false;
    this._pollLockTimer = null;

    // Release the poll lock on service dispose (graceful shutdown path).
    ctx.on('dispose', () => { try { this._intServer?.close(); } catch {} void this._releasePollLock(); });

    // Sessions are created under <DSH_HOME>/wechat-companion/WeChatSpace by
    // default; make sure it exists before the first inbound message.
    try {
      fs.mkdirSync(this.workspaceDir(), { recursive: true });
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] workspace dir create failed: ${err.message}`);
    }

    ctx.commands?.register({
      name: 'companion',
      description: 'Control the WeChat (ilink bot) bridge: enable / disable / status / qrlogin / accounts',
      input: { hint: '[enable|disable|status|qrlogin|accounts|rm <accountId>]' },
      handler: (inv) => this.handleCommand(inv),
    });

    // Register the outbound media tool so the agent can send generated
    // images/files back to the WeChat peer it is talking to.
    ctx.inject(['tools', 'attachments'], (sctx) => { this._registerSendFileTool(sctx); });

    // One-time rename of the settings.yaml section from the weixin-bridge era
    // so an existing `enabled: true` survives the plugin rename. The settings
    // file provider hot-publishes external edits, so no restart is needed.
    // Registered before the settings namespace registration so the renamed section is
    // resolved by the new namespace registration below.
    ctx.inject(['settings'], (sctx) => this._migrateLegacySettingsSection(sctx.settings));

    // Canonical DSH settings wiring: registers the `wechat-companion` namespace
    // (so writes persist to settings.yaml), uses composition config as base,
    // and re-applies enable/disable live on every settings change.
    this._settingsSource = () => ({
      enabled: this.config.enabled,
      mediaEnabled: this.config.mediaEnabled,
      defaultProvider: this.config.defaultProvider || '',
      defaultModel: this.config.defaultModel || '',
      allowedPeers: this.config.allowedPeers || '',
      notifyEnabled: this.config.notifyEnabled !== false,
      notifyMutedWorkspaces: Array.isArray(this.config.notifyMutedWorkspaces) ? this.config.notifyMutedWorkspaces : [],
    });
    // dsh 0.1.2-rc.1：settings 服务化注册（base=组合层初值，watch=热生效）
    ctx.inject(['settings'], (sctx) => {
      const scope = sctx.settings.register(SETTINGS_NS, SETTINGS_SCHEMA, {
        base: {
          enabled: this.config.enabled,
          mediaEnabled: this.config.mediaEnabled,
          defaultProvider: this.config.defaultProvider || '',
          defaultModel: this.config.defaultModel || '',
          allowedPeers: this.config.allowedPeers || '',
          notifyEnabled: this.config.notifyEnabled !== false,
          notifyMutedWorkspaces: Array.isArray(this.config.notifyMutedWorkspaces) ? this.config.notifyMutedWorkspaces : [],
        },
        applies: 'live',
      });
      this._settingsSource = () => scope.get();
      scope.watch(() => this._applySettings());
      // 启动时设置源可能还没就绪：watch 的首次回调拿到 undefined → 被当成 false → 她不上线，
      // 而且之后再没有回调，于是整晚都不在线（真机 2026-09-14 04:11 就是这样）。
      // setEnabled 幂等，所以这里直接应用一次 + 补几次重试（设置晚到也能自愈）。
      this._applySettings();
      for (const ms of [2000, 8000, 20000, 60000]) {
        try { setTimeout(() => { try { this._applySettings(); } catch { /* noop */ } }, ms); } catch { /* noop */ }
      }
    });

    // One-way session notifier: subscribe once at mount. `session/event` is a
    // post-commit fire-and-forget feed whose listener failures are contained
    // per listener — unlike the serial `agent/turn-stopping`, a bug here can
    // never delay or fail anyone's turn. The untagged plugin context receives
    // every session in the process; narrowing happens in the handler.
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'turn/end') return;
        this._maybeNotifyTurnEnd(session, event.data);
      } catch { /* notifications must never break sessions */ }
    });

    this.ctx.logger?.info?.('[wechat-companion] service mounted (hot-plug via /companion or settings wechat-companion.enabled)');

    // Optional wiring: when a webServer exists (web profile), serve the
    // settings-tab JSON API under /wechat-companion/*.
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/wechat-companion',
        handler: (req, res) => this.httpHandler(req, res),
      }), 'wechat-companion: http api route');
    });
  }

  /** 今天的她：每日随机状态（作息/情绪/话痨度/意外事件），人设自动定基调 */
  today() {
    const persona = this.soul.getPersona();
    // 职业机制参数（类型来自人设，时段/强度来自配置）→ 交给每日系统决定"今天的生活形状"
    const jobCfg = (this._modelConfig().job) || {};
    return todayState(this.companionDir, { ...persona, __job: { ...jobCfg, type: jobCfg.type || persona.jobType || 'none' } });
  }

  /** Default session cwd: <DSH_HOME>/wechat-companion/WeChatSpace. */
  workspaceDir() {
    return path.join(
      DSH_DOT_DIR,
      'wechat-companion', 'WeChatSpace',
    );
  }

  _applySettings() {
    const s = this._settingsSource();
    // 设置还没就绪（拿不到布尔值）→ 什么都别做。
    // 以前这里写 `setEnabled(!!s?.enabled)`：undefined 被当成 false，会把"本该在跑的她"关掉，
    // 而且 watch 之后不再回调 → 她整晚离线（真机 2026-09-14 04:11 就是这个坑）。
    if (!s || typeof s.enabled !== 'boolean') return;
    this.setEnabled(s.enabled);
  }

  /**
   * Parsed inbound peer allowlist from settings: comma-separated WeChat ids
   * (from_user_id). An empty result (unset or blank) means deny everyone —
   * the fail-closed default.
   */
  _allowedPeers() {
    const raw = this._settingsSource()?.allowedPeers || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * Rename a legacy `weixin-bridge:` section in the settings document to
   * `wechat-companion:` once, so the enabled flag survives the plugin rename.
   * Best-effort: any failure just logs and leaves the section untouched.
   */
  _migrateLegacySettingsSection(settings) {
    const docPath = settings?.documentPath;
    if (!docPath) return;
    try {
      const text = fs.readFileSync(docPath, 'utf8');
      if (!/^weixin-bridge:/m.test(text)) return;
      if (/^wechat-companion:/m.test(text)) return; // already migrated
      const migrated = text.replace(/^weixin-bridge:/m, 'wechat-companion:');
      fs.writeFileSync(docPath, migrated, 'utf8');
      this.ctx.logger?.info?.('[wechat-companion] migrated legacy settings section weixin-bridge -> wechat-companion');
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] settings section migration skipped: ${err.message}`);
    }
  }

  // ── hot plug ──
  setEnabled(enabled) {
    if (enabled && !this.running) this.start();
    else if (!enabled && this.running) this.stop();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this._stop = controller;
    this._loop(controller.signal);
    this._lifeTimer = setInterval(() => { void this._lifeTick(); }, 60000);
    this.ctx.logger?.info?.('[wechat-companion] started');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._stop?.abort();
    this._stop = null;
    if (this._lifeTimer) { clearInterval(this._lifeTimer); this._lifeTimer = null; }
    void this._releasePollLock();
    this.ctx.logger?.info?.('[wechat-companion] stopped');
  }

  async _loop(signal) {
    while (this.running && !signal.aborted) {
      if (!this._pollLockHeld) {
        if (await this._acquirePollLock()) {
          this.ctx.logger?.info?.('[wechat-companion] poll lock acquired');
        } else {
          await sleep(5_000, signal);
          continue;
        }
      }
      const accounts = this.store.listAccounts().filter((a) => a.enabled === 1 && a.token);
      if (accounts.length === 0) {
        await sleep(5_000, signal);
        continue;
      }
      // Run each account poll concurrently; wait for all, then re-loop.
      await Promise.all(accounts.map((acc) => this._pollAccount(acc, signal)));
      if (!this.running) break;
      await sleep(500, signal);
    }
  }

  /**
   * Atomically create the poll lock (O_EXCL) recording pid + heartbeat
   * timestamp. An existing lock belongs to a live, fresh holder and blocks
   * this process from polling; a stale lock (dead pid or heartbeat older than
   * the long-poll window) is taken over.
   */
  async _acquirePollLock() {
    try {
      const fh = await fsp.open(this._pollLockPath, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await fh.close();
      this._pollLockHeld = true;
      this._startPollLockHeartbeat();
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        this.ctx.logger?.warn?.(`[wechat-companion] poll lock unavailable: ${err.message}`);
        return false;
      }
    }
    try {
      const data = JSON.parse(await fsp.readFile(this._pollLockPath, 'utf8'));
      const staleByTs = Date.now() - (data.ts || 0) > 120_000;
      let holderAlive = true;
      try { process.kill(data.pid, 0); } catch { holderAlive = false; }
      if (staleByTs || !holderAlive) {
        await fsp.unlink(this._pollLockPath).catch(() => {});
        return this._acquirePollLock();
      }
    } catch {
      // Unparsable lock: treat as stale and retry once.
      await fsp.unlink(this._pollLockPath).catch(() => {});
      return this._acquirePollLock();
    }
    return false;
  }

  /**
   * Background heartbeat: a single WeChat message can drive the agent for
   * minutes, during which the poll loop never ticks, so the lock timestamp
   * must be refreshed by its own timer to avoid a false "stale" takeover.
   */
  _startPollLockHeartbeat() {
    if (this._pollLockTimer) return;
    this._pollLockTimer = setInterval(() => {
      if (!this._pollLockHeld) return;
      fsp.writeFile(this._pollLockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }))
        .catch(() => { this._pollLockHeld = false; });
    }, 30_000);
    if (this._pollLockTimer.unref) this._pollLockTimer.unref();
  }

  /** Drop the lock when this process stops polling or disposes. */
  async _releasePollLock() {
    if (this._pollLockTimer) {
      clearInterval(this._pollLockTimer);
      this._pollLockTimer = null;
    }
    if (!this._pollLockHeld) return;
    this._pollLockHeld = false;
    try { await fsp.unlink(this._pollLockPath); } catch { /* already gone */ }
  }

  async _pollAccount(account, signal) {
    const accountId = account.account_id;
    const offsetKey = `wechat:${accountId}`;
    let failures = 0;
    const BACKOFF_BASE = 2_000;
    const BACKOFF_MAX = 30_000;

    while (this.running && !signal.aborted) {
      // Re-read the account EVERY iteration: a QR re-login persists a fresh
      // token to the store, and an in-flight poller (e.g. paused on errcode
      // -14 session expiry) must pick it up without a disable/enable cycle
      // or process restart.
      const fresh = this.store.listAccounts().find((a) => a.account_id === accountId);
      if (!fresh || fresh.enabled !== 1 || !fresh.token) break; // account removed/disabled
      const creds = {
        botToken: fresh.token,
        ilinkBotId: fresh.account_id,
        baseUrl: fresh.base_url || 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: fresh.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
      };

      // session-expired pause (errcode -14)
      const paused = this._pauses.get(accountId);
      if (paused && Date.now() < paused) {
        await sleep(10_000, signal);
        continue;
      } else if (paused) {
        this._pauses.delete(accountId);
      }

      try {
        const buf = this.store.getOffset(offsetKey);
        const resp = await getUpdates(creds, buf === '0' ? '' : buf);

        if (resp.errcode === ERRCODE_SESSION_EXPIRED) {
          this._pauses.set(accountId, Date.now() + 60 * 60 * 1000);
          this._accountHealth.set(accountId, { state: 'session-expired', at: new Date().toISOString() });
          this.ctx.logger?.warn?.(`[wechat-companion] account ${accountId} session expired (errcode -14), pausing 60m — re-scan the QR code to recover`);
          continue;
        }
        if (resp.errcode && resp.errcode !== 0) {
          throw new Error(`API error: ${resp.errcode} ${resp.errmsg || ''}`);
        }
        this._accountHealth.delete(accountId);

        if (resp.msgs && resp.msgs.length > 0) {
          for (const msg of resp.msgs) {
            await this._handleInbound(account, creds, msg);
          }
          if (resp.get_updates_buf) this.store.setOffset(offsetKey, resp.get_updates_buf);
        }
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures += 1;
        const backoff = Math.min(BACKOFF_BASE * 2 ** (failures - 1), BACKOFF_MAX);
        this.ctx.logger?.error?.(`[wechat-companion] poll error ${accountId}: ${err.message}`);
        await sleep(backoff, signal);
      }
    }
  }

  async _handleInbound(account, creds, msg) {
    if (!msg.from_user_id) return;
    const accountId = account.account_id;
    const peer = msg.from_user_id;
    const chatId = encodeWeixinChatId(accountId, peer);
    // 任何来消息的人都先记录 context_token（不论后续闸门）——已知联系人与主动推送的依据
    this._refreshPeerToken(accountId, peer, msg.context_token);

    // Fail-closed peer allowlist (settings `allowedPeers`, comma-separated
    // bot-internal peer ids). An unset/blank list means NOBODY may drive the
    // agent — deny everyone by default. Rejection happens before dedupe/storage
    // so unknown peers never touch the session store. The id is an opaque bot
    // internal id, NOT the WeChat alias: a stranger messaging the bot gets it
    // echoed back in the hint below. The context token is persisted even for
    // denied peers so their id shows up as a clickable chip in the Settings
    // tab's allowlist card ("已对话过的 ID") — that conversation is the only
    // way to discover these ids.
    if (this._modelConfig().paused) return; // 全局急停：她立刻安静，不再回复任何人
    // 非主人：她睡着时一个字都不回（2026-09-13：睡眠窗口取代了旧的「安静时段」）
    if (this._modelConfig().ownerPeerId !== peer && this.life && this.life.isAsleepNow(new Date(), { wake: (this.today() || {}).wake, sleep: (this.today() || {}).sleep })) return;
    if (this._modelConfig().ownerPeerId === peer) this.life.noteOwnerActivity(); // 主人来了，清掉"等急了"
    if (this._isBlocked(peer)) return;
    if (!this._allowedPeers().includes(peer) && !this._replyToAll()) {
      this.ctx.logger?.info?.(`[wechat-companion] rejecting non-allowlisted peer ${peer}`);
      try {
        const contextToken = msg.context_token || this.store.getContextToken(accountId, peer);
        this._refreshPeerToken(accountId, peer, msg.context_token);
        if (contextToken) {
          await sendTextMessage(creds, peer,
            `当前 ID: ${peer}\n该 ID 未加入白名单,本次消息已忽略。\n` +
            `如需放行,请在 DSH 设置 → 她 → 名单与身份 中操作。`,
            contextToken);
        }
      } catch { /* hint delivery is best-effort */ }
      return;
    }

    // Dedupe: the WeChat long-poll can re-deliver a batch when the process
    // dies before the offset is persisted, and a second DSH process polls the
    // same account during dual-process windows. The stable message id (or the
    // server seq as fallback) makes each message at-most-once.
    const messageId = msg.message_id || String(msg.seq || '');
    if (this.store.wasMessageProcessed(accountId, messageId)) {
      this.ctx.logger?.info?.(`[wechat-companion] skipping duplicate message ${messageId} from ${peer}`);
      this._refreshPeerToken(accountId, peer, msg.context_token);
      return;
    }
    this.store.recordProcessedMessage(accountId, messageId);
    this._lastInboundAt = Date.now();

    // 先把正文解析出来，再记录实况——顺序绝不能反：
    // 曾经写成"先 activity(...text...)、后 let text"，于是每条消息都在 TDZ 抛错（Cannot access 'text'
    // before initialization），整个入站处理中断 → 她收到消息但永远不回。现在解析统一收进 inbound.js。
    const parsed = parseInboundText(msg);
    const text = parsed.text;
    this.activity('[收到] ' + peer + '：' + String(text || '(媒体)').slice(0, 60));
    this.ctx.logger?.info?.('[wechat-companion] 收到来自 ' + peer + '：' + String(text || '(媒体)').slice(0, 60));

    // Media items (image / file / video / voice): download, decrypt, and park
    // them in the inbox directory. Images are also offered as native image
    // content when the selected model declares image input.
    const mediaEnabled = this._settingsSource()?.mediaEnabled !== false;
    const content = [];
    if (text) content.push({ type: 'text', text });
    if (mediaEnabled) {
      const mediaBlocks = await this._collectInboundMedia(account, creds, msg, chatId);
      content.push(...mediaBlocks);
    }
    if (content.length === 0) return;

    try {
      if (this._soulEnabled()) {
        await this._driveSoul(accountId, creds, peer, chatId, text, content);
        return;
      }
      const reply = await this._driveAgent(chatId, content);
      const contextToken = this.store.getContextToken(accountId, peer);
      if (!contextToken) {
        this.ctx.logger?.warn?.(`[wechat-companion] no context_token for ${peer}; cannot reply`);
        return;
      }
      const plain = stripMarkup(reply);
      const limit = 4096;
      const chunks = chunkText(plain, limit);
      const effective = chunks.length > 5
        ? [...chunks.slice(0, 4), chunks.slice(4).join('\n').slice(0, limit - 30) + '\n\n[... response truncated]']
        : chunks;
      for (const c of effective) {
        await sendTextMessage(creds, peer, c, contextToken);
      }
    } catch (err) {
      this.ctx.logger?.error?.(`[wechat-companion] agent drive failed: ${err.message}`);
      try {
        const contextToken = this.store.getContextToken(accountId, peer);
        if (contextToken) await sendTextMessage(creds, peer, `⚠️ 处理失败: ${err.message}`.slice(0, 4000), contextToken);
      } catch { /* ignore */ }
    }
  }

  // ---------- 灵魂引擎（陪伴模式） ----------
  _soulEnabled() { return this.config.useSoul !== false; }

  /** 面板管理的 config.json（模型服务/名单/行为参数），每次调用热读取 */
  _modelConfig() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.companionDir, 'config.json'), 'utf8')); 
    } catch { return {}; }
  }

  _replyToAll() { return this._modelConfig().replyToAll !== false; }

  /**
   * 向量配置解析（2026-09-13 第三次改版）。
   * 以前这里是 `source === 'api'` 才算云端——source 是后台一个下拉，用户改了地址不改下拉，
   * 或者改了下拉不改地址，就会"设置和实际行为对不上"。现在地址是唯一权威：
   *   地址是 127.0.0.1 / localhost / 0.0.0.0 → 本地 Ollama
   *   其它地址                              → 云端（OpenAI 兼容 /v1/embeddings）
   */
  _embedCfg() {
    const e = this._modelConfig().embed || {};
    const raw = String(e.url || e.baseURL || '').trim();
    const local = !raw || /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(raw);
    return {
      local,
      url: (raw || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      apiKey: String(e.apiKey || ''),
      model: String(e.model || e.embedModel || 'bge-m3'),
      dim: Number(e.dim) > 0 ? Math.round(Number(e.dim)) : 0,
      where: local ? '本地 Ollama' : '云端接口',
    };
  }

  /** 向量解析：地址决定走本地 Ollama 还是云端（两个分支都真接线） */
  async _embedTextFor(text) {
    const e = this._embedCfg();
    if (!e.local) {
      return embedText({ baseURL: e.url, apiKey: e.apiKey, model: e.model, input: text });
    }
    const res = await fetch(e.url + '/api/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: e.model, prompt: String(text).slice(0, 2000) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error('embed HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.embedding)) throw new Error('embed 空返回');
    return data.embedding;
  }

  /** 她的实况：最近200条活动（面板/房间可见） */
  activity(text) {
    this._activity.unshift({ at: Date.now(), text: String(text).slice(0, 200) });
    if (this._activity.length > 200) this._activity.length = 200;
  }

  /**
   * 她这次要不要回（2026-09-13 加，用户明确要求）。
   * 用户原话："有的时候我发的消息不是一定要回的，可能她觉得没必要回、或者不想回、或者晚点回。"
   * 规则：社交电量低 / 心情差 / 正忙（工作日的工作时段）→ 更容易"已读不回"或"晚点回"。
   * 护栏：连续不回最多 1 次（否则你会以为她坏了）；依恋强度放低"不回"的概率（越黏你越不会不理你）。
   */
  _replyPolicy(today, persona) {
    const batt = Number((today && today.battery) == null ? 60 : today.battery);
    const mood = Number((today && today.mood) == null ? 60 : today.mood);
    const job = (today && today.job) || {};
    const busy = !!(today && today.busyDay) || (job.workday === true && job.type && job.type !== 'none');
    const traits = (persona && persona.traits) || {};
    const att = traits.attachment == null ? 50 : Number(traits.attachment);
    let pSkip = 0.06 + (busy ? 0.14 : 0) + (batt < 40 ? 0.16 : 0) + (mood < 40 ? 0.12 : 0) - att / 1000;
    pSkip = Math.max(0, Math.min(0.45, pSkip));
    let pLater = 0.1 + (busy ? 0.22 : 0) + (batt < 50 ? 0.12 : 0);
    pLater = Math.max(0, Math.min(0.55, pLater));
    if ((this._skipStreak || 0) >= 1) pSkip = 0;
    const r = Math.random();
    if (r < pSkip) {
      return { mode: 'skip', reason: busy ? '她在忙（' + (job.label || job.type) + '）' : (batt < 40 ? '今天电量见底，不想说话' : '心情不太好，这条先不回') };
    }
    if (r < pSkip + pLater) {
      const mins = 3 + Math.round(Math.random() * 17);
      return { mode: 'later', delayMs: mins * 60000, reason: (busy ? '在忙，' + mins + ' 分钟后再回' : '手上有点事，' + mins + ' 分钟后再回') };
    }
    return { mode: 'now', reason: '' };
  }

  /** 她现在是不是睡着（2026-09-13 起：不再有单独的「安静时段」，直接用她今天的作息） */
  _isAsleepNow(now) {
    if (!this.life || typeof this.life.isAsleepNow !== 'function') return false;
    const t = this.today() || {};
    return this.life.isAsleepNow(now || new Date(), { wake: t.wake, sleep: t.sleep });
  }

  // ---------- 生活系统（主动消息心跳） ----------
  /**
   * 世界引擎给的「今天主动上限」（只收紧"日常分享/催你"的条数，早安/晚安永远允许）。
   * **心跳与后台显示必须走同一个方法**：以前心跳里现算一份、后台读的是原始配置（pokesPerDay+nudgeMaxPerDay），
   * 于是后台显示"今天主动 0/12 次"而实际生效是 0/0 —— 数不一样就是黑盒。
   */
  _stageLimitNow(tone) {
    return { ...proactiveLimit(tone), morning: true, night: true };
  }

  async _lifeTick() {
    try {
      if (!this.running || !this._soulEnabled()) return;
      const cfg = this._modelConfig();
      if (cfg.paused || !cfg.ownerPeerId) return;
      if (cfg.life && cfg.life.enabled === false) return;
      // 今天的她（必须放在最前面：下面承诺到期检查要用 today.wake / today.sleep。
      // 2026-09-14 真机抓到的 bug：这两处写在 const today 之前 → 每跳都抛 "Cannot access 'today' before initialization"，
      // 整条心跳（早安/晚安/分享/催/承诺/记忆补迁）全废，且只在日志里留一行 warn。）
      const today = this.today();
      // 她夹带的「晚点再说」到点了就发出去（批 E2 / A5）
      void this._nudgesTick();
      // 她答应过的事到期了没有（批 E3 / A8）：在睡就推到起床后，每条只主动提一次
      void this.promises.tick({
        isAsleep: () => (this.life && this.life.isAsleepNow ? this.life.isAsleepNow(new Date(), { wake: today.wake, sleep: today.sleep }) : false),
        wake: today.wake,
        lastPokeAt: this._lastPokeAt(),
        send: (chunks, delays) => this._sendToOwnerChunks(chunks, delays),
      }).catch((e) => this.ctx.logger?.warn?.('[promises] tick 异常: ' + (e && e.message)));
      this.deform.daily(today); // 每日衰减/通宵事件
      if (!today.allNighter) this._dayEvent('rest', '睡得好');
      // 世界引擎：她睡了才为她的世界转起来（每晚一次）
      if (!this._worldBusy && this.world.shouldGenerate(new Date(), today)) {
        this._worldBusy = true;
        void this.world.generate({ persona: this.soul.getPersona(), today, memories: (this.soul.getMemories().entries || []).slice(-12) })
          .then((out) => {
            this.activity('[世界] 她的世界已生成：日记+流水' + (out.flow || []).length + '件');
            this._applyWorkload(out.workload);
          })
          .catch((e) => this.ctx.logger?.warn?.('[world] 生成失败(下轮再试): ' + e.message))
          .then(() => { this._worldBusy = false; });
      }
      const toneNow = toneForToday(this.world.state(), today);
      const worldNow = this.world.state() || {};
      const personaNow = this.soul.getPersona();
      const sent = await this.life.tick({
        soul: this._soulForLife(today),
        overrides: {
          wake: today.wake, sleep: today.sleep, pokesPerDay: today.activeToday,
          // 世界引擎给的主动上限（只能收紧"最多几条"，不再是配额）。
          // 但早安/晚安**永远允许**（2026-09-13 用户拍板）：那是"她还活着"的基本盘，
          // 世界引擎只准管"日常分享/催你"的次数，不准让她一整天不吭声。
          stageLimit: this._stageLimitNow(toneNow),
          proactiveAt: toneNow.source === 'world' ? String(toneNow.proactiveAt || '') : '',
          insomnia: toneNow.source === 'world' ? toneNow.insomnia === true : false,
          // 事件驱动分享要用的输入（2026-09-13 方案 D）：
          flow: Array.isArray(worldNow.flow) ? worldNow.flow : [],   // 她今天真实经历的事
          traits: (personaNow && personaNow.traits) || {},           // 发起力/依恋 → 她对谁都想说话的程度
          battery: today.battery,                                    // 今天剩多少力气
          mood: today.mood,
        },
        sendToOwner: (text) => this._sendToOwnerPeer(cfg.ownerPeerId, text),
      });
      // A11：以前这里是「每催一次就记一笔压力 +15」，等于你越不来她越黏你（用户否掉了）。
      // 现在改成「回来那一刻才算总账」：见 _driveSoulOnce 里按想念曲线只结算一次。
      for (const item of sent) { this.ctx.logger?.info?.('[life] 主动消息(' + item.kind + '): ' + item.text.slice(0, 40)); this.activity('[主动·' + item.kind + '] ' + item.text.slice(0, 50)); }
    } catch (err) {
      this.ctx.logger?.warn?.('[life] 心跳失败(下轮再试): ' + (err && err.message));
    }
  }

  async _sendToOwnerPeer(peer, text) {
    const acct = this.store.listAccounts().find((a) => a.enabled === 1 && a.token);
    if (!acct) throw new Error('没有已启用的微信账号');
    const contextToken = this.store.getContextToken(acct.account_id, peer);
    if (!contextToken) throw new Error('主人还没有给她发过消息（协议要求先有过来往才能主动推送）');
    const creds = {
      baseUrl: acct.baseUrl || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: acct.cdnBaseUrl || 'https://novac2c.cdn.weixin.qq.com/c2c',
      botToken: acct.token,
    };
    await this._sendChunk(peer, text, { creds, peer, contextToken });
  }

  /** 发送一条语音消息（mp3 → CDN voice 上传 → voice_item） */
  async _sendVoiceMessage(accountId, peer, data, durationMs) {
    const account = this.store.getAccount(accountId);
    if (!account || !account.token) throw new Error('no stored account for ' + accountId);
    const creds = {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
    };
    const contextToken = this.store.getContextToken(accountId, peer);
    if (!contextToken) throw new Error('no context_token for ' + peer);
    const uploaded = await uploadMediaToCdn(creds, getUploadUrl, data, peer, 'voice');
    const media = {
      encrypt_query_param: uploaded.encryptQueryParam,
      aes_key: uploaded.aesKeyBase64,
      encrypt_type: 1,
    };
    const item = { type: 3, voice_item: { media, voice_length: Math.max(1000, Math.round(durationMs)), len: String(uploaded.fileSize) } };
    await sendMessage(creds, peer, [item], contextToken);
  }

  /** 发一张图片：和发语音同一条上传链路，item 类型换成 image（通道本来就支持接收/发送图片） */
  async _sendImageMessage(accountId, peer, data) {
    const account = this.store.getAccount(accountId);
    if (!account || !account.token) throw new Error('no stored account for ' + accountId);
    const creds = {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
    };
    const contextToken = this.store.getContextToken(accountId, peer);
    if (!contextToken) throw new Error('no context_token for ' + peer);
    const uploaded = await uploadMediaToCdn(creds, getUploadUrl, data, peer, 'image');
    const media = { encrypt_query_param: uploaded.encryptQueryParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 };
    // 图片的密钥，接收端优先读十六进制的 aeskey（见 downloadMediaFromItem），所以两种都给
    let aeskey = '';
    try { aeskey = Buffer.from(String(uploaded.aesKeyBase64 || ''), 'base64').toString('hex'); } catch { /* noop */ }
    const item = { type: 2, image_item: { media, aeskey, len: String(uploaded.fileSize) } };
    await sendMessage(creds, peer, [item], contextToken);
  }

  /**
   * 执行她夹带的指令（批 E2 / A5）。
   * 闸门全在 commands.js：去重 + 每条回复限次 + 每天限次；这里只负责真去做，
   * 并且**把做没做、为什么没做都记进后台**（禁黑盒：被拦下来也要看得见）。
   */
  async _runCommands(commands, peerKey, accountId, opts = {}) {
    const list = Array.isArray(commands) ? commands : [];
    if (!list.length) return;
    const cfg = this._modelConfig();
    if ((cfg.behavior || {}).commands === false) return;          // 总开关
    const peer = opts.peer || peerKey.split(':').slice(1).join(':');
    const dayKey = new Date().toISOString().slice(0, 10);
    let usage = {};
    try { usage = JSON.parse(fs.readFileSync(path.join(this.companionDir, 'cmd-usage.json'), 'utf8')); } catch { usage = emptyUsage(dayKey); }
    const f = filterCommands(list, usage, dayKey, { recent: this._recentCommands(peerKey) });
    try {
      const tmp = path.join(this.companionDir, 'cmd-usage.json.tmp-' + Date.now());
      fs.writeFileSync(tmp, JSON.stringify(f.usage), 'utf8');
      fs.renameSync(tmp, path.join(this.companionDir, 'cmd-usage.json'));
    } catch { /* 记账失败不影响执行 */ }
    // 记下这一轮真正执行的指令（跨轮重复抑制靠它：连着几轮同一条就压掉）
    if (f.ok.length) this._rememberCommands(peerKey, f.ok);
    for (const d of f.dropped) this.activity('[她想的] ' + (CMD_KIND[d.kind] || d.kind) + '：这次没做（' + d.why + '）');
    for (const c of f.ok) {
      try {
        if (c.kind === 'remember') {
          await this.soul.addMemory({ who: peerKey, text: c.arg, cat: /^我/.test(c.arg) ? 'her' : 'you' });
          this.activity('[她想的] 记住了一件事：' + c.arg.slice(0, 40));
        } else if (c.kind === 'sticker') {
          const name = matchStickerName(this.companionDir, c.arg);
          const s = name ? readSticker(this.companionDir, name) : null;
          if (!s) { this.activity('[她想的] 想发表情包「' + c.arg.slice(0, 12) + '」，但库里没有相近的'); continue; }
          await this._sendImageMessage(accountId, peer, s.data);
          this.activity('[她想的] 发了个表情包：' + s.name);
        } else if (c.kind === 'image') {
          const out = await this.router.image(c.arg);
          const first = (out && out[0]) || null;
          if (!first) throw new Error('生图返回为空');
          let buf;
          if (first.b64) buf = Buffer.from(String(first.b64), 'base64');
          else {
            const r = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
            if (!r.ok) throw new Error('图片下载失败 ' + r.status);
            buf = Buffer.from(await r.arrayBuffer());
          }
          await this._sendImageMessage(accountId, peer, buf);
          this.activity('[她想的] 拍了张照片发给你：' + c.arg.slice(0, 30));
        } else if (c.kind === 'voice') {
          const said = String(c.arg).replace(/\s+/g, ' ').slice(0, 160);
          const audio = await this.router.tts(said);
          await this._sendVoiceMessage(accountId, peer, audio, Math.min(60000, Math.max(1500, said.length * 230)));
          this.activity('[她想的] 发了条语音：' + said.slice(0, 30));
        } else if (c.kind === 'nudge_at') {
          const t = this._addNudge(c.arg);
          this.activity('[她想的] 「' + String(c.arg).slice(0, 24) + '」先记着，' + t + ' 再跟你说');
        }
      } catch (err) {
        // 做不成要留痕，不然这就是黑盒
        this.activity('[她想的] ' + (CMD_KIND[c.kind] || c.kind) + ' 没做成：' + ((err && err.message) || '未知原因').slice(0, 60));
        this.ctx.logger?.warn?.('[commands] ' + c.kind + ' 执行失败: ' + (err && err.message));
      }
    }
  }

  /** 把她的几条话发给主人（承诺提醒与「晚点再说」共用，别再各写一遍） */
  async _sendToOwnerChunks(chunks, delays) {
    const cfg = this._modelConfig();
    const owner = cfg.ownerPeerId;
    if (!owner) throw new Error('没配置主人');
    const account = (this.store.listAccounts ? this.store.listAccounts() : []).find((a) => a && a.enabled !== false && a.token);
    if (!account) throw new Error('没有可用的账号');
    const creds = {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
    };
    const contextToken = this.store.getContextToken(account.account_id, owner);
    if (!contextToken) throw new Error('还没建立会话（context_token 缺失）');
    const list = Array.isArray(chunks) ? chunks : [];
    for (let i = 0; i < list.length; i++) {
      const d = i < (delays || []).length ? Math.min(Number(delays[i]) || 0, 4000) : (i ? 400 : 0);
      if (d > 0) await sleep(d);
      await this._sendChunk(owner, String(list[i]).slice(0, 2000), { creds, peer: owner, contextToken });
    }
  }
  /** 只读借用生活系统的 lastPokeAt（不代它写）——承诺提醒别和日常分享挤在同一分钟 */
  _lastPokeAt() {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.companionDir, 'life-state.json'), 'utf8'));
      return Number(s && s.lastPokeAt) || 0;
    } catch { return 0; }
  }

  /** 她的"晚点再说"队列：随机 45~180 分钟后，落在她今天醒着的时间里 */
  _addNudge(text) {
    const f = path.join(this.companionDir, 'nudges.json');
    let all = [];
    try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { all = []; }
    if (!Array.isArray(all)) all = [];
    const mins = 45 + Math.floor(Math.random() * 136);
    const due = Date.now() + mins * 60000;
    all.push({ text: String(text).slice(0, 200), dueAt: due, madeAt: Date.now() });
    try {
      const tmp = f + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(all.slice(-30), null, 2), 'utf8');
      fs.renameSync(tmp, f);
    } catch { /* noop */ }
    return new Date(due).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  /** 到点了就把她"先记着的那句话"发出去（在她醒着、且不在深夜时） */
  async _nudgesTick() {
    const f = path.join(this.companionDir, 'nudges.json');
    let all = [];
    try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return; }
    if (!Array.isArray(all) || !all.length) return;
    const cfg = this._modelConfig();
    const t0 = this.today() || {};
    const np = this.life && this.life.nightPhase ? this.life.nightPhase(new Date(), { wake: t0.wake, sleep: t0.sleep }) : 'awake';
    if (np === 'asleep') return;                       // 她睡了就不发，等醒了再说
    const now = Date.now();
    const due = all.filter((x) => x && x.dueAt && x.dueAt <= now);
    if (!due.length) return;
    const rest = all.filter((x) => !due.includes(x));
    const account = (this.store.listAccounts ? this.store.listAccounts() : []).find((a) => a && a.enabled !== false && a.token);
    const owner = cfg.ownerPeerId;
    if (!account || !owner) return;
    const creds = {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
    };
    const contextToken = this.store.getContextToken(account.account_id, owner);
    if (!contextToken) return;
    for (const n of due.slice(0, 2)) {
      try {
        await this._sendChunk(owner, String(n.text).slice(0, 500), { creds, peer: owner, contextToken });
        this.activity('[她想的] 把先前那句说出来了：' + String(n.text).slice(0, 30));
      } catch (err) {
        this.ctx.logger?.warn?.('[nudge] 发送失败: ' + (err && err.message));
        rest.push(n);                                   // 发失败就留着下次再试
      }
    }
    try {
      const tmp = f + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(rest, null, 2), 'utf8');
      fs.renameSync(tmp, f);
    } catch { /* noop */ }
  }

  /** 你多久没来、她现在的想念状态（只给一句人话，**不给分数**——A12 的要求） */
  _longingInfo() {
    const cfg = this._modelConfig();
    const owner = String(cfg.ownerPeerId || '');
    if (!owner) return null;
    const h = this.soul.getHistory(owner);
    const now = new Date();
    const absenceMs = this.soul._absenceMs(h, now);
    const t = (this.soul.getPersona().traits) || {};
    const tt = this.today() || {};
    const ww = this.world.state() || {};
    const curve = longingCurve({ absenceMs, attachment: Number(t.attachment) || 0, battery: Number(tt.battery) || 60, workload: Number(ww.workload) || 0 });
    return { text: longingLine(curve, { who: '你' }) || '你们刚说过话。', days: Math.round(curve.days * 10) / 10, phase: curve.phase, settledOnReturn: true };
  }

  /** 她的身体建档信息（后台只读展示用：周期参数与建档说明，禁黑盒） */
  _bodyStateInfo() {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(this.companionDir, 'body-state.json'), 'utf8'));
      return { cycleDays: st.cycleDays, periodLen: st.periodLen, anchor: st.anchor, createdNote: st.createdNote || '', createdAt: st.createdAt || 0 };
    } catch { return null; }
  }

  /** 指令今日用量的文件路径（HTTP 处理函数里不许直接用 path，所以拼装放在方法里） */
  _cmdUsageFile() { return path.join(this.companionDir, 'cmd-usage.json'); }

  /** 「最近几轮她用过的指令」的存档路径（跨轮重复抑制用） */
  _cmdRecentFile() { return path.join(this.companionDir, 'cmd-recent.json'); }

  /** 远程访问口令（空 = 不校验；给内网穿透用的那道门） */
  _accessKey() {
    try { return String((((this._modelConfig() || {}).security || {}).accessKey) || '').trim(); } catch { return ''; }
  }

  /** 定长比较：别用 === 泄露长度/前缀（口令是本机明文存的，但比较方式不该留破绽） */
  _keyEq(a, b) {
    const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
    if (A.length !== B.length || !A.length) return false;
    try { return crypto.timingSafeEqual(A, B); } catch { return false; }
  }

  /** 请求有没有带对的口令：支持 ?key= / X-Access-Key 头 / Bearer / Basic */
  _accessOk(req, url) {
    const key = this._accessKey();
    if (!key) return true;
    let given = '';
    try { given = String((url && url.searchParams && url.searchParams.get('key')) || ''); } catch { given = ''; }
    if (!given) given = String((req.headers && req.headers['x-access-key']) || '');
    const auth = String((req.headers && req.headers['authorization']) || '');
    if (!given) { const m = /^Bearer\s+(.+)$/i.exec(auth); if (m) given = m[1]; }
    if (!given) {
      const m = /^Basic\s+(.+)$/i.exec(auth);
      if (m) { try { const s = Buffer.from(m[1], 'base64').toString('utf8'); given = s.slice(s.indexOf(':') + 1); } catch { given = ''; } }
    }
    return !!given && this._keyEq(String(given).trim(), key);
  }

  _recentCommands(peerKey) {
    try {
      const all = JSON.parse(fs.readFileSync(this._cmdRecentFile(), 'utf8')) || {};
      const arr = all[peerKey];
      return Array.isArray(arr) ? arr.slice(-RECENT_KEEP) : [];
    } catch { return []; }
  }

  _rememberCommands(peerKey, okList) {
    try {
      const file = this._cmdRecentFile();
      let all = {};
      try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { all = {}; }
      const prev = Array.isArray(all[peerKey]) ? all[peerKey] : [];
      all[peerKey] = prev.concat((okList || []).map((c) => ({ kind: c.kind, arg: String(c.arg || '').slice(0, 120), ts: Date.now() }))).slice(-RECENT_KEEP);
      fs.writeFileSync(file, JSON.stringify(all), 'utf8');
    } catch { /* 记不下也不影响执行 */ }
  }

  /** 读今天的指令用量（跨天自动归零） */
  _readCmdUsage() {
    const dayKey = new Date().toISOString().slice(0, 10);
    try {
      const u = JSON.parse(fs.readFileSync(this._cmdUsageFile(), 'utf8'));
      if (u && u.date === dayKey && u.used && typeof u.used === 'object') return u;
    } catch { /* 还没用过 */ }
    return emptyUsage(dayKey);
  }

  /** 最近她"想做的事"（给后台看；禁黑盒：被拦下的也要看得见） */
  _recentWanted() {
    return (Array.isArray(this._activity) ? this._activity : [])
      .filter((x) => String((x && x.text) || '').indexOf('[她想的]') >= 0)
      .slice(0, 10)
      .map((x) => new Date(x.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' ' + x.text);
  }

  _writeCompanionConfig(next) {
    fs.mkdirSync(this.companionDir, { recursive: true });
    const file = path.join(this.companionDir, 'config.json');
    const tmp = file + '.tmp-' + Date.now();
    next.savedAt = new Date().toISOString();
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    this._syncSidecarConfigs(next);
    return next;
  }

  /** 把提炼模型/监听名单同步给两个 sidecar（记忆引擎 + wxauto 桥），保存配置即生效 */
  _syncSidecarConfigs(cfg) {
    try {
      const mem = cfg.memory || {};
      const chat = cfg.chat || {};
      // 记忆提炼也支持顺位链：chain.memory[0] 为主力，其余作为回落（sidecar 会在失败时轮流试）
      const memChain = ((cfg.chain || {}).memory || []).filter((c) => c && c.baseURL && c.model);
      const primary = memChain[0] || {};
      const svc = {
        llm: {
          base_url: primary.baseURL || mem.extractionBaseUrl || chat.baseURL || 'https://api.siliconflow.cn/v1',
          api_key: primary.apiKey || mem.extractionApiKey || chat.apiKey || '',
          model: primary.model || mem.extractionModel || chat.model || '',
          fallbacks: memChain.slice(1).map((c) => ({ base_url: c.baseURL, api_key: c.apiKey || '', model: c.model })),
        },
        // 向量（2026-09-13 打通）：以前这里读的是早就不存在的 cfg.ollama，
        // 于是后台「大脑 → ⑥ 向量接口」填什么都不生效 —— 记忆引擎永远用本地默认。
        // 现在读的真配置：地址决定 provider，维度由「测连通/真跑一次」实测后写进 embed.dim。
        embedder: (() => {
          const ec = this._embedCfg();
          return ec.local
            ? { provider: 'ollama', model: ec.model, ollama_base_url: ec.url, embedding_dims: ec.dim || 1024 }
            : { provider: 'openai', model: ec.model, openai_base_url: ec.url, api_key: ec.apiKey, embedding_dims: ec.dim || 1024 };
        })(),
        store_path: path.join(this.companionDir, 'mem0-store'),
      };
      fs.writeFileSync(path.join(this.companionDir, 'memory-service.json'), JSON.stringify(svc, null, 2), 'utf8');
      // 2026-09-13：配置**真的变了**就重启引擎（不只是 /reload）。
      // 踩过的坑：上一批把"向量真打通"写进了 python，但引擎一直跑着旧进程，
      // 后台改配置它也不读 → 功能白写。这里用配置指纹判断，变了就重启。
      const svcJson = JSON.stringify(svc, null, 2);
      const changed = svcJson !== this._svcLastJson;
      this._svcLastJson = svcJson;
      if (changed && this._memEngineWasUp) this._restartMemoryEngine('配置变了');
      const wx = {
        callback: 'http://127.0.0.1:43121/wechat-companion/panel/wxauto/in',
        peers: (cfg.channel && cfg.channel.wxautoPeers) || [],
      };
      fs.writeFileSync(path.join(this.companionDir, 'wxauto-bridge.json'), JSON.stringify(wx, null, 2), 'utf8');
      // sidecar 若已在跑，让它热重载新配置（失败无所谓，下次重启自动生效）
      const memUrl = String((cfg.memory && cfg.memory.sidecarUrl) || 'http://127.0.0.1:43122').replace(/\/+$/, '');
      fetch(memUrl + '/reload', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    } catch { /* 非致命：sidecar 用默认配置 */ }
  }

  /** 面板提交的配置清洗：只接受白名单字段，防手滑写坏 */
  _sanitizeConfig(b = {}) {
    const out = this._modelConfig();
    const role = (v) => {
      if (!v || typeof v !== 'object') return undefined;
      const r = {};
      if (typeof v.baseURL === 'string') r.baseURL = v.baseURL.trim().slice(0, 300);
      if (typeof v.apiKey === 'string') r.apiKey = v.apiKey.trim().slice(0, 300);
      if (typeof v.model === 'string') r.model = v.model.trim().slice(0, 200);
      if (typeof v.voice === 'string') r.voice = v.voice.trim().slice(0, 200);
      if (typeof v.speed === 'number' && v.speed > 0) r.speed = v.speed;
      if (typeof v.size === 'string') r.size = v.size.trim().slice(0, 40);
      if (Number.isInteger(v.n) && v.n >= 1 && v.n <= 4) r.n = v.n;
      return Object.keys(r).length ? r : undefined;
    };
    for (const k of ['chat', 'image', 'tts', 'asr', 'vision', 'ollama']) {
      const r = role(b[k]);
      if (r) out[k] = r;
    }
    if (b.security && typeof b.security === 'object') {
      // 远程访问口令：空字符串表示"清掉"（清掉后不再校验；本机使用照旧）
      if (typeof b.security.accessKey === 'string') out.security = { ...(out.security || {}), accessKey: b.security.accessKey.trim().slice(0, 64) };
    }
    if (b.chain && typeof b.chain === 'object') {
      // 五个接口各留三个回落槽：[0]=主力, 1~3=回落（2026-09-12）
      const CH = {};
      // 注意：这里不能把循环变量叫 role——那会遮蔽上面那个 role() 映射函数，
      // 于是 list.map(role) 里 role 变成字符串 → TypeError → 保存整包失败（我踩过一次）。
      for (const rl of ['chat', 'image', 'vision', 'world', 'memory']) {
        const list = Array.isArray(b.chain[rl]) ? b.chain[rl] : null;
        if (!list) continue;
        // 生图/识图各四槽（4+4=8），其余三个接口各三槽
        const cap = (rl === 'image' || rl === 'vision') ? 4 : 3;
        const clean = list.map(role).filter(Boolean).slice(0, cap);
        if (clean.length) CH[rl] = clean;
      }
      if (Object.keys(CH).length) out.chain = { ...(out.chain || {}), ...CH };
    }
    if (Array.isArray(b.fallbacks)) {
      out.fallbacks = b.fallbacks.map(role).filter(Boolean).slice(0, 5);
    }
    if (b.params && typeof b.params === 'object') {
      const p = {};
      if (typeof b.params.temperature === 'number' && b.params.temperature >= 0 && b.params.temperature <= 2) p.temperature = b.params.temperature;
      if (Number.isInteger(b.params.maxTokens) && b.params.maxTokens >= 64 && b.params.maxTokens <= 8000) p.maxTokens = b.params.maxTokens;
      if (Number.isInteger(b.params.historyRounds) && b.params.historyRounds >= 2 && b.params.historyRounds <= 60) p.historyRounds = b.params.historyRounds;
      if (Object.keys(p).length) out.params = { ...(out.params || {}), ...p };
    }
    if (typeof b.ownerPeerId === 'string') out.ownerPeerId = b.ownerPeerId.trim().slice(0, 120);
    if (typeof b.replyToAll === 'boolean') out.replyToAll = b.replyToAll;
    if (Array.isArray(b.blocklist)) out.blocklist = b.blocklist.map((s) => String(s).trim().slice(0, 120)).filter(Boolean).slice(0, 200);
    if (typeof b.paused === 'boolean') out.paused = b.paused;
    // 2026-09-13（决定 B2）：废弃「安静时段」——她的睡眠窗口直接由'她今天的 睡觉~起床'决定，
    // 不再需要用户另配一段。老配置里残留的 quietHours 会被丢弃。
    if (b.behavior && typeof b.behavior === 'object') {
      const B = {};
      if (typeof b.behavior.voiceRate === 'number' && b.behavior.voiceRate >= 0 && b.behavior.voiceRate <= 1) B.voiceRate = b.behavior.voiceRate;
      if (Number.isInteger(b.behavior.chunkMax) && b.behavior.chunkMax >= 1 && b.behavior.chunkMax <= 8) B.chunkMax = b.behavior.chunkMax;
      // 治断片（批 E4）的两个旋钮：总结起始轮数 + 自定义总结提示词
      if (Number.isInteger(b.behavior.summaryStart) && b.behavior.summaryStart >= 2 && b.behavior.summaryStart <= 40) B.summaryStart = b.behavior.summaryStart;
      if (typeof b.behavior.summaryPrompt === 'string') B.summaryPrompt = b.behavior.summaryPrompt.slice(0, 500);
      // 她的身体（生理期 + 日常身体）默认开；关掉后提示词与电量都不再受影响
      if (b.body && typeof b.body.enabled === 'boolean') B.body = { enabled: b.body.enabled };
      // N2：两条主动之间最少隔多久（分钟）——主动性闸门的统一间隔
      if (b.life && isFinite(Number(b.life.proactiveGapMin))) {
        B.life = { ...(B.life || {}), proactiveGapMin: Math.max(0, Math.min(600, Math.round(Number(b.life.proactiveGapMin)))) };
      }
      // 真人感来自减法（会犯困/话说短/小细节记不清）默认开
      if (typeof b.behavior.realism === 'boolean') B.realism = b.behavior.realism;
      // 她能不能用指令（记住一件事 / 拍张照片给你 / 发语音 / 发个表情包）
      if (typeof b.behavior.commands === 'boolean') B.commands = b.behavior.commands;
      // 复读止血的强度（她主动消息不重复说同一件事）
      if (['off', 'literal', 'literal+intent'].includes(b.behavior.repeatGuard)) B.repeatGuard = b.behavior.repeatGuard;
      // 常识四层·第 4 层（发前自检）的开关，默认开
      if (typeof b.behavior.selfCheck === 'boolean') B.selfCheck = b.behavior.selfCheck;
      if (Number.isInteger(b.behavior.contextRounds) && b.behavior.contextRounds >= 2 && b.behavior.contextRounds <= 100) B.contextRounds = b.behavior.contextRounds;
      // 手速倍率（越大越快；上轮打字太慢后加的后台可调项）
      if (typeof b.behavior.talkiness === 'number' && isFinite(b.behavior.talkiness) && b.behavior.talkiness >= 0 && b.behavior.talkiness <= 100) B.talkiness = Math.round(b.behavior.talkiness);
      if (typeof b.behavior.speedMul === 'number' && isFinite(b.behavior.speedMul) && b.behavior.speedMul >= 0.5 && b.behavior.speedMul <= 2.5) B.speedMul = Math.round(b.behavior.speedMul * 100) / 100;
      if (Object.keys(B).length) out.behavior = { ...(out.behavior || {}), ...B };
    }
    if (b.memory && typeof b.memory === 'object') {
      const M = {};
      if (['cloud', 'manual'].includes(b.memory.extraction)) M.extraction = b.memory.extraction;
      if (typeof b.memory.extractionBaseUrl === 'string') M.extractionBaseUrl = b.memory.extractionBaseUrl.trim().slice(0, 300);
      if (typeof b.memory.extractionApiKey === 'string') M.extractionApiKey = b.memory.extractionApiKey.trim().slice(0, 300);
      if (typeof b.memory.extractionModel === 'string') M.extractionModel = b.memory.extractionModel.trim().slice(0, 200);
      if (Number.isInteger(b.memory.topK) && b.memory.topK >= 1 && b.memory.topK <= 20) M.topK = b.memory.topK;
      if (Number.isInteger(b.memory.extractEveryN) && b.memory.extractEveryN >= 1 && b.memory.extractEveryN <= 20) M.extractEveryN = b.memory.extractEveryN;
      if (typeof b.memory.sidecarUrl === 'string') M.sidecarUrl = b.memory.sidecarUrl.trim().slice(0, 200);
      if (typeof b.memory.selfMemory === 'boolean') M.selfMemory = b.memory.selfMemory;
      if (Object.keys(M).length) out.memory = { ...(out.memory || {}), ...M };
    }
    if (b.deform && typeof b.deform === 'object') {
      const D = {};
      if (typeof b.deform.enabled === 'boolean') D.enabled = b.deform.enabled;
      const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi);
      if (num(b.deform.sensitivity, 0.2, 3)) D.sensitivity = Math.round(b.deform.sensitivity * 100) / 100;
      if (num(b.deform.grip, 10, 95)) D.grip = Math.round(b.deform.grip);
      if (num(b.deform.loop, 20, 98)) D.loop = Math.round(b.deform.loop);
      if (num(b.deform.shadow, 30, 100)) D.shadow = Math.round(b.deform.shadow);
      if (Object.keys(D).length) out.deform = { ...(out.deform || {}), ...D };
    }
    // 「他是谁」已退场（2026-09-13 用户拍板）：她从零认识你，认知全部来自记忆。
    // 传进来的 ownerProfile 直接忽略，旧配置里的残留键也不再写回。
    if (b.job && typeof b.job === 'object') {
      // 职业机制：职业给"场景"，性格给"强度"。这里只存机制参数（职业名与类型在人设里）。
      const J = {};
      if (typeof b.job.enabled === 'boolean') J.enabled = b.job.enabled;
      if (['office', 'shift', 'freelance', 'night', 'student', 'none'].includes(b.job.type)) J.type = b.job.type;
      if (typeof b.job.workStart === 'string' && /^\d{1,2}:\d{2}$/.test(b.job.workStart.trim())) J.workStart = b.job.workStart.trim().padStart(5, '0');
      if (typeof b.job.workEnd === 'string' && /^\d{1,2}:\d{2}$/.test(b.job.workEnd.trim())) J.workEnd = b.job.workEnd.trim().padStart(5, '0');
      if (typeof b.job.workDays === 'string') J.workDays = b.job.workDays.replace(/[^0-6,]/g, '').slice(0, 20);
      const jn = (v, lo, hi, round) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? (round ? Math.round(v) : Math.round(v * 100) / 100) : null);
      const jv = jn(b.job.intensity, 0, 2, false); if (jv !== null) J.intensity = jv;
      const jc = jn(b.job.npcCount, 0, 6, true); if (jc !== null) J.npcCount = jc;
      for (const k of ['toSchedule', 'toNpc', 'toMoments', 'toStress']) if (typeof b.job[k] === 'boolean') J[k] = b.job[k];
      if (typeof b.job.label === 'string') J.label = b.job.label.trim().slice(0, 40);
      if (typeof b.job.reason === 'string') J.reason = b.job.reason.trim().slice(0, 120);
      if (typeof b.job.inferredFrom === 'string') J.inferredFrom = b.job.inferredFrom.trim().slice(0, 160);
      if (typeof b.job.source === 'string') J.source = b.job.source.trim().slice(0, 20);
      if (typeof b.job.inferredAt === 'number' && isFinite(b.job.inferredAt)) J.inferredAt = Math.round(b.job.inferredAt);
      if (Object.keys(J).length) out.job = { ...(out.job || {}), ...J };
    }
    if (b.world && typeof b.world === 'object') {
      const WD = {};
      if (typeof b.world.baseURL === 'string') WD.baseURL = b.world.baseURL.trim().slice(0, 300);
      if (typeof b.world.apiKey === 'string') WD.apiKey = b.world.apiKey.trim().slice(0, 300);
      if (typeof b.world.model === 'string') WD.model = b.world.model.trim().slice(0, 200);
      if (typeof b.world.weatherReal === 'boolean') WD.weatherReal = b.world.weatherReal;
      if (Object.keys(WD).length) out.world = { ...(out.world || {}), ...WD };
    }
    if (b.workshop && typeof b.workshop === 'object') {
      const W = {};
      if (typeof b.workshop.baseURL === 'string') W.baseURL = b.workshop.baseURL.trim().slice(0, 300);
      if (typeof b.workshop.apiKey === 'string') W.apiKey = b.workshop.apiKey.trim().slice(0, 300);
      if (typeof b.workshop.model === 'string') W.model = b.workshop.model.trim().slice(0, 200);
      if (Object.keys(W).length) out.workshop = { ...(out.workshop || {}), ...W };
    }
    if (b.media && typeof b.media === 'object') {
      const MD = {};
      if (typeof b.media.imageEnabled === 'boolean') MD.imageEnabled = b.media.imageEnabled;
      if (typeof b.media.reviewBeforeSend === 'boolean') MD.reviewBeforeSend = b.media.reviewBeforeSend;
      if (Object.keys(MD).length) out.media = { ...(out.media || {}), ...MD };
    }
    if (b.channel && typeof b.channel === 'object') {
      const C = {};
      if (['clawbot', 'wxauto'].includes(b.channel.mode)) C.mode = b.channel.mode;
      if (typeof b.channel.wxautoEnabled === 'boolean') C.wxautoEnabled = b.channel.wxautoEnabled;
      if (typeof b.channel.wxautoUrl === 'string') C.wxautoUrl = b.channel.wxautoUrl.trim().slice(0, 200);
      if (Number.isInteger(b.channel.wxautoDailyCap) && b.channel.wxautoDailyCap >= 1 && b.channel.wxautoDailyCap <= 1000) C.wxautoDailyCap = b.channel.wxautoDailyCap;
      if (Array.isArray(b.channel.wxautoPeers)) C.wxautoPeers = b.channel.wxautoPeers.map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 50);
      if (Object.keys(C).length) out.channel = { ...(out.channel || {}), ...C };
    }
    if (b.system && typeof b.system === 'object') {
      const S = {};
      if (typeof b.system.pythonPath === 'string') S.pythonPath = b.system.pythonPath.trim().slice(0, 300);
      if (typeof b.system.autoStartEngine === 'boolean') S.autoStartEngine = b.system.autoStartEngine;
      if (Number.isInteger(b.system.backupKeepDays) && b.system.backupKeepDays >= 1 && b.system.backupKeepDays <= 365) S.backupKeepDays = b.system.backupKeepDays;
      if (Object.keys(S).length) out.system = { ...(out.system || {}), ...S };
    }
    if (b.ollama && typeof b.ollama === 'object') {
      const o = {};
      if (typeof b.ollama.url === 'string') o.url = b.ollama.url.trim().slice(0, 200);
      if (typeof b.ollama.embedModel === 'string') o.embedModel = b.ollama.embedModel.trim().slice(0, 100);
      if (Object.keys(o).length) out.ollama = { ...(out.ollama || {}), ...o };
    }
    if (b.embed && typeof b.embed === 'object') {
      // 向量接口（2026-09-13 改）：地址是唯一权威，本地/云端由地址自动判定——
      // source 不再由用户选（下拉已删），这里改成"跟着地址自动写"，避免地址和来源互相打架。
      const E = {};
      if (typeof b.embed.baseURL === 'string') E.baseURL = b.embed.baseURL.trim().slice(0, 300);
      if (typeof b.embed.url === 'string') E.url = b.embed.url.trim().slice(0, 200);
      if (typeof b.embed.apiKey === 'string') E.apiKey = b.embed.apiKey.trim().slice(0, 300);
      if (typeof b.embed.model === 'string') E.model = b.embed.model.trim().slice(0, 200);
      if (typeof b.embed.embedModel === 'string') E.embedModel = b.embed.embedModel.trim().slice(0, 200);
      const dv = Number(b.embed.dim);
      if (isFinite(dv) && dv >= 64 && dv <= 8192) E.dim = Math.round(dv);
      // 来源跟着地址走（本地地址=local，其余=api）
      const probe = String(E.url != null ? E.url : E.baseURL || '');
      if (probe) E.source = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(probe.trim()) ? 'local' : 'api';
      else if (b.embed.source === 'local' || b.embed.source === 'api') E.source = b.embed.source;
      if (Object.keys(E).length) out.embed = { ...(out.embed || {}), ...E };
    }
    if (b.life && typeof b.life === 'object') {
      const L = {};
      if (typeof b.life.enabled === 'boolean') L.enabled = b.life.enabled;
      if (typeof b.life.wake === 'string' && /^\d{1,2}:\d{2}$/.test(b.life.wake.trim())) L.wake = b.life.wake.trim();
      if (typeof b.life.sleep === 'string' && /^\d{1,2}:\d{2}$/.test(b.life.sleep.trim())) L.sleep = b.life.sleep.trim();
      if (typeof b.life.morningOn === 'boolean') L.morningOn = b.life.morningOn;
      if (typeof b.life.nightOn === 'boolean') L.nightOn = b.life.nightOn;
      if (Number.isInteger(b.life.pokesPerDay) && b.life.pokesPerDay >= 0 && b.life.pokesPerDay <= 50) L.pokesPerDay = b.life.pokesPerDay;
      if (Array.isArray(b.life.pokeWindow) && b.life.pokeWindow.length === 2) L.pokeWindow = b.life.pokeWindow.map((x) => String(x).trim().slice(0, 5));
      if (Number.isInteger(b.life.nudgeMinutes) && b.life.nudgeMinutes >= 1 && b.life.nudgeMinutes <= 720) L.nudgeMinutes = b.life.nudgeMinutes;
      if (Number.isInteger(b.life.nudgeMaxPerDay) && b.life.nudgeMaxPerDay >= 0 && b.life.nudgeMaxPerDay <= 20) L.nudgeMaxPerDay = b.life.nudgeMaxPerDay;
      if (Object.keys(L).length) out.life = { ...(out.life || {}), ...L };
    }
    return out;
  }

  _isBlocked(peer) {
    const bl = this._modelConfig().blocklist;
    return Array.isArray(bl) && bl.includes(peer);
  }

  _driveSoul(accountId, creds, peer, chatId, text, content) {
    const prev = this._driveQueues.get(chatId) ?? Promise.resolve();
    const run = prev.then(
      () => this._driveSoulOnce(accountId, creds, peer, chatId, text, content),
      () => this._driveSoulOnce(accountId, creds, peer, chatId, text, content),
    );
    this._driveQueues.set(chatId, run);
    return run.finally(() => {
      if (this._driveQueues.get(chatId) === run) this._driveQueues.delete(chatId);
    });
  }

  async _driveSoulOnce(accountId, creds, peer, chatId, text, content, opts = {}) {
    const contextToken = this.store.getContextToken(accountId, peer);
    if (!contextToken) {
      this.ctx.logger?.warn?.('[wechat-companion] no context_token for ' + peer + '; cannot reply');
      return;
    }
    const cfg = this._modelConfig();
    const isOwner = !!cfg.ownerPeerId && cfg.ownerPeerId === peer;
    const mediaCount = content.filter((c) => c.type !== 'text').length;
          const hitCatchup = isOwner && this.life && this.life.consumeMorningCatchup ? this.life.consumeMorningCatchup() : false;
      // 她真的睡着了（夜间三态）：不回消息、不消耗模型，只记一笔；第二天早上她会自己提
      const _t0 = this.today() || {};
      const np = this.life && this.life.nightPhase ? this.life.nightPhase(new Date(), { wake: _t0.wake, sleep: _t0.sleep }) : 'awake';
      if (np === 'asleep') {
        try { this.life.markSleptThrough(); } catch {}
        this.activity('[睡] 她已睡着，这条先不打扰她：' + String(text || '').slice(0, 30));
        return;
      }
      // ── 醒着也不保证必回（2026-09-13，用户要求："我发的消息不是一定要回的"）──
      // 睡着是硬状态（上面已挡）；这里是软状态：电量低 / 心情差 / 在忙 → 她可能不回，或晚点回。
      // 铁律：绝不黑盒——每次不回都在实况直播写明原因；而且"连续不回"最多 1 次（免得像坏了）。
      if (!(opts && opts.forceReply)) {
        const pol = this._replyPolicy(this.today(), this.soul.getPersona());
        if (pol.mode === 'skip') {
          this._skipStreak = (this._skipStreak || 0) + 1;
          this.activity('[已读不回] 这次她没回你（' + pol.reason + '）');
          this.ctx.logger?.info?.('[soul] 已读不回：' + pol.reason);
          return;
        }
        if (pol.mode === 'later') {
          this._skipStreak = 0;
          this.activity('[已读不回] 这次她晚点回（' + pol.reason + '）');
          setTimeout(() => {
            void this._driveSoulOnce(accountId, creds, peer, chatId, text, content, { forceReply: true }).catch(() => {});
          }, pol.delayMs);
          return;
        }
        this._skipStreak = 0;
      }
const out = await this.soul.reply({ peerKey: accountId + ':' + peer, isOwner, text, mediaCount, today: this.today(), world: this.world.state(), voiceRate: isOwner ? Number((cfg.behavior && cfg.behavior.voiceRate) || 0) : 0, nightPhase: np, morningCatchup: hitCatchup });
    if (out.thought) this.activity('[思考] ' + out.thought);
    // ── 常识四层 · 第 4 层：发之前自检（2026-09-13，用户要求"4 加开关"）──
    // 用便宜模型审一遍：跟她此刻的处境/作息/现实常识冲不冲突？冲突就按处境改写再发。
    // 铁律：失败就原样发（绝不卡住她）；改写了必须在实况直播里写明原因。
    // 开关住在「她→她怎么说话」的人设里（persona.behavior.selfCheck），_behavior() 已把 config 与 persona 合并
    if ((this.soul._behavior() || {}).selfCheck !== false && out.chunks && out.chunks.length) {
      try {
        const situ = nowDoing(this.today(), this.world.state(), new Date()) + String.fromCharCode(10) + COMMON_SENSE;
        const rv = await selfCheckReview({
          chain: ((cfg.chain || {}).memory || []),
          situation: situ, userText: text, reply: out.chunks.join(' '), timeoutMs: 12000,
        });
        if (rv && rv.ok === false && rv.fix) {
          out.chunks = [rv.fix];
          out.delaysMs = [Array.isArray(out.delaysMs) && out.delaysMs.length ? out.delaysMs[0] : 800];
          this.activity('[常识自检] 改了一句不合处境的回复：' + (rv.reason || ''));
          this.ctx.logger?.info?.('[selfcheck] 改写：' + (rv.reason || ''));
        } else if (rv && rv.skipped) {
          this.ctx.logger?.info?.('[selfcheck] 跳过：' + (rv.reason || ''));
        }
      } catch (err) { this.ctx.logger?.warn?.('[selfcheck] 异常（原样发）: ' + (err && err.message)); }
    }
    for (let i = 0; i < out.chunks.length; i++) {
      const delay = i < out.delaysMs.length ? out.delaysMs[i] : 800;
      await sleep(delay);
      const chunkText = String(out.chunks[i]).slice(0, 4000);
      let voiceSent = false;
      // 语音条：仅主人、首条、配置了TTS、且本轮掷中语音
      if (out.voice && i === 0 && cfg.tts && cfg.tts.baseURL && cfg.tts.model) {
        try {
          const speakText = chunkText.replace(/\s+/g, ' ').slice(0, 160);
          const audio = await this.router.tts(speakText);
          const durationMs = Math.min(60000, Math.max(1500, speakText.length * 230));
          await this._sendVoiceMessage(accountId, peer, audio, durationMs);
          voiceSent = true;
          this.ctx.logger?.info?.('[voice] 语音条已发送 (' + audio.length + 'B)');
        } catch (err) {
          this.ctx.logger?.warn?.('[voice] 语音条失败，退回文字: ' + (err && err.message));
        }
      }
      if (!voiceSent) await this._sendChunk(peer, chunkText, { creds, peer, contextToken });
      this.activity('[回复] ' + chunkText.slice(0, 60));
    }
    // 她自己在回复里夹带的事（想拍张照片给你看 / 想记一件事 / 想发个表情包…）——文字发完再去做
    await this._runCommands(out.commands, accountId + ':' + peer, accountId, { peer });
    void this.soul.recordConversation({ peerKey: accountId + ':' + peer, isOwner, userText: text, herTexts: out.chunks }).then((sig) => {
      // A11：你隔了很久没来、现在回来了 → 这段缺席**只结算这一次**（量由想念曲线给）
      if (isOwner && out && out.absenceMs > 12 * 3600 * 1000) {
        try {
          const lg = out.longing || null;
          const sc = lg ? Math.max(0.25, Math.min(1, lg.value)) : 0.5;
          const days = Math.round(out.absenceMs / 86400000 * 10) / 10;
          this._dayEvent('ignored', '你隔了 ' + days + ' 天没来', sc);
          this.activity('[想念] 你隔了 ' + days + ' 天回来，这件事只算这一次（强度 ' + Math.round(sc * 100) + '%）');
        } catch { /* 结算失败不影响回复 */ }
      }
      // N3：引擎恢复后把降级的记忆补迁进引擎（10 分钟一次，没降级就零开销）
      if ((this.soul._memHealth ? this.soul._memHealth().degraded : 0) > 0 && Date.now() - (this._memSyncAt || 0) > 10 * 60 * 1000) {
        this._memSyncAt = Date.now();
        void this.soul.syncPendingMemories(5).then((r) => { if (r && r.synced) this.activity('[记忆] 把 ' + r.synced + ' 条降级记忆补进了引擎'); }).catch(() => {});
      }
      // 承诺闭环：每轮回复后火后不管地抽一次（只在主人轮次；绝不阻塞回复）
      void this.promises.maybeExtract({ peerKey: accountId + ':' + peer, isOwner, userText: text, herTexts: out.chunks })
        .catch((e) => this.ctx.logger?.warn?.('[promises] 抽取失败(忽略): ' + (e && e.message)));
      // 伤害程度影响压力大小（程度 2 明显更重）——仍然喂给同一台压力机，没有新增平行系统
      if (sig && sig.rude) this._dayEvent('rude', String(sig.hurtWhy || text).slice(0, 30), sig.hurtLevel === 2 ? 1.6 : 1);
      if (sig && sig.warm) this._dayEvent('warm', text.slice(0, 30));
      // 第三次改版：不再因阶段跃迁自动改称呼（称呼由世界引擎的分寸决定；后台仍可手动点「让她现在想一个」）
    }).catch(() => {});
  }

  // ── 通道抽象：ClawBot（官方机器人） ↔ wxauto（PC 接管，默认关）──

  _wxautoActive(cfg) {
    const ch = cfg.channel || {};
    return !!(ch.mode === 'wxauto' && ch.wxautoEnabled);
  }

  /** 发送一条分块：按配置走 wxauto 桥或 ClawBot */
  async _sendChunk(peer, text, fb) {
    const cfg = this._modelConfig();
    if (this._wxautoActive(cfg)) {
      if (this._wxautoOverCap(cfg, peer)) throw new Error('wxauto 今日发送已达上限（防封保护），明天再试');
      const url = String((cfg.channel && cfg.channel.wxautoUrl) || 'http://127.0.0.1:43123').replace(/\/+$/, '');
      const res = await fetch(url + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: peer, text }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error('wxauto 桥 HTTP ' + res.status);
      this._wxautoCountToday(peer);
      return;
    }
    await sendTextMessage(fb.creds, fb.peer, text, fb.contextToken);
  }

  /** wxauto 每日发送计数（防封：每日条数上限） */
  _wxautoCountToday(peer) {
    const key = localDateKey();
    if (!this._wxautoCounts || this._wxautoCounts.day !== key) this._wxautoCounts = { day: key, byPeer: {} };
    const by = this._wxautoCounts.byPeer;
    by[peer] = (by[peer] || 0) + 1;
    return by[peer];
  }

  _wxautoOverCap(cfg, peer) {
    const ch = cfg.channel || {};
    const cap = Math.max(1, Number(ch.wxautoDailyCap) || 120);
    if (!this._wxautoCounts || this._wxautoCounts.day !== localDateKey()) return false;
    return (this._wxautoCounts.byPeer[peer] || 0) >= cap;
  }

  /** wxauto 入站消息 → 灵魂回复 → 桥发回（UIA 通道驱动器） */
  async _driveWxauto(peer, text) {
    const cfg = this._modelConfig();
    if (cfg.paused) return;
    if (this._isBlocked(peer)) return;
    const isOwner = !!cfg.ownerPeerId && cfg.ownerPeerId === peer;
    const out = await this.soul.reply({ peerKey: 'wxauto:' + peer, isOwner, text, mediaCount: 0 });
    if (out.thought) this.activity('[思考] ' + out.thought);
    for (let i = 0; i < out.chunks.length; i++) {
      const delay = i < out.delaysMs.length ? out.delaysMs[i] : 800;
      await sleep(delay);
      const chunk = String(out.chunks[i]).slice(0, 4000);
      await this._sendChunk(peer, chunk, { creds: null, peer, contextToken: null });
      this.activity('[回复·wxauto] ' + chunk.slice(0, 60));
    }
    void this.soul.recordConversation({ peerKey: 'wxauto:' + peer, isOwner, userText: text, herTexts: out.chunks }).catch(() => {});
  }

  /** 起一个记忆引擎进程（内部用；不等待就绪） */
  _spawnMemoryEngine() {
    try {
      const sys = this._modelConfig().system || {};
      const py = String(sys.pythonPath || 'python');
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'python', 'memory_service.py');
      const logPath = path.join(this.companionDir, 'mem-engine.log');
      const out = fs.openSync(logPath, 'a');
      const child = spawn(py, [script], {
        detached: true, stdio: ['ignore', out, out], windowsHide: true,
        // 关掉 mem0 的遥测与远程公告（配置里的 telemetry 字段是假的，必须在进程环境层设）——
        // 实测 mem-engine.log 里出现过 "[PostHog] error uploading: us.i.posthog.com"，
        // 说明只写配置不够（mem0 / chromadb 都会各自建 PostHog 客户端）。
        env: {
          ...process.env,
          MEMORY_SERVICE_CONFIG: path.join(this.companionDir, 'memory-service.json'),
          // python 重定向到文件时默认是块缓冲，日志会看不到启动信息与诊断（实测踩到）
          PYTHONUNBUFFERED: '1',
          MEM0_TELEMETRY: 'False',
          ANONYMIZED_TELEMETRY: 'False',
          CHROMA_TELEMETRY: 'False',
          DO_NOT_TRACK: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          SCARF_NO_ANALYTICS: 'true',
        },
      });
      this._memEngineSpawned = true;
      try { child.unref(); } catch { /* noop */ }
      this.ctx.logger?.info?.('[wechat-companion] 已拉起 mem0 记忆引擎 (' + py + ')，日志: ' + logPath);
      return true;
    } catch (err) {
      this.ctx.logger?.warn?.('[wechat-companion] 记忆引擎拉起失败（可用 启动记忆引擎.bat 手动启动）: ' + err.message);
      return false;
    }
  }

  /**
   * 重启记忆引擎（2026-09-13 加）。
   * 为什么必须有：插件启动时若发现引擎已在跑就"复用"，永远不会重启它 →
   * **改了 python 代码 / 改了向量配置，引擎却一直跑旧的**。
   * 上一批的"向量真打通 + 维度护栏"就是这么白写的（后台显示已保存，实际不生效）。
   */
  async _restartMemoryEngine(reason) {
    if (this._memRestarting) return false;
    this._memRestarting = true;
    try {
      const memUrl = String((this._modelConfig().memory || {}).sidecarUrl || 'http://127.0.0.1:43122').replace(/\/+$/, '');
      this.ctx.logger?.info?.('[wechat-companion] 记忆引擎重启中（' + reason + '）…');
      // ① 让旧进程体面退出（老版本没有 /quit，退出失败也无所谓，下面新进程会顶掉端口）
      try {
        await fetch(memUrl + '/quit', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });
      } catch { /* 旧进程可能本来就没跑，或版本太旧没有 /quit */ }
      for (let i = 0; i < 12; i++) { await sleep(500); const h = await this.memClient.health(); if (!h) break; }
      // ② 起新的
      try { this.soul._engineCache = { ok: null, at: 0, info: null }; } catch { /* noop */ }
      this._spawnMemoryEngine();
      // ③ 等它就绪
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const h = await this.memClient.health();
        if (h && h.ready) {
          this._memEngineWasUp = true;
          try { this.soul._engineCache = { ok: true, at: Date.now(), info: h }; } catch { /* noop */ }
          this.ctx.logger?.info?.('[wechat-companion] 记忆引擎已重启并就绪: 向量 ' + (h.embedder || '?') + ' / 提炼 ' + (h.llm || '?'));
          return true;
        }
      }
      this.ctx.logger?.warn?.('[wechat-companion] 记忆引擎重启后仍未就绪（看 mem-engine.log）');
      return false;
    } finally {
      this._memRestarting = false;
    }
  }

  /** 旧 JSON 记忆 → mem0 的一次性补迁（幂等；只在没迁过时跑） */
  async _autoMigrateLegacyMemory() {
    try {
      const cfgNow = this._modelConfig();
      if (cfgNow.memoryLegacyMigrated) return;
      const pending = (this.soul.getMemories().entries || []).filter((e) => !e.mid);
      if (pending.length) {
        const r = await this.soul.migrateLegacyMemory();
        this.activity('[记忆] 旧记忆补迁 mem0: ' + r.added + ' 条（跳过重复 ' + (r.skipped || 0) + '）');
        this.ctx.logger?.info?.('[wechat-companion] 旧记忆补迁: ' + r.added + '/' + r.total);
      }
      this._writeCompanionConfig({ ...cfgNow, memoryLegacyMigrated: true });
    } catch (err) {
      this.ctx.logger?.warn?.('[wechat-companion] 旧记忆补迁失败(下轮再试): ' + err.message);
    }
  }

  /**
   * 桶化迁移（一次性）：给老记忆补上「桶」并回填本地缺失的 mid。
   * 失败不置标志、下轮重试；标志只保证"成功过就不重复跑"。
   */
  async _autoMigrateBuckets() {
    try {
      const cfgNow = this._modelConfig();
      if (cfgNow.memoryBucketsMigrated) return;
      const r = await this.soul.migrateBuckets();
      this.activity('[记忆] 桶化迁移：' + r.migrated + ' 条入桶 · 补回 mid ' + r.matched + ' 条 · 待人工处置 ' + r.review + ' 条');
      this._writeCompanionConfig({ ...cfgNow, memoryBucketsMigrated: true });
    } catch (err) {
      this.ctx.logger?.warn?.('[wechat-companion] 桶化迁移失败(下轮再试): ' + err.message);
    }
  }

  /** 记忆引擎 sidecar 自检：启动先写配置（消灭"引擎先于配置"空窗），拉起/重启，日志落盘 */
  async _ensureMemoryEngine() {
    try {
      const cfg0 = this._modelConfig();
      const sys = cfg0.system || {};
      if (sys.autoStartEngine === false) return;
      this._syncSidecarConfigs(cfg0);
      const h0 = await this.memClient.health();
      let restarted = false;
      if (h0) {
        if (h0.ready) this._memEngineWasUp = true;
        // 启动时总是重启一次，保证引擎跑的是当前的 python 代码 + 当前配置。
        // （旧行为「已在跑就复用」会让改了 python 也永远不生效。）
        restarted = await this._restartMemoryEngine('插件启动');
      }
      // 重启失败、或本来就没在跑 → 都必须退回去「直接拉起」。
      // 以前这里写的是 `if (!ok) return;`——结果是引擎一旦重启失败就**永远起不来**（实测踩到：
      // 插件重启后 /quit 关掉了旧引擎，新引擎再没被拉起，所有记忆操作全挂）。
      if (!restarted) {
        if (!this._spawnMemoryEngine()) return;
        for (let i = 0; i < 15; i++) {
          await sleep(2000);
          const h2 = await this.memClient.health();
          if (h2 && h2.ready) {
            this._memEngineWasUp = true;
            try { this.soul._engineCache = { ok: true, at: Date.now(), info: h2 }; } catch { /* noop */ }
            this.ctx.logger?.info?.('[wechat-companion] mem0 记忆引擎已就绪（自动拉起成功）');
            break;
          }
        }
      }
      await this._autoMigrateLegacyMemory();
      await this._autoMigrateBuckets();
    } catch (err) {
      this.ctx.logger?.warn?.('[wechat-companion] 记忆引擎自检失败: ' + (err && err.message));
    }
  }

  /** Directory where inbound media files are parked for the agent to read. */
  mediaInboxDir() {
    return path.join(this.workspaceDir(), 'inbox', localDateKey());
  }

  /** Whether the model selected for bridged sessions declares image input. */
  async _modelAcceptsImages() {
    try {
      const llm = this.ctx.get('llm');
      if (!llm?.listModels) return false;
      const defaultModel = this.ctx.get('agentDefaultModel');
      const current = this._settingsSource();
      const provider = current?.defaultProvider || defaultModel?.currentSelection?.()?.provider;
      const model = current?.defaultModel || defaultModel?.currentSelection?.()?.model;
      if (!provider || !model) return false;
      const info = (await llm.listModels(provider)).find((m) => m.id === model);
      return info?.inputModalities?.includes('image') === true;
    } catch {
      return false;
    }
  }

  /**
   * Download and decrypt every media item of one inbound message. Files are
   * parked under the inbox directory and described to the agent by path; an
   * image is additionally attached as native image content when the selected
   * model declares image input and the attachment store is available.
   */
  async _collectInboundMedia(account, creds, msg, chatId) {
    const blocks = [];
    const attachments = this.ctx.get('attachments');
    const acceptsImages = attachments && await this._modelAcceptsImages();
    for (const item of msg.item_list || []) {
      if (![2, 3, 4, 5].includes(item.type)) continue;
      let media;
      try {
        media = await downloadMediaFromItem(item, creds.cdnBaseUrl);
      } catch (err) {
        this.ctx.logger?.warn?.(`[wechat-companion] media download failed: ${err.message}`);
        continue;
      }
      if (!media) continue;

      const inbox = this.mediaInboxDir();
      try {
        await fsp.mkdir(inbox, { recursive: true });
        const name = `${Date.now()}-${media.fileName || `media-${item.type}.bin`}`;
        const target = path.join(inbox, name);
        await fsp.writeFile(target, media.data);
        // 语音：配置了ASR就"听懂"它
        if (media.kind === 'voice') {
          const a = this._modelConfig().asr;
          let heard = '';
          if (a && a.baseURL && a.model) {
            try {
              const wav = await silkToWav(media.data);
              const t = await this.router.asr(wav);
              heard = t.text || '';
              this.activity('[语音] 她听到：' + heard.slice(0, 40));
            } catch (err) {
              this.ctx.logger?.warn?.('[wechat-companion] 语音识别失败: ' + (err && err.message));
            }
          }
          blocks.push({ type: 'text', text: heard ? ('[微信语音] 她听到：' + heard) : ('[微信语音已保存: ' + target + ']') });
          continue;
        }
        // 图片：配置了识图模型就"看懂"它；否则走多模态附件
        if (media.kind === 'image') {
          const v = this._modelConfig().vision;
          if (v && v.baseURL && v.model) {
            try {
              const desc = await this.router.visionDescribe({ imageData: media.data, mime: 'image/jpeg', prompt: '这是你在微信里收到的一张图片，用一两句口语描述它的内容' });
              blocks.push({ type: 'text', text: '[微信图片] 她看到：' + String(desc).slice(0, 300) });
              this.activity('[图片] ' + String(desc).slice(0, 40));
              continue;
            } catch (err) {
              this.ctx.logger?.warn?.('[wechat-companion] 识图失败: ' + (err && err.message));
            }
          }
          if (acceptsImages) {
            try {
              const ref = await attachments.saveImage({
                data: new Uint8Array(media.data),
                mediaType: 'image/jpeg',
                name: media.fileName || 'wechat-image',
              });
              blocks.push({ type: 'image', attachment: ref });
            } catch (err) {
              this.ctx.logger?.warn?.(`[wechat-companion] image attach failed: ${err.message}`);
            }
          } else {
            blocks.push({ type: 'text', text: '[微信图片已保存: ' + target + ']' });
          }
          continue;
        }
        // 文件/视频：落盘告知
        const kindLabel = media.kind === 'file' ? '文件' : media.kind === 'video' ? '视频' : '媒体';
        blocks.push({ type: 'text', text: '[微信' + kindLabel + '已保存: ' + target + ']' });
      } catch (err) {
        this.ctx.logger?.warn?.(`[wechat-companion] media park failed: ${err.message}`);
      }
    }
    return blocks;
  }

  // ── one-way session turn-end notifications ──
  //
  // Every TOP-LEVEL DSH session's finished turn pings the allowlisted WeChat
  // peers with a short fixed-template message (no LLM summarization):
  //   【会话通知：<session name ≤15 chars>（<session id first 6>）】
  //   <turn response ≤200 chars>
  //
  // Strictly one-way BY CONSTRUCTION: the text is sent straight through the
  // WeChat HTTP API and is never appended to any session, injected into any
  // agent, or routed through the daily bridge session — so the daily session
  // never sees these notifications. A peer's reply still arrives through the
  // normal poll path and drives that day's session as usual. The bridge's own
  // sessions are skipped entirely (the peer already gets those replies; also
  // prevents notify → reply → notify loops).

  /**
   * Gate one `turn/end` event and fire the send in the background. Runs on
   * the hot session-event path: must never throw and never block the caller.
   */
  /** Workspace ids currently muted for one-way notifications. */
  _mutedWorkspaceIds() {
    return (this._settingsSource()?.notifyMutedWorkspaces || [])
      .map((w) => String(typeof w === 'string' ? w : w?.id || '').trim())
      .filter(Boolean);
  }

  /**
   * Resolve the workspace a session belongs to by reading the live workspace
   * registry (~/.dsh/storages/workspace.json) fresh on every check — that is
   * what makes muting take effect immediately without restarts. Any read or
   * parse failure fails open (session considered not muted).
   */
  _workspaceIdOfSession(sessionId) {
    try {
      const home = DSH_DOT_DIR;
      const raw = fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8');
      return findWorkspaceIdForSession(sessionId, JSON.parse(raw)?.tables?.workspaces);
    } catch {
      return null;
    }
  }

  _maybeNotifyTurnEnd(session, data) {
    if (!this.running) return; // notifications ride on an enabled bridge
    if (!this._settingsSource()?.notifyEnabled) return; // opt-in flag
    // Persistence-backend artifact: closing a crash-orphaned turn when an old
    // log is reloaded. Not a live turn end — never ping for it.
    if (data?.reason?.kind === 'interrupted') return;
    if (!shouldNotifySession(session?.id, session?.header)) return;

    // Workspace-level mute: every session inside a muted workspace is skipped.
    if (isWorkspaceMuted(this._workspaceIdOfSession(session.id), this._mutedWorkspaceIds())) return;

    let text;
    try {
      text = formatTurnNotification({
        events: session.events,
        turn: data.turn,
        reason: data.reason,
        sessionId: session.id,
      });
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] notification render failed: ${err.message}`);
      return;
    }
    // Serialize sends so concurrent turn ends cannot reorder within a chat.
    const run = (this._notifyChain ?? Promise.resolve())
      .then(() => this._sendSessionNotification(text));
    this._notifyChain = run.catch(() => { /* logged downstream */ });
  }

  /**
   * Record a freshly delivered context_token and, for allowlisted peers,
   * schedule delivery of any notifications queued while the token was stale.
   * Called from every inbound path (normal, duplicate, denied).
   */
  _refreshPeerToken(accountId, peer, token) {
    if (!token) return;
    this.store.upsertContextToken(accountId, peer, token);
    if (this._allowedPeers().includes(peer)) this._flushQueuedForPeer(peer);
  }

  /** Stash one failed push so the next inbound token refresh can catch up. */
  _enqueueNotifyBacklog(peer, text) {
    const now = Date.now();
    // Drop entries older than 24h (stale news) and cap total size so a
    // long outage cannot grow the queue without bound.
    this._notifyBacklog = this._notifyBacklog
      .filter((b) => now - b.at < 24 * 60 * 60 * 1000)
      .filter((b) => !(b.peer === peer && b.text === text));
    this._notifyBacklog.push({ peer, text, at: now });
    if (this._notifyBacklog.length > 20) this._notifyBacklog.splice(0, this._notifyBacklog.length - 20);
  }

  /** Deliver pushes queued for one peer as a single merged message. */
  async _flushNotifyBacklog(peer) {
    const items = this._notifyBacklog.filter((b) => b.peer === peer);
    if (items.length === 0) return;
    const target = this._notificationTargets().find((t) => t.peer === peer);
    if (!target) return;
    const head = items.length > 1 ? `📬 补发 ${items.length} 条暂存通知：\n\n` : '';
    const merged = head + items.map((b) => b.text).join('\n\n');
    try {
      await sendTextMessage(target.creds, peer, merged.slice(0, 4000), target.contextToken);
      this._notifyBacklog = this._notifyBacklog.filter((b) => b.peer !== peer);
      this.ctx.logger?.info?.(`[wechat-companion] flushed ${items.length} queued notification(s) to ${peer}`);
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] backlog flush to ${peer} failed, keeping ${items.length} queued: ${err.message}`);
    }
  }

  /** Chain a backlog flush onto the notification serializer. */
  _flushQueuedForPeer(peer) {
    const run = (this._notifyChain ?? Promise.resolve()).then(() => this._flushNotifyBacklog(peer));
    this._notifyChain = run.catch(() => { /* logged downstream */ });
  }

  /** Deliver one notification text to every reachable allowlisted peer. */
  async _sendSessionNotification(text) {
    const targets = this._notificationTargets();
    if (targets.length === 0) {
      this.ctx.logger?.info?.('[wechat-companion] session notification skipped: no allowlisted peer with a context_token yet');
      this._lastNotifyResult = { at: new Date().toISOString(), ok: 0, failed: 0, error: 'no reachable target (peer has no context_token yet)' };
      return;
    }
    let ok = 0;
    let failed = 0;
    let lastError;
    await Promise.all(targets.map(async ({ creds, peer, contextToken }) => {
      try {
        await sendTextMessage(creds, peer, text, contextToken);
        ok += 1;
      } catch (err) {
        failed += 1;
        lastError = err.message;
        this._enqueueNotifyBacklog(peer, text);
        this.ctx.logger?.warn?.(`[wechat-companion] session notification to ${peer} failed: ${err.message}`);
      }
    }));
    this._lastNotifyResult = { at: new Date().toISOString(), ok, failed, error: failed > 0 ? lastError : undefined };
  }

  /**
   * (account, peer) pairs a notification may go out through: every enabled
   * account × every allowlisted peer holding a stored `context_token`. The
   * token originates from the peer's last inbound message, so a peer who has
   * never messaged the bot cannot be proactively notified (protocol limit).
   */
  _notificationTargets() {
    const peers = this._allowedPeers();
    if (peers.length === 0) return [];
    const out = [];
    for (const account of this.store.listAccounts()) {
      if (account.enabled !== 1 || !account.token) continue;
      const creds = {
        botToken: account.token,
        ilinkBotId: account.account_id,
        baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
      };
      for (const peer of peers) {
        const contextToken = this.store.getContextToken(account.account_id, peer);
        if (!contextToken) continue;
        out.push({ creds, peer, contextToken });
      }
    }
    return out;
  }

  // Drive one DSH agent session per peer per local calendar day. Messages for
  // the same chat are serialized through a per-chat promise chain: two inbound
  // messages must never drive the same session concurrently (concurrent writers
  // were the seq-gap corruption trigger of the 2026-08-15 incident).
  _driveAgent(chatId, content) {
    const prev = this._driveQueues.get(chatId) ?? Promise.resolve();
    const run = prev.then(
      () => this._driveAgentOnce(chatId, content),
      () => this._driveAgentOnce(chatId, content),
    );
    this._driveQueues.set(chatId, run);
    return run.finally(() => {
      if (this._driveQueues.get(chatId) === run) this._driveQueues.delete(chatId);
    });
  }

  async _driveAgentOnce(chatId, content) {
    const agents = this.ctx.get('agents');
    const sessions = this.ctx.get('sessions');
    const defaultModel = this.ctx.get('agentDefaultModel');
    if (!agents || !sessions) {
      const _probe = ['settings', 'sessions', 'agents', 'sessionPersistence', 'agentDefaultModel', 'commands', 'tools', 'attachments', 'llm'];
      const _desc = (v) => (v === void 0 ? 'undefined' : v === null ? 'null' : typeof v);
      const _diag = _probe.map((k) => `${k}=${_desc(this.ctx.get(k))}`).join(' ');
      throw new Error(`agents/sessions service unavailable | ctx-probe: ${_diag}`);
    }

    const current = this._settingsSource();
    const provider = current?.defaultProvider || defaultModel?.currentSelection?.()?.provider;
    const model = current?.defaultModel || defaultModel?.currentSelection?.()?.model;
    const selection = provider && model ? { provider, model } : defaultModel?.currentSelection?.();
    // Sessions live under <DSH_HOME>/wechat-companion/WeChatSpace by default, not
    // the process cwd (~), so wechat conversations don't scatter sessions into
    // the home project directory. The directory is created on demand.
    const cwd = this.config.defaultCwd || this.workspaceDir();

    // Compose the same agent preset the GUI enter pipeline composes (default
    // preset, resolved BEFORE the session exists so the header can record it).
    // Without this, the WeChat agent runs against the empty global layer: the
    // tools and prompt sections the model is told about (bash, skill, fs, ...)
    // have no execution backend, every call fails with `unknown tool`, and the
    // failed call poisons the persisted session — the recurring "headless"
    // failure. A broken or absent preset roster degrades to the old
    // global-layer behavior with a warning instead of failing every message.
    const presets = this.ctx.get('agentPresets');
    let presetId;
    if (presets) {
      try {
        presetId = (await presets.resolve(undefined)).id;
      } catch (err) {
        this.ctx.logger?.warn?.(`[wechat-companion] agent preset resolution failed; running without preset tools: ${err.message}`);
      }
    }

    // One session per peer per local calendar day (this machine's timezone).
    // The date suffix rotates the session id at local midnight; a day without
    // conversation never materializes a session because creation stays lazy
    // (this code only runs on the first inbound text of the day).
    const dayKey = localDateKey();
    const sessionId = `wechat-${chatId}-${dayKey}`;
    const title = dayKey;
    // Mirror the GUI enter pipeline's composeAgent(): install the pinned
    // model selection, mount the preset (full capability surface), and deny
    // the one preset tool whose answer channel (the DSH web GUI) the phone
    // peer cannot reach. Mount failure propagates so the drive fails visibly
    // instead of silently producing a tool-less session.
    const setup = async (ac) => {
      installModelSelection(ac, { current: selection, assembled: undefined });
      if (presets && presetId !== undefined) {
        await presets.mount(ac, presetId);
        try {
          ac.tools.restrict({ deny: ['ask_user_question'] });
        } catch (err) {
          this.ctx.logger?.warn?.(`[wechat-companion] ask_user_question restriction skipped: ${err.message}`);
        }
      }
    };
    const agentOptions = { provider: selection?.provider, model: selection?.model };

    // Reuse the live agent when it is still registered; otherwise resume the
    // persisted session; otherwise create fresh (and attach to the workspace
    // so it shows up in the sidebar). create/resume return an AgentHandle
    // ({ agent, dispose }); agents.get() returns a bare Agent.
    let agent = agents.get(sessionId);
    let created = false;
    if (!agent) {
      try {
        agent = (await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })).agent;
      } catch {
        try {
          agent = (await agents.create({
            sessionId,
            meta: { cwd, ...presetId === undefined ? {} : { agentPreset: presetId } },
            agentOptions,
            setup,
          })).agent;
          created = true;
        } catch (createErr) {
          // A corrupt log blocks both resume (validation failure) and create
          // ("already exists"). Quarantine the artifact once, then recreate so
          // the rest of the day is usable instead of failing every message.
          if (String(createErr?.message || '').includes('already exists')) {
            if (await this._quarantineCorruptSession(sessionId)) {
              agent = (await agents.create({
                sessionId,
                meta: { cwd, ...presetId === undefined ? {} : { agentPreset: presetId } },
                agentOptions,
                setup,
              })).agent;
              created = true;
            } else {
              throw createErr;
            }
          } else {
            throw createErr;
          }
        }
      }
    }
    if (created) {
      await this._attachToWorkspace(sessionId, cwd);
      // Pin the human-readable title "<date>" with the user source so
      // automatic title generation is superseded and never overwrites it.
      try {
        agent.session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
      } catch (err) {
        this.ctx.logger?.warn?.(`[wechat-companion] title append failed for ${sessionId}: ${err.message}`);
      }
      // Bridge-created agents now mount the agent preset in setup (same as
      // the GUI enter pipeline), so the preset's own plugins inject the
      // user-global AGENTS.md and the skill catalog at every pre-step. The
      // one thing no preset knows is that this session's answer channel is
      // WeChat, not the web GUI — inject the interaction guard once per day.
      await this._injectDailyContext(agent);
    }
    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }));
    await agent.whenIdle();
    await sessions.flush(agent.session);

    // Reply extraction: the last non-empty assistant text of the drive
    // window, plus the final turn's end reason. A model-call failure (e.g.
    // upstream 401) ends the turn with reason.kind === 'error' and produces
    // no assistant message at all — surface THAT instead of a generic
    // "(空回复)" so the phone peer sees the real cause.
    let out = '';
    let lastReason;
    for (const ev of agent.session.events) {
      if (ev.seq < firstSeq) continue;
      if (ev.type === 'assistant/message') {
        const joined = ev.data?.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') || '';
        if (joined) out = joined;
      } else if (ev.type === 'turn/end') {
        lastReason = ev.data?.reason;
      }
    }
    if (!out && lastReason?.kind === 'error') return formatTurnErrorReply(lastReason, selection);
    return out || '(空回复)';
  }

  /**
   * Rename the persisted log of a corrupt session aside (`.corrupt-<ts>`)
   * using the persistence service's own locate(), so the raw bytes survive
   * for forensics while the session id becomes creatable again.
   * @returns true when the artifact was quarantined.
   */
  async _quarantineCorruptSession(sessionId) {
    try {
      const persistence = this.ctx.get('sessionPersistence');
      if (!persistence?.list || !persistence?.locate) return false;
      for (const header of await persistence.list()) {
        if (header.id !== sessionId) continue;
        const loc = persistence.locate(header);
        if (loc?.kind !== 'jsonl' || !loc.path) continue;
        const target = `${loc.path}.corrupt-${Date.now()}`;
        await fsp.rename(loc.path, target);
        this.ctx.logger?.warn?.(`[wechat-companion] quarantined corrupt session log: ${loc.path} -> ${target}`);
        return true;
      }
      return false;
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] quarantine attempt failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Register the `wechat_send_file` tool: the agent uploads a local image,
   * video, or file to the WeChat CDN and sends it to the peer of the session
   * it is driving. The peer is resolved from the session id
   * (`wechat-<chatId>-<dayKey>`), so no recipient argument is needed.
   */
  _registerSendFileTool(sctx) {
    try {
      const tools = sctx.tools;
      if (!tools?.register) return;
      tools.register(defineTool({
        name: 'wechat_send_file',
        description: 'Send a local file to the WeChat user of the current conversation. Uploads the file to the WeChat CDN and delivers it as an image, video, or file attachment (routed by file extension). Use it after generating an image, chart, report, or any artifact the WeChat user asked for.',
        parameters: {
          filePath: {
            type: 'string',
            required: true,
            description: 'Absolute path to the local file to send.',
          },
          caption: {
            type: 'string',
            description: 'Optional text caption sent as a separate message before the media.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              kind: { type: 'string' },
            },
          },
          render: (args, value) => [{
            type: 'text',
            text: value.ok
              ? `已发送${value.kind === 'image' ? '图片' : value.kind === 'video' ? '视频' : '文件'}到微信: ${args.filePath}`
              : '发送失败',
          }],
        },
        async execute(args, exec) {
          const sessionId = exec.agent?.session?.id;
          if (!sessionId) throw new Error('wechat_send_file has no calling agent session');
          return this._sendFileToPeer(sessionId, args.filePath, args.caption);
        },
      }));
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] send-file tool registration failed: ${err.message}`);
    }
  }

  /** 当前主人的亲密度（没有主人 / 还没聊过 → 0 = 刚认识） */
  _ownerAffection(cfg = this._modelConfig()) {
    try {
      const ownerRaw = String(cfg.ownerPeerId || '');
      const rels = this.soul.getRelations();
      for (const k of Object.keys(rels)) {
        if (ownerRaw && (k === ownerRaw || k.endsWith(':' + ownerRaw))) {
          const a = rels[k] && rels[k].affection;
          return typeof a === 'number' ? a : 0;
        }
      }
    } catch {}
    return 0;
  }

  /** 给生活调度器用的 soul 包装：主动消息也要知道"今天几点、今天的她、她的世界" */
  /** 主人的完整会话 key（accountId:peer）——取聊天记录要用它（主动消息 2026-09-13 起带上下文） */
  _ownerPeerKey(cfg = this._modelConfig()) {
    const peer = String(cfg.ownerPeerId || '');
    if (!peer) return 'owner';
    try {
      const acct = this.store.listAccounts().find((a) => a.enabled === 1 && a.token);
      if (acct && acct.accountId) return acct.accountId + ':' + peer;
    } catch { /* 取不到账号就退回裸 peer */ }
    return peer;
  }

  _soulForLife(today) {
    const self = this;
    const ownerKey = this._ownerPeerKey();
    return {
      proactive: (kind, extra = {}) => self.soul.proactive(kind, { ...extra, today, world: self.world.state(), peerKey: ownerKey }),
    };
  }

  /**
   * 职业 → 生活形状：只要求用户填一句话，机器负责判断怎么上班。
   * 链路：对话模型判断（几秒）→ 失败则关键词兜底（永远不失败）；结果存进 config.job，后台可见可改。
   * 世界引擎每晚跑成功后会在 world-state.job 里给出它自己的判断（更懂她的生活），daily 会优先用它。
   */
  async _inferJob(jobText) {
    const text = String(jobText == null ? (this.soul.getPersona().job || '') : jobText).trim();
    const cfg = this._modelConfig();
    const jc = cfg.job || {};
    if (!text) {
      this._writeCompanionConfig(this._sanitizeConfig({ ...cfg, job: { ...jc, inferredFrom: '', reason: '还没填职业', source: '' } }));
      return { type: 'none', label: JOB_TYPES.none.label, source: 'none', reason: '还没填职业' };
    }
    const res = await inferJob({ router: this.router, jobText: text, persona: this.soul.getPersona(), log: (m) => this.ctx.logger?.info?.(m) });
    this._writeCompanionConfig(this._sanitizeConfig({
      ...cfg,
      job: { ...jc, type: res.type, label: res.label, workStart: res.workStart, workEnd: res.workEnd, workDays: res.workDays, reason: res.reason, source: res.source, inferredFrom: res.inferredFrom, inferredAt: res.inferredAt },
    }));
    this.ctx.logger?.info?.('[job] 判断「' + text + '」→ ' + res.label + ' ' + res.workStart + '-' + res.workEnd + '（' + res.source + '）' + res.reason);
    this.activity('[职业] ' + res.label + '（' + (res.source === 'model' ? '模型判断' : '关键词兜底') + '）：' + res.reason);
    return res;
  }

  /** 后台保存人设后异步跑一次（不阻塞保存） */
  _inferJobBackground(jobText) {
    void this._inferJob(jobText).catch((e) => this.ctx.logger?.warn?.('[job] 推断失败: ' + (e && e.message)));
  }

  /**
   * 工作负荷落地：世界引擎排的 workload（0-100）超过阈值才算"被工作压垮"，
   * 强度 = 超出部分 × 配置里的职业影响强度 × 性格系数（在 applyDayEvent 里按秩序感放大）。
   * 这样"加班让她崩"是可解释的：后台能同时看到 workload、压力值、当天六维浮动。
   */
  _applyWorkload(workload) {
    const w = Number(workload);
    if (!isFinite(w) || w < 50) return null;
    const cfg = this._modelConfig();
    const jobCfg = cfg.job || {};
    if (jobCfg.enabled === false || jobCfg.toStress === false) return null;
    const inten = typeof jobCfg.intensity === 'number' ? jobCfg.intensity : 1;
    const scale = Math.max(0.2, Math.min(2, ((w - 40) / 60) * inten));
    this.ctx.logger?.info?.('[job] 工作负荷 ' + Math.round(w) + ' → 压力/六维 ×' + scale.toFixed(2));
    return this._dayEvent('work', '工作负荷 ' + Math.round(w), scale);
  }

  /**
   * 关系阶段跃迁后，让她自己决定要不要换个"希望大家怎么叫她"的称呼。
   * 一次只跑一个（防并发），结果写进 persona.relationship：ownerCallsMe + renameLog + announceName。
   * 后台可锁死（renameLock=true 时永不自动改）。
   */
  async _maybeRename() {
    if (this._renameBusy) return null;
    let persona;
    try { persona = this.soul.getPersona(); } catch { return null; }
    const rc = persona.relationship || {};
    const pend = rc.renamePending;
    if (!pend || rc.renameLock) return null;
    this._renameBusy = true;
    try {
      const r = await decideRename({
        router: this.router, persona, from: pend.from || '上一阶段', to: pend.to || '这一阶段',
        log: (m) => this.ctx.logger?.info?.(m),
      });
      if (!r || !r.changed || !r.name) {
        this.soul.updateRelationship({ renamePending: null });
        if (r && r.same) this.ctx.logger?.info?.('[rename] 她想保持现在的叫法');
        return r;
      }
      const log = Array.isArray(rc.renameLog) ? rc.renameLog.slice(-19) : [];
      log.push({ at: Date.now(), from: rc.ownerCallsMe || persona.name || '', to: r.name, stage: pend.to, reason: r.reason || '' });
      this.soul.updateRelationship({ ownerCallsMe: r.name, renameLog: log, renamePending: null, announceName: true });
      try { await this.soul.addMemory({ who: 'self', text: '（改称呼）我决定让大家叫我「' + r.name + '」' + (r.reason ? '——' + r.reason : ''), cat: 'her', bucket: 'feel' }); } catch {}
      this.ctx.logger?.info?.('[rename] 她现在希望大家叫她「' + r.name + '」（' + (r.reason || '') + '）');
      this.activity('[称呼] 她决定让大家叫她「' + r.name + '」：' + (r.reason || ''));
      return r;
    } catch (err) {
      this.ctx.logger?.warn?.('[rename] 失败: ' + err.message);
      return null;
    } finally { this._renameBusy = false; }
  }

  /**
   * 记一次"今天发生的事"：同时进①变形压力机（stress）②当天六维弹性（traitDrift）。
   * 同一个事件两套机制的用处不同——变形机管"她这一刻会不会崩"，
   * 当天六维管"她今天接下来的语气/电量/主动欲"，都回归到"她是活的"。
   */
  _dayEvent(kind, note, scale) {
    const k = scale == null ? 1 : scale;
    try { this.deform?.note(kind, k); } catch {}
    let out = null;
    try {
      const traits = (this.soul?.getPersona() || {}).traits || {};
      out = applyDayEvent(this.companionDir, kind, traits, { note, intensity: k });
      if (out && !out.skipped) this.ctx.logger?.info?.('[wechat-companion] 今日六维浮动「' + out.label + '」 ' + JSON.stringify(out.applied));
    } catch (err) { this.ctx.logger?.warn?.('[wechat-companion] day event failed: ' + err.message); }
    return out;
  }

  /** Resolve `{ accountId, peer }` from a wechat session id, if it is one. */
  _peerFromSessionId(sessionId) {
    const m = /^wechat-(.+)-\d{4}-\d{2}-\d{2}$/.exec(sessionId);
    if (!m) return null;
    const decoded = decodeWeixinChatId(m[1]);
    if (!decoded) return null;
    return decoded;
  }

  /** Upload one local file and deliver it to the WeChat peer of a session. */
  async _sendFileToPeer(sessionId, filePath, caption) {
    const peerInfo = this._peerFromSessionId(sessionId);
    if (!peerInfo) throw new Error(`cannot resolve WeChat peer from session "${sessionId}"`);
    return this._deliverMedia(peerInfo.accountId, peerInfo.peerUserId, filePath, caption);
  }

  /** 把本地图片/视频/文件上传微信 CDN 并发给某个联系人（相册"发到微信"走这条） */
  async _deliverMedia(accountId, peerUserId, filePath, caption) {
    const ext = path.extname(filePath).toLowerCase();
    let kind = 'file';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) kind = 'image';
    else if (['.mp4', '.mov', '.m4v'].includes(ext)) kind = 'video';

    const account = this.store.getAccount(accountId);
    if (!account?.token) throw new Error(`no stored account for ${accountId}`);
    const creds = {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
    };
    const contextToken = this.store.getContextToken(accountId, peerUserId);
    if (!contextToken) throw new Error(`no context_token for ${peerUserId}; cannot send`);

    const data = await fsp.readFile(filePath);
    if (data.length === 0) throw new Error(`file is empty: ${filePath}`);
    if (data.length > 100 * 1024 * 1024) throw new Error(`file exceeds 100MB: ${filePath}`);

    const uploaded = await uploadMediaToCdn(creds, getUploadUrl, data, peerUserId, kind);

    // Build the outbound media item per the ilink protocol.
    const media = {
      encrypt_query_param: uploaded.encryptQueryParam,
      aes_key: uploaded.aesKeyBase64,
      encrypt_type: 1,
    };
    let item;
    if (kind === 'image') {
      item = { type: 2, image_item: { media, mid_size: uploaded.fileSizeCiphertext } };
    } else if (kind === 'video') {
      item = { type: 5, video_item: { media, video_size: uploaded.fileSizeCiphertext } };
    } else {
      item = {
        type: 4,
        file_item: {
          media,
          file_name: path.basename(filePath),
          len: String(uploaded.fileSize),
        },
      };
    }

    if (caption) {
      await sendTextMessage(creds, peerUserId, String(caption).slice(0, 4000), contextToken);
    }
    await sendMessage(creds, peerUserId, [item], contextToken);
    return { ok: true, kind };
  }

  /**
   * Inject the one piece of context the agent preset cannot supply for a
   * WeChat session: the interaction guard. Bridge-created agents mount the
   * agent preset in setup (same as the GUI enter pipeline), so the preset's
   * own plugins already inject the user-global AGENTS.md and the
   * model-invocable skill catalog at every pre-step — reinjecting them here
   * would only duplicate the prompts. Best-effort: any failure leaves the
   * session fully functional.
   */
  async _injectDailyContext(agent) {
    // WeChat interaction guard: the interactive option UI is wired (same
    // `userQuestions` provider as GUI sessions) but its answer channel is the
    // DSH web GUI, not WeChat — options render in the browser, the phone user
    // cannot see or click them, and the reply would never arrive unless
    // someone operates the desktop UI. Instruct the model to inline questions
    // + options as plain text instead. Injected first so it is the strongest,
    // earliest context the model sees for this session kind. (`ask_user_question`
    // is additionally denied at the tool layer in the agent setup.)
    try {
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: WECHAT_INTERACTION_GUARD,
        }],
        source: { kind: 'plugin', plugin: 'dsh-wechat-companion' },
      }));
      this.ctx.logger?.info?.('[wechat-companion] injected WeChat interaction guard (no interactive option UI)');
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] interaction guard injection skipped: ${err.message}`);
    }
  }

  // ── workspace attachment (sidebar visibility) ──

  /** Attach a session to the workspace whose path equals its cwd (best-effort). */
  async _attachToWorkspace(sessionId, cwd) {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry) return;
      let ws = await registry.resolveByPath(cwd);
      if (!ws) ws = await registry.create(cwd);
      await ws.attachSession(sessionId);
    } catch (err) {
      // Non-fatal: the session still works; it just may not show in the sidebar.
      this.ctx.logger?.warn?.(`[wechat-companion] workspace attach failed: ${err.message}`);
    }
  }

  // ── QR login (shared by /companion command and settings-tab HTTP API) ──

  /** Start a QR login session; returns sessionId plus a scannable PNG data URL. */
  async startQrLogin() {
    const resp = await startLoginQr();
    if (!resp.qrcode || !resp.qrcode_img_content) throw new Error('failed to get QR from WeChat (bot_type=3 ilink account required)');
    const sessionId = `qr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this._loginSessions.set(sessionId, { qrcode: resp.qrcode, status: 'waiting', startedAt: Date.now() });
    // CodePilot renders a QR of the qrcode_img_content URL server-side.
    const qrImage = await QRCode.toDataURL(resp.qrcode_img_content, { width: 256, margin: 2 });
    return { sessionId, qrImage };
  }

  /** Poll one QR session; on confirmed, persists the account and enables the bridge. */
  async pollQrStatus(sessionId) {
    const s = this._loginSessions.get(sessionId);
    if (!s) throw new Error('unknown sessionId');
    const r = await pollLoginQrStatus(s.qrcode);
    s.status = r.status || s.status;
    if (r.status === 'confirmed' && r.bot_token && r.ilink_bot_id) {
      const accountId = r.ilink_bot_id.replace(/[@.]/g, '-');
      this.store.upsertAccount({
        accountId,
        userId: r.ilink_user_id || '',
        baseUrl: r.baseurl || 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
        token: r.bot_token,
        name: accountId,
        enabled: true,
      });
      this._loginSessions.delete(sessionId);
      this.setEnabled(true);
      return { status: 'confirmed', accountId };
    }
    return { status: s.status };
  }

  /**
   * Enumerate selectable provider/model options from the live `llm` service:
   * registered provider routes plus each provider's adapter-discovered models.
   * The settings UI renders these as dropdown options (no free-text input).
   */
  async _modelOptions() {
    const llm = this.ctx.get('llm');
    if (!llm?.listProviders) return { providers: [] };
    const providers = [];
    for (const info of llm.listProviders()) {
      const models = [];
      if (typeof llm.listModels === 'function') {
        try {
          for (const m of await llm.listModels(info.id) || []) {
            models.push({ id: m.id, name: m.name || m.id });
          }
        } catch (err) {
          this.ctx.logger?.warn?.(`[wechat-companion] model list failed for ${info.id}: ${err.message}`);
        }
      }
      providers.push({ id: info.id, name: info.name || info.id, models });
    }
    return { providers };
  }

  // ── HTTP API for the settings tab ──

  async httpHandler(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    });
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/^\/wechat-companion\/?/, '');
      // ── 远程访问口令（机务 → 系统与备份）────────────────────────────────
      // 只有**设了口令**才校验：没设＝一切照旧（本机使用不受影响）。
      // 这是给"内网穿透"加的门：公网请求必须带 ?key=你的口令（或 X-Access-Key 头）。
      if (!this._accessOk(req, url)) {
        const isPage = (req.method === 'GET' && (path === '' || path === 'room' || path === 'room/' || path === 'console'));
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(isPage
          ? '<!doctype html><meta charset="utf-8"><title>需要口令</title><body style="font-family:system-ui;padding:28px;line-height:1.9;color:#333"><h3>需要访问口令</h3><p>这台机器上的她设了访问口令。请在地址后面加上你的口令再打开，例如：</p><p><code>?key=你的口令</code></p><p>提示：口令在「机务 → 系统与备份 → 远程访问口令」里可以改。</p></body>'
          : JSON.stringify({ ok: false, error: '需要访问口令（在地址后面加 ?key=你的口令）' }));
        return;
      }
      if (req.method === 'GET' && path === 'status') {
        const current = this._settingsSource();
        return send(200, {
          running: this.running,
          defaultProvider: current?.defaultProvider || '',
          defaultModel: current?.defaultModel || '',
          notifyEnabled: !!current?.notifyEnabled,
          allowedPeers: current?.allowedPeers || '',
          // Peer ids holding a context token — people who have messaged the
          // bot at least once. This is where the opaque internal peer ids
          // (not WeChat aliases) become visible after a first conversation.
          knownPeers: this.store.listKnownPeers(),
          // Diagnostics: last notification batch outcome + per-account poll
          // health (e.g. 'session-expired' → re-scan the QR code).
          lastNotify: this._lastNotifyResult,
          notifyMutedWorkspaces: this._settingsSource()?.notifyMutedWorkspaces || [],
          notifyBacklog: this._notifyBacklog.length,
          lastInboundAt: this._lastInboundAt || null,
          // Hours since the last inbound refresh of each allowlisted peer's
          // context_token (first enabled account) — staleness is what makes
          // proactive pushes start failing with errcode -14.
          peerTokenAgeHours: (() => {
            const acct = this.store.listAccounts().find((a) => a.enabled === 1 && a.token);
            if (!acct) return {};
            const out = {};
            for (const peer of this._allowedPeers()) {
              const at = this.store.contextTokenAt(acct.account_id, peer);
              out[peer] = at ? Math.round(((Date.now() - at) / 3_600_000) * 10) / 10 : null;
            }
            return out;
          })(),
          accounts: this.store.listAccounts().map((a) => ({
            accountId: a.account_id,
            name: a.name,
            enabled: a.enabled === 1,
            hasToken: !!a.token,
            lastLoginAt: a.last_login_at,
            health: this._accountHealth.get(a.account_id)?.state,
          })),
        });
      }
      if (req.method === 'GET' && path === 'model-options') {
        return send(200, await this._modelOptions());
      }
      if (req.method === 'POST' && path === 'notify-test') {
        // Diagnostic probe: one real proactive send per reachable target with
        // per-target outcomes, so token expiry / send failures are visible
        // instead of silently dropped.
        if (!this.running) return send(400, { error: 'bridge not running' });
        const stamp = new Date().toTimeString().slice(0, 8);
        const targets = this._notificationTargets();
        const results = [];
        await Promise.all(targets.map(async ({ creds, peer, contextToken }) => {
          try {
            await sendTextMessage(creds, peer, `🔔 wechat-companion 测试通知 ${stamp}（可忽略）`, contextToken);
            results.push({ peer, ok: true });
          } catch (err) {
            results.push({ peer, ok: false, error: err.message });
          }
        }));
        const failed = results.filter((r) => !r.ok);
        for (const r of results) if (r.ok) await this._flushNotifyBacklog(r.peer);
        this._lastNotifyResult = {
          at: new Date().toISOString(),
          ok: results.length - failed.length,
          failed: failed.length,
          error: failed[0]?.error,
        };
        const summary = results.length === 0
          ? 'no reachable target (peer has no context_token yet)'
          : failed[0]?.error;
        return send(200, { ok: failed.length === 0 && results.length > 0, error: summary, targets: results.length, results });
      }
      if (req.method === 'POST' && path === 'config') {
        const body = await readBody();
        const settings = this.ctx.get('settings');
        if (!settings) return send(500, { error: 'settings service unavailable' });
        const patch = {};
        if (typeof body.defaultProvider === 'string') patch.defaultProvider = body.defaultProvider;
        if (typeof body.defaultModel === 'string') patch.defaultModel = body.defaultModel;
        // Settings-tab notification toggle.
        if (typeof body.notifyEnabled === 'boolean') patch.notifyEnabled = body.notifyEnabled;
        // Settings-tab allowlist editor (comma-separated internal peer ids;
        // empty string = deny everyone).
        if (typeof body.allowedPeers === 'string') patch.allowedPeers = body.allowedPeers.trim();
        // Muted-workspace list for one-way notifications ([{id,title}], id is
        // the stable key). Sanitized to plain string fields before persisting.
        if (Array.isArray(body.notifyMutedWorkspaces)) {
          patch.notifyMutedWorkspaces = body.notifyMutedWorkspaces
            .map((w) => ({ id: String(typeof w === 'string' ? w : w?.id || '').trim(), title: String(typeof w === 'string' ? '' : w?.title || '').trim() }))
            .filter((w) => w.id)
            .slice(0, 100);
        }
        if (Object.keys(patch).length === 0) return send(400, { error: 'no fields to update' });
        await settings.update(SETTINGS_NS, patch);
        return send(200, { ok: true, ...this._settingsSource() });
      }
      if (req.method === 'POST' && path === 'enable') { await this._persistEnabled(true); this.setEnabled(true); return send(200, { ok: true }); }
      if (req.method === 'POST' && path === 'disable') { await this._persistEnabled(false); this.setEnabled(false); return send(200, { ok: true }); }
      if (req.method === 'POST' && path === 'qrlogin') {
        const r = await this.startQrLogin();
        return send(200, { ok: true, ...r });
      }
      if (req.method === 'POST' && path === 'qrstatus') {
        const body = await readBody();
        const r = await this.pollQrStatus(body.sessionId || '');
        return send(200, { ok: true, ...r });
      }
      if (req.method === 'POST' && path === 'remove') {
        const body = await readBody();
        this.store.deleteAccount(body.accountId || '');
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === 'selftest') {
        const body = await readBody();
        const text = String(body.text || 'ping').slice(0, 2000);
        const chatId = String(body.chatId || `selftest::${Date.now()}`).slice(0, 200);
        const reply = await this._driveAgent(chatId, [{ type: 'text', text }]);
        return send(200, { ok: true, reply: reply.slice(0, 4000) });
      }
      if (req.method === 'POST' && path === 'refresh') {
        // Restart workers so account-list changes take effect immediately.
        if (this.running) { this.stop(); this.start(); }
        return send(200, { ok: true });
      }
      // ── 她的房间 + 后台控制台（手机/浏览器网页）──
      if (req.method === 'GET' && path === 'console') {
        // 每次请求都从磁盘现读：前台改动后浏览器刷新即生效，不用重启 DSH
        let html = CONSOLE_HTML;
        try { html = fs.readFileSync(CONSOLE_FILE, 'utf8'); } catch {}
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && (path === 'room' || path === 'room/' || path === '')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(ROOM_HTML);
        return;
      }
      // ── 陪伴面板 API（/wechat-companion/panel/*）──
      if (req.method === 'POST' && path === 'panel/conn-test') {
        const acct = this.store.listAccounts().find((a) => a.enabled === 1 && a.token) || this.store.listAccounts()[0];
        if (!acct || !acct.token) return send(400, { ok: false, error: '还没有已绑定的微信账号，请先扫码绑定' });
        const creds = {
          botToken: acct.token,
          ilinkBotId: acct.account_id,
          baseUrl: acct.base_url || 'https://ilinkai.weixin.qq.com',
          cdnBaseUrl: acct.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
        };
        try {
          await getUpdates(creds, '', 6000);
          const tokens = this.store.listKnownPeers();
          return send(200, { ok: true, note: '连接正常：微信服务器应答成功' + (tokens.length ? '，已认识 ' + tokens.length + ' 位联系人' : '，还没有人给她发过消息') });
        } catch (err) {
          return send(200, { ok: false, error: '连接失败: ' + err.message + '（token 可能过期，请重新扫码绑定）' });
        }
      }
      if (req.method === 'GET' && path === 'panel/activity') {
        return send(200, { ok: true, activity: this._activity, lastInboundAt: this._lastInboundAt || null, inboundCount: this._inboundCount || 0 });
      }
      if (req.method === 'GET' && path === 'panel/today') {
        try {
          const cfg0 = this._modelConfig();
          const ownerRaw = String(cfg0.ownerPeerId || '');
          const rels = this.soul.getRelations();
          let ownerRel = null;
          for (const k of Object.keys(rels)) {
            if (!ownerRaw) break;
            if (k === ownerRaw || k.endsWith(':' + ownerRaw)) { ownerRel = { key: k, ...rels[k] }; break; }
          }
          // 第三次改版：亲密度/关系阶段退场 —— 只下发"相处的事实"
          const relation = {
            hasOwner: !!ownerRaw,
            ownerKey: ownerRel ? ownerRel.key : '',
            callsMe: ((this.soul.getPersona().relationship) || {}).ownerCallsMe || '',
            chats: ownerRel ? (ownerRel.chats || 0) : 0,
            firstSeen: ownerRel ? (ownerRel.firstSeen || 0) : 0,
            lastSeen: ownerRel ? (ownerRel.lastSeen || 0) : 0,
            mood: this.soul.moodNow(),
          };
          try { relation.longing = this._longingInfo(); } catch { /* noop */ }
          // A12：后台只写一句事实，不显示分数（熟度取自世界引擎的实时判断）
          try {
            const tt0 = (this.world.state() || {}).tone || {};
            relation.fact = this.soul.affectionTitle(Number(tt0.intimacy) || 0, !!ownerRaw);
          } catch { /* noop */ }
          try {
            // 用与世界引擎心跳同一个上限（否则后台的额度数与实际生效的不是一个数）
            const toneG = toneForToday(this.world.state(), this.today());
            relation.gate = (this.life && this.life.gateView) ? this.life.gateView(new Date(), { stageLimit: this._stageLimitNow(toneG) }) : null;
          } catch { /* noop */ }
          return send(200, { ok: true, today: this.today(), deform: this.deform.info(), world: this.world.state(), evolution: this.soul.readEvolution(), relation, bodyState: this._bodyStateInfo() });
        } catch (err) { return send(200, { ok: true, today: null, error: err.message }); }
      }
      /* ── 形象工坊 + 相册 ── */
      if (req.method === 'GET' && path === 'panel/avatar') {
        const refs = this.avatar.refs().map((r) => ({ ...r, url: 'panel/avatar/file?id=' + r.id }));
        const main = this.avatar.main();
        const P0 = this.soul.getPersona();
        const prof0 = P0.profile || {};
        return send(200, {
          ok: true, refs, angles: ANGLES, mainId: main ? main.id : '',
          appearance: this.avatar.appearance(),
          appearanceText: this.avatar.appearanceText(),
          appearanceFrom: prof0.appearanceFrom || null,
          appearanceAt: prof0.appearanceAt || 0,
          hasPrev: !!prof0.appearancePrev,
          albumCount: this.avatar.album().length,
          canGenerate: !!(this._modelConfig().image || {}).model,
          hint: refs.length ? '' : '还没导入她的形象图：上传 3~8 张多角度（正/左/右/45度/全身）最利于保持长相一致。',
        });
      }
      if (req.method === 'GET' && path === 'panel/avatar/file') {
        const id = String((url.searchParams.get('id') || ''));
        const rec = this.avatar.refs().find((r) => r.id === id);
        if (!rec) { res.writeHead(404); return res.end('not found'); }
        const buf = fs.readFileSync(this.avatar.refFile(rec));
        res.writeHead(200, { 'content-type': rec.file.endsWith('.jpg') ? 'image/jpeg' : rec.file.endsWith('.webp') ? 'image/webp' : rec.file.endsWith('.gif') ? 'image/gif' : 'image/png', 'cache-control': 'no-store' });
        return res.end(buf);
      }
      if (req.method === 'POST' && path === 'panel/avatar/upload') {
        const b = await readBody();
        try {
          const rec = this.avatar.addRef({ dataBase64: b.dataBase64, mime: b.mime, angle: b.angle, name: b.name });
          this.activity('[形象] 新定稿图：' + rec.angle);
          // 用户拍板：外貌档案随上传的照片自动改变（识图失败不影响上传本身）
          void this.avatar.describeAppearance({ refId: rec.id })
            .then(() => this.activity('[形象] 已按新定稿图更新外貌描述'))
            .catch((e) => this.ctx.logger?.info?.('[avatar] 自动外貌描述跳过: ' + e.message));
          return send(200, { ok: true, ref: { ...rec, url: 'panel/avatar/file?id=' + rec.id } });
        } catch (err) { return send(400, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/avatar/setmain') {
        const b = await readBody();
        try { this.avatar.setMain(String(b.id || '')); return send(200, { ok: true }); }
        catch (err) { return send(400, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/avatar/delete') {
        const b = await readBody();
        const list = this.avatar.removeRef(String(b.id || ''));
        return send(200, { ok: true, refs: list.length });
      }
      if (req.method === 'GET' && path === 'panel/album') {
        const items = this.avatar.album().slice().reverse().map((x) => ({ ...x, url: 'panel/album/file?id=' + x.id }));
        return send(200, { ok: true, items });
      }
      if (req.method === 'GET' && path === 'panel/album/file') {
        const id = String(url.searchParams.get('id') || '');
        const rec = this.avatar.album().find((x) => x.id === id);
        if (!rec) { res.writeHead(404); return res.end('not found'); }
        const buf = fs.readFileSync(this.avatar.albumFile(rec));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(buf);
      }
      if (req.method === 'POST' && path === 'panel/album/generate') {
        const b = await readBody();
        try {
          const rec = await this.avatar.generate({ scene: b.scene, mode: b.mode || 'i2i', size: b.size });
          this.activity('[相册] 她拍了一张生活照：' + (rec.scene || '随手拍'));
          return send(200, { ok: true, item: { ...rec, url: 'panel/album/file?id=' + rec.id } });
        } catch (err) { return send(400, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/album/delete') {
        const b = await readBody();
        this.avatar.removeAlbum(String(b.id || ''));
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === 'panel/album/send') {
        const b = await readBody();
        const id = String(b.id || '');
        const rec = this.avatar.album().find((x) => x.id === id);
        if (!rec) return send(400, { ok: false, error: '找不到这张照片' });
        const cfg0 = this._modelConfig();
        const ownerRaw = String(cfg0.ownerPeerId || '').trim();
        const acct = this.store.listAccounts().find((a) => a.enabled === 1 && a.token) || this.store.listAccounts()[0];
        if (!acct) return send(400, { ok: false, error: '还没有绑定的微信账号' });
        // 收件人：优先"主人"，其次最近给她发过消息的人（有会话令牌才发得出去）
        const peers = this.store.listContextPeers(acct.account_id);
        let peer = '';
        if (ownerRaw) peer = peers.find((p) => p === ownerRaw || p.endsWith(':' + ownerRaw)) || '';
        if (!peer) peer = peers[0] || '';
        if (!peer) return send(400, { ok: false, error: '还没有会话令牌：让主人先给她发一条消息（发图必须有对方先来过消息）' });
        try {
          await this._deliverMedia(acct.account_id, peer, this.avatar.albumFile(rec), String(b.caption || '').slice(0, 200) || undefined);
          this.avatar.markSent(id);
          this.activity('[相册] 已把照片发到微信');
          return send(200, { ok: true, peer });
        } catch (err) { return send(400, { ok: false, error: '发送失败：' + err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/model-test') {
        // 「大脑」六个接口的两级体检：测连通（零成本） / 真跑一次（最小真实请求）
        const b = await readBody();
        const role = String(b.role || 'chat');
        const saved = this._modelConfig();
        const logs = [];
        const dir = joinPath(this.companionDir, 'model-tests');
        const saveFile = async ({ buf, b64, url, name, ext }) => {
          fs.mkdirSync(dir, { recursive: true });
          const useExt = ext || 'png';
          const file = joinPath(dir, name + '.' + useExt);
          if (buf) fs.writeFileSync(file, buf);
          else if (b64) fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          else if (url) { const r = await fetch(url); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); }
          else return '';
          return file;
        };
        const out = await runModelTest({ role, deep: !!b.deep, saved, form: b.form || b, saveFile, log: (m) => logs.push(m) });
        this.ctx.logger?.info?.('[model-test] ' + role + (b.deep ? ' 真跑' : ' 测连通') + ' → ' + (out.ok ? 'OK' : 'FAIL') + ' ' + out.ms + 'ms ' + (out.detail || ''));
        return send(200, { ok: true, ...out });
      }
      /* ── 外貌档案（一段描述；可按定稿图自动生成） ── */
      if (req.method === 'POST' && path === 'panel/avatar/describe') {
        const b = await readBody();
        try {
          const r = await this.avatar.describeAppearance({ refId: b.refId });
          this.activity('[形象] 按定稿图更新了外貌描述');
          return send(200, { ok: true, text: r.text, from: r.from });
        } catch (err) { return send(400, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/avatar/appearance') {
        const b = await readBody();
        if (b.restore) {
          const P = this.soul.getPersona();
          const prev = ((P.profile || {}).appearancePrev) || '';
          if (!prev) return send(400, { ok: false, error: '没有上一版可以恢复' });
          this.avatar.saveAppearanceText(prev);
          return send(200, { ok: true, text: prev });
        }
        const text = this.avatar.saveAppearanceText(String(b.text || ''));
        return send(200, { ok: true, text });
      }
      if (req.method === 'POST' && path === 'panel/job/infer') {
        // 手动让她重新判断一次职业怎么上班（保存职业时也会自动跑）
        const b = await readBody();
        try {
          const res = await this._inferJob(b.job);
          return send(200, { ok: true, job: res, config: this._modelConfig().job || {} });
        } catch (err) { return send(200, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/rename/now') {
        // 手动让她"现在想一个"：不受阶段跃迁限制（测试/预览用），锁死时也拒绝
        const P0 = this.soul.getPersona();
        const R0 = P0.relationship || {};
        if (R0.renameLock) return send(400, { ok: false, error: '已经锁死「她自己改称呼」——先在「你们→称呼」里解锁' });
        this.soul.updateRelationship({ renamePending: { from: R0.stage || '现在', to: R0.stage || '现在', at: Date.now() } });
        const r = await this._maybeRename();
        if (!r) return send(200, { ok: true, changed: false, note: '她这次没想改（或者调用失败，看日志）' });
        return send(200, { ok: true, changed: !!r.changed, name: r.name || '', reason: r.reason || '', same: !!r.same });
      }
      if (req.method === 'POST' && path === 'panel/rename/lock') {
        const b = await readBody();
        this.soul.updateRelationship({ renameLock: !!b.locked, renamePending: null });
        return send(200, { ok: true, locked: !!b.locked });
      }
      if (req.method === 'POST' && path === 'panel/relation/name') {
        // 备注名：只改后台显示（用户拍板 2026-09-13：不改她的记忆、不改她怎么称呼对方）
        const b = await readBody();
        try {
          const r = this.soul.setRelationName(b.key, b.name);
          return send(200, { ok: true, ...r });
        } catch (err) { return send(400, { ok: false, error: err.message }); }
      }
      if (req.method === 'GET' && path === 'panel/portrait') {
        return send(200, { ok: true, portrait: (this.world.state() || {}).portrait || '' });
      }
      if (req.method === 'GET' && path === 'panel/past') {
        // 她的过去（2026-09-13 决定 C3）：完全由世界引擎生成与推进，后台**只读**
        const P0 = this.soul.getPersona();
        return send(200, { ok: true, past: (P0.profile || {}).past || {}, readOnly: true });
      }
      if (req.method === 'POST' && path === 'panel/past/regen') {
        // 不满意就重点一下：清空 → 立刻让世界引擎重编一份（异步，约 10~30 秒）
        const P0 = this.soul.getPersona();
        this.soul.savePersona({ profile: { ...(P0.profile || {}), past: {} } });
        this._worldBusy = true;
        void this.world.generate({ persona: this.soul.getPersona(), today: this.today(), memories: (this.soul.getMemories().entries || []).slice(-12) })
          .then(() => { this._worldBusy = false; this.activity('[世界] 重新生成了她的过去'); })
          .catch((e) => { this._worldBusy = false; this.ctx.logger?.warn?.('[world] 重新生成过去失败: ' + e.message); });
        return send(200, { ok: true, note: '正在让她重新长一份过去，约 10~30 秒后刷新这一页' });
      }
      if (req.method === 'GET' && path === 'panel/diary/days') {
        // 已留档的日期（新→旧）：后台「世界 → 她的日记」的月历据此点亮
        return send(200, { ok: true, days: this.world.diaryDays() });
      }
      if (req.method === 'GET' && path === 'panel/diary') {
        // 看某一天的完整存档（Markdown 原文）。没带 date = 只看最近一晚。
        const date = String(url.searchParams.get('date') || '').slice(0, 10);
        const cur = this.world.state() || {};
        const days = this.world.diaryDays();
        return send(200, {
          ok: true, date, days,
          markdown: date ? this.world.diaryOf(date) : '',
          latest: { date: cur.date || '', forDate: cur.forDate || '', diary: cur.diary || '', generatedAt: cur.generatedAt || 0 },
        });
      }
      if (req.method === 'POST' && path === 'panel/portrait') {
        // 第三次改版（用户拍板 2026-09-13）：画像完全归世界引擎，后台不再提供手改入口。
        // 手改会被当晚的世界引擎重写（"能保存≠生效"的黑盒），所以直接拒绝而不是假装保存成功。
        return send(400, { ok: false, error: '画像由世界引擎每晚重写，后台已不提供手改（在「世界 → 世界引擎API」里点「立刻生成一次世界」可立即重写）' });
      }
      if (req.method === 'POST' && path === 'panel/reset') {
        // 一键重置（破坏性）：可分别勾选 记忆 / 聊天上下文 / 关系 / 她的生活；可先自动备份。
        // 设计原则：①默认全部不勾（必须用户主动勾）②返回值里逐项报告删了什么，避免"黑盒式清空"
        const b = await readBody();
        const want = {
          memory: !!b.memory,
          history: !!b.history,
          relation: !!b.relation,
          life: !!b.life,
        };
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const bdir = joinPath(this.companionDir, '..', 'wechat-companion-backups', '重置前-' + stamp);
        const report = { backupDir: '', removed: {}, note: [] };
        const targets = [];
        if (want.memory) targets.push('memory.json', 'memory-meta.json');
        if (want.relation) targets.push('relations.json');
        if (want.life) targets.push('world-state.json', 'daily-state.json', 'deform-state.json', 'evolution.json');
        if (b.backup) {
          try {
            fs.mkdirSync(bdir, { recursive: true });
            for (const f of [...targets, 'persona.json']) { try { fs.copyFileSync(joinPath(this.companionDir, f), joinPath(bdir, f)); } catch {} }
            if (want.history) { try { fs.cpSync(joinPath(this.companionDir, 'history'), joinPath(bdir, 'history'), { recursive: true }); } catch {} }
            if (want.memory) { try { fs.cpSync(joinPath(this.companionDir, 'mem0-store'), joinPath(bdir, 'mem0-store'), { recursive: true }); } catch {} }
            report.backupDir = bdir;
          } catch (err) { report.note.push('备份失败（已中止重置）：' + err.message); return send(500, { ok: false, ...report }); }
        }
        // 记忆：逐条走她的记忆接口删（引擎内存索引一起清），再清本地镜像
        if (want.memory) {
          try {
            const view = await this.soul.memoriesView();
            const ids = (view.entries || []).map((e) => e.id).filter(Boolean);
            for (const id of ids) { try { await this.soul.deleteMemory(id); } catch {} }
            const left = ((await this.soul.memoriesView()).entries || []).length;
            report.removed.memory = ids.length + ' 条' + (left ? ('（还有 ' + left + ' 条没删掉）') : '（已清空）');
          } catch (err) { report.note.push('清记忆时出错：' + err.message); }
          // 注意形状：必须是 {entries:[],todos:[]}，写成裸数组 [] 会让读取方 .entries 变 undefined → 她一说话就崩
          try { fs.writeFileSync(joinPath(this.companionDir, 'memory.json'), JSON.stringify({ entries: [], todos: [] }, null, 2), 'utf8'); } catch {}
          try { fs.writeFileSync(joinPath(this.companionDir, 'memory-meta.json'), '{}', 'utf8'); } catch {}
        }
        // 聊天上下文
        if (want.history) {
          let n = 0;
          try {
            const hd = joinPath(this.companionDir, 'history');
            for (const f of fs.readdirSync(hd)) { if (f.endsWith('.json')) { try { fs.unlinkSync(joinPath(hd, f)); n++; } catch {} } }
          } catch {}
          report.removed.history = n + ' 个会话文件';
        }
        // 关系 / 她的生活：直接删文件（下次自动重建）
        for (const [k, list] of [['relation', ['relations.json']], ['life', ['world-state.json', 'daily-state.json', 'deform-state.json', 'evolution.json']]]) {
          if (!want[k]) continue;
          let n = 0;
          for (const f of list) { try { fs.unlinkSync(joinPath(this.companionDir, f)); n++; } catch {} }
          report.removed[k] = n + ' 个文件';
        }
        this.activity('[重置] ' + JSON.stringify(report.removed));
        this.ctx.logger?.info?.('[reset] ' + JSON.stringify(report));
        return send(200, { ok: true, ...report });
      }
      if (req.method === 'POST' && path === 'panel/weather/test') {
        // 「天气到底接没接上」：拿她人设里的城市真查一次，把结果或失败原因原样返回
        const persona = this.soul.getPersona();
        const w0 = (this._modelConfig().world) || {};
        if (w0.weatherReal === false) return send(200, { ok: false, error: '「接入真实天气 API」这个开关是关着的（世界 → 她的天气）' });
        try {
          const r0 = await this.world._weather(persona, 0);
          const r1 = await this.world._weather(persona, 1);
          if (!r0 && !r1) return send(200, { ok: false, error: this.world._lastWeatherError || '取不到实时天气', city: persona.city || '' });
          return send(200, { ok: true, city: persona.city || '', today: r0, tomorrow: r1, note: '数据来自 Open-Meteo（免费、不需要 key）' });
        } catch (err) { return send(200, { ok: false, error: err.message, city: persona.city || '' }); }
      }
      if (req.method === 'POST' && path === 'panel/world/generate') {
        if (!this.running) return send(400, { error: '服务未启动' });
        // 指定日期 = 补那一天的剧本（当成那天深夜生成，这样 forDate 正好是那一天）
        const _b = await readBody();
        const _want = String(_b.date || '').trim();
        const _now = /^\d{4}-\d{2}-\d{2}$/.test(_want) ? new Date(_want + 'T23:30:00') : new Date();
        this._worldBusy = true;
        void this.world.generate({ now: _now, persona: this.soul.getPersona(), today: this.today(), memories: (this.soul.getMemories().entries || []).slice(-12) })
          .then((out) => { this._worldBusy = false; this.activity('[世界] 手动生成完成'); this._applyWorkload(out.workload); })
          .catch((e) => { this._worldBusy = false; this.ctx.logger?.warn?.('[world] ' + e.message); });
        return send(200, { ok: true, note: '世界生成中，约10-30秒', forDate: /^\d{4}-\d{2}-\d{2}$/.test(_want) ? _want : '' });
      }
      if (req.method === 'GET' && path === 'panel/moments') {
        return send(200, { ok: true, drafts: this.moments.list() });
      }
      if (req.method === 'POST' && path === 'panel/moments/generate') {
        const body = await readBody();
        const draft = await this.moments.generate({ theme: String(body.theme || '').slice(0, 200), imageTheme: String(body.imageTheme || '').slice(0, 200) });
        this.activity('[朋友圈草稿] ' + String(draft.text || '').slice(0, 50));
        return send(200, { ok: true, draft });
      }
      if (req.method === 'POST' && path === 'panel/moments/delete') {
        const body = await readBody();
        this.moments.deleteDraft(String(body.id || ''));
        return send(200, { ok: true, drafts: this.moments.list() });
      }
      if (req.method === 'POST' && path === 'panel/moments/posted') {
        const body = await readBody();
        this.moments.markPosted(String(body.id || ''));
        return send(200, { ok: true, drafts: this.moments.list() });
      }
      if (req.method === 'GET' && path === 'panel/workshop/sessions') {
        return send(200, { ok: true, sessions: this.workshop.listSessions() });
      }
      if (req.method === 'POST' && path === 'panel/workshop/sessions/new') {
        const s = this.workshop.newSession();
        return send(200, { ok: true, session: { id: s.id, title: s.title } });
      }
      if (req.method === 'POST' && path === 'panel/workshop/sessions/delete') {
        const body = await readBody();
        this.workshop.deleteSession(String(body.id || ''));
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && path === 'panel/workshop/session') {
        const u2 = new URL(req.url, 'http://x');
        const s = this.workshop.getSession(String(u2.searchParams.get('id') || ''));
        if (!s) return send(404, { error: '会话不存在' });
        return send(200, { ok: true, session: { id: s.id, title: s.title, messages: s.messages, draft: s.draft } });
      }
      if (req.method === 'POST' && path === 'panel/workshop/audit') {
        // 女娲的新职责之一：读她现有的人设/记忆/日记，指出"哪里不像人设/哪里矛盾"并给改法
        try {
          const r = await this.workshop.audit({});
          this.activity('[女娲] 体检校准完成：' + (r.findings || []).length + ' 条建议');
          return send(200, { ok: true, ...r });
        } catch (err) { return send(200, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/workshop/chat') {
        const body = await readBody();
        const r = await this.workshop.chat({ sessionId: String(body.sessionId || ''), message: String(body.message || ''), images: Array.isArray(body.images) ? body.images : [] });
        return send(200, { ok: true, ...r });
      }
      if (req.method === 'POST' && path === 'panel/workshop/analyze') {
        const body = await readBody();
        const draft = await this.workshop.analyze({ chatText: String(body.chatText || '').slice(0, 60000), description: String(body.description || '').slice(0, 500) });
        return send(200, { ok: true, draft });
      }
      if (req.method === 'POST' && path === 'panel/workshop/apply') {
        const body = await readBody();
        const r = await this.workshop.apply(body.draft);
        return send(200, { ok: true, persona: r.persona, seeds: r.seeds });
      }
      if (req.method === 'GET' && path === 'panel/config') {
        // 口令只回一个"设了没有"，**不回原文**（免得截图/日志把口令带出去）
        const cfgOut = JSON.parse(JSON.stringify(this._modelConfig() || {}));
        const hasKey = !!(this._accessKey());
        if (cfgOut.security) cfgOut.security = { ...cfgOut.security, accessKey: '' };
        return send(200, { ok: true, config: cfgOut, accessKeySet: hasKey, useSoul: this._soulEnabled() });
      }
      if (req.method === 'POST' && path === 'panel/config') {
        const body = await readBody();
        const next = this._writeCompanionConfig(this._sanitizeConfig(body));
        return send(200, { ok: true, config: next });
      }
      if (req.method === 'POST' && path === 'panel/models') {
        const body = await readBody();
        const models = await fetchModels({ baseURL: String(body.baseURL || ''), apiKey: String(body.apiKey || '') });
        return send(200, { ok: true, models });
      }
      if (req.method === 'POST' && path === 'panel/embed/probe') {
        // 向量接口"真跑一次"（2026-09-13 加）：打一次真实的 embedding 调用，量出**维度**。
        // 为什么要维度：mem0 的 faiss 库是按维度建的，换模型维度不同就必须重建库，否则一直检索不准。
        // 测通后把维度写进 config.embed.dim，并立刻同步给记忆引擎 sidecar（它是真消费方）。
        const b = await readBody();
        const url = String(b.url || '').trim().replace(/\/+$/, '');
        const apiKey = String(b.apiKey || '');
        const model = String(b.model || 'bge-m3');
        const local = !url || /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);
        const t0 = Date.now();
        try {
          let vec;
          if (local) {
            const r = await fetch((url || 'http://127.0.0.1:11434') + '/api/embeddings', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model, prompt: '连通性测试' }), signal: AbortSignal.timeout(30000),
            });
            if (!r.ok) throw new Error('HTTP ' + r.status + '（本地 Ollama 是否在跑？模型 ' + model + ' 是否已 pull？）');
            const d = await r.json();
            vec = d.embedding;
          } else {
            vec = await embedText({ baseURL: url, apiKey, model, input: '连通性测试' });
          }
          const dims = Array.isArray(vec) ? vec.length : 0;
          if (!dims) throw new Error('返回里没有向量（检查模型名是否是嵌入模型）');
          // 把这次测出来的维度存进配置（真实消费点：sidecar 的 embedding_dims）
          const saved = this._writeCompanionConfig(this._sanitizeConfig({
            ...this._modelConfig(),
            embed: { url: url || 'http://127.0.0.1:11434', apiKey, model, dim: dims },
          }));
          const sidecar = (saved.embed || {});
          return send(200, {
            ok: true, dims, ms: Date.now() - t0, local,
            detail: (local ? '本地 Ollama' : '云端接口') + ' · ' + model + ' · 实测 ' + dims + ' 维',
            saved: { url: sidecar.url || '', model: sidecar.model || '', dim: sidecar.dim || dims, source: sidecar.source || '' },
          });
        } catch (err) {
          return send(200, { ok: false, error: err.message, ms: Date.now() - t0, local });
        }
      }
      if (req.method === 'GET' && path === 'panel/persona') {
        const P = this.soul.getPersona();
        const bi = birthdayInfo(P.birthday);
        return send(200, { ok: true, persona: P, derived: { birthday: bi, age: bi.age != null ? bi.age : (P.age || '') } });
      }
      if (req.method === 'POST' && path === 'panel/persona') {
        const body = await readBody();
        const patch = {};
        for (const k of ['name', 'birthday', 'city', 'job', 'age', 'personaText', 'relationship', 'traits', 'behavior', 'quirks', 'redLines', 'interests', 'styleExamples', 'assessments', 'profile']) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        // 生日 → 年龄：填了完整日期就以生日算出来的为准（年龄不再手填）
        try {
          const cur = this.soul.getPersona();
          const bi = birthdayInfo(patch.birthday !== undefined ? patch.birthday : cur.birthday);
          if (bi.age != null) patch.age = String(bi.age);
        } catch { /* 算不出来就用手填的 age */ }
        const persona = this.soul.savePersona(patch);
        // 职业变了 → 让她自己（用对话模型）判断工作类型与作息；世界引擎今晚跑了会以它为准
        try {
          const jobText = String(persona.job || '').trim();
          const jc = this._modelConfig().job || {};
          if (jobText && jobText !== String(jc.inferredFrom || '')) {
            this._inferJobBackground(jobText);
          } else if (!jobText && jc.inferredFrom) {
            this._writeCompanionConfig(this._sanitizeConfig({ ...this._modelConfig(), job: { ...jc, inferredFrom: '', source: '', reason: '职业已清空' } }));
          }
        } catch { /* 推断失败不影响保存 */ }
        // 行为并入人设：persona.behavior 镜像到 config.life/behavior（life.js 过渡兼容）
        try {
          const b = persona.behavior || {};
          const cfgNow = this._modelConfig();
          this._writeCompanionConfig(this._sanitizeConfig({ ...cfgNow,
            behavior: { ...(cfgNow.behavior || {}) },
            life: { ...(cfgNow.life || {}), wake: b.baseWake || (cfgNow.life || {}).wake, sleep: b.baseSleep || (cfgNow.life || {}).sleep, pokesPerDay: b.activePerDay != null ? b.activePerDay : (cfgNow.life || {}).pokesPerDay, nudgeMinutes: b.pokeMinutes || (cfgNow.life || {}).nudgeMinutes, nudgeMaxPerDay: b.pokeMaxPerDay != null ? b.pokeMaxPerDay : (cfgNow.life || {}).nudgeMaxPerDay },
          }));
        } catch { /* 镜像失败不致命 */ }
        return send(200, { ok: true, persona });
      }
      if (req.method === 'GET' && path === 'panel/persona/archives') {
        return send(200, { ok: true, archives: this.soul.listArchives() });
      }
      if (req.method === 'POST' && path === 'panel/persona/archive') {
        const body = await readBody();
        const entry = this.soul.archivePersona(String(body.name || ''));
        return send(200, { ok: true, archive: entry });
      }
      if (req.method === 'POST' && path === 'panel/persona/switch') {
        const body = await readBody();
        const persona = this.soul.switchArchive(String(body.id || ''));
        return send(200, { ok: true, persona });
      }
      if (req.method === 'POST' && path === 'panel/persona/rename') {
        const body = await readBody();
        const hit = this.soul.renameArchive(String(body.id || ''), String(body.name || ''));
        return send(200, { ok: true, archive: hit });
      }
      if (req.method === 'POST' && path === 'panel/persona/archive-delete') {
        const body = await readBody();
        this.soul.deleteArchive(String(body.id || ''));
        return send(200, { ok: true });
      }
      // 她答应过的事（批 E3 / A8）：看得见、能取消/改期/补提
      if (req.method === 'GET' && path === 'panel/promises') {
        try { return send(200, { ok: true, ...this.promises.view() }); }
        catch (err) { return send(500, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/promises/action') {
        try {
          const b3 = await readBody(req);
          const r3 = this.promises.action({ id: String(b3.id || ''), op: String(b3.op || ''), due: b3.due, reason: b3.reason });
          if (!r3.ok) return send(400, { ok: false, error: r3.error });
          return send(200, { ok: true, ...this.promises.view() });
        } catch (err) { return send(500, { ok: false, error: err.message }); }
      }
      // 调试用：跑一次抽取但不入队（防"抽没抽到"变成黑盒）
      if (req.method === 'POST' && path === 'panel/promises/test') {
        try {
          const b4 = await readBody(req);
          const r4 = await this.promises.testExtract(String(b4.dialogue || ''));
          return send(r4.ok ? 200 : 400, r4);
        } catch (err) { return send(500, { ok: false, error: err.message }); }
      }
      // 表情包库（批 E2 / A7）：她能自己挑着发，你能传/停用/删
      if (req.method === 'GET' && path === 'panel/stickers') {
        try { return send(200, { ok: true, items: listStickers(this.companionDir) }); }
        catch (err) { return send(500, { ok: false, error: err.message }); }
      }
      if (req.method === 'POST' && path === 'panel/stickers') {
        try {
          const b2 = await readBody(req);
          const op = String(b2.op || 'add');
          if (op === 'add') {
            let buf = Buffer.alloc(0);
            if (b2.dataBase64) buf = Buffer.from(String(b2.dataBase64).replace(/^data:[^,]+,/, ''), 'base64');
            const r2 = addSticker(this.companionDir, { name: b2.name, ext: b2.ext || '.png', data: buf, tags: b2.tags });
            if (!r2.ok) return send(400, { ok: false, error: r2.error });
            this.activity('[表情包] 新增：' + b2.name);
            return send(200, { ok: true, item: r2.item, items: listStickers(this.companionDir) });
          }
          if (op === 'remove') {
            const r2 = removeSticker(this.companionDir, b2.name);
            if (!r2.ok) return send(400, { ok: false, error: r2.error });
            this.activity('[表情包] 删除：' + b2.name);
            return send(200, { ok: true, items: listStickers(this.companionDir) });
          }
          if (op === 'enable') {
            const r2 = setStickerEnabled(this.companionDir, b2.name, b2.enabled !== false);
            if (!r2.ok) return send(400, { ok: false, error: r2.error });
            return send(200, { ok: true, items: listStickers(this.companionDir) });
          }
          return send(400, { ok: false, error: 'op 只能是 add / remove / enable' });
        } catch (err) { return send(500, { ok: false, error: err.message }); }
      }
      // 她今天用了哪些「她想做的事」、到顶了没有（禁黑盒）
      if (req.method === 'GET' && path === 'panel/commands') {
        const cfg2 = this._modelConfig();
        const usage = this._readCmdUsage();
        return send(200, {
          ok: true,
          enabled: (cfg2.behavior || {}).commands !== false,
          usage: usageLine(usage, usage.date || ''),
          raw: usage.used || {},
          recent: this._recentWanted(),
        });
      }
      if (req.method === 'POST' && path === 'panel/memory/buckets-migrate') {
        try {
          const r = await this.soul.migrateBuckets();
          const cfgNow = this._modelConfig();
          this._writeCompanionConfig({ ...cfgNow, memoryBucketsMigrated: true });
          return send(200, { ok: true, ...r });
        } catch (err) { return send(500, { ok: false, error: err.message }); }
      }
      if (req.method === 'GET' && path === 'panel/memory') {
        const view = await this.soul.memoriesView();
        // 心情是算出来的（见 soul.moodNow）：读接口时统一带上，不返回文件里那个旧值
        const relsRaw = this.soul.getRelations();
        const moodNow = this.soul.moodNow();
        const relations = {};
        for (const k of Object.keys(relsRaw)) relations[k] = { ...relsRaw[k], mood: moodNow };
        const staleCount = (view.entries || []).filter((e) => e.bucket === 'dynamic' && e.weight <= 0.3).length;
        return send(200, { ok: true, ...view, relations, staleCount, health: { ...this.soul._memHealth(), pendingSync: this.soul.pendingMemoryCount() } });
      }
      if (req.method === 'GET' && path === 'panel/mem-engine') {
        const h = await this.memClient.health();
        return send(200, { ok: true, running: !!h, info: h });
      }
      if (req.method === 'POST' && path === 'panel/mem-engine/restart') {
        // 手动重启记忆引擎：改了向量配置/维度、或者引擎卡住时用（2026-09-13 加）
        const ok = await this._restartMemoryEngine('用户点了重启');
        const h = await this.memClient.health();
        this.activity('[记忆] 手动重启记忆引擎：' + (ok ? '成功' : '未就绪'));
        return send(200, { ok: true, restarted: ok, running: !!h, info: h });
      }
      if (req.method === 'GET' && path === 'panel/features') {
        return send(200, { ok: true, groups: featureGroups(), items: FEATURE_STATUS });
      }
      if (req.method === 'POST' && path === 'panel/memory/migrate') {
        const r = await this.soul.migrateLegacyMemory();
        this.activity('[记忆] 旧记忆迁移 mem0: ' + r.added + '/' + r.total);
        const view = await this.soul.memoriesView();
        return send(200, { ok: true, ...r, ...view });
      }
      if (req.method === 'GET' && path === 'panel/wxauto/status') {
        const cfg = this._modelConfig();
        const ch = cfg.channel || {};
        let bridge = null;
        try {
          const url = String(ch.wxautoUrl || 'http://127.0.0.1:43123').replace(/\/+$/, '');
          const r = await fetch(url + '/health', { signal: AbortSignal.timeout(3000) });
          bridge = r.ok ? await r.json() : null;
        } catch { bridge = null; }
        return send(200, {
          ok: true,
          enabled: !!ch.wxautoEnabled,
          mode: ch.mode || 'clawbot',
          bridge,
          sentToday: (this._wxautoCounts && this._wxautoCounts.day === localDateKey()) ? (this._wxautoCounts.byPeer || {}) : {},
        });
      }
      if (req.method === 'POST' && path === 'panel/wxauto/in') {
        // wxauto 桥回推的入站消息（PC 接管通道）
        const body = await readBody();
        const peer = String(body.peer || '').slice(0, 120);
        const text = String(body.text || '').slice(0, 4000);
        if (!peer || !text) return send(400, { error: 'peer/text required' });
        const msgId = 'wxauto:' + crypto.createHash('md5').update(peer + '|' + text + '|' + String(body.ts || '')).digest('hex').slice(0, 16);
        if (this.store.wasMessageProcessed('wxauto', msgId)) return send(200, { ok: true, dup: true });
        this.store.recordProcessedMessage('wxauto', msgId);
        this._lastInboundAt = Date.now();
        this._inboundCount = (this._inboundCount || 0) + 1;
        this.activity('[收·wxauto] ' + peer + ': ' + text.slice(0, 40));
        void this._driveWxauto(peer, text).catch((err) => this.ctx.logger?.warn?.('[wxauto] 处理失败: ' + err.message));
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === 'panel/memory') {
        const body = await readBody();
        const op = String(body.op || '');
        if (op === 'add') {
          await this.soul.addMemory({ who: String(body.who || ''), cat: String(body.cat || ''), bucket: String(body.bucket || ''), text: String(body.text || '') });
        } else if (op === 'edit') {
          await this.soul.editMemory(String(body.id || ''), body.patch || {});
        } else if (op === 'delete') {
          await this.soul.deleteMemory(String(body.id || ''));
        } else if (op === 'pin') {
          await this.soul.pinMemory(String(body.id || ''));
        } else if (op === 'bucket') {
          await this.soul.setBucket(String(body.id || ''), String(body.bucket || ''));
        } else {
          return send(400, { error: 'op must be add|edit|delete|pin|bucket' });
        }
        const view = await this.soul.memoriesView();
        return send(200, { ok: true, ...view });
      }
      if (req.method === 'POST' && path === 'panel/soul-test') {
        const body = await readBody();
        const out = await this.soul.reply({
          peerKey: String(body.peerKey || 'panel-test'),
          isOwner: body.isOwner !== false,
          text: String(body.text || '在干嘛呢').slice(0, 2000),
        });
        if (body.record) {
          try { void this.soul.recordConversation({ peerKey: String(body.peerKey || 'panel-test'), isOwner: body.isOwner !== false, userText: String(body.text || ''), herTexts: out.chunks }); } catch {}
        }
        return send(200, { ok: true, ...out });
      }
      return send(404, { error: 'unknown endpoint' });
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── slash command ──
  async _persistEnabled(val) {
    const settings = this.ctx.get('settings');
    try {
      await settings?.update(SETTINGS_NS, { enabled: val });
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-companion] settings persist failed: ${err.message}`);
    }
  }

  async handleCommand(inv) {
    const arg = (inv.input?.trim?.() || '').trim();
    const [cmd, ...rest] = arg.split(/\s+/);

    switch (cmd) {
      case 'enable': {
        await this._persistEnabled(true);
        this.setEnabled(true);
        return { kind: 'success', text: 'WeChat bridge enabled.' };
      }
      case 'disable': {
        await this._persistEnabled(false);
        this.setEnabled(false);
        return { kind: 'success', text: 'WeChat bridge disabled.' };
      }
      case 'status':
        return { kind: 'success', text: `running=${this.running}, accounts=${this.store.listAccounts().length}, notify=${this._settingsSource()?.notifyEnabled ? 'on' : 'off'}` };
      case 'accounts':
        return { kind: 'success', text: this.store.listAccounts().map((a) => `${a.account_id} enabled=${a.enabled} hasToken=${!!a.token}`).join('\n') || '(none)' };
      case 'rm':
        if (!rest[0]) return { kind: 'error', text: 'usage: /companion rm <accountId>' };
        this.store.deleteAccount(rest[0]);
        return { kind: 'success', text: `account ${rest[0]} removed` };
      case 'qrlogin': {
        try {
          const { sessionId, qrImage } = await this.startQrLogin();
          return { kind: 'success', text: `QR login started. sessionId=${sessionId}\n(poll status with /companion qrstatus ${sessionId}, or use the Settings UI tab)` };
        } catch (e) {
          return { kind: 'error', text: `qrlogin failed: ${e.message}` };
        }
      }
      case 'qrstatus': {
        try {
          const r = await this.pollQrStatus(rest[0] || '');
          return { kind: 'success', text: r.status === 'confirmed' ? `login confirmed, account ${r.accountId} saved & bridge enabled` : `status=${r.status}` };
        } catch (e) {
          return { kind: 'error', text: `qrstatus failed: ${e.message}` };
        }
      }
      default:
        return { kind: 'success', text: 'usage: /companion [enable|disable|status|accounts|qrlogin|qrstatus <sid>|rm <accountId>]' };
    }
  }
}

export { name };

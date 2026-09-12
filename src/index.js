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
import { birthdayInfo } from './birthday.js';
import { parseInboundText } from './inbound.js';
import { proactiveLimitOf, stageToneOf } from './soul.js';
import { inferJob, JOB_TYPES, guessJobType } from './job.js';
import { formatTurnErrorReply, formatTurnNotification, shouldNotifySession, stripMarkup, findWorkspaceIdForSession, isWorkspaceMuted } from './notify.js';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ModelRouter, fetchModels, embedText } from './model-router.js';
import { Soul } from './soul.js';
import { MemoryEmbed } from './memory-embed.js';
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
  'function j(m,p,b){return fetch("/wechat-companion/"+p,{method:m,headers:b?{"content-type":"application/json"}:undefined,body:b?JSON.stringify(b):undefined}).then(function(r){return r.json()})}',
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
    this._wxautoCounts = null;
    this.soul = new Soul({
      dir: this.companionDir,
      router: this.router,
      embed: this.embed,
      memory: this.memClient,
      behavior: () => {
        const c = this._modelConfig();
        return { ...(c.behavior || {}), memory: c.memory || {}, params: c.params || {} };
      },
      logger: (m) => this.ctx.logger?.info?.(m),
    });
    this.life = new Life({ dir: this.companionDir, config: () => this._modelConfig(), logger: (m) => this.ctx.logger?.info?.(m) });
    this.moments = new MomentsWorkshop({ dir: this.companionDir, router: () => this.router, soul: this.soul, config: () => this._modelConfig(), logger: (m) => this.ctx.logger?.info?.(m) });
    this.workshop = new PersonaWorkshop({ soul: this.soul, router: () => this.router, config: () => this._modelConfig(), sessionFile: path.join(this.companionDir, 'workshop-sessions.json'), logger: (m) => this.ctx.logger?.info?.(m) });
    this.world = new WorldEngine({ dir: this.companionDir, router: () => this.router, config: () => this._modelConfig(), soul: this.soul, logger: (m) => this.ctx.logger?.info?.(m) });
    this.avatar = new AvatarWorkshop({ dir: this.companionDir, routerGet: () => this.router, soul: this.soul, cfgGet: () => this._modelConfig(), logger: (m) => this.ctx.logger?.info?.(m) });
    this.deform = new Deform(this.companionDir, (m) => this.ctx.logger?.info?.(m), () => this._modelConfig());
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
    this.setEnabled(!!s?.enabled);
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
    if (this._modelConfig().ownerPeerId !== peer && this._inQuietHours(new Date())) return; // 安静时段：她只理主人
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

  /** 向量解析：source=api 走云端接口，否则本地 Ollama */
  async _embedTextFor(text) {
    const e = this._modelConfig().embed || {};
    if (e.source === 'api' && e.baseURL && e.model) {
      return embedText({ baseURL: e.baseURL, apiKey: e.apiKey, model: e.model, input: text });
    }
    const url = String(e.url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const model = e.model || e.embedModel || 'bge-m3';
    const res = await fetch(url + '/api/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: String(text).slice(0, 2000) }),
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

  /** 安静时段（如 01:00-07:30）：她只在主人找她时才回 */
  _inQuietHours(now) {
    const s = String(this._modelConfig().quietHours || '').trim();
    if (!/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(s)) return false;
    const toMin = (t) => { const p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); };
    const parts = s.split('-');
    const A = toMin(parts[0]); const B = toMin(parts[1]);
    const cur = now.getHours() * 60 + now.getMinutes();
    return A <= B ? (cur >= A && cur < B) : (cur >= A || cur < B);
  }

  // ---------- 生活系统（主动消息心跳） ----------
  async _lifeTick() {
    try {
      if (!this.running || !this._soulEnabled()) return;
      const cfg = this._modelConfig();
      if (cfg.paused || !cfg.ownerPeerId) return;
      if (cfg.life && cfg.life.enabled === false) return;
      const today = this.today();
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
      const sent = await this.life.tick({
        soul: this._soulForLife(today),
        overrides: {
          wake: today.wake, sleep: today.sleep, pokesPerDay: today.activeToday,
          // 关系阶段给的主动上限（刚认识就不该天天来找你）+ 安静时段（她不该打扰你的时间）
          stageLimit: proactiveLimitOf(this._ownerAffection(cfg)),
          quietHours: String(cfg.quietHours || ''),
        },
        sendToOwner: (text) => this._sendToOwnerPeer(cfg.ownerPeerId, text),
      });
      if (sent.some((x) => x.kind === 'nudge')) this._dayEvent('ignored', '她催你，你没回'); // 催过=被冷落记一笔
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
      const svc = {
        llm: {
          base_url: mem.extractionBaseUrl || chat.baseURL || 'https://api.siliconflow.cn/v1',
          api_key: mem.extractionApiKey || chat.apiKey || '',
          model: mem.extractionModel || chat.model || '',
        },
        embedder: {
          ollama_base_url: (cfg.ollama && cfg.ollama.url) || 'http://127.0.0.1:11434',
          model: (cfg.ollama && cfg.ollama.embedModel) || 'bge-m3',
        },
        store_path: path.join(this.companionDir, 'mem0-store'),
      };
      fs.writeFileSync(path.join(this.companionDir, 'memory-service.json'), JSON.stringify(svc, null, 2), 'utf8');
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
    if (typeof b.quietHours === 'string') out.quietHours = b.quietHours.trim().slice(0, 40);
    if (b.behavior && typeof b.behavior === 'object') {
      const B = {};
      if (typeof b.behavior.voiceRate === 'number' && b.behavior.voiceRate >= 0 && b.behavior.voiceRate <= 1) B.voiceRate = b.behavior.voiceRate;
      if (['instant', 'human', 'slow'].includes(b.behavior.replySpeed)) B.replySpeed = b.behavior.replySpeed;
      if (Number.isInteger(b.behavior.chunkMax) && b.behavior.chunkMax >= 1 && b.behavior.chunkMax <= 8) B.chunkMax = b.behavior.chunkMax;
      if (Number.isInteger(b.behavior.contextRounds) && b.behavior.contextRounds >= 2 && b.behavior.contextRounds <= 100) B.contextRounds = b.behavior.contextRounds;
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
      const E = {};
      if (b.embed.source === 'local' || b.embed.source === 'api') E.source = b.embed.source;
      if (typeof b.embed.baseURL === 'string') E.baseURL = b.embed.baseURL.trim().slice(0, 300);
      if (typeof b.embed.url === 'string') E.url = b.embed.url.trim().slice(0, 200);
      if (typeof b.embed.apiKey === 'string') E.apiKey = b.embed.apiKey.trim().slice(0, 300);
      if (typeof b.embed.model === 'string') E.model = b.embed.model.trim().slice(0, 200);
      if (typeof b.embed.embedModel === 'string') E.embedModel = b.embed.embedModel.trim().slice(0, 200);
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

  async _driveSoulOnce(accountId, creds, peer, chatId, text, content) {
    const contextToken = this.store.getContextToken(accountId, peer);
    if (!contextToken) {
      this.ctx.logger?.warn?.('[wechat-companion] no context_token for ' + peer + '; cannot reply');
      return;
    }
    const cfg = this._modelConfig();
    const isOwner = !!cfg.ownerPeerId && cfg.ownerPeerId === peer;
    const mediaCount = content.filter((c) => c.type !== 'text').length;
    const out = await this.soul.reply({ peerKey: accountId + ':' + peer, isOwner, text, mediaCount, today: this.today(), world: this.world.state(), voiceRate: isOwner ? Number((cfg.behavior && cfg.behavior.voiceRate) || 0) : 0 });
    if (out.thought) this.activity('[思考] ' + out.thought);
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
    void this.soul.recordConversation({ peerKey: accountId + ':' + peer, isOwner, userText: text, herTexts: out.chunks }).then((sig) => {
      if (sig && sig.rude) this._dayEvent('rude', text.slice(0, 30));
      if (sig && sig.warm) this._dayEvent('warm', text.slice(0, 30));
      void this._maybeRename(); // 阶段跃迁过？让她自己想想要不要换个叫法
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

  /** 记忆引擎 sidecar 自检：启动先写配置（消灭"引擎先于配置"空窗），没在跑就拉起，日志落盘 */
  async _ensureMemoryEngine() {
    try {
      const cfg0 = this._modelConfig();
      const sys = cfg0.system || {};
      if (sys.autoStartEngine === false) return;
      this._syncSidecarConfigs(cfg0);
      const h = await this.memClient.health();
      if (h && h.ready) {
        this.ctx.logger?.info?.('[wechat-companion] mem0 记忆引擎已就绪: ' + (h.engine || 'mem0') + ' / ' + (h.llm || 'llm?'));
        return;
      }
      if (h && !h.ready) {
        this.ctx.logger?.warn?.('[wechat-companion] 记忆引擎在跑但未就绪: ' + (h.reason || '未配置') + '（保存模型配置后 1 分钟内自动恢复）');
        return;
      }
      if (this._memEngineSpawned) return;
      this._memEngineSpawned = true;
      const py = String(sys.pythonPath || 'python');
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'python', 'memory_service.py');
      const logPath = path.join(this.companionDir, 'mem-engine.log');
      try {
        const out = fs.openSync(logPath, 'a');
        spawn(py, [script], {
          detached: true, stdio: ['ignore', out, out], windowsHide: true,
          env: { ...process.env, MEMORY_SERVICE_CONFIG: path.join(this.companionDir, 'memory-service.json') },
        }).unref();
        this.ctx.logger?.info?.('[wechat-companion] 已尝试拉起 mem0 记忆引擎 (' + py + ')，日志: ' + logPath);
      } catch (err) {
        this.ctx.logger?.warn?.('[wechat-companion] 记忆引擎拉起失败（可用 启动记忆引擎.bat 手动启动）: ' + err.message);
      }
      for (let i = 0; i < 15; i++) {
        await sleep(2000);
        const h2 = await this.memClient.health();
        if (h2 && h2.ready) {
          this.ctx.logger?.info?.('[wechat-companion] mem0 记忆引擎已就绪（自动拉起成功）');
          this.soul._engineCache = { ok: true, at: Date.now(), info: h2 };
          // 旧JSON记忆自动迁移（幂等：服务端按文本去重；标记防重复跑）
          try {
            const cfgNow = this._modelConfig();
            if (!cfgNow.memoryLegacyMigrated) {
              const pending = (this.soul.getMemories().entries || []).filter((e) => !e.mid);
              if (pending.length) {
                const r = await this.soul.migrateLegacyMemory();
                this.activity('[记忆] 旧记忆自动迁移 mem0: ' + r.added + ' 条（跳过重复 ' + (r.skipped || 0) + '）');
                this.ctx.logger?.info?.('[wechat-companion] 旧记忆自动迁移: ' + r.added + '/' + r.total);
              }
              this._writeCompanionConfig({ ...cfgNow, memoryLegacyMigrated: true });
            }
          } catch (err) {
            this.ctx.logger?.warn?.('[wechat-companion] 旧记忆自动迁移失败(下轮再试): ' + err.message);
          }
          break;
        }
      }
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
  _soulForLife(today) {
    const self = this;
    return {
      proactive: (kind, extra = {}) => self.soul.proactive(kind, { ...extra, today, world: self.world.state() }),
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
      try { await this.soul.addMemory({ who: 'self', text: '（改称呼）我决定让大家叫我「' + r.name + '」' + (r.reason ? '——' + r.reason : ''), importance: 3, tags: ['称呼'], source: 'self' }); } catch {}
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
      if (out) this.ctx.logger?.info?.('[wechat-companion] 今日六维浮动「' + out.label + '」 ' + JSON.stringify(out.applied));
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
          const aff = ownerRel && typeof ownerRel.affection === 'number' ? ownerRel.affection : 0;
          const cur = this.soul.stageOf(aff);
          const table = this.soul.stageTable();
          const nxt = table.find((x) => x.min > aff) || null;
          const relation = {
            hasOwner: !!ownerRaw, ownerKey: ownerRel ? ownerRel.key : '', stage: cur.label, stageMin: cur.min, callHint: cur.callHint,
            affection: Math.round(aff), mood: ownerRel ? Math.round(ownerRel.mood || 0) : 0, chats: ownerRel ? (ownerRel.chats || 0) : 0,
            firstSeen: ownerRel ? ownerRel.firstSeen : 0,
            next: nxt ? { label: nxt.label, min: nxt.min, need: Math.max(0, Math.round((nxt.min - aff) * 10) / 10) } : null,
            stages: table,
          };
          return send(200, { ok: true, today: this.today(), deform: this.deform.info(), world: this.world.state(), evolution: this.soul.readEvolution(), relation });
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
      if (req.method === 'GET' && path === 'panel/portrait') {
        return send(200, { ok: true, portrait: (this.world.state() || {}).portrait || '' });
      }
      if (req.method === 'POST' && path === 'panel/portrait') {
        const body = await readBody();
        const s = this.world.state();
        s.portrait = String(body.portrait || '').slice(0, 300);
        s.generatedAt = Date.now();
        this.world._write(s);
        return send(200, { ok: true, portrait: s.portrait });
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
        this._worldBusy = true;
        void this.world.generate({ persona: this.soul.getPersona(), today: this.today(), memories: (this.soul.getMemories().entries || []).slice(-12) })
          .then((out) => { this._worldBusy = false; this.activity('[世界] 手动生成完成'); this._applyWorkload(out.workload); })
          .catch((e) => { this._worldBusy = false; this.ctx.logger?.warn?.('[world] ' + e.message); });
        return send(200, { ok: true, note: '世界生成中，约10-30秒' });
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
        return send(200, { ok: true, config: this._modelConfig(), useSoul: this._soulEnabled() });
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
            behavior: { ...(cfgNow.behavior || {}), replySpeed: b.replySpeed || (cfgNow.behavior || {}).replySpeed || 'human' },
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
      if (req.method === 'GET' && path === 'panel/memory') {
        const view = await this.soul.memoriesView();
        return send(200, { ok: true, ...view, relations: this.soul.getRelations() });
      }
      if (req.method === 'GET' && path === 'panel/mem-engine') {
        const h = await this.memClient.health();
        return send(200, { ok: true, running: !!h, info: h });
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
          await this.soul.addMemory({ who: String(body.who || ''), text: String(body.text || ''), importance: Number(body.importance) || 3, tags: Array.isArray(body.tags) ? body.tags : [], pinned: !!body.pinned });
        } else if (op === 'edit') {
          await this.soul.editMemory(String(body.id || ''), body.patch || {});
        } else if (op === 'delete') {
          await this.soul.deleteMemory(String(body.id || ''));
        } else if (op === 'pin') {
          await this.soul.pinMemory(String(body.id || ''));
        } else {
          return send(400, { error: 'op must be add|edit|delete|pin' });
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

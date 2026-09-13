// _probe.mjs — 渲染自查探针（开发用）：用真 Chromium 跑 console.html + 假后端，
// 把某个页签渲染出来的**可见文字**整段打印出来，用来验证"某个设置项到底有没有出现在页面上"。
// 用法：~/.dsh/electron/electron.exe test/_probe.mjs <页签id> [要展开的小项序号,逗号分隔]
// 与 preview.mjs 的分工：preview 量排版指标 + 截图；probe 只回答"这段话在不在页面上"。
// 加 PROBE_LIVE=1 时：console.html 仍用工作区最新版，其余接口转发给正在跑的插件服务（127.0.0.1:43121），
// 于是可以"不改后端、不重启 DSH"地用真数据看页面。
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tab = process.argv[2] || 'persona';
const openItems = (process.argv[3] || '').split(',').filter(Boolean).map(Number);
const LIVE = process.env.PROBE_LIVE === '1';
const UPSTREAM = 'http://127.0.0.1:' + (process.env.PANEL_PORT || '43121');

const now = Date.now();
const routes = {
  status: { running: true, accounts: [{ accountId: 'wx_1f56fa24b78f8dfdee8d63fc', name: '小号', enabled: true, hasToken: true, lastLoginAt: '2026-09-11 21:03' }], knownPeers: ['peeraaa'] },
  'panel/persona/archives': { archives: [] },
  'panel/persona': { persona: { name: '苏镜语', birthday: '2004-02-03', city: '上海', job: '律师', interests: ['拼图', '咖啡'], quirks: { catchphrases: ['好呀'], emojiRate: 0.4, typoRate: 0 }, behavior: { replySpeed: 'human', baseWake: '08:00', baseSleep: '02:00', jitterMin: 45, nightOwlProb: 0.15, allNighterProb: 0.03, weekendShiftMin: 60, activePerDay: 3, talkiness: 44, speedMul: 1 }, relationship: { callOwner: '锦鲤', callLock: false, ownerCallsMe: '苏镜语' }, traits: { socialBattery: 59, warmth: 26, attachment: 20, sharpness: 64, initiative: 44, orderliness: 73 }, assessments: { mbti: 'INTJ' } } },
  'panel/config': { config: { world: { baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V4-Flash' }, deform: { enabled: true }, life: { enabled: true }, memory: { extraction: 'cloud' }, embed: { source: 'local', url: 'http://127.0.0.1:11434', model: 'bge-m3:latest' }, workshop: { baseURL: 'https://token.sensenova.cn/v1', model: 'sensenova-6.8-flash-lite' }, ownerPeerId: 'o9cq80yIvnvM7qlSYFqBUXOGJzHA@im.wechat', chat: { baseURL: 'https://api.sophnet.com/v1', model: 'DeepSeek-V4-Pro' }, behavior: { chunkMax: 4, contextRounds: 32 } } },
  'panel/today': { today: { date: '2026-09-13', wake: '09:30', sleep: '01:10', mood: 62, battery: 64, focus: '大理攻略', events: ['周末'] }, deform: { state: 'normal', stress: 22, integration: 12, thresholds: { grip: 58, loop: 80, shadow: 95 }, enabled: true, sensitivity: 0.67 }, world: { date: '2026-09-12', forDate: '2026-09-13', diary: '周末还是没能完全躺平。', thoughts: ['想去大理'], secrets: ['存了他一句话'], npcs: [{ name: '张姐', rel: '同事', note: '爱八卦' }], flow: [{ time: '10:10', text: '赖床' }], workload: 0, tone: { intimacy: 25, reason: '刚认识' }, statusLine: '今天案子卡住了，有点闷' }, evolution: { warm: 2, rude: 0, chats: 12 }, relation: { hasOwner: true, mood: 62, chats: 12, firstSeen: now - 5 * 86400000, lastSeen: now, callsMe: '苏镜语', gate: { line: '今天主动 1/3 次（分享与催共用这本账，早安晚安不算） · 距上一条 1 小时 30 分钟 · 明细：分享 1', gapMin: 45, budget: 3, skipped: {} } } },
  'panel/activity': { inboundCount: 128, lastInboundAt: now - 60000, activity: [] },
  'panel/memory': { engine: 'mem0', entries: [{ id: 'm1', text: '他不吃香菜', ts: now, who: 'peeraaa', source: 'manual', importance: 4, tags: ['饮食'] }], relations: { 'peeraaa': { mood: 70, chats: 42, lastSeen: now }, 'o9cq80yIvnvM7qlSYFqBUXOGJzHA@im.wechat': { mood: 62, chats: 12, firstSeen: now - 5 * 86400000, lastSeen: now }, 'wxid_abc123def456@im.wechat': { mood: 50, chats: 3, lastSeen: now - 6 * 3600000 } } },
  'panel/mem-engine': { running: true, info: { ready: true, llm: 'sensenova-6.8-flash-lite', embedder: 'bge-m3' } },
  'panel/wxauto/status': { mode: 'clawbot', enabled: false, bridge: { ready: false, listening: [] } },
  'panel/features': { groups: [] },
  'panel/moments': { drafts: [] },
  'panel/workshop/sessions': { sessions: [{ id: 's1', title: '新造人', updatedAt: now }] },
  'panel/workshop/session': { session: { id: 's1', messages: [], draft: {} } },
  'panel/portrait': { portrait: '他最近工作很忙' },
  'panel/avatar': { refs: [], mainId: '', appearance: {}, albumCount: 0, canGenerate: false, hint: '' },
  'panel/album': { items: [] },
  'panel/diary/days': { days: ['2026-09-12', '2026-09-11'] },
  'panel/diary': { date: '2026-09-12', days: ['2026-09-12', '2026-09-11'], markdown: '# 2026-09-12 她的日记\n\n> 这是她写给自己看的。\n\n## 📔 她的话（私人日记）\n\n周末还是没能完全躺平。\n\n## 🌤️ 那一天的她\n\n- 天气：多云转晴\n- 情绪：62 / 100\n\n## 💭 她的念头\n\n- 想去大理\n', latest: { date: '2026-09-12', forDate: '2026-09-13', diary: '周末还是没能完全躺平。', generatedAt: now } },
  'panel/status': { running: true },
};

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/wechat-companion/, '').replace(/^\//, '');
  if (u === 'console' || u === '') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(root, 'src/console.html')));
    return;
  }
  if (LIVE) {
    const up = new URL(UPSTREAM + req.url);
    const pr = http.request({ hostname: up.hostname, port: up.port, path: up.pathname + up.search, method: req.method, headers: { ...req.headers, host: up.host } }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    pr.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream: ' + e.message })); });
    req.pipe(pr);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(routes[u] !== undefined ? routes[u] : {}));
});

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const win = new BrowserWindow({ width: 1560, height: 1180, show: false, useContentSize: true });
  const errs = [];
  win.webContents.on('console-message', function () {
    const msg = Array.prototype.slice.call(arguments).map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/error|Error|not a function|undefined/.test(msg)) errs.push(msg.slice(0, 300));
  });
  await win.loadURL('http://127.0.0.1:' + port + '/console');
  await win.webContents.executeJavaScript("try{localStorage.setItem('ctab','" + tab + "');go('" + tab + "');}catch(e){}");
  await new Promise((r) => setTimeout(r, 900));
  if (openItems.length) {
    await win.webContents.executeJavaScript("var it=document.querySelectorAll('details.item');[" + openItems.join(',') + "].forEach(function(i){if(it[i])it[i].open=true;});");
    await new Promise((r) => setTimeout(r, 500));
  }
  const text = await win.webContents.executeJavaScript(
    "(function(){var m=document.querySelector('main');return m?m.innerText:('NO-MAIN '+(document.body?document.body.innerText.slice(0,500):''));})()"
  );
  const items = await win.webContents.executeJavaScript("document.querySelectorAll('details.item').length");
  console.log('=== TAB ' + tab + ' | items=' + items + ' | PAGE-ERR=' + errs.length + ' ===');
  if (errs.length) console.log(errs.map((e) => 'PAGE-ERR: ' + e).join('\n'));
  console.log(text);
  server.close();
  app.quit();
});

// preview.mjs — 给后台拍真实截图 + 量真实排版指标（Electron 主进程）
// 用法：~/.dsh/electron/electron.exe test/preview.mjs [页签id] [输出png] [要展开的小项序号,逗号分隔]
// 作用：起一个假后端（喂固定数据），用真实 Chromium 渲染 console.html：
//      ① 截图（给人看）② 打印排版指标（字号/宽度/换行/溢出，给机器把关，不靠肉眼）
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tab = process.argv[2] || 'persona';
const out = process.argv[3] || path.join(root, 'test', 'preview-' + tab + '.png');
const openItems = (process.argv[4] || '').split(',').filter(Boolean).map(Number);

const now = Date.now();
const routes = {
  status: { running: true, accounts: [{ accountId: 'wx_1f56fa24b78f8dfdee8d63fc', name: '小号', enabled: true, hasToken: true, lastLoginAt: '2026-09-11 21:03' }], knownPeers: ['peeraaa', 'peerbbb'] },
  'panel/persona/archives': { archives: [{ id: 'x1', name: '出厂小暖', savedAt: now, personaName: '小暖' }, { id: 'x2', name: '温柔的版本', savedAt: now - 86400000, personaName: '小暖' }] },
  'panel/persona': { persona: { name: '小暖', birthday: '3-14 双鱼座', city: '杭州', job: '插画师', age: '24', personaText: '在杭州做插画，接稿为生，喜欢下雨天窝在家里画图。', interests: ['拼图', '咖啡', '老电影'], quirks: { catchphrases: ['好呀', '嘿嘿'], emojiRate: 0.4, typoRate: 0 }, behavior: { replySpeed: 'human', baseWake: '07:30', baseSleep: '23:30', jitterMin: 45, nightOwlProb: 0.15, allNighterProb: 0.03, weekendShiftMin: 60, activePerDay: 3, pokeMinutes: 30, pokeMaxPerDay: 2 }, relationship: { callOwner: '阿泽', callLock: false, ownerCallsMe: '小暖' }, traits: { socialBattery: 59, warmth: 84, attachment: 70, sharpness: 11, initiative: 48, orderliness: 15 }, assessments: { mbti: 'INFP' } } },
  'panel/config': { config: { world: { baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen2.5-7B-Instruct', weatherReal: true }, deform: { enabled: true, sensitivity: 1, grip: 45, loop: 70, shadow: 88 }, life: { enabled: true, morningOn: true, nightOn: true, pokeWindow: ['10:00', '22:00'] }, memory: { extraction: 'cloud', topK: 6, extractEveryN: 2, selfMemory: true }, system: { pythonPath: '', autoStartEngine: true, backupKeepDays: 7 }, channel: { mode: 'clawbot', wxautoEnabled: false, wxautoUrl: 'http://127.0.0.1:43123', wxautoDailyCap: 120, wxautoPeers: [] }, media: { imageEnabled: true, reviewBeforeSend: false }, behavior: { chunkMax: 3, contextRounds: 16, voiceRate: 0 }, params: { temperature: 0.8 }, quietHours: '01:00-07:30', savedAt: now } },
  'panel/today': { today: { date: '2026-09-11', wake: '08:12', sleep: '00:40', mood: 72, battery: 64, chatter: 1.12, focus: '拼图', events: ['今天心情很好'], traitDrift: { warmth: 5, socialBattery: -6 }, worldAuthored: true }, deform: { state: 'normal', stress: 22, integration: 12, thresholds: { grip: 46, loop: 70, shadow: 88 }, lastGripAt: now - 3 * 86400000, lastEvent: 'warm', enabled: true, sensitivity: 1 }, world: { date: '2026-09-10', forDate: '2026-09-11', wake: '08:12', sleep: '00:40', mood: 72, focus: '拼图', weather: '小雨，19~25°C', weatherSource: 'real', weatherReal: true, generatedAt: now - 3600000, diary: '今天接了个新稿子。', thoughts: ['想给他画一张', '周末想去逛旧书店'], secrets: ['悄悄存了他说过的一句话'], npcs: [{ name: '张姐', rel: '同事', note: '爱八卦但心软' }, { name: '小林', rel: '大学同学', note: '在成都开咖啡馆' }], longterm: [{ text: '想把那本画册画完送给他' }], flow: [{ time: '10:00', text: '去楼下咖啡店改稿' }] }, evolution: { warm: 5, rude: 1, chats: 42 } },
  'panel/activity': { inboundCount: 128, lastInboundAt: now - 60000, activity: [{ at: now - 60000, text: '[思考] 想起：主人不爱吃香菜' }] },
  'panel/memory': { engine: 'mem0', entries: [{ id: 'm1', text: '主人不吃香菜', ts: now, who: 'peeraaa', source: 'manual', importance: 4, tags: ['饮食'] }, { id: 'm2', text: '我下周要去趟杭州', ts: now, who: 'self', source: 'self', importance: 2, tags: ['自述'] }], relations: { peeraaa: { affection: 62, mood: 70, chats: 42, lastSeen: now } } },
  'panel/mem-engine': { running: true, info: { ready: true, llm: 'Qwen2.5-7B', embedder: 'bge-m3' } },
  'panel/wxauto/status': { mode: 'clawbot', enabled: false, bridge: { ready: false, listening: [] } },
  'panel/features': { groups: [{ name: '聊天', items: [{ id: 'chat', name: '文字聊天收发', status: 'done', detail: 'iLink 官方通道' }] }] },
  'panel/moments': { drafts: [{ id: 'd1', text: '下雨天和奶茶更配哦', createdAt: now, status: 'draft', images: [] }] },
  'panel/workshop/sessions': { sessions: [{ id: 's1', title: '新造人', updatedAt: now }] },
  'panel/workshop/session': { session: { id: 's1', messages: [], draft: { name: '小暖', assessments: { mbti: 'INFP' } } } },
  'panel/portrait': { portrait: '他最近工作很忙，嘴硬心软' },
  'panel/today': { today: { date: '2026-09-12', wake: '08:12', sleep: '02:00', mood: 55, battery: 62, activeToday: 1, focus: '旅行', events: ['周末'], traitDrift: { socialBattery: 3, warmth: 0 } }, deform: { state: 'normal', stress: 22, integration: 12, thresholds: { grip: 46, loop: 70, shadow: 88 }, lastGripAt: now - 3 * 86400000, lastEvent: 'warm' }, world: { date: '2026-09-11', forDate: '2026-09-12', wake: '08:12', sleep: '02:00', mood: 55, focus: '旅行', weather: '小雨，19~25°C', weatherSource: 'real', generatedAt: now - 3600000, diary: '今天接了个新案子，晚上改到两点。', thoughts: ['想去看海'], secrets: ['悄悄存了他的一句话'], npcs: [{ name: '张姐', rel: '同事', note: '爱八卦但心软' }], longterm: [{ text: '想学做甜点' }], flow: [{ time: '10:00', text: '去律所开会' }], workload: 62, job: { type: 'office', workStart: '09:00', workEnd: '18:00', workDays: '1,2,3,4,5', source: 'world', reason: '律所坐班' }, tone: { intimacy: 12, address: '用名字或哎', style: '客气简短有边界感', forbid: ['撒娇', '叫昵称'], reason: '刚认识', source: 'world' }, disclosed: [{ layer: '表层', topic: '老家在苏州', at: now }], interestLog: [{ at: now, kind: '兴趣', op: 'add', text: '露营', reason: '同事拉我去的' }], tendency: { interest: 0.55, phrase: 0.4, why: '发起力 44／秩序感 73 → 兴趣变化倾向 55%' } }, evolution: { warm: 2, rude: 0, chats: 12, lastEvolvedAt: 0 }, relation: { hasOwner: true, stage: '刚认识', affection: 6, mood: 55, chats: 12, firstSeen: now - 5 * 86400000, callHint: '用名字或哎', next: { label: '熟人', min: 20, need: 14 }, stages: [{ min: 0, label: '刚认识', callHint: '用名字或哎' }] } },
  'panel/avatar': { refs: [{ id: 'r1', file: 'r1.png', angle: '正面', bytes: 204800, addedAt: now, url: 'panel/avatar/file?id=r1' }, { id: 'r2', file: 'r2.png', angle: '45度', bytes: 190000, addedAt: now, url: 'panel/avatar/file?id=r2' }], mainId: 'r1', appearance: { face: '圆脸、单眼皮', hair: '黑色长发齐刘海', style: '黑白极简', body: '160 偏瘦', vibe: '安静' }, albumCount: 3, canGenerate: true, hint: '' },
  'panel/album': { items: [{ id: 'p1', file: 'p1.png', scene: '咖啡店窗边', mode: 'i2i', createdAt: now, bytes: 320000, url: 'panel/album/file?id=p1' }, { id: 'p2', file: 'p2.png', scene: '雨天窝沙发', mode: 't2i', createdAt: now - 3600000, bytes: 280000, url: 'panel/album/file?id=p2' }] },
  'panel/avatar/file': {}, 'panel/album/file': {},
};

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/wechat-companion/, '').replace(/^\//, '');
  if (u === 'console' || u === '') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(root, 'src/console.html')));
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
  await win.loadURL('http://127.0.0.1:' + port + '/console');
  win.webContents.on('console-message', function () {
    var args = Array.prototype.slice.call(arguments);
    var msg = args.map(function (x) { return (x && x.message) ? x.message : String(x); }).join(' ');
    if (/error|Error|not a function|undefined/.test(msg)) console.log('PAGE-ERR: ' + msg.slice(0, 300));
  });
  const metricsSrc = fs.readFileSync(path.join(root, 'test', '_metrics.js'), 'utf8');
  const tabs = tab === 'all' ? ['home', 'persona', 'world', 'relation', 'memory', 'brain', 'nwa', 'ops'] : [tab];
  for (const t of tabs) {
    await win.webContents.executeJavaScript("try{localStorage.setItem('ctab','" + t + "');go('" + t + "');}catch(e){}");
    await new Promise((r) => setTimeout(r, 700));
    if (t === tab && openItems.length) {
      await win.webContents.executeJavaScript("var it=document.querySelectorAll('details.item');[" + openItems.join(',') + "].forEach(function(i){if(it[i])it[i].open=true;});");
      await new Promise((r) => setTimeout(r, 400));
    }
    try {
      const m = await win.webContents.executeJavaScript(metricsSrc);
      console.log('METRICS[' + t + '] ' + JSON.stringify(m));
    } catch (e) {
      console.log('METRICS[' + t + '] FAILED: ' + e.message);
    }
    if (tab === 'all') {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(root, 'test', 'preview-' + t + '.png'), img.toPNG());
    }
  }
  if (tab !== 'all') {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    console.log('screenshot: ' + out);
  } else {
    console.log('screenshots: test/preview-<tab>.png × ' + tabs.length);
  }
  server.close();
  app.quit();
});

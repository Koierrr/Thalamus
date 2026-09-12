// world-engine.js — 世界引擎：她睡觉时，为她的整个世界转起来
// 触发：每晚她进入睡眠窗口后生成一次。产出：
//   日记（她的私人真心话）· 生活流水（明天她经历的事2-4件）· 模糊念头 · 私密秘密事件
//   · 虚构社交圈NPC · 长线剧情推进 · 情绪基线与今日痴迷话题 · 天气 · 画像 · 每周性格结算
// 生活流水与秘密会写入记忆（source: life/self），日记存档可偷看。
// 独立API槽位（cfg.world）：必须单独配置，绝不共用对话接口、绝不回落；未配置=她没有剧本（随机兜底）。

import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from './model-router.js';
import { JOB_TYPE_IDS, guessJobType } from './job.js';
import { applyInterestChanges, changeTendency, INTEREST_MIN, PHRASE_MIN } from './interest.js';
import { derivedTraits } from './soul.js';

function dayKey(now) {
  const y = now.getFullYear(); const m = String(now.getMonth() + 1).padStart(2, '0'); const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/**
 * 把一晚的世界剧本渲染成一份人能读的 Markdown（2026-09-13）。
 * 为什么不是直接 dump JSON：这是给用户翻旧账看的，用记事本就能打开、能看懂才算留档。
 * 内容 = 那一晚的全部产出（日记/流水/念头/秘密/社交圈/长线/明天的分寸/画像），一条都不丢。
 */
function worldMarkdown(o) {
  const L = [];
  const arr = (x) => (Array.isArray(x) ? x : []);
  // 注意：statusLine / insomnia / proactiveAt / rhythm 在世界引擎的产出里是挂在 tone 下面的
  // （曾经在这里按顶层读 → 存档里"她的状态/今晚失眠/作息基准"三块是空的，且不报错）。
  const T = (o && o.tone && typeof o.tone === 'object') ? o.tone : {};
  L.push('# ' + (o.date || '') + ' 她的日记');
  L.push('');
  L.push('> 这是她写给自己看的，不是给你看的。世界引擎每晚替她写下这一天。');
  L.push('');
  L.push('## 📔 她的话（私人日记）');
  L.push('');
  L.push(String(o.diary || '（这一天没有日记）'));
  L.push('');
  L.push('## 🌤️ 那一天的她');
  L.push('');
  L.push('- 天气：' + (o.weather || '—') + (o.weatherSource === 'real' ? '（真实天气）' : o.weatherSource === 'story' ? '（剧本自己编的）' : ''));
  L.push('- 情绪：' + (o.mood == null ? '—' : o.mood + ' / 100'));
  L.push('- 痴迷的事：' + (o.focus || '—'));
  L.push('- 作息：' + (o.wake || '?') + ' 起 · ' + (o.sleep || '?') + ' 睡');
  L.push('- 工作负荷：' + (o.workload == null ? '—' : o.workload + ' / 100'));
  if (o.milestone) L.push('- 🎉 纪念日：' + o.milestone);
  const j = o.job || {};
  if (j.type && j.type !== 'none') L.push('- 她怎么上班：' + j.type + (j.workStart ? '（' + j.workStart + '–' + j.workEnd + '）' : '') + (j.reason ? ' —— ' + j.reason : ''));
  const statusLine = String(T.statusLine || o.statusLine || '');
  if (statusLine) L.push('- 她今天的状态：' + statusLine);
  if (T.insomnia === true || o.insomnia === true) L.push('- 今晚失眠到很晚');
  L.push('');
  if (arr(o.thoughts).length) {
    L.push('## 💭 她的念头');
    L.push('');
    arr(o.thoughts).forEach((x) => L.push('- ' + x));
    L.push('');
  }
  if (arr(o.secrets).length) {
    L.push('## 🤫 她的秘密（还没告诉你的事）');
    L.push('');
    arr(o.secrets).forEach((x) => L.push('- ' + (x && x.text ? x.text : x)));
    L.push('');
  }
  if (arr(o.flow).length) {
    L.push('## 🕐 她的一天（生活流水）');
    L.push('');
    arr(o.flow).forEach((f) => L.push('- **' + (f.time || '') + '** ' + (f.text || '')));
    L.push('');
  }
  if (arr(o.npcs).length) {
    L.push('## 🧑‍🤝‍🧑 她身边的人');
    L.push('');
    arr(o.npcs).forEach((n) => L.push('- ' + (n.name || '') + (n.rel ? '（' + n.rel + '）' : '') + (n.note ? '：' + n.note : '')));
    L.push('');
  }
  if (arr(o.longterm).length) {
    L.push('## 🎯 她的长线小心思');
    L.push('');
    arr(o.longterm).forEach((x) => L.push('- ' + (x && x.text ? x.text : x)));
    L.push('');
  }
  if (arr(o.disclosed).length) {
    L.push('## 🗝️ 她已经告诉过你的过去（分层）');
    L.push('');
    arr(o.disclosed).forEach((d) => L.push('- [' + (d.layer || '') + '] ' + (d.topic || '')));
    L.push('');
  }
  const t = o.tone || null;
  if (t) {
    L.push('## 🎭 第二天她对你的分寸');
    L.push('');
    L.push('- 该表现的熟度：' + (t.intimacy == null ? '—' : t.intimacy + ' / 100'));
    L.push('- 怎么称呼你：' + (t.address || '—'));
    L.push('- 语气：' + (t.style || '—'));
    if (t.proactiveAt) L.push('- 大概什么时候会想找你：' + t.proactiveAt);
    if (t.proactive) L.push('- 主动倾向：早安 ' + (t.proactive.morning ? '会' : '不') + ' · 晚安 ' + (t.proactive.night ? '会' : '不') + (t.proactive.pokes != null ? (' · 最多主动 ' + t.proactive.pokes + ' 次') : '') + (t.proactive.nudges != null ? (' · 催你 ' + t.proactive.nudges + ' 次') : ''));
    if (arr(t.forbid).length) L.push('- 绝对不要做：' + arr(t.forbid).join('、'));
    if (t.reason) L.push('- 为什么是这个分寸：' + t.reason);
    L.push('');
  }
  const rhythm = T.rhythm || o.rhythm || null;
  if (rhythm) {
    L.push('## ⏰ 她的作息基准（世界引擎推的）');
    L.push('');
    L.push('- 平时：' + (rhythm.baseWake || '?') + ' 起 · ' + (rhythm.baseSleep || '?') + ' 睡');
    L.push('- 周末最多推迟 ' + (rhythm.weekendShiftMin == null ? '—' : rhythm.weekendShiftMin + ' 分钟') + ' · 夜猫子概率 ' + (rhythm.nightOwlProb == null ? '—' : Math.round(rhythm.nightOwlProb * 100) + '%') + ' · 通宵概率 ' + (rhythm.allNighterProb == null ? '—' : Math.round(rhythm.allNighterProb * 100) + '%'));
    L.push('');
  }
  if (o.portrait) {
    L.push('## 🪞 她眼中的你（画像）');
    L.push('');
    L.push(String(o.portrait));
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('生成时间：' + (o.generatedAt ? new Date(o.generatedAt).toLocaleString('zh-CN') : '—') + '　·　这份存档由插件自动写入，一天一个文件、永久保存、可直接用记事本打开。');
  L.push('');
  return L.join('\n');
}

const WMO = { 0: '晴', 1: '基本晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹' };

export class WorldEngine {
  constructor(options = {}) {
    this.dir = options.dir || '.';
    this.routerGet = typeof options.router === 'function' ? options.router : () => options.router;
    this.cfgGet = typeof options.config === 'function' ? options.config : () => ({});
    this.soul = options.soul || null;
    this.log = options.logger || (() => {});
    this.chatFn = options.chatFn || null; // 测试注入用；默认走独立HTTP（绝不共用对话接口）
    this._lastFail = 0;
    this._file = path.join(this.dir, 'world-state.json');
  }

  get router() { return this.routerGet(); }

  _read() { try { return JSON.parse(fs.readFileSync(this._file, 'utf8')); } catch { return {}; } }
  _write(s) { fs.mkdirSync(this.dir, { recursive: true }); const t = this._file + '.tmp-' + Date.now(); fs.writeFileSync(t, JSON.stringify(s, null, 2), 'utf8'); fs.renameSync(t, this._file); }
  state() { return this._read(); }

  /* ---------- 世界剧本留档（2026-09-13 加，用户拍板：一天一个 Markdown、永久保存） ----------
     为什么：world-state.json 只有"最近一晚"，她一写新的一晚，昨天的日记/流水/念头/秘密就全没了。
     现在每晚生成完顺手写一份 diary/<日期>.md：记事本能直接打开、一天坏了不影响别的天、备份天然按天分。 */
  _diaryDir() { return path.join(this.dir, 'diary'); }

  /** 把一晚的世界剧本写成可读的 Markdown（用"那一天"的日期，也就是她日记里正在回顾的那天） */
  _archive(out) {
    if (!out || !/^\d{4}-\d{2}-\d{2}$/.test(String(out.date || ''))) return '';
    try {
      fs.mkdirSync(this._diaryDir(), { recursive: true });
      const f = path.join(this._diaryDir(), out.date + '.md');
      fs.writeFileSync(f, worldMarkdown(out), 'utf8');
      return f;
    } catch (e) {
      this.log('[world] 日记留档失败（不影响当晚生成）: ' + (e && e.message));
      return '';
    }
  }

  /** 已留档的日期（新→旧），后台日历用；顺手把"当前 state 还没留档"的情况补上（老数据升级） */
  diaryDays() {
    try {
      const s = this._read();
      if (s && s.date && s.diary && !fs.existsSync(path.join(this._diaryDir(), s.date + '.md'))) this._archive(s);
    } catch { /* 补档失败不影响列表 */ }
    try {
      return fs.readdirSync(this._diaryDir())
        .filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x))
        .map((x) => x.slice(0, 10)).sort().reverse();
    } catch { return []; }
  }

  /** 读某一天的存档原文（Markdown）；没有就返回空字符串 */
  diaryOf(date) {
    const d = String(date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
    try { return fs.readFileSync(path.join(this._diaryDir(), d + '.md'), 'utf8'); } catch { return ''; }
  }

  /** 真实天气（Open-Meteo 免费无key，城市→坐标缓存）。失败返回 null（由剧本编一个）。 */
  async _weather(persona, idx) {
    const city = String(persona.city || '').trim();
    if (!city) { this._lastWeatherError = '她的城市没填（「她→她是谁→城市」）'; return null; }
    this._lastWeatherError = '';
    try {
      const geoFile = path.join(this.dir, 'weather-geo.json');
      let geo = null;
      try { geo = JSON.parse(fs.readFileSync(geoFile, 'utf8')); } catch {}
      if (!geo || geo.city !== city) {
        const gr = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json', { signal: AbortSignal.timeout(10000) });
        const gj = await gr.json();
        const g = gj && Array.isArray(gj.results) && gj.results[0];
        if (!g) { this._lastWeatherError = '没查到城市「' + city + '」的坐标（换个更标准的写法试试）'; return null; }
        geo = { city, lat: g.latitude, lon: g.longitude };
        try { fs.writeFileSync(geoFile, JSON.stringify(geo)); } catch {}
      }
      const wr = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + geo.lat + '&longitude=' + geo.lon + '&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=2', { signal: AbortSignal.timeout(10000) });
      const wj = await wr.json();
      const dl = wj && wj.daily;
      if (!dl || !Array.isArray(dl.weathercode) || dl.weathercode[idx] == null) { this._lastWeatherError = '天气服务返回的数据不完整'; return null; }
      const desc = WMO[dl.weathercode[idx]] || '天气未知';
      const lo = Math.round(dl.temperature_2m_min[idx]); const hi = Math.round(dl.temperature_2m_max[idx]);
      return { text: desc + '，' + lo + '~' + hi + '°C', source: 'real', at: Date.now() };
    } catch (err) {
      this._lastWeatherError = '取实时天气失败：' + ((err && err.message) || String(err)) + '（网络/被墙/服务临时故障）';
      return null;
    }
  }

  /** 她睡了才转（today.sleep 之后，或凌晨4点前补转）；同一天只转一次 */
  /** 世界引擎必须有自己独立的API（BaseURL+模型）；不跟对话接口共用 */
  /** 世界引擎的顺位链（三槽：主力 + 2 回落；仍然只用自己的槽位，绝不共用对话接口） */
  _worldChain() {
    const cfg = this.cfgGet() || {};
    const ch = (cfg.chain || {}).world;
    if (Array.isArray(ch) && ch.length) return ch.filter((c) => c && c.baseURL && c.model);
    const w = cfg.world || {};
    return (w.baseURL && w.model) ? [w] : [];
  }

  _dedicatedReady() {
    return this._worldChain().length > 0;
  }

  /** 她睡了才转（today.sleep 之后，或凌晨4点前补转）；同一天只转一次；失败后30分钟内不重试 */
  shouldGenerate(now, todaySchedule) {
    if (!this._dedicatedReady()) return false;
    if (Date.now() - this._lastFail < 30 * 60 * 1000) return false;
    const s = this._read();
    const key = dayKey(now);
    if (s.date === key) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    const p = String((todaySchedule && todaySchedule.sleep) || '23:30').split(':');
    const sl = Number(p[0]) * 60 + Number(p[1] || 0);
    return cur >= sl || cur <= 240;
  }

  /** 睡眠窗口调用：生成日记/明天作息/流水/念头/秘密/NPC/画像。必须有独立API，绝不共用对话接口。 */
  async generate({ persona, today, memories = [], now = new Date() } = {}) {
    if (!this._dedicatedReady()) throw new Error('世界引擎未配置独立API（在「她」页配置，不跟对话接口共用）');
    const worldChain = this._worldChain();
    const chat = async (msgs, opts) => {
      const fn = this.chatFn || chatCompletion;
      const errs = [];
      for (const c of worldChain) {
        try {
          const r = await fn({ baseURL: c.baseURL, apiKey: c.apiKey || '', model: c.model, messages: msgs, temperature: 0.85, maxTokens: 2600, timeoutMs: 180000 });
          this.lastBackend = c.model;
          return r;
        } catch (err) { errs.push(c.model + ': ' + err.message); }
      }
      throw new Error('世界引擎 ' + worldChain.length + ' 个槽位都失败了 → ' + errs.join(' | '));
    };
    const A = persona.assessments || {};
    const T = persona.traits || {};
    const prof = persona.profile || {};
    const memText = (memories || []).slice(0, 12).map((m2) => '- ' + (m2.text || '')).join('\n');
    // 时间框架：深夜0-4点的生成属于"刚到来的这一天"的剧本；晚间的生成属于明天
    const isSmallHours = now.getHours() < 4;
    const forDateObj = isSmallHours ? now : new Date(now.getTime() + 86400000);
    const forDate = dayKey(forDateObj);
    const wkCN = ['日', '一', '二', '三', '四', '五', '六'];
    const forWeekend = [0, 6].includes(forDateObj.getDay());
    const PB = persona.behavior || {};
    const baseWake = PB.baseWake || '07:30';
    const baseSleep = PB.baseSleep || '23:30';
    const jitterMin = PB.jitterMin == null ? 45 : PB.jitterMin;
    const wkShift = PB.weekendShiftMin == null ? 60 : PB.weekendShiftMin;
    const prev = this._read();
    const prevPortrait = prev.portrait || '';

    // 真实天气（凌晨生成 idx=0=今天；晚间生成 idx=1=明天）。开关关了或拿不到 → 由剧本编一个。
    const weather = (((this.cfgGet() || {}).world || {}).weatherReal !== false) ? await this._weather(persona, isSmallHours ? 0 : 1) : null;

    // 虚拟社交圈：稳定编制（持久保存，按名字去重合并，不凭空换人；兼容旧版字符串格式）
    const normNpc = (x) => {
      if (x && typeof x === 'object') return { name: String(x.name || '').slice(0, 12), rel: String(x.rel || '').slice(0, 10), note: String(x.note || '').slice(0, 40) };
      const s = String(x || '').trim();
      if (!s) return null;
      const m = s.match(/^(.{1,12}?)（(.{1,10}?)）[:：]?(.*)$/);
      return m ? { name: m[1], rel: m[2], note: (m[3] || '').slice(0, 40) } : { name: s.slice(0, 12), rel: '', note: '' };
    };
    const cast = (Array.isArray(prev.npcs) ? prev.npcs : []).map(normNpc).filter((x) => x && x.name).slice(0, 6);
    const castText = cast.length ? cast.map((x) => x.name + (x.rel ? '（' + x.rel + '）' : '') + (x.note ? '：' + x.note : '')).join('；') : '';

    // 每周性格结算：距上次结算满7天才触发；数据来自 evolution.json（被哄/被怼/聊天轮数）
    const evoFile = path.join(this.dir, 'evolution.json');
    let evo = { lastEvolvedAt: 0, warm: 0, rude: 0, chats: 0 };
    try { evo = { ...evo, ...JSON.parse(fs.readFileSync(evoFile, 'utf8')) }; } catch {}
    const evolveDue = Date.now() - (evo.lastEvolvedAt || 0) >= 7 * 86400000;
    const prevLong = (Array.isArray(prev.longterm) && prev.longterm.length) ? prev.longterm[prev.longterm.length - 1].text : '';

    /* 职业：场景生成器（作息形状由 daily 负责，这里负责"明天她具体在忙什么"） */
    const jobCfg = ((this.cfgGet() || {}).job) || {};
    const jobOn = jobCfg.enabled !== false;
    const jType = jobCfg.type || persona.jobType || 'none';
    const JOB_LABEL = { office: '上班族（朝九晚六）', shift: '排班制（护士/服务/工厂，班次不固定）', freelance: '自由职业（在家接活）', night: '夜班（昼夜颠倒）', student: '学生', none: '无固定工作' };
    const jIntensity = typeof jobCfg.intensity === 'number' ? jobCfg.intensity : 1;
    const jWorkday = !!(today && today.job && today.job.workday);
    const npcWant = jobOn && jobCfg.toNpc !== false && jType !== 'none' ? Math.max(1, Math.round((jobCfg.npcCount == null ? 2 : jobCfg.npcCount))) : 0;
    const tend = changeTendency(T, 0);
    // 关系现状（亲密度/已聊/认识天数）——你（用户）拍板：分寸由世界引擎综合判断，不写死表
    // 她的过去（分层）+ 已经告诉过他的（编剧每晚维护，避免重复讲/前后矛盾）
    let pastLine = '';
    try {
      const P = persona.profile || {};
      const past = P.past || {};
      const dis = Array.isArray(prev.disclosed) ? prev.disclosed.slice(-12) : [];
      const disTxt = dis.length ? dis.map((x) => (x.layer || '') + '：' + (x.topic || '')).join('；') : '（还没说什么）';
      const L = ['【她的过去·分层（她对外一层层透露，绝不一次说完）】'];
      if (past.surface || persona.personaText) L.push('表层（随时可聊）：' + String(past.surface || persona.personaText || '').slice(0, 200));
      if (past.middle) L.push('中层（熟人~朋友、且被问到才零星说）：' + String(past.middle).slice(0, 200));
      if (past.deep) L.push('深层（亲近以上+气氛对了才说）：' + String(past.deep).slice(0, 200));
      L.push('【已经告诉过他的】' + disTxt);
      L.push('你今晚要做的：看她的日记/流水里有没有"今天对他透露了一点过去"，把**这次新透露的**写进 disclosedAdd（只写主题，不要抄内容；没透露就给空数组）。');
      pastLine = L.join(String.fromCharCode(10));
    } catch { pastLine = ''; }
    let relLine = '';
    try {
      const rels = (this.soul && this.soul.getRelations) ? this.soul.getRelations() : {};
      const ownerRaw = String(((this.cfgGet() || {}).ownerPeerId) || '').trim();
      let r0 = null;
      for (const k of Object.keys(rels || {})) {
        if (!ownerRaw || k === ownerRaw || k.endsWith(':' + ownerRaw)) { r0 = rels[k]; break; }
      }
      if (!r0 && Object.keys(rels || {}).length) r0 = rels[Object.keys(rels)[0]];
      if (r0) {
        const days = r0.firstSeen ? Math.max(0, Math.round((Date.now() - r0.firstSeen) / 86400000)) : 0;
        relLine = '【你们的关系现状】亲密度 ' + Math.round(r0.affection || 0) + '/100；认识 ' + days + ' 天；聊过 ' + (r0.chats || 0) + ' 次；他最近的情绪 ' + Math.round(r0.mood || 0) + '/100。';
      } else {
        relLine = '【你们的关系现状】还没有正式的关系记录（等价于刚认识，亲密度 0）：她不该热络。';
      }
    } catch { relLine = ''; }
    const jobLines = (jobOn && persona.job && jType !== 'none')
      ? [
        '【她的职业】' + persona.job + '（' + (JOB_LABEL[jType] || jType) + '）' + (jobCfg.workStart && jobCfg.workEnd ? '，作息大致 ' + jobCfg.workStart + '-' + jobCfg.workEnd : '') + '；工作影响强度约 ' + Math.round(jIntensity * 100) + '%。',
        '【明天是不是工作日】' + (jWorkday ? '是' : '不是') + '。' + (jWorkday ? '流水里必须有一件与工作有关的具体事（赶稿/开会/客户改需求/同事八卦/通宵加班…），并且这次要给出 workload（0-100 的工作负荷）。' : '不要编工作场景，让她过自己的日子。'),
        npcWant ? '【社交圈里的工作关系】她的社交圈里至少要有 ' + npcWant + ' 位工作关系的人（同事/客户/领导/同学），这些人真实存在于她的生活里。' : '',
      ].filter(Boolean).join('\n')
      : '';
    const sys = [
      '你是一个世界的"命运编剧"。有一位女生正在真实地生活着，你负责在她每晚睡着后，为她写出这一天的心声，并把她的明天安排好。',
      '【她是谁】名字：' + String(((persona.relationship || {}).ownerCallsMe) || persona.name || '') + (String(((persona.relationship || {}).ownerCallsMe) || '') && String(((persona.relationship || {}).ownerCallsMe) || '') !== String(persona.name || '') ? '（本名' + (persona.name || '') + '，她希望大家这么叫她）' : '') + '；' + (persona.job ? '职业：' + persona.job + '；' : '') + (persona.city ? '城市：' + persona.city + '；' : '') + 'MBTI：' + ((A.mbti || '') || '未知') + '。',
      '【性格六维】社交电量' + (T.socialBattery == null ? 50 : T.socialBattery) + '/情感温度' + (T.warmth == null ? 50 : T.warmth) + '/依恋强度' + (T.attachment == null ? 50 : T.attachment) + '/批判锐度' + (T.sharpness == null ? 50 : T.sharpness) + '/发起力' + (T.initiative == null ? 50 : T.initiative) + '/秩序感' + (T.orderliness == null ? 50 : T.orderliness) + '（0-100）。',
      (persona.personaText ? '【背景】' + String(persona.personaText).slice(0, 300) : ''),
      (persona.interests && persona.interests.length ? '【兴趣】' + persona.interests.join('、') : ''),
      '【时间】现在是深夜，她刚过完' + dayKey(now) + '（周' + wkCN[now.getDay()] + '）这一天，马上要睡了；她醒来就是' + forDate + '（周' + wkCN[forDateObj.getDay()] + '）' + (forWeekend ? '——明天是周末' : '') + '。',
      '【她的作息基准】起床 ' + baseWake + ' / 睡觉 ' + baseSleep + '，日常浮动±' + jitterMin + '分钟' + (forWeekend ? '，周末可以明显赖床（最多比基准晚' + wkShift + '分钟）' : '') + '。',
      relLine,
      pastLine,
      jobLines,
      '【今天她的状态】睡觉时间：' + ((today && today.sleep) || '23:30') + '；' + ((today && today.events) || []).join('；'),
      (weather ? '【明天天气（真实，务必与流水/心情自洽）】' + weather.text + '（下雨→窝家/带伞，降温→可以提醒主人添衣）' : ''),
      (memText ? '【她最近记住的事】\n' + memText : ''),
      (castText ? '【她的社交圈（稳定编制，这些人真实存在于她的生活里，不要凭空换人或消失；只有剧情需要新面孔时才新增）】' + castText : ''),
      (prevPortrait ? '【她目前对主人的印象（在此基础上更新）】' + prevPortrait : ''),
      (prevLong ? '【她的长线小心思（已有，慢慢推进或自然收尾）】' + prevLong : ''),
      '输出要求（只输出一个JSON对象，不要解释）：',
      '{"diary":"她今晚的私人日记，第一人称，150-250字，真心话，口语化，可以有今天的情绪和小心思"' +
      (weather ? '' : ',"weather":"她醒来那天的天气，一句话（与她的城市和当季自洽，如：小雨，12~19°C）"') +
      ',"wake":"她明天(醒来那天)的起床时间HH:MM","sleep":"她明天晚上的睡觉时间HH:MM","mood":明天情绪基线0-100,"focus":"明天可能痴迷的话题","flow":[{"time":"HH:MM","text":"她明天会经历的事，第三人称一句话"}]共3-4件,"thoughts":["她明天可能冒出的念头"]共2-3条,"secrets":[{"text":"她还没告诉主人的私人事件"}]0-2条（没有就不给）,"npc":[{"name":"名字","rel":"关系（同事/闺蜜/室友…）","note":"一句话人设"}]0-3条（社交圈里已有的人除非剧情需要不要重复输出；没有新面孔就不给）,"portrait":"她眼中主人的近期印象，60字内，写她的真实感受（想念/别扭/信任…），别像档案","longline":"她的长线小心思推进一句话（想学的技能/想去的地方/想为主人做的事；第一次没有就为她起一条）"' +
      (evolveDue ? ',"evolve":{"warmth":1,"attachment":1,"reason":"第一人称一句话说明为什么变（六维键：socialBattery/warmth/attachment/sharpness/initiative/orderliness，值-2~+2，可以只给部分键）"' : '') +
      (evolveDue ? ',"interestsAdd":"","interestDrop":"","phraseAdd":"","phraseDrop":"","interestsReason":""' : '') +
      ',"disclosedAdd":[{"layer":"表层|中层|深层","topic":"今晚她新告诉他的一个过去细节（如：老家在苏州）"}]0-2条，没有就空数组' +
      ',"tone":{"intimacy":今天她该表现的熟度0-100,"address":"明天她该怎么称呼他（例如：用名字/叫哎/叫XX）","style":"明天的语气要点，一句话","proactive":{"morning":明天要不要主动说早安true/false,"night":要不要说晚安true/false,"pokes":明天最多主动几次0-5,"nudges":催他几次0-5},"chunks":明天她一条回复最多几条消息1-4（话少的人给1）,"maxChars":每条最多几个字8-80（话少的人给15左右）,"forbid":["明天绝对不要做的事，2-4条"],"reason":"一句理由（为什么是这个分寸）"}' +
      ',"statusLine":"她今天状态的一句话（第一人称、口语，例如：今天案子卡住了，有点闷）"' +
      ',"insomnia":今晚她是不是失眠到很晚true/false' +
      ',"proactiveAt":"明天她大概什么时候会想找他（例如 16:00 前后 / 通勤路上 / 睡前；不想找就给空字符串）"' +
      ',"rhythm":{"baseWake":"她平时的起床HH:MM","baseSleep":"她平时的睡觉HH:MM","weekendShiftMin":周末推迟分钟0-180,"nightOwlProb":夜猫子概率0-1,"allNighterProb":通宵概率0-1}' +
      ',"workload":今天的工作负荷0-100（不是工作日填0）' +
      (jobOn && persona.job ? ',"job":{"type":"office|shift|freelance|night|student|none","workStart":"HH:MM","workEnd":"HH:MM","workDays":"1,2,3,4,5","reason":"你判断她明天怎么上班的一句理由"}' : '') +
      '}',
      '规则：**话量必须跟她的性格一致**（性格六维里温度/发起力低的人惜字如金：chunks=1、maxChars≈15，别让她变成话痨）；**分寸必须与【你们的关系现状】严格匹配**——亲密度低（比如 0~20）时她就该客气、有边界感，不能撒娇、不能叫昵称、不能要求对方为她做事、不能深夜发消息；亲密度越高才可以越随意越亲昵。宁可冷淡也别越界。；一切与她的性格/职业/兴趣/城市自洽；wake/sleep 必须在【作息基准】允许的范围内，且要和流水剧情对得上（如果今晚日记里是熬夜赶稿，明天就明显晚起）；流水要像真实生活（有琐碎有起伏）' + (weather ? '，且与真实天气自洽' : '') + '；秘密是她的私人边界，只在合适时机被提起；绝不提AI/模型/生成。',
    ];
    if (evolveDue) {
      sys.push('【性格周结算（满7天一次，这次要做）】她和你生活的这一周：被哄了' + (evo.warm || 0) + '次、被怼了' + (evo.rude || 0) + '次、聊了' + (evo.chats || 0) + '轮。请给六维微调：每个键 -2~+2（可以不变），全维度变动合计绝对值≤5，方向要与这些互动的因果相符（常被哄→温度/依恋缓涨；常被冷落怼→锐度涨依恋跌；总她在主动→发起力涨）。铁律：只能微调"表达层"，绝不能违背她的MBTI认知类型（如 Fi 主导的人再暖也是安静深沉的暖，不会变成 Fe 式外放热情）；拿不准就少动或不动。');
      sys.push('【兴趣与口头禅（跟性格结算同一轮，一周最多动一次）】她现在的兴趣：' + (persona.interests || []).join('、')
        + '；她现在的口头禅：' + (((persona.quirks || {}).catchphrases) || []).join('、') + '。'
        + '如果这一周她确实接触了新的东西、或养成了新的说法（结合她的职业与生活流水，别凭空编），就给出来；没有就全部留空字符串。'
        + '规则：各最多新增 1 个、淡出 1 个；兴趣至少保留 ' + INTEREST_MIN + ' 个、口头禅至少保留 ' + PHRASE_MIN + ' 个；'
        + '新增的兴趣 2~6 个字（像"拼图""咖啡""老电影"这种），口头禅 1~6 个字（像"好呀""嘿嘿""绝了"）；'
        + '她的性格倾向是：' + tend.why + '——倾向低就别硬加，她不是每周都变。');
    }
    let r;
    try {
      r = await chat([{ role: 'system', content: sys.filter(Boolean).join('\n') }, { role: 'user', content: '（现在是她睡着的时间，开始为她的世界转起来。）' }], { temperature: 0.85, maxTokens: 2600 });
      const m = String(r.content || '').match(/\{[\s\S]*\}/);
      if (!m) throw new Error('世界引擎输出不是JSON');
      try { r = { parsed: JSON.parse(m[0]) }; } catch (err) { throw new Error('世界引擎JSON解析失败: ' + err.message); }
    } catch (err) {
      this._lastFail = Date.now(); // 30分钟内不重试，避免刷日志/刷token
      throw err;
    }
    const d = r.parsed;
    const hm = (s) => (/^\d{1,2}:\d{2}$/.test(String(s || '')) ? String(s).padStart(5, '0') : null);
    const state = this._read();

    // 长线小心思：推进就追加（最多留5条），没给就沿用
    let longterm = Array.isArray(state.longterm) ? state.longterm.slice(-4) : [];
    const longline = String(d.longline || '').trim().slice(0, 80);
    if (longline && longline !== (longterm.length ? longterm[longterm.length - 1].text : '')) {
      longterm.push({ text: longline, ts: Date.now() });
    }

    // 社交圈合并：新面孔追加，同名刷新人设；总编制上限6人（稳定持久）
    const incoming = (Array.isArray(d.npc) ? d.npc : []).map(normNpc).filter((x) => x && x.name);
    for (const np of incoming) {
      const i = cast.findIndex((x) => x.name === np.name);
      if (i >= 0) cast[i] = np; else cast.push(np);
    }

    // 兴趣/口头禅变化历史（先声明，out 里要用）
    let interestLog = Array.isArray(state.interestLog) ? state.interestLog.slice(-40) : [];
    const out = {
      date: dayKey(now),
      forDate,
      diary: String(d.diary || '').slice(0, 800),
      wake: hm(d.wake) || '',
      sleep: hm(d.sleep) || '',
      weather: (weather && weather.text) || String(d.weather || '').slice(0, 60),
      weatherSource: weather ? 'real' : (d.weather ? 'story' : ''),
      weatherError: weather ? '' : (this._lastWeatherError || ''),
      flow: Array.isArray(d.flow) ? d.flow.slice(0, 4).map((f) => ({ time: String(f.time || '').slice(0, 5), text: String(f.text || '').slice(0, 120) })) : [],
      thoughts: Array.isArray(d.thoughts) ? d.thoughts.slice(0, 3).map((x) => String(x).slice(0, 80)) : [],
      secrets: Array.isArray(d.secrets) ? d.secrets.slice(0, 2).map((x) => String(x.text || x || '').slice(0, 120)) : [],
      npcs: cast.slice(0, 6),
      mood: typeof d.mood === 'number' ? Math.round(d.mood) : null,
      workload: (() => { const v = Number(d.workload); return isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0; })(),
      job: (() => {
        const J = d.job;
        if (!J || typeof J !== 'object') return state.job || null;
        const g = guessJobType(persona.job);
        const type = JOB_TYPE_IDS.includes(J.type) ? J.type : g.type;
        return {
          type,
          workStart: /^\d{1,2}:\d{2}$/.test(String(J.workStart || '')) ? String(J.workStart).padStart(5, '0') : '',
          workEnd: /^\d{1,2}:\d{2}$/.test(String(J.workEnd || '')) ? String(J.workEnd).padStart(5, '0') : '',
          workDays: String(J.workDays || '1,2,3,4,5').replace(/[^0-6,]/g, '').slice(0, 20),
          reason: String(J.reason || '').slice(0, 80),
          source: 'world',
        };
      })(),
      focus: String(d.focus || '').slice(0, 40),
      portrait: String(d.portrait || '').slice(0, 160) || (state.portrait || ''),
      longterm,
      tone: (() => {
        const t = d.tone;
        if (!t || typeof t !== 'object') return state.tone || null;
        const clamp = (v, lo, hi, dv) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dv);
        return {
          intimacy: clamp(t.intimacy, 0, 100, 10),
          address: String(t.address || '').slice(0, 30),
          style: String(t.style || '').slice(0, 120),
          chunks: (typeof t.chunks === 'number' && isFinite(t.chunks)) ? Math.max(1, Math.min(4, Math.round(t.chunks))) : undefined,
          proactive: (t.proactive && typeof t.proactive === 'object') ? {
            morning: t.proactive.morning !== false,
            night: t.proactive.night !== false,
            pokes: Number.isFinite(Number(t.proactive.pokes)) ? Math.max(0, Math.min(5, Math.round(Number(t.proactive.pokes)))) : undefined,
            nudges: Number.isFinite(Number(t.proactive.nudges)) ? Math.max(0, Math.min(5, Math.round(Number(t.proactive.nudges)))) : undefined,
          } : undefined,
          statusLine: String(d.statusLine || '').slice(0, 80),
          insomnia: d.insomnia === true,
          proactiveAt: String(d.proactiveAt || '').slice(0, 30),
          rhythm: (d.rhythm && typeof d.rhythm === 'object') ? {
            baseWake: /^\d{1,2}:\d{2}$/.test(String(d.rhythm.baseWake || '')) ? String(d.rhythm.baseWake) : undefined,
            baseSleep: /^\d{1,2}:\d{2}$/.test(String(d.rhythm.baseSleep || '')) ? String(d.rhythm.baseSleep) : undefined,
            weekendShiftMin: (() => { const v = Number(d.rhythm.weekendShiftMin); return isFinite(v) ? Math.max(0, Math.min(180, Math.round(v))) : 60; })(),
            nightOwlProb: (() => { const v = Number(d.rhythm.nightOwlProb); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.15; })(),
            allNighterProb: (() => { const v = Number(d.rhythm.allNighterProb); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.03; })(),
          } : undefined,
          maxChars: (typeof t.maxChars === 'number' && isFinite(t.maxChars)) ? Math.max(8, Math.min(80, Math.round(t.maxChars))) : undefined,
          forbid: Array.isArray(t.forbid) ? t.forbid.map((x) => String(x).slice(0, 20)).filter(Boolean).slice(0, 5) : [],
          reason: String(t.reason || '').slice(0, 80),
          source: 'world',
        };
      })(),
      disclosed: (() => {
        const base = Array.isArray(state.disclosed) ? state.disclosed.slice(-60) : [];
        const add = Array.isArray(d.disclosedAdd) ? d.disclosedAdd.slice(0, 2) : [];
        for (const x of add) {
          const topic = String((x && x.topic) || '').slice(0, 60);
          if (!topic) continue;
          if (base.some((y) => y.topic === topic)) continue;
          base.push({ layer: String((x && x.layer) || '表层').slice(0, 4), topic, at: Date.now() });
        }
        return base.slice(-60);
      })(),
      interestLog,
      tendency: tend,
      generatedAt: Date.now(),
    };

    // 每周性格结算落地：先按MBTI八维推导基准做钳制（类型永不变，只许微调表达层）
    if (evolveDue && d.evolve && typeof d.evolve === 'object') {
      const base = persona.traits || {};
      const derived = derivedTraits(persona.assessments && persona.assessments.mbti) || {};
      const next = { ...base };
      let total = 0; let applied = 0;
      for (const k of ['socialBattery', 'warmth', 'attachment', 'sharpness', 'initiative', 'orderliness']) {
        let dv = Number(d.evolve[k]);
        if (!isFinite(dv) || dv === 0) continue;
        dv = Math.max(-2, Math.min(2, Math.round(dv)));
        total += Math.abs(dv);
        if (total > 6) break;
        let v = (base[k] == null ? 50 : base[k]) + dv;
        if (typeof derived[k] === 'number') v = Math.max(derived[k] - 25, Math.min(derived[k] + 25, v)); // 不越过认知类型允许的范围
        next[k] = Math.max(5, Math.min(95, Math.round(v)));
        applied++;
      }
      if (applied && this.soul && typeof this.soul.savePersona === 'function') {
        this.soul.savePersona({ traits: next });
        const reason = String(d.evolve.reason || '').slice(0, 100);
        if (reason && this.soul.addMemory) {
          try { await this.soul.addMemory({ who: 'self', text: '（成长）' + reason, importance: 3, tags: ['成长'], source: 'life' }); } catch {}
        }
        this.log('[world] 性格周结算完成：' + applied + ' 维微调' + (reason ? '（' + reason + '）' : ''));
      }
    }
    // 兴趣/口头禅演化（她自己换的留历史；用户手改的不留）
    try {
      if (evolveDue && this.soul && typeof this.soul.savePersona === 'function') {
        const p0 = this.soul.getPersona();
        const res = applyInterestChanges({
          persona: p0,
          traits: T,
          suggestion: {
            interestsAdd: d.interestsAdd, interestDrop: d.interestDrop,
            phraseAdd: d.phraseAdd, phraseDrop: d.phraseDrop,
            interestsReason: d.interestsReason, phraseReason: d.interestsReason,
          },
        });
        if (res.changed) {
          this.soul.savePersona({ interests: res.interests, quirks: { ...(p0.quirks || {}), catchphrases: res.phrases } });
          interestLog = interestLog.concat(res.log).slice(-40);
          this.log('[world] 兴趣/口头禅变化：' + res.notes.join('；') + '｜' + res.tendency.why);
        } else if (res.notes.length) {
          this.log('[world] 兴趣/口头禅这周没变：' + res.notes.join('；'));
        }
      }
    } catch (err) { this.log('[world] 兴趣演化失败（不影响其它产出）: ' + (err && err.message)); }

    // 结算后清零计数器（无论这次是否真的变了）
    if (evolveDue) {
      try { fs.writeFileSync(path.join(this.dir, 'evolution.json'), JSON.stringify({ lastEvolvedAt: Date.now(), warm: 0, rude: 0, chats: 0 })); } catch {}
    }

    // 纪念日：认识满100天/整年，标记成今天的日子
    const ann = this.anniversary();
    if (ann) out.milestone = ann.label;

    this._write(out);
    this._archive(out); // 一天一份 Markdown 留档（翻旧账用；失败不影响当晚生成）
    // 生活流水入她的记忆（source: life），供日后自然聊起
    if (this.soul) {
      for (const f of out.flow) {
        try { await this.soul.addMemory({ who: 'self', text: '（生活）' + f.text, importance: 2, tags: ['生活'], source: 'life' }); } catch {}
      }
    }
    this.log('[world] 世界已生成：日记+明天作息 ' + (out.wake || '?') + '-' + (out.sleep || '?') + ' +流水' + out.flow.length + '件+秘密' + out.secrets.length + '条+画像' + (out.portrait ? '✓' : '✗'));
    return out;
  }

  /** 纪念日引擎：自动发现里程碑（认识N天/满百日/满一年） */
  anniversary() {
    const rel = this.soul ? this.soul.getRelations() : {};
    let first = null;
    for (const k of Object.keys(rel)) { if (!first || rel[k].firstSeen < first) first = rel[k].firstSeen; }
    if (!first) return null;
    const days = Math.floor((Date.now() - first) / 86400000);
    if (days > 0 && (days === 100 || days % 365 === 0)) return { days, label: '认识 ' + days + ' 天' };
    return null;
  }
}

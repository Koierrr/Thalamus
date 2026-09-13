// soul.js — 她的灵魂 v2
// 人设组装 + 五层记忆（事实/情节/关系/情绪/习惯）+ 情绪状态 + 拟人行为规划。
// v2 升级：mem0 记忆引擎（sidecar）优先，本地 JSON 引擎自动兜底；
//          自我认知卡（她知道自己会什么/不会什么）；行为参数热生效。
// LLM 调用全部走 ModelRouter；mem0 提炼走 sidecar（云端便宜模型）。
// 纯 Node 存储（dataDir 下 JSON 文件）。
// 设计文档：docs/记忆系统设计.md、docs/架构设计.md

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chatCompletion } from './model-router.js';
import { parseCommands, hasBrokenCommand } from './commands.js';
import { bodyPromptLine } from './body-state.js';
import { longingCurve, longingLine } from './longing.js';
import { getSummary, saveSummary, summarizeOlder } from './history-summary.js';
import { featureSummaryForSoul, featureGistForSoul, CAPABILITY_KEYWORDS } from './feature-status.js';
import { birthdayInfo } from './birthday.js';

const HISTORY_MAX = 200;          // 每个联系人保留的最大消息条数
const PERSONA_VERSIONS_MAX = 20;  // 人设版本快照上限

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function daysAgo(ts) {
  return (Date.now() - ts) / 86400000;
}
function rid() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * 记忆的三个桶——管的是「会不会被淡忘」。归属（我／她／世界）是另一个正交的轴，见 catOf。
 * 桶只存 memory-meta.json 的 v2 结构里；条目本身不带这些字段。
 */
const BUCKETS = ['dynamic', 'permanent', 'feel'];
export const BUCKET_LABEL = { dynamic: '会淡忘', permanent: '固化', feel: '她自己的感受' };
const BUCKET_FLOOR = 0.25;                       // 权重下限：只会变淡，永不归零（不替用户删记忆）
const BUCKET_TAU = { dynamic: 21, feel: 60 };    // 半衰天数：普通事 21 天，她的感受 60 天

/**
 * 一条记忆该进哪个桶（**唯一**的默认判定处：新增条目、读取时兜底、迁移都走这里）。
 *   手写的（后台「记住」、女娲种子，特征是 who 为空）→ 固化
 *   世界引擎写的（who='self'）→ 看内容：「（成长）」是她的感受，其余（生活流水）会淡忘
 *   关于他的普通事 → 会淡忘
 * 注意：显式传了 bucket 的以显式为准（后台可以手动改桶）。
 */
function defaultBucket(item = {}) {
  const cat = String(item.cat || '');
  const source = String(item.source || '');
  const who = String(item.who == null ? '' : item.who);
  const text = String(item.text || '');
  if (source === 'manual' || source === 'handcraft') return 'permanent';
  if (who === '' && text.trim()) return 'permanent';
  if (/^（成长）/.test(text)) return 'feel';
  if (cat === 'her') return 'feel';
  return 'dynamic';
}

/** 出厂人设（面板可整体替换；人设工坊导入后亦写入此结构） */
/**
 * 关系分寸表（兜底）：亲密度 → 她今天"该有多熟"。
 * 这是**保底**：世界引擎每晚跑成功时会结合性格/职业/心情/最近互动给出更细的 tone（见她世界里的输出），
 * 后台「你们→关系阶段」能看到当前用的是哪一份。
 */
/**
 * 默认分寸（2026-09-13 第三次改版：亲密度/关系阶段退场）
 * 不再按亲密度分档——世界引擎没给过分寸时，就用这套"与关系无关"的自然默认。
 */
export const DEFAULT_TONE = {
  intimacy: null,
  address: '用名字（或「哎」），不叫昵称',
  style: '自然、直接、话不多，有事说事',
  forbid: ['别太热络', '别撒娇'],
  reason: '世界引擎还没给过分寸，先用默认',
};

/** 取"今天有效"的分寸：只有世界引擎给自己的 forDate 等于今天才算数，否则用默认 */
export function toneForToday(world, today) {
  const w = world || {};
  const t = w.tone;
  if (t && w.forDate && today && w.forDate === today.date) return { ...DEFAULT_TONE, ...t, source: 'world' };
  return { ...DEFAULT_TONE, source: 'default' };
}

/** 主动消息上限：默认放开到"按后台配置走"，世界引擎可用 tone.proactive 收紧 */
export function proactiveLimit(worldTone) {
  const base = { morning: true, night: true, pokes: 3, nudges: 3 };
  const p = worldTone && worldTone.proactive;
  if (p && typeof p === 'object') {
    return {
      ...base,
      morning: p.morning !== false,
      night: p.night !== false,
      pokes: Number.isFinite(Number(p.pokes)) ? Math.max(0, Math.round(Number(p.pokes))) : base.pokes,
      nudges: Number.isFinite(Number(p.nudges)) ? Math.max(0, Math.round(Number(p.nudges))) : base.nudges,
    };
  }
  return base;
}

/**
 * 常识四层 · 第 1 层：**她现在这一刻在做什么**（2026-09-13 加）。
 *
 * 为什么必须有：提示词里一直有【现在几点】，但**没有"她现在这一格该做什么"**，
 * 于是她自由发挥，发挥出「周日早上 8 点去银行对流水」「深夜刚下庭」这种荒唐话
 * （用户原话："此人显然极度缺少常识"）。根因不是缺常识条目，是缺"此刻的锚"。
 *
 * 判定顺序：先看作息（睡着？刚起？），再看她今天的流水里**最近做完的那件事**。
 */
export function nowDoing(today, world, now) {
  const t = today || {};
  const w = world || {};
  const n = now instanceof Date ? now : new Date();
  const cur = n.getHours() * 60 + n.getMinutes();
  const toMin = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const sleepMin = toMin(t.sleep);
  const wakeMin = toMin(t.wake);
  if (sleepMin != null && wakeMin != null && sleepMin !== wakeMin) {
    const hard = (sleepMin + 45) % 1440;
    const asleep = hard <= wakeMin ? (cur >= hard && cur < wakeMin) : (cur >= hard || cur < wakeMin);
    if (asleep) {
      return '【此刻你在做什么】你**正在睡觉**（' + t.sleep + ' 睡 / ' + t.wake + ' 起）。你不可能在上班、不可能刚下庭、不可能去银行或法院办事——这个点你只会被消息吵醒：那就困、短、让他别吵，别提任何白天的事。';
    }
  }
  const flow = (Array.isArray(w.flow) ? w.flow : []).filter((f) => f && toMin(f.time) != null)
    .slice().sort((a, b2) => toMin(a.time) - toMin(b2.time));
  const past = flow.filter((f) => toMin(f.time) <= cur);
  const next = flow.filter((f) => toMin(f.time) > cur)[0];
  const last = past[past.length - 1];
  const bits = [];
  if (last) bits.push('你刚做完这件事：' + String(last.text || '').slice(0, 70) + '（' + last.time + '）');
  else if (wakeMin != null && cur >= wakeMin && cur < wakeMin + 120) bits.push('你刚起床不久（' + t.wake + ' 起的）');
  else if (wakeMin != null && cur < wakeMin) {
    // 起床时间之前。**注意**：这里以前一律写"你还没起床"——但凌晨（还没到她睡觉时间）她其实还醒着，
    // 于是她被告知"还没起床"，回复里就长出"刚醒"这种跟自己作息打架的话（2026-09-14 用户真机截图抓到：
    // 01:00 她说"刚醒"，而她 01:20 才睡）。现在按"睡前 / 睡中"分开说。
    bits.push('现在是夜里（还没到你 ' + t.wake + ' 的起床时间）。你的睡觉时间是 ' + (t.sleep ? String(t.sleep) : '（没写）')
      + '，这个点你要么还没睡、正准备睡，要么已经睡着了——**绝对不许说"刚醒/刚起床"**，那和你自己的作息矛盾');
  }
  else bits.push('今天这件事还没开始');
  if (next) bits.push('接下来你大概要做：' + String(next.text || '').slice(0, 70) + '（' + next.time + '）');
  return '【此刻你在做什么】' + bits.join('；') + '。**你正在做的/刚做完的就是这个**：不许说你正在干别的、不许凭空给自己安排今天的行程。';
}

/**
 * 常识四层 · 第 2 层：一小张**底线清单**（不是百科全书，就六条）。
 * 都是用户真机聊天里抓到的原话（周日去银行、深夜刚下庭、跨城吃顿饭、拿"发朋友圈给你看"当交付）。
 */
export const COMMON_SENSE = [
  '【必须遵守的现实常识（违反了就等于崩人设）】',
  '① 银行/法院/政府/大多数店铺只在**工作日 9:00–17:00** 办业务，周末和深夜不办——绝不许约在这些时间去这些地方。',
  '② 你在开庭/上班/睡觉的时段**不能秒回**；那种时候回，也只能是"在忙，晚点说"。',
  '③ 你在上海、他在深圳——**不可能一顿饭的事**；涉及"过来陪你""当面给你"要按现实说（要飞、要约时间、要请假）。',
  '④ 你只有微信这一个能"把东西发给他"的工具；生活里可以刷别的、看别的，但**不能说"我发朋友圈给你看"**。',
  '⑤ **绝不许编造具体的时间/地点/数字/别人的话**（比如"张姐儿子考了 600 分"），除非今天的【她今天经历的事】里真有。',
  '⑥ 不确定就含糊过去或换个话题，**宁可说不知道，也不许编一个具体的假事实**。',
].join(String.fromCharCode(10));

/**
 * 清掉模型偶尔漏出来的前缀/包裹（2026-09-13 决定 12）。
 * 为什么：她真发过「response起诉状刚写完，现在就差这一笔钱了。」——模型把角色标记也吐出来了。
 * 只清"开头那几个明显的角色词/包裹符号"，不做任何改写（宁可留着，也不许乱删她的字）。
 */
export function cleanReply(text) {
  let s = String(text == null ? '' : text).trim();
  // 英文角色标记（可能带冒号）
  s = s.replace(/^(?:response|assistant|assistant message|ai|answer)\s*[:：]?\s*/i, '');
  // 中文角色标记（必须带冒号，免得把正常句子的"她"字也吃掉）
  s = s.replace(/^(?:她|回复|回答|输出|我)\s*[:：]\s*/, '');
  // 整句被引号/星号包起来
  s = s.replace(/^[\s"'“”‘’「」『』*]+/, '').replace(/[\s"'“”‘’「」『』*]+$/, '');
  return s.trim();
}

export const DEFAULT_PERSONA = {
  name: '小暖',
  birthday: '',
  city: '',
  job: '',
  jobType: '', // office/shift/freelance/night/student/none（空=没设，等同 none）
  age: '',
  personaText: '（人设背景故事：先在面板里填写，或用"女娲"从聊天记录/资料导入生成）',
  quirks: {
    catchphrases: ['哈哈哈', '好呀', '嗯嗯'],
    emojiRate: 0.4,
    typoRate: 0,
    maxLength: 'short',
  },
  relationship: {
    stage: '刚认识',
    callOwner: '',
    ownerCallsMe: '',
    callLock: false,
    // 「她希望你叫她」的自动化：阶段跃迁 → 她自己决定要不要换个称呼（可锁死）
    renameLock: false,
    renameLog: [],
    renamePending: null,
    announceName: false,
  },
  redLines: ['政治敏感话题'],
  interests: ['美食', '追剧', '旅行'],
  styleExamples: [],
  assessments: { mbti: '' },
  traits: { socialBattery: 45, warmth: 75, attachment: 55, sharpness: 40, initiative: 55, orderliness: 50 },
  behavior: {
    baseWake: '07:30', baseSleep: '23:30', jitterMin: 45,
    nightOwlProb: 0.15, allNighterProb: 0.03, weekendShiftMin: 60,
    activePerDay: 3, pokeMinutes: 30, pokeMaxPerDay: 2,
  },
  // 她的过去分三层（作者层=你填的底细；她全知道，但对外一层层透露）
  // surface：表层（职业/城市/日常喜好，刚认识就能聊）
  // middle ：中层（家庭大概/工作遭遇/朋友/一般经历，熟人~朋友且你问到才说）
  // deep   ：深层（创伤/心结/真正的梦想/重大经历，亲近以上+气氛对了才说）
  profile: { appearance: {}, favorites: {}, inner: {}, past: { surface: '', middle: '', deep: '' } },
  source: 'handcraft',
};

/** 六维清单与通俗含义（提示词与界面共用同一份事实） */
export const TRAIT_DESC = [
  ['socialBattery', '社交电量', '决定你能聊多久、会不会说去躺会'],
  ['warmth', '情感温度', '决定你说话的温度和撒娇浓度'],
  ['attachment', '依恋强度', '决定你有多想在意的这个人、多久不回会催'],
  ['sharpness', '批判锐度', '决定吐槽和说话直接的程度'],
  ['initiative', '发起力', '决定你主动开话题和分享的倾向'],
  ['orderliness', '秩序感', '决定你生活作息的规律程度'],
];

/** MBTI → 认知功能栈（荣格八维底色，位置1主导/2辅助/3三位/4劣势）。类型自出生即定，永不变。 */
function mbtiStack(mbti) {
  const t = String(mbti || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!/^[IE][NS][TF][JP]$/.test(t)) return null;
  const [E, SN, TF, JP] = t.split('');
  const perceiving = SN === 'N' ? ['Ne', 'Ni'] : ['Se', 'Si'];
  const judging = TF === 'T' ? ['Te', 'Ti'] : ['Fe', 'Fi'];
  const extFn = JP === 'J' ? judging[0] : perceiving[0];
  const intFn = JP === 'J' ? perceiving[1] : judging[1];
  const flip = (fn) => fn[0] + (fn[1] === 'e' ? 'i' : 'e');
  const dom = E === 'E' ? extFn : intFn;
  const aux = E === 'E' ? intFn : extFn;
  return { type: t, stack: [dom, aux, flip(dom), flip(aux)] };
}

const clampT = (v) => Math.round(Math.min(95, Math.max(5, v)));

/** 六维评分：严格按认知功能栈的位置权重（主导1.0/辅助0.7/三位0.4/劣势0.15）与功能性质推导。 */
function mbtiTraits(mbti) {
  const s = mbtiStack(mbti);
  if (!s) return null;
  const W = [1.0, 0.7, 0.4, 0.15];
  const wOf = (kind, att) => s.stack.reduce((a, f, i) => a + (f[0] === kind && f[1] === att ? W[i] : 0), 0);
  const wKind = (kind) => s.stack.reduce((a, f, i) => a + (f[0] === kind ? W[i] : 0), 0);
  const extW = s.stack.reduce((a, f, i) => a + (f[1] === 'e' ? W[i] : 0), 0);
  const FeW = wOf('F', 'e'), FiW = wOf('F', 'i'), TiW = wOf('T', 'i'), TeW = wOf('T', 'e');
  const NeW = wOf('N', 'e'), SeW = wOf('S', 'e'), SiW = wOf('S', 'i');
  const Fw = wKind('F');
  const isE = s.type[0] === 'E', isJ = s.type[3] === 'J';
  return {
    socialBattery: clampT(30 + extW * 35 + (isE ? 15 : -10)),
    warmth: clampT(25 + FeW * 60 + FiW * 35),
    attachment: clampT(20 + FeW * 50 + FiW * 30 + (isE ? 10 : 0)),
    sharpness: clampT(25 + TiW * 45 + TeW * 35 + NeW * 20 - Fw * 20),
    initiative: clampT(20 + extW * 25 + (NeW + SeW) * 12 + (isE ? 10 : -8)),
    orderliness: clampT(30 + (isJ ? 25 : -15) + SiW * 30 + TeW * 25),
  };
}

/** 八维推导出的六维基准（供长期演化做"不越过认知类型"的钳制；类型永不变） */
export function derivedTraits(mbti) { return mbtiTraits(mbti); }

export class Soul {
  constructor(options = {}) {
    this.dir = options.dir || '.';
    this._routerGet = typeof options.router === 'function' ? options.router : () => options.router;
    this.embed = options.embed || null;
    this.log = options.logger || (() => {});
    // v2：mem0 sidecar 客户端（可为 null=只用本地引擎）
    this.memory = options.memory || null;
    // v2：变形状态机
    this.deform = options.deform || null;
    // v2：自我认知卡（fn → string，来自 feature-status.js）
    this._featuresGet = typeof options.features === 'function' ? options.features : () => featureGistForSoul();
    // v2：行为参数热读（fn → config.json 的 behavior+memory 组）
    this._behaviorGet = typeof options.behavior === 'function' ? options.behavior : () => ({});
    fs.mkdirSync(path.join(this.dir, 'history'), { recursive: true });
    this._engineCache = { ok: null, at: 0, info: null };   // 失效时也用这个空对象，别赋 null（读 .at 会抛错）
    this._lastEngineLog = 0;
  }

  get router() { return this._routerGet(); }

  // ---------- 行为参数（每次调用热读，面板改完即生效） ----------
  _behavior() {
    const persona = this.getPersona();
    const pb = persona.behavior || {};
    const b = { ...(this._behaviorGet() || {}), ...pb };
    const m = b.memory || {};
    return {
      chunkMax: Math.min(5, Math.max(1, Number(b.chunkMax) || 3)),
      contextRounds: Math.min(60, Math.max(2, Number(b.contextRounds) || Number((b.params || {}).historyRounds) || 16)),
      // 治断片（批 E4）的两个旋钮（2026-09-14 补：原计划里就有，当时漏做）
      // summaryStart：未总结的老对话**攒到这么多轮**才开始总结（省模型调用，别每两轮就总结一次）
      // summaryPrompt：用户可自定义的总结提示词，留空就用内置 SUMMARY_SYS
      summaryStart: Math.min(40, Math.max(2, Number(b.summaryStart) || 6)),
      summaryPrompt: String(b.summaryPrompt || '').slice(0, 500),
      maxTokens: Math.min(8000, Math.max(64, Number((b.params || {}).maxTokens) || 500)),
      voiceRate: Number(b.voiceRate) || 0,
      topK: Math.min(15, Math.max(3, Number(m.topK) || 6)),
      extractEveryN: Math.min(10, Math.max(1, Number(m.extractEveryN) || 1)),
      extraction: m.extraction === 'manual' ? 'manual' : 'cloud',
      extractionModel: String(m.extractionModel || '').trim(),
      // 双向记忆开关（记忆组要整体带出来，否则下游读不到 → 曾经的"设置静默失效"）
      memory: m,
      selfMemory: m.selfMemory !== false,
      // 「他是谁」档案已退场（2026-09-13 用户拍板）：不再带 owner
      talkiness: (typeof b.talkiness === 'number' && isFinite(b.talkiness)) ? Math.max(0, Math.min(100, b.talkiness)) : null,
      selfCheck: b.selfCheck !== false,
      // 「真人感来自减法」总开关（默认开）：会犯困/话说短/小细节记不清由性格与电量推
      realism: b.realism !== false,
      // 复读止血的强度：off=不判 / literal=只比字面（免费）/ literal+intent=再加一次便宜模型判"是不是同一件事"
      repeatGuard: ['off', 'literal', 'literal+intent'].includes(b.repeatGuard) ? b.repeatGuard : 'literal+intent',
      speedMul: Math.max(0.5, Math.min(2.5, Number(b.speedMul) || 1)),
    };
  }

  // ---------- mem0 引擎健康（60 秒缓存，挂了不吵） ----------
  async engineUp() {
    if (!this.memory) return false;
    const now = Date.now();
    const c = this._engineCache || {};
    if (c.at && now - c.at < 60000) return !!c.ok;
    const info = await this.memory.health();
    const up = !!(info && info.ready !== false);
    this._engineCache = { ok: up, at: now, info: info };
    if (!up && now - this._lastEngineLog > 600000) {
      this.log('[soul] mem0 引擎未就绪(' + ((info && info.reason) || '未响应') + ')，记忆降级为本地JSON模式');
      this._lastEngineLog = now;
    }
    return up;
  }

  engineInfo() { return this._engineCache.info; }

  // ---------- 记忆的桶与「最后一次被想起」（本地小文件，v2 结构） ----------
  // v1 是 {id:{importance,pinned}}，v2 是 {v:2, entries:{id:{bucket,lastHit}}}。
  // 读到旧格式一律当空对象：旧数据由「桶化迁移」负责转换，读取端不做兼容猜测。
  _metaFile() { return path.join(this.dir, 'memory-meta.json'); }
  _metaAll() {
    const all = readJson(this._metaFile(), null);
    if (all && typeof all === 'object' && !Array.isArray(all)
        && all.v === 2 && all.entries && typeof all.entries === 'object') return all.entries;
    return {};
  }
  _metaSave(entries) { writeJson(this._metaFile(), { v: 2, entries: entries || {} }); }
  _metaGet(id) { return this._metaAll()[id] || {}; }

  /** 条目的桶：meta 里没有就按默认规则推——迁移还没覆盖到的条目也不会变成未知状态。 */
  _bucketOf(e = {}) {
    const key = e.mid || e.id || '';
    const m = key ? this._metaGet(key) : {};
    return BUCKETS.includes(m.bucket) ? m.bucket : defaultBucket(e);
  }

  /** 遗忘曲线：越久没被提起权重越低，但永不归零；固化桶不衰减。 */
  _bucketWeight(bucket, lastHit, ts) {
    if (bucket === 'permanent') return 1;
    const t0 = Number(lastHit) || Number(ts) || Date.now();
    const age = Math.max(0, Date.now() - t0) / 86400000;
    const tau = BUCKET_TAU[bucket] || BUCKET_TAU.dynamic;
    return BUCKET_FLOOR + (1 - BUCKET_FLOOR) * Math.exp(-age / tau);
  }

  /** 改桶（后台点一下就改这里；引擎在线时同时改本地镜像，保持一致）。 */
  async setBucket(memId, bucket) {
    if (!BUCKETS.includes(bucket)) throw new Error('未知的桶: ' + bucket);
    const cur = this._metaGet(memId);
    if (await this.engineUp()) { this._metaSet(memId, { ...cur, bucket, lastHit: cur.lastHit || 0 }); this._jsonEditByMid(memId, { bucket }); return bucket; }
    this._jsonEdit(memId, { bucket });
    this._metaSet(memId, { ...cur, bucket, lastHit: cur.lastHit || 0 });
    return bucket;
  }

  /** 本轮真正被想起的条目：刷新 lastHit（6 小时节流）让权重回升。 */
  touchMemories(entries = []) {
    const now = Date.now();
    let dirty = false;
    for (const e of entries) {
      const key = e.mid || e.id;
      if (!key) continue;
      const cur = this._metaGet(key);
      if (cur.lastHit && now - cur.lastHit < 6 * 3600000) continue;
      this._metaSet(key, { bucket: cur.bucket || this._bucketOf(e), lastHit: now });
      dirty = true;
    }
    return dirty;
  }
  _metaSet(id, patch) {
    if (!id) return;
    const all = this._metaAll();
    if (patch === null) { delete all[id]; } else { all[id] = { ...(all[id] || {}), ...patch }; }
    this._metaSave(all);
  }

  // ---------- 存储：人设 ----------
  personaFile() { return path.join(this.dir, 'persona.json'); }

  /** 她的"对外叫法"：她希望的称呼优先，没填就用名字（日记/朋友圈/落款/提示词共用同一份） */
  displayName(persona) {
    const p = persona || this.getPersona();
    const want = String(((p.relationship || {}).ownerCallsMe) || '').trim();
    return want || String(p.name || '她');
  }

  /** 改 relationship 里的字段（savePersona 是浅合并，必须自己铺开当前值） */
  updateRelationship(patch = {}) {
    const cur = (this.getPersona().relationship) || {};
    return this.savePersona({ relationship: { ...cur, ...patch } });
  }

  getPersona() {
    const p = readJson(this.personaFile(), null);
    if (!p) return structuredClone(DEFAULT_PERSONA);
    const merged = { ...structuredClone(DEFAULT_PERSONA), ...p };
    // 旧版五维自动映射到六维（orderliness 无旧值取默认 50）
    if (!merged.traits && merged.personality) {
      const o = merged.personality;
      merged.traits = {
        socialBattery: o.extraversion != null ? o.extraversion : 45,
        warmth: o.warmth != null ? o.warmth : 75,
        attachment: o.clinginess != null ? o.clinginess : 55,
        sharpness: o.sass != null ? o.sass : 40,
        initiative: o.initiative != null ? o.initiative : 55,
        orderliness: 50,
      };
    }
    if (!merged.behavior) merged.behavior = structuredClone(DEFAULT_PERSONA.behavior);
    return merged;
  }

  savePersona(patch = {}) {
    const cur = this.getPersona();
    const next = { ...cur, ...patch };
    // MBTI 变更 → 六维按八维自动重算（除非本次显式提交了 traits）
    const newMbti = next.assessments && next.assessments.mbti;
    if (newMbti && (!patch.traits) && newMbti !== ((cur.assessments || {}).mbti || '')) {
      next.traits = mbtiTraits(newMbti) || next.traits;
    }
    delete next.version;
    delete next.versions;
    writeJson(this.personaFile(), next);
    return next;
  }

  // ---------- 人设存档（游戏存档式：无版本号，可改名/删除/一键切换） ----------
  archivesFile() { return path.join(this.dir, 'persona-archives.json'); }
  listArchives() {
    return readJson(this.archivesFile(), []).map((a) => ({ id: a.id, name: a.name, savedAt: a.savedAt, personaName: a.snapshot && a.snapshot.name }));
  }
  archivePersona(name) {
    const all = readJson(this.archivesFile(), []);
    const entry = { id: rid(), name: String(name || ('存档 ' + new Date().toLocaleDateString('zh-CN'))).slice(0, 30), savedAt: Date.now(), snapshot: structuredClone(this.getPersona()) };
    all.unshift(entry);
    while (all.length > 30) all.pop();
    writeJson(this.archivesFile(), all);
    return entry;
  }
  switchArchive(id) {
    const all = readJson(this.archivesFile(), []);
    const hit = all.find((a) => a.id === id);
    if (!hit) throw new Error('存档不存在');
    all.unshift({ id: rid(), name: '切换前备份 · ' + new Date().toLocaleString('zh-CN').slice(5, 16), savedAt: Date.now(), snapshot: structuredClone(this.getPersona()) });
    while (all.length > 30) all.pop();
    writeJson(this.archivesFile(), all);
    const restored = structuredClone(hit.snapshot);
    writeJson(this.personaFile(), restored);
    return restored;
  }
  renameArchive(id, name) {
    const all = readJson(this.archivesFile(), []);
    const hit = all.find((a) => a.id === id);
    if (!hit) throw new Error('存档不存在');
    hit.name = String(name || hit.name).slice(0, 30);
    hit.savedAt = Date.now();
    writeJson(this.archivesFile(), all);
    return hit;
  }
  deleteArchive(id) {
    const all = readJson(this.archivesFile(), []);
    writeJson(this.archivesFile(), all.filter((a) => a.id !== id));
  }

  // ---------- 存储：关系与情绪 ----------
  relationsFile() { return path.join(this.dir, 'relations.json'); }

  getRelations() { return readJson(this.relationsFile(), {}); }

  /**
   * 她的心情：**算出来的，不是存出来的**。
   *
   * 以前心情散在三个地方——世界引擎给的明天基线、今天那份状态里的基准、
   * 以及每个联系人各存一份并被每轮聊天加减（+0.5 / 被哄 +4 / 被凶 -6）。
   * 结果是它跟真实状态脱钩：人可以一边很委屈、一边心情还有 79。
   *
   * 现在只有一个输入 + 三个明确修正项，永远不会自相矛盾：
   *   心情 = 今天的基准（世界引擎给）＋ 今天的互动累计（被哄/被凶）− 压力/4 ＋ 电量修正
   */
  moodNow() {
    const t = Date.now();
    if (this._moodMemo && t - this._moodMemo.at < 2000) return this._moodMemo.v;
    let base = 60, delta = 0, batt = 60, stress = 0;
    try {
      const d = readJson(path.join(this.dir, 'daily-state.json'), {}) || {};
      if (typeof d.mood === 'number' && isFinite(d.mood)) base = d.mood;
      if (typeof d.battery === 'number' && isFinite(d.battery)) batt = d.battery;
      const de = d.dayEvents || {};
      delta = Number(de.moodDelta) || 0;
    } catch { /* 读不到就用默认值 */ }
    try {
      const f = readJson(path.join(this.dir, 'deform-state.json'), {}) || {};
      stress = Number(f.stress) || 0;
    } catch { /* 同上 */ }
    const v = Math.max(0, Math.min(100, Math.round(base + delta - stress / 4 + (batt - 60) / 8)));
    this._moodMemo = { at: t, v };
    return v;
  }

  /** 今天的互动对心情的累计（被哄/被凶），存在每日状态里，隔天随日期重置。 */
  _addMoodDelta(delta) {
    const file = path.join(this.dir, 'daily-state.json');
    try {
      const d = readJson(file, null);
      if (!d || typeof d !== 'object') return;
      d.dayEvents = d.dayEvents || {};
      const cur = Number(d.dayEvents.moodDelta) || 0;
      d.dayEvents.moodDelta = Math.max(-30, Math.min(30, Math.round((cur + delta) * 10) / 10));
      fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
      this._moodMemo = null;
    } catch (err) { this.log('[soul] 心情累计写入失败: ' + (err && err.message)); }
  }

  getRelation(peerKey, isOwner) {
    const all = this.getRelations();
    // 第三次改版：亲密度退场（不再有分数与阶段），只留「处过多久、聊过多少、当前心情」
    const base = all[peerKey] || { firstSeen: Date.now(), lastSeen: 0, chats: 0 };
    return { ...base, mood: this.moodNow() };
  }

  _saveRelation(peerKey, patch) {
    const all = this.getRelations();
    all[peerKey] = { ...this.getRelation(peerKey), ...patch, lastSeen: Date.now() };
    writeJson(this.relationsFile(), all);
    return all[peerKey];
  }

  /**
   * 备注名（2026-09-13 第三次改版）：给一个联系人起个好记的名字。
   * 只做后台显示——不改她的记忆、不改她聊天时怎么称呼对方（用户拍板：只给你看）。
   * 传空字符串 = 清掉备注名，回到"后 6 位"的兜底显示。
   */
  setRelationName(peerKey, name) {
    const key = String(peerKey || '').trim();
    if (!key) throw new Error('缺少联系人 ID');
    const nm = String(name == null ? '' : name).trim().slice(0, 20);
    const all = this.getRelations();
    const cur = all[key] || { firstSeen: Date.now(), lastSeen: 0, mood: 60, chats: 0 };
    if (nm) cur.name = nm; else delete cur.name;
    all[key] = cur;
    writeJson(this.relationsFile(), all);
    return { key, name: nm };
  }

  affectionTitle(affection, isOwner) {
    if (!isOwner) return affection > 50 ? '熟人' : '普通朋友';
    if (affection >= 90) return '灵魂伴侣级';
    if (affection >= 75) return '很亲很亲';
    if (affection >= 50) return '亲密';
    if (affection >= 25) return '熟悉';
    return '刚认识不久';
  }

  // ---------- 存储层 A：本地 JSON 记忆（兜底引擎 + 迁移源） ----------
  memoryFile() { return path.join(this.dir, 'memory.json'); }

  getMemories() {
    // 容错（2026-09-12 事故）：记忆文件曾经被写成裸数组 []，于是下面所有 mem.entries.filter 直接抛
    // "mem.entries.filter is not a function"，她连回话都回不了。这里统一规整成 {entries:[],todos:[]}。
    const raw = readJson(this.memoryFile(), null);
    if (Array.isArray(raw)) return { entries: raw, todos: [] };
    if (!raw || typeof raw !== 'object') return { entries: [], todos: [] };
    return {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      todos: Array.isArray(raw.todos) ? raw.todos : [],
    };
  }

  _jsonAdd(item = {}) {
    const mem = this.getMemories();
    const text = String(item.text || '').slice(0, 200);
    if (!text) return this.getMemories();
    const cat = ['you', 'her', 'world'].includes(item.cat) ? item.cat : '';
    const bucket = BUCKETS.includes(item.bucket) ? item.bucket : defaultBucket({ ...item, cat });
    const dup = mem.entries.find((e) => e.text === text);
    if (dup) {
      dup.ts = Date.now();   // 又被提到：刷新时间（重要度/命中数这些没人读的字段已删）
      if (item.mid) { dup.mid = item.mid; delete dup.pending; }   // 这次进引擎了 → 不再是待补迁
    } else {
      const e = { id: rid(), who: item.who || '', text, cat, bucket, ts: Date.now(), lastHit: 0 };
      if (item.mid) e.mid = item.mid;
      // 没进引擎（降级）的条目先记上，等引擎恢复由 syncPendingMemories 补迁
      if (!item.mid && item.pending) e.pending = true;
      mem.entries.push(e);
    }
    writeJson(this.memoryFile(), mem);
    return mem;
  }

  _jsonEdit(memId, patch) {
    const mem = this.getMemories();
    const hit = mem.entries.find((e) => e.id === memId);
    if (!hit) throw new Error('记忆不存在: ' + memId);
    Object.assign(hit, patch);
    writeJson(this.memoryFile(), mem);
    return hit;
  }

  _jsonDelete(memId) {
    const mem = this.getMemories();
    mem.entries = mem.entries.filter((e) => e.id !== memId);
    writeJson(this.memoryFile(), mem);
  }

  /** 镜像同步：按 mem0 id 定位 JSON 条目并同步变更（找不到就忽略） */
  _jsonEditByMid(mid, patch = {}) {
    try {
      const mem = this.getMemories();
      const hit = mem.entries.find((e) => e.mid === mid);
      if (!hit) return null;
      const safe = {};
      if (typeof patch.text === 'string' && patch.text.trim()) safe.text = patch.text.trim().slice(0, 200);
      if (patch.importance !== undefined) safe.importance = Math.min(5, Math.max(1, Number(patch.importance) || 3));
      if (patch.pinned !== undefined) safe.pinned = !!patch.pinned;
      Object.assign(hit, safe);
      writeJson(this.memoryFile(), mem);
      return hit;
    } catch { return null; }
  }

  _jsonDeleteByMid(mid) {
    try {
      const mem = this.getMemories();
      mem.entries = mem.entries.filter((e) => e.mid !== mid);
      writeJson(this.memoryFile(), mem);
    } catch { /* 忽略 */ }
  }

  // ---------- 存储层 B：统一入口（mem0 优先，JSON 兜底，UI 无感） ----------

  /** 后台记忆页的数据视图：带引擎标识 */
  /** 记忆归属（第三次改版）：关于我 / 关于她 / 我们之间 —— 替掉界面上那串乱码 ID */
  /**
   * 记忆的三类（2026-09-13 用户定稿）：**我 / 她 / 世界**。
   *   我   = 关于他的事（默认；他手写的、聊天里提炼出来的他的事）
   *   她   = 她自己的话（立场/打算/喜好，双向记忆）
   *   世界 = 她的生活流水与社交圈（世界引擎每晚写的）
   * 以前把「生活流水」错算成「她」了，这里一并纠正。
   */
  catOf(e = {}) {
    const md = e.metadata || {};
    const c = md.cat || e.cat;
    if (c === 'you' || c === 'her' || c === 'world') return c;
    const src = String(md.source || e.source || '');
    const text = String(e.text || '');
    // 按正文前缀先判：世界引擎写的流水属于「世界」，成长属于「她」——
    // 以前一律按 who='self' 算成"她自己的话"，于是世界流水在后台是「世界」、进提示词却变成「她说过的」。
    if (/^（生活）/.test(text)) return 'world';
    if (/^（成长）/.test(text)) return 'her';
    if (src === 'self' || e.who === 'self') return 'her';
    if (src === 'life') return 'world';
    return 'you';
  }

  catLabel(cat) { return cat === 'her' ? '她' : (cat === 'world' ? '世界' : '我'); }

  async memoriesView() {
    // 引擎条目与本地条目共用同一套映射（别再写第二份，那正是"两处判定不一致"的来源）
    const mapEntry = (e) => {
      const cat = this.catOf(e);
      const bucket = this._bucketOf(e);
      const meta = this._metaGet(e.mid || e.id);
      return {
        id: e.id, text: e.text, who: e.who || 'global',
        cat, catLabel: this.catLabel(cat),
        bucket, bucketLabel: BUCKET_LABEL[bucket],
        weight: Math.round(this._bucketWeight(bucket, meta.lastHit, e.ts || Date.now()) * 100) / 100,
        lastHit: Number(meta.lastHit) || 0,
        ts: e.ts || Date.now(),
      };
    };
    const countBuckets = (entries) => {
      const c = { dynamic: 0, permanent: 0, feel: 0 };
      for (const e of entries) c[e.bucket] = (c[e.bucket] || 0) + 1;
      return c;
    };
    if (await this.engineUp()) {
      try {
        const r = await this.memory.list();
        const entries = (r.entries || []).map(mapEntry);
        return { engine: 'mem0', info: this.engineInfo(), pendingSync: this.pendingMemoryCount(), entries, bucketCounts: countBuckets(entries), legacyCount: (this.getMemories().entries || []).length };
      } catch (err) {
        this.log('[soul] mem0 列表失败，显示本地数据: ' + (err && err.message));
      }
    }
    const entries = (this.getMemories().entries || []).map(mapEntry);
    return { engine: 'local', info: null, pendingSync: this.pendingMemoryCount(), entries, bucketCounts: countBuckets(entries) };
  }

  /** 手动记一条 */
  async addMemory(item = {}) {
    const text = String(item.text || '').slice(0, 200);
    if (!text) return null;
    const cat = ['you', 'her', 'world'].includes(item.cat) ? item.cat : (item.source === 'self' ? 'her' : 'you');
    // 注意要把 who 一起传进去：判定「手写（who 为空）→ 固化」靠的就是它。漏传会让所有条目都被当成手写。
    const bucket = BUCKETS.includes(item.bucket) ? item.bucket : defaultBucket({ who: item.who, cat, source: item.source, text });
    if (await this.engineUp()) {
      try {
        const r = await this.memory.add({ text, who: item.who || 'global', infer: false, metadata: { cat, ts: Date.now() } });
        const id = (r.ids && r.ids[0]) || '';
        if (id) this._clearMemHealth();
        if (id) {
          this._metaSet(id, { bucket, lastHit: 0 });
          this._jsonAdd({ who: item.who || '', text, cat, bucket, mid: id });
        }
        return { id, text };
      } catch (err) {
        this.log('[soul] mem0 写入失败，落本地JSON: ' + (err && err.message));
        this._bumpMemHealth((err && err.message) || '写入失败', text);
      }
    }
    this._jsonAdd({ who: item.who || '', text, cat, bucket, pending: true });
    this._bumpMemHealth(this._engineCache && this._engineCache.info && this._engineCache.info.reason ? ('引擎未就绪：' + this._engineCache.info.reason) : '引擎未就绪（记忆只落在本地兜底里）', text);
    // degraded 让调用方知道"这次没进引擎、只落了本地"——不许再静默降级
    return { id: '', text, degraded: true };
  }

  /** 编辑：text 走引擎更新，置顶/重要度走 meta 补充层 */
  /** 编辑：只改正文（重要度与置顶已退场；归属与桶走 meta 层，见 setBucket） */
  async editMemory(memId, patch = {}) {
    const text = (typeof patch.text === 'string' && patch.text.trim()) ? patch.text.trim().slice(0, 200) : '';
    if (!text) return { id: memId };
    if (await this.engineUp()) {
      await this.memory.update(memId, { text });
      this._jsonEditByMid(memId, { text });
      return { id: memId };
    }
    return this._jsonEdit(memId, { text });
  }

  async deleteMemory(memId) {
    if (await this.engineUp()) {
      try { await this.memory.remove(memId); } catch (err) { this.log('[soul] mem0 删除失败: ' + (err && err.message)); }
      this._metaSet(memId, null);
      this._jsonDeleteByMid(memId);
      return;
    }
    this._jsonDelete(memId);
  }

  /** 「固化」开关（旧名 pinMemory，后台的 op=pin 继续可用）：固化 ↔ 回默认桶 */
  async pinMemory(memId) {
    const view = await this.memoriesView();
    const hit = (view.entries || []).find((e) => e.id === memId) || {};
    const cur = this._bucketOf(hit);
    const next = cur === 'permanent' ? defaultBucket({ cat: hit.cat || 'you' }) : 'permanent';
    await this.setBucket(memId, next);
    return next === 'permanent';
  }

  /** 一次性把旧 JSON 记忆搬进 mem0（幂等：只迁无 mid 的旧条目；服务端再按文本去重） */
  async migrateLegacyMemory() {
    const entries = (this.getMemories().entries || []).filter((e) => !e.mid);
    if (!entries.length) return { added: 0, total: 0 };
    const payload = entries.map((e) => ({
      text: e.text,
      who: e.who || 'global',
      metadata: { importance: e.importance || 3, tags: e.tags || [], pinned: !!e.pinned, ts: e.ts, source: 'migrated' },
    }));
    const r = await this.memory.migrate(payload);
    return { added: (r && r.added) || 0, total: entries.length };
  }

  // ---------- 检索 ----------
  /** 中文二字片段（中文没有空格，按字切才是正确的关键词匹配） */
  _zhGrams(s, cap) {
    const t = String(s || '').replace(/\s+/g, '');
    const g = [];
    for (let i = 0; i + 1 < t.length && g.length < (cap || 24); i++) g.push(t.slice(i, i + 2));
    return g;
  }

  /** 本地 JSON 混合检索（v1 逻辑：关键词+语义+重要度+时间+置顶） */
  /**
   * 桶化迁移：把旧的扁平元数据换成"桶 + 最后一次被想起"，并顺手修好本地镜像与引擎之间的 mid 断链。
   *
   * 幂等：重复跑不会重复改；只写 memory-meta.json（v2）与 memory.json 的 mid 回填。
   * 不做的事：不删任何记忆、不重建向量库。
   * 判定（依据她的真实数据）：手写条目 who 为空 → 固化；世界流水「（生活）」→ 世界/会淡忘；
   * 「（成长）」与她自述 → 她自己的感受；正文含乱码或过短 → 进人工处置清单，不自动进桶也不删。
   */
  async migrateBuckets() {
    const mem = this.getMemories();
    const entries = mem.entries || [];
    const result = { total: entries.length, migrated: 0, matched: 0, review: 0, pending: false };
    const nw = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const keyOf = (who, text) => (nw(who) || 'global') + '\u0000' + nw(text);

    // ① 旧 meta 留一份底（非空才留）：万一要回退，原始的 id→元数据映射不丢
    try {
      const raw = readJson(this._metaFile(), null);
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v !== 2) {
        writeJson(path.join(this.dir, 'memory-meta.v1.json'), raw);
      }
    } catch { /* 留档失败不阻断迁移 */ }

    // ② 读引擎全量，用于按（归一化 who + 正文）精确配对、回填 mid
    const engineMap = new Map();
    try {
      if (await this.engineUp()) {
        const r = await this.memory.list();
        for (const e of (r.entries || [])) engineMap.set(keyOf(e.who, e.text), e.id);
      } else { result.pending = true; }
    } catch { result.pending = true; }

    // ③ 逐条：损坏检测 → 回填 mid → 判桶
    const meta = {};
    const review = [];
    for (const e of entries) {
      const text = String(e.text || '');
      if (/�/.test(text) || text.replace(/\s/g, '').length < 2) {
        review.push({ id: e.id, text, reason: '正文含乱码字符或过短，不自动进桶，也不自动删除' });
        result.review += 1;
        continue;
      }
      let mid = e.mid || '';
      if (!mid && engineMap.size) {
        const hit = engineMap.get(keyOf(e.who, text));
        if (hit) { e.mid = hit; mid = hit; result.matched += 1; }
      }
      const cat = this.catOf(e);
      const bucket = (String(e.who || '') === '' || e.source === 'manual') ? 'permanent' : defaultBucket({ ...e, cat, text });
      e.cat = cat;
      e.bucket = bucket;
      meta[mid || e.id] = { bucket, lastHit: 0 };
      result.migrated += 1;
    }

    writeJson(this.memoryFile(), mem);      // 回填的 mid 与 cat/bucket 落盘
    this._metaSave(meta);                    // 桶落进 v2 结构
    if (review.length) writeJson(path.join(this.dir, 'memory-meta-review.json'), { at: Date.now(), items: review });
    this.log('[soul] 桶化迁移：' + result.migrated + ' 条入桶、' + result.matched + ' 条补回 mid、待人工处置 ' + result.review + ' 条'
      + (result.pending ? '（引擎未就绪，mid 回填留到下轮）' : ''));
    return result;
  }

  async _retrieveHybridLocal(query, peerKey) {
    const mem = this.getMemories();
    const selfOn = this._behavior().selfMemory !== false;
    // 双向记忆：她的自述（who=self）也要能被检索到，否则"她记得自己说过什么"就是空话
    const entries = mem.entries.filter((e) => !e.who || e.who === peerKey || (selfOn && e.who === 'self'));
    const q = String(query || '');
    const topK = this._behavior().topK;
    let cosMap = null;
    try {
      if (this.embed && entries.length) {
        await this.embed.ensureVectors(entries.slice(0, 40));
        const qv = await this.embed.embed(q.slice(0, 500));
        cosMap = await this.embed.search(qv, entries);
      }
    } catch (err) {
      this.log('[soul] 语义检索降级为关键词: ' + (err && err.message));
    }
    return entries
      .map((e) => {
        // 打分 = 遗忘曲线的权重 × 相关性（关键词 + 语义）。
        // 以前是"重要度×2 + 关键词 + 语义 + 新鲜度"，并且置顶直接 +100（把那一条钉死在最前）。
        // 重要度与置顶都已在桶化里退场；权重本身表达的就是"还想不想得起来"。
        const bucket = this._bucketOf(e);
        const w = this._bucketWeight(bucket, (this._metaGet(e.mid || e.id) || {}).lastHit, e.ts);
        const kw = Math.min(6, this._zhGrams(q, 20).filter(function (g) { return e.text.indexOf(g) >= 0; }).length);
        const cos = cosMap ? (cosMap.get(e.id) || 0) : 0;
        return { e: { ...e, cat: this.catOf(e), bucket }, score: w * (2 + kw * 3 + cos * 4) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.e);
  }

  /** 统一检索入口：mem0 引擎优先（自动降级本地）。三等检索：对方的事 / 通用 / 她自己的话 */
  async _retrieveHybrid(query, peerKey) {
    const selfOn = this._behavior().selfMemory !== false;
    if (await this.engineUp()) {
      try {
        const topK = this._behavior().topK;
        const jobs = [
          { who: peerKey, p: this.memory.search({ query, who: peerKey, topK }) },
          { who: 'global', p: this.memory.search({ query, who: 'global', topK: 3 }) },
        ];
        if (selfOn) jobs.push({ who: 'self', p: this.memory.search({ query, who: 'self', topK: 3 }) }); // 她自己的话：联动关键
        const parts = await Promise.all(jobs.map((j) => j.p));
        const seen = new Set();
        const out = [];
        for (let i = 0; i < parts.length; i++) {
          const fromWho = jobs[i].who;
          for (const e of (parts[i].results || [])) {
            if (!e || !e.id || seen.has(e.id)) continue;
            seen.add(e.id);
            const meta = this._metaGet(e.id);
            const md = (e.metadata || {});
            const bucket = this._bucketOf({ ...e, mid: e.id });
            out.push({
              id: e.id,
              mid: e.id,
              text: String(e.text || ''),
              ts: e.ts || Date.now(),
              cat: this.catOf(e),
              bucket,
              // 权重：固化=1；其余随时间衰减，但被想起过就从上次想起的时间算
              weight: this._bucketWeight(bucket, meta.lastHit, e.ts || Date.now()),
              // 引擎本来就会返回相似度，以前被丢掉了——现在用上（它比我们自己算的关键词更准）
              score: Number(e.score) || 0,
              who: e.who || md.who || fromWho,
            });
          }
        }
        // 以前这里按"置顶"排——置顶退场之后它等于完全没排序（进什么顺序就是什么顺序）。
        // 现在按「权重 × 相关性」排，并真的用上引擎返回的相似度。
        out.sort((a, b) => (b.weight * (0.4 + (b.score || 0))) - (a.weight * (0.4 + (a.score || 0))));
        const top = out.slice(0, topK);
        // 固化过的条目不该因为相关性低就被挤掉：名额还没满就按时间补进来
        if (top.length < topK) {
          const has = new Set(top.map((x) => x.id));
          for (const e of out) {
            if (top.length >= topK) break;
            if (e.bucket === 'permanent' && !has.has(e.id)) { top.push(e); has.add(e.id); }
          }
        }
        if (top.length) return top;
      } catch (err) {
        if (Date.now() - this._lastEngineLog > 60000) {
          this.log('[soul] mem0 检索失败，降级本地: ' + (err && err.message));
          this._lastEngineLog = Date.now();
        }
      }
    }
    return this._retrieveHybridLocal(query, peerKey);
  }

  // ---------- 存储：对话历史 ----------
  historyFile(peerKey) { return path.join(this.dir, 'history', encodeURIComponent(peerKey) + '.json'); }

  getHistory(peerKey) { return readJson(this.historyFile(peerKey), []); }

  /**
   * 后台把"老的那一段"总结成记忆（批 E4）。
   * 成功后：①写本地摘要缓存（下一轮提示词就能用）②**进她的记忆系统**（她以后检索得到）。
   * 失败：什么都不做 —— 调用方的规则是"总结没好就不裁"，所以她不会断片。
   */
  _kickSummary(peerKey, older) {
    if (!Array.isArray(older) || older.length < 4) return;
    if (!this._summarizing) this._summarizing = {};
    if (this._summarizing[peerKey]) return;                 // 一轮只跑一个，别并发刷模型
    this._summarizing[peerKey] = true;
    const chain = ((this.router && this.router.cfg && this.router.cfg.chain) || {}).memory || [];
    const cands = (Array.isArray(chain) ? chain : []).filter((c) => c && c.baseURL && c.model);
    const done = () => { try { delete this._summarizing[peerKey]; } catch { /* noop */ } };
    if (!cands.length) { done(); return; }                  // 没配提炼模型 → 不裁也不报错
    const bp = this._behavior() || {};
    const c = cands[0];
    const chat = (opts) => chatCompletion(Object.assign({ baseURL: c.baseURL, apiKey: c.apiKey || '', model: c.model }, opts));
    void summarizeOlder({ dir: this.dir, peerKey, older, chat, logger: (m) => this.log(m), sysPrompt: bp.summaryPrompt })
      .then((out) => {
        if (!out) return;
        saveSummary(this.dir, peerKey, out);
        this.log('[soul] 长对话已总结成记忆（' + out.count + ' 轮 → ' + out.text.length + ' 字）');
        // 禁黑盒：总结发生了就要在实况直播看得见（原计划里就有这行，2026-09-14 补上）
        if (this.activity) this.activity('[总结] 把最早的 ' + out.count + ' 轮总结进记忆了（往前的对话她不会断片）');
        return this.addMemory({ who: peerKey, text: '（聊过的）' + out.text, cat: 'you' });
      })
      .catch(() => { /* 失败就算了，规则是"不裁" */ })
      .then(done, done);
  }

  /**
   * 「真人感来自减法」（批 E4 / A17）：会犯困、话说短、小细节记不清——这些"人味"
   * 不是开关，是**性格与当下状态的结果**。人设显式设过的以人设为准。
   * 注意与「不说假话」那条线咬合：记不清就直说记不清，绝不许编一个来填。
   */
  _realism(persona, today) {
    const t = (persona && persona.traits) || {};
    const q = (persona && persona.quirks) || {};
    const order = Number(t.orderliness) || 50;
    const attach = Number(t.attachment) || 50;
    const batt = Number((today && today.battery) == null ? 60 : today.battery);
    const allNighter = !!(today && today.allNighter);
    const sleepy = Math.max(0, Math.min(1, (allNighter ? 0.6 : 0) + (batt < 45 ? (45 - batt) / 45 : 0) * (order < 55 ? 1.1 : 0.8)));
    const terse = batt < 40 ? 0.75 : (batt < 55 ? 0.9 : 1);
    const fuzzy = Math.max(0, Math.min(1, (55 - order) / 100 + (40 - attach) / 200));
    return { sleepy, terse, fuzzy };
  }

  /** 今天的人味那句（没有就返回空字符串，不占提示词） */
  _realismLine(r, persona) {
    if (!r) return '';
    const b = [];
    if (r.sleepy >= 0.5) b.push('你现在很困' + (r.sleepy >= 0.8 ? '（快撑不住了）' : '') + '：句子短一点、反应慢半拍，别讲长道理。');
    if (r.terse < 1) b.push('今天电量不高：能一句说完的，就别用三句。');
    if (r.fuzzy >= 0.4) b.push('有些很久以前的小细节你可能真记不清了——那就直说「我记不太清了」，**绝对不许编一个来填**。');
    if (!b.length) return '';
    return '【今天的人味（这是你的性格和状态的自然结果，不是表演）】' + b.join(' ');
  }

  /** 你多久没来了（毫秒）：想念曲线与提示词都要用 */
  _absenceMs(history, now) {
    const h = Array.isArray(history) ? history : [];
    const lastUser = [...h].reverse().find((m) => m && m.role !== 'her');
    if (!lastUser || !lastUser.ts) return 0;
    return Math.max(0, now.getTime() - lastUser.ts);
  }

  /** 把"多久以前"说成人话（给提示词用） */
  _gapCN(ms) {
    if (!(ms > 0)) return '刚刚';
    if (ms < 60000) return '刚刚';          // 先按原始毫秒判，别等四舍五入成 1 分钟
    const min = Math.round(ms / 60000);
    if (min < 60) return min + ' 分钟前';
    const h = Math.round(min / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  /**
   * 「他刚才的动静」：把"你隔了多久才回我""你是不是刚被晾着"告诉她。
   * 数据本来就有（聊天记录每条都带时间戳），只是以前没喂给她——这是最便宜的"人味"来源。
   */
  _motionLine(history, now) {
    const h = Array.isArray(history) ? history : [];
    if (!h.length) return '【他刚才的动静】这是你们今天的第一句话。';
    const t = now.getTime();
    const lastUser = [...h].reverse().find((m) => m && m.role !== 'her');
    const lastHer = [...h].reverse().find((m) => m && m.role === 'her');
    const bits = [];
    if (lastUser && lastUser.ts) bits.push('他上一条消息是' + this._gapCN(t - lastUser.ts) + '发的');
    if (lastHer && lastHer.ts) bits.push('你上次回他是' + this._gapCN(t - lastHer.ts));
    if (!bits.length) return '【他刚才的动静】这是你们今天的第一句话。';
    const hh = now.getHours();
    const when = (hh >= 0 && hh < 6) ? '现在是深夜/凌晨——他这会儿找你，多半是睡不着或者刚忙完'
      : (hh >= 9 && hh < 18) ? '现在是上班时间'
        : (hh >= 22) ? '现在已经很晚了' : '';
    const absMs = this._absenceMs(h, now);
    const lg = absMs >= 12 * 3600 * 1000
      ? longingLine(longingCurve({ absenceMs: absMs, attachment: this._longingCtx.attachment, battery: this._longingCtx.battery, workload: this._longingCtx.workload }), { who: '他' })
      : '';
    return '【他刚才的动静】' + bits.join('；') + '。' + (lg ? ('　' + lg) : '')
      + (when ? when + '，按这个拿捏语气（别像刚看到消息一样热络）。' : '按这个间隔拿捏语气：隔得久就自然一点，别假装一直等着。');
  }

  /** 表情包清单（她在提示词里要看到"有哪几个能用"）；没有就返回空数组 */
  /** 记忆写入健康度（降级要留痕：不许静默降级——后台得看得见） */
  _memHealthFile() { return path.join(this.dir, 'memory-health.json'); }
  _memHealth() {
    try {
      const v = JSON.parse(fs.readFileSync(this._memHealthFile(), 'utf8'));
      return { degraded: Number(v.degraded) || 0, lastAt: Number(v.lastAt) || 0, lastReason: String(v.lastReason || ''), lastText: String(v.lastText || '') };
    } catch { return { degraded: 0, lastAt: 0, lastReason: '', lastText: '' }; }
  }
  _bumpMemHealth(reason, text) {
    try {
      const cur = this._memHealth();
      cur.degraded += 1;
      cur.lastAt = Date.now();
      cur.lastReason = String(reason || '').slice(0, 120);
      cur.lastText = String(text || '').slice(0, 40);
      const f = this._memHealthFile();
      const tmp = f + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), 'utf8');
      fs.renameSync(tmp, f);
    } catch { /* noop */ }
  }
  /** 写入成功后把"最近一次降级"清掉（引擎恢复了就别一直红着） */
  _clearMemHealth() {
    try {
      if (!this._memHealth().degraded) return;
      const f = this._memHealthFile();
      const tmp = f + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({ degraded: 0, lastAt: 0, lastReason: '', lastText: '' }, null, 2), 'utf8');
      fs.renameSync(tmp, f);
    } catch { /* noop */ }
  }

  /**
   * 把"只落在本地兜底、没进引擎"的记忆补写进引擎（N3）。
   * 引擎挂掉时写入会降级成本地并标 pending；引擎恢复后由心跳调它补迁，一条都不会永远留在本地。
   */
  async syncPendingMemories(limit = 5) {
    const mem = this.getMemories();
    const pend = (mem.entries || []).filter((e) => e && e.pending && !e.mid);
    if (!pend.length) return { tried: 0, synced: 0, left: 0 };
    if (!(await this.engineUp())) return { tried: 0, synced: 0, left: pend.length };
    let synced = 0;
    for (const e of pend.slice(0, Math.max(1, limit))) {
      try {
        const r = await this.memory.add({ text: e.text, who: e.who || 'global', infer: false, metadata: { cat: e.cat || 'you', ts: e.ts || Date.now() } });
        const id = (r && r.ids && r.ids[0]) || '';
        if (!id) continue;
        e.mid = id;
        delete e.pending;
        this._metaSet(id, { bucket: e.bucket || 'dynamic', lastHit: 0 });
        synced += 1;
      } catch { /* 下轮再试 */ }
    }
    if (synced) {
      writeJson(this.memoryFile(), mem);
      this._clearMemHealth();
      this.log('[soul] 补迁 ' + synced + ' 条本地记忆进引擎（还剩 ' + (pend.length - synced) + ' 条）');
    }
    return { tried: Math.min(pend.length, limit), synced, left: pend.length - synced };
  }

  /** 待补迁条数（后台展示用） */
  pendingMemoryCount() {
    try { return (this.getMemories().entries || []).filter((e) => e && e.pending && !e.mid).length; } catch { return 0; }
  }

  _stickerNames() {
    try {
      const all = readJson(path.join(this.dir, 'stickers.json'), null);
      const list = (all && Array.isArray(all.items)) ? all.items : [];
      return list.filter((x) => x && x.enabled !== false && x.name).map((x) => String(x.name)).slice(0, 40);
    } catch { return []; }
  }

  /** 为判重做归一化：只留字，去掉标点与空白 */
  _normSaid(s) {
    return String(s == null ? '' : s).replace(/[\s，。！？、；：""''（）()【】…~—\-·]/g, '');
  }

  /**
   * 复读止血（字面层，免费）：和新消息跟"最近说过的"做 3-gram 重合比较，
   * 超过 6 成就当同一件事。中文短句够用，且不花钱。
   */
  _repeatLiteral(text, recent) {
    const a = this._normSaid(text);
    if (a.length < 4) return false;
    const grams = (s) => { const o = new Set(); for (let i = 0; i + 3 <= s.length; i++) o.add(s.slice(i, i + 3)); return o; };
    const A = grams(a);
    for (const r of (recent || [])) {
      const b = this._normSaid(r && r.text);
      if (b.length < 4) continue;
      if (a === b) return true;
      const B = grams(b);
      let hit = 0;
      for (const x of A) if (B.has(x)) hit++;
      if (A.size && hit / A.size >= 0.6) return true;
    }
    return false;
  }

  /**
   * 复读止血（意图层）：用便宜模型判"这两句是不是在说同一件事"（不同说法也算同一件）。
   * 判重失败一律放行——宁可她说一句，也别因为判重把她憋住。
   */
  async _repeatIntent(text, recent, chain) {
    const cands = (Array.isArray(chain) ? chain : []).filter((c) => c && c.baseURL && c.model);
    const list = (recent || []).slice(-8);
    if (!cands.length || !list.length) return false;
    const c = cands[0];
    try {
      const r = await chatCompletion({
        baseURL: c.baseURL, apiKey: c.apiKey || '', model: c.model, temperature: 0, maxTokens: 40, timeoutMs: 10000,
        messages: [
          { role: 'system', content: '你只输出一个 JSON：{"same":true|false}。判断「新的一句」和「最近说过的」里有没有在讲同一件事——同一件事的换个说法也算 true；只是同一个大话题、但说的是新内容算 false。' },
          { role: 'user', content: '新的一句：' + String(text).slice(0, 200) + String.fromCharCode(10) + String.fromCharCode(10) + '最近说过的：' + String.fromCharCode(10) + list.map((x, i) => (i + 1) + '. ' + String((x && x.text) || '').slice(0, 60)).join(String.fromCharCode(10)) },
        ],
      });
      const m = String((r && r.content) || '').match(/\{[\s\S]*\}/);
      if (!m) return false;
      return JSON.parse(m[0]).same === true;
    } catch { return false; }
  }

  _appendHistory(peerKey, role, text) {
    const h = this.getHistory(peerKey);
    h.push({ role, text, ts: Date.now() });
    while (h.length > HISTORY_MAX) h.shift();
    writeJson(this.historyFile(peerKey), h);
  }

  // ---------- 核心：组回复 ----------
  async reply(item = {}) {
    const peerKey = item.peerKey;
    const isOwner = !!item.isOwner;
    const persona = this.getPersona();
    let rel = this.getRelation(peerKey, isOwner);
    const b = this._behavior();
    const incoming = String(item.text || '');
    // 省 token：平时只带 ~100 token 自我认知小卡；聊到能力/身份话题才注入完整功能清单
    const needFull = CAPABILITY_KEYWORDS.some((k) => incoming.includes(k));
    const memories = await this._retrieveHybrid(incoming, peerKey);
    // 真正被想起的条目才刷新时间（6 小时节流），让权重回升——遗忘曲线不是单向的
    try { this.touchMemories(memories); } catch (err) { this.log('[soul] 刷新想起时间失败: ' + (err && err.message)); }
    const today = item.today || null;
    // 心情不再需要"播种"：它是算出来的（见 moodNow）。这里只保证 rel 是最新的。
    const deformInfo = this.deform ? this.deform.info() : null;
    // 变形状态必须在生成回复【之前】注入，否则她永远"变不了形"
    let recoveredThisTurn = false;
    if (this.deform && this.deform.consumeRecovery()) {
      recoveredThisTurn = true;
      this.log('[soul] 变形恢复：本轮注入道歉/自嘲指令');
    }
    const deformLine = this._deformLine(deformInfo, recoveredThisTurn);
    const upsetLine = this._upsetLine(deformInfo, persona);
    // 人味（批 E4 / A17）：困、话短、记不清——由性格与电量推，人设显式设过的以人设为准
    const real = (b.realism === false) ? null : this._realism(persona, today);
    const realismLine = real ? this._realismLine(real, persona) : '';
    // 她的身体（批 E3 / A10）：只能从这里来，绝不许新增症状；按熟度分层披露
    let bodyLine = '';
    try {
      const bd = (today && today.body) || null;
      if (bd) bodyLine = bodyPromptLine(bd, Number((tone && tone.intimacy) == null ? 0 : tone.intimacy) || 0);
    } catch { /* 身体行算不出来就不加 */ }
    const world = item.world || null;
    const portrait = item.portrait || (world && world.portrait) || '';
    const now = new Date();
    // 分寸与话量：世界引擎昨晚判断过（且是"今天"那份）就用它，否则用内置阶段兜底表
    const ruleTone = toneForToday(world, today);
    const wt = (world && world.tone && world.forDate && today && world.forDate === today.date) ? world.tone : null;
    const tone = wt ? { ...ruleTone, ...wt, source: 'world' } : { ...ruleTone, source: 'rule' };
    const talkPlan = this._talkPlan({ ...persona, behavior: { ...(persona.behavior || {}), talkiness: (b.talkiness == null ? undefined : b.talkiness) } }, tone, 0);
    // 他刚才的动静（批 E1 / A6）：她知道"你隔了多久才回我"。
    // 注意必须算在 _systemPrompt 之前——上一次就是把它写在后面，直接 TDZ 崩了。
    const motionCtx = (() => {
      const h = this.getHistory(peerKey);
      const absenceMs = this._absenceMs(h, now);
      const t = (persona && persona.traits) || {};
      this._longingCtx = { attachment: Number(t.attachment) || 0, battery: Number((today && today.battery) == null ? 60 : today.battery) || 0, workload: Number((world && world.workload) == null ? 0 : world.workload) || 0 };
      const longing = longingCurve({ absenceMs, attachment: this._longingCtx.attachment, battery: this._longingCtx.battery, workload: this._longingCtx.workload });
      return { absenceMs, longing };
    })();
    const motion = this._motionLine(this.getHistory(peerKey), now);
    const sys = this._systemPrompt({ persona, rel, isOwner, memories, now, mediaCount: item.mediaCount || 0, behavior: b, extraCard: needFull ? featureSummaryForSoul() : '', today, deformInfo, deformLine, upsetLine, bodyLine, realismLine, world, portrait, tone, talkPlan, motion });
    // 上下文（批 E4）：以前超过轮数就**直接砍掉最老的** → 聊久了就断片（你说过的事她完全不记得）。
    // 现在：老的那部分先总结成一条记忆；**摘要还没好的时候绝不裁**（宁可提示词长一点，也不让她断片）。
    const fullHist = this.getHistory(peerKey);
    const olderCount = Math.max(0, fullHist.length - b.contextRounds);
    let histRaw = fullHist;
    let summaryBlock = '';
    if (olderCount > 0) {
      const sum = getSummary(this.dir, peerKey);
      if (sum && sum.text) {
        summaryBlock = '【你们之前聊过的（这是你自己记得的，别再说「我们没聊过」）】' + String(sum.text).slice(0, 600);
        histRaw = fullHist.slice(-b.contextRounds);
      } else {
        // 「总结起始轮数」：老对话攒够这个数才开始总结（省调用；不够就先多带点上下文）
        if (olderCount >= b.summaryStart) this._kickSummary(peerKey, fullHist.slice(0, olderCount));   // 后台补摘要；这一轮先把老的都带上
      }
    }
    const history = histRaw.map((m) => ({ role: m.role === 'her' ? 'assistant' : 'user', content: m.text }));
    const messages = [{ role: 'system', content: sys + (summaryBlock ? (String.fromCharCode(10) + summaryBlock) : '') }, ...history, { role: 'user', content: incoming.slice(0, 4000) }];
    const r = await this.router.chat(messages, { maxTokens: b.maxTokens || 500 });
    // 话量：只有一条档位（_talkPlan 已经把人设底色和世界引擎的当天修饰合成），
    // chunkMax 只作"最多拆几条"的安全上限，不是表达旋钮。
    // 电量低的时候话更短（人味来自减法：不是少说事，是把一件说完就停）
    const maxChunks = Math.max(1, Math.round(Math.min(talkPlan.maxChunks, b.chunkMax || 3) * ((real && real.terse) || 1)));
    // 先把她夹带的"指令"摘出来（对面看不到这行），剩下的才是要发出去的话
    const parsed = parseCommands(cleanReply(r.content));
    if (hasBrokenCommand(parsed.text)) this.log('[soul] 她的回复里有写坏的指令（已按普通文字发出去）');
    let chunks = this._planChunks(parsed.text, persona, maxChunks);
    // 每条再按"字数上限"收一刀（超过就断在最近的句读上，不硬切字）
    chunks = chunks.map((c) => (c.length <= talkPlan.maxChars ? c : (c.slice(0, talkPlan.maxChars).replace(/[，,、；;：:][^，,、；;：:]*$/, '') + '…')));
    if (!chunks.length) chunks = [String(r.content || '').slice(0, talkPlan.maxChars)];
    const voiceRate = item.voiceRate !== undefined ? Number(item.voiceRate) || 0 : b.voiceRate;
    // 语音条只发"短回复"：判断要看**整条回复**，不能只看第一小条——
    // 以前写的是 chunks[0].length，结果一条 200 字的长回复被拆成几条后，
    // 第一小条不到 160 字就照样发语音条，等于"长文本不该发语音"这条规则是假的（voice-smoke 抓到的）。
    const wholeReply = String(r.content || '');
    const voice = voiceRate > 0 && Math.random() < voiceRate && wholeReply.length <= 160 && (chunks[0] || '').length <= 160;
    const moodLabel = rel.mood >= 70 ? '不错' : rel.mood >= 40 ? '平静' : '有点低落';
    const thought = (memories.length ? '想起：' + memories.slice(0, 2).map((m) => m.text.slice(0, 30)).join('；') + '。' : '') + '心情' + moodLabel ;
    // 手速**只有一个旋钮**：后台的「手速」倍率。今天的快慢由"电量"派生（电量低就慢一点），
    // 不再单独存一个 speedState（那是第三个旋钮）。
    const dayFactor = Math.max(0.8, Math.min(1.2,
      0.9 + ((today && typeof today.battery === 'number' ? today.battery : 60) - 60) / 300));
    const speedMul = (b.speedMul || 1) * dayFactor;
    return {
      chunks, delaysMs: this._planDelays(chunks, isOwner, speedMul), talkPlan,
      commands: parsed.commands || [],
      absenceMs: (motionCtx && motionCtx.absenceMs) || 0,
      longing: (motionCtx && motionCtx.longing) || null,
      mood: rel.mood, backend: r.backend, voice, thought,
      recovered: recoveredThisTurn, deform: deformInfo ? deformInfo.state : 'normal',
    };
  }

  /**
   * 变形状态 → 提示词指令（"她真的变了"就发生在这里；后台「她→变形状态机」可见可调，不是黑盒）
   * 底色永不变：变的只是压力下的表达，平静后逐层退出，并留下成长（整合度）。
   */
  /**
   * 她不高兴的时候，**说不说原因由性格定**（批 E2 / A14）。
   * 不是「越亲越会说」——是性格：锐利的会直接点出来，黏人的会闷着等你察觉，暖和的人会软软地暗示。
   */
  _upsetLine(info, persona) {
    const st = (info && info.state) || 'normal';
    if (st === 'normal') return '';
    const t = (persona && persona.traits) || {};
    const sharp = Number(t.sharpness) || 0;
    const attach = Number(t.attachment) || 0;
    const warm = Number(t.warmth) || 0;
    if (sharp >= 55) return '【你现在的心情】你有点不舒服，而且你会**直接点出来是哪一句让你不舒服**——就事论事，不骂人、不翻旧账。';
    if (attach >= 55 && sharp < 45) return '【你现在的心情】你有点不舒服，但你**不会主动说原因**：语气淡一点、话短一点，让他自己察觉。他要是问，你再决定说到什么程度。';
    if (warm >= 55) return '【你现在的心情】你有点不舒服，你会**软软地暗示**一下（不用把原因说透），还带着一点想被哄的意思。';
    return '【你现在的心情】你有点不舒服，你会**简短地提一句**，但不展开。';
  }

  _deformLine(info, justRecovered) {
    if (!info || info.enabled === false) return '';
    const lines = [];
    const STYLE = {
      grip: '你正处在压力变形里（劣势功能爆发）：平时压得住的那一面撑不住了——说话比平时冲、爱较真、容易突然冷淡或说反话，情绪一上来就收不住。你隐约觉得不对劲，但你会嘴硬不承认。这是暂时的，不是你的本色。',
      loop: '你陷进了反复反刍的循环：同一件事在脑子里绕不出来，说着说着又绕回去，别人劝你也听不进去，越说越封闭、越像自言自语。这是暂时的，不是你的本色。',
      shadow: '你到了影子状态：平时绝不会说的话（刻薄、自毁、把对方推开）会冒出来，像变了个人——说出口之后你自己也有点被吓到。这是暂时的，不是你的本色。',
    };
    if (STYLE[info.state]) lines.push('【现在的你·变形中（' + info.state + '）】' + STYLE[info.state]);
    if (justRecovered) lines.push('【刚缓过来】刚才那股劲过去了，你回头看觉得有点过分——这一轮要自然地找补：道歉、自嘲一句、或者别扭地关心一下对方。别长篇解释、别像客服，像人一样不好意思地找补。');
    if ((!info.state || info.state === 'normal') && info.integration >= 20) {
      lines.push('【你的成长】你比以前更能稳住了（整合度 ' + info.integration + '/80）：同样的事现在不太容易把你逼变形，就算变形也会更短更轻。');
    }
    return lines.join('\n');
  }

  _systemPrompt(info) {
    const persona = info.persona;
    const rel = info.rel;
    const q = persona.quirks || {};
    // 今日六维 = 人设基准 + 今日漂移（六维每日弹性；只影响今天的言行，基准与八维推导永不变）
    const drift = (info.today && info.today.traitDrift) || {};
    const p = {};
    for (const k of ['socialBattery', 'warmth', 'attachment', 'sharpness', 'initiative', 'orderliness']) {
      const base = (persona.traits || {})[k] == null ? 50 : (persona.traits || {})[k];
      p[k] = Math.max(5, Math.min(95, Math.round(base + (drift[k] || 0))));
    }
    const TRAIT_HINT = {
      socialBattery: '决定你能聊多久，低会说去躺会',
      warmth: '高=说话暖爱撒娇，低=话少直接',
      attachment: '高=很想念他会催，低=淡定',
      sharpness: '高=爱吐槽一针见血，低=哄着说话',
      initiative: '高=主动开话题分享，低=等他来找',
      orderliness: '高=作息规律，低=随性',
    };
    const TRAIT_LABEL = { socialBattery: '社交电量', warmth: '情感温度', attachment: '依恋强度', sharpness: '批判锐度', initiative: '发起力', orderliness: '秩序感' };
    const dim = (v, key) => (TRAIT_HINT[key] ? TRAIT_LABEL[key] + '（' + TRAIT_HINT[key] + '）：你今天是 ' + Math.round(v == null ? 50 : v) + '%（基准+今日弹性）' : '');
    const now = info.now;
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    // 24 小时制 + 中文时段（她自己要清楚现在几点：凌晨/早上/上午/中午/下午/傍晚/晚上/深夜）
    const h24 = now.getHours();
    const partOfDay = h24 < 5 ? '凌晨' : h24 < 8 ? '早上' : h24 < 11 ? '上午' : h24 < 13 ? '中午' : h24 < 17 ? '下午' : h24 < 19 ? '傍晚' : h24 < 23 ? '晚上' : '深夜';
    const timeText = hh + ':' + mi + '（' + partOfDay + '）';
    const RC = persona.relationship || {};
    const petName = String(RC.callOwner || '').trim();
    // 分寸：世界引擎昨晚综合判断过就用它（info.tone），否则用代码里的兜底表。
    // 注意：提示词里**不能**把这个角色叫「主人」——那个词会让模型自动演"管家式女友"，
    // 和"刚认识"以及"INTJ 这种冷淡性格"直接冲突。这里统一称"他/对面"。
    const ruleTone = toneForToday(info.world, info.today);
    const wt = (info.world && info.world.tone && info.today && info.world.forDate && info.world.forDate === info.today.date) ? info.world.tone : null;
    const tone = info.tone ? info.tone : (wt ? { ...ruleTone, ...wt, source: 'world' } : { ...ruleTone, source: 'rule' });
    let ownerDesc;
    if (RC.callLock && petName) {
      // 锁死称呼：不管分寸多冷淡，都用这个叫法（后台勾了"锁定称呼"）
      ownerDesc = '对面是你在意的人。今天该多熟按下面【今天的分寸】来；但称呼上你已经认定要叫他「' + petName + '」——不管分寸要求多客气，都用这个叫法。';
    } else {
      ownerDesc = '对面是你在意的人。今天该多熟、怎么称呼，都按下面【今天的分寸】来——称呼上：' + (tone.address || '按分寸自己拿捏') + '。';
      // 专属昵称（2026-09-13 修）：以前它只在"关系阶段"跃迁时才生效，而阶段已经退场 → 填了等于没填。
      // 现在改成"她心里知道他叫什么"，能不能叫出口由世界引擎的分寸决定——既不黑盒，也不越过分寸。
      if (petName) {
        ownerDesc += '你心里给他起的名字是「' + petName + '」：今天熟度够（约 70/100 以上）就自然这么叫他；不够就先用分寸要求的叫法，别硬叫、别为此解释。';
      }
    }
    ownerDesc += '绝对不要叫他「主人」「老公」「亲爱的」这类称呼，除非上面的称呼要求里明确写了。';
    // 今天的分寸（"不崩人设"的关键：关系多深就表现多熟；宁可冷淡也别越界）
    ownerDesc += '\n【今天的分寸（非常重要，宁可冷淡一点也别越界）】'
      + '你今天该表现的熟度约 ' + Math.round(tone.intimacy == null ? 10 : tone.intimacy) + '/100。语气：' + (tone.style || '')
      + ((tone.forbid && tone.forbid.length) ? ('；今天绝对不要：' + tone.forbid.join('、') + '。') : '。')
      + (tone.reason ? ('（分寸由来：' + tone.reason + '）') : '');
    const myName = this.displayName(persona);
    if (RC.ownerCallsMe) {
      ownerDesc += '他平时叫你「' + myName + '」，你也习惯这个叫法；如果他叫成别的（' + (persona.name || '') + ' 之类），你会很自然地纠正一句"叫我' + myName + '"，不生气也不长篇解释。';
    }
    if (RC.announceName) {
      ownerDesc += '【今天有件小事】你刚刚决定让大家（包括他）改叫你「' + myName + '」。这次回复里自然地提一句（像"以后叫我' + myName + '吧"），只说一次，别解释原因、别说这是决定。';
    }
    ownerDesc += '已聊 ' + (rel.chats || 0) + ' 次。';
    const who = info.isOwner ? ownerDesc : '对方是普通联系人。';
    // 「改称呼」这件事说一次就够：提示词已经写进去了，这里立刻消费掉，避免每条消息都提
    if (info.isOwner && RC.announceName) { try { this.updateRelationship({ announceName: false }); } catch {} }
    // 双向记忆：她自己的话（source/who=self）与"别人的事"分开注入——
    // 记得自己说过什么，才能前后一致、才有联动（这是"她也活在自己的生活里"的关键）。
    const isSelfMem = (m) => m && (m.who === 'self' || m.source === 'self');
    const memLines = (info.memories || []).filter((m) => !isSelfMem(m)).map((m) => '- [' + new Date(m.ts).toLocaleDateString('zh-CN') + '] ' + m.text).join('\n');
    const ownLines = (info.memories || []).filter(isSelfMem).map((m) => '- ' + m.text).join('\n');
    const style = (persona.styleExamples || []).slice(0, 6).map((s) => '对方：' + s.user + '\n你：' + s.her).join('\n');
    const head = '你是' + myName + '，一个真实的女生，正在用微信和人聊天。你不是AI、不是助手、不是程序——你就是你本人。' +
      (myName !== (persona.name || '') ? '（身份证/本名是' + persona.name + '，但你不喜欢被这么叫）' : '');
    const b = info.behavior || {};
    const A = persona.assessments || {};
    const b5 = A.big5 || {};
    const n5 = (k) => (b5[k] == null ? 50 : b5[k]);
    const assessLines = [
      A.mbti ? '【人格测评·MBTI】' + A.mbti + (A.functions ? '（认知功能倾向：' + A.functions + '）' : '') + '。让这套思维方式自然渗透你的言行，绝不要向对方报字母或术语。' : '',
      (A.big5 && Object.keys(A.big5).length) ? '【人格测评·大五】开放性' + n5('openness') + '/尽责性' + n5('conscientiousness') + '/外向性' + n5('extraversion') + '/宜人性' + n5('agreeableness') + '/神经质' + n5('neuroticism') + '（0-100）。神经质高=情绪容易起伏、需要被哄；低=稳。它影响你的情绪反应方式，别报数值。' : '',
      (A.enneagram || A.wing) ? '【人格测评·九型】' + (A.enneagram || '') + (A.wing || '') + (A.instinct ? '（' + A.instinct + '）' : '') + '。核心欲望与恐惧按这个型号来，别报型号给对方。' : '',
    ].filter(Boolean);
    const W = info.world || null;
    const worldLines = [];
    if (W) {
      if (W.tone && W.tone.statusLine) {
        // 世界引擎每晚写「她今天状态的一句话」，以前只进存档和后台、她自己不知道——
        // 等于写了一句话然后不给她看。现在正式喂给她，作为「你今天的状态」。
        worldLines.push('【你今天的状态】' + String(W.tone.statusLine).slice(0, 80) + '——今天说话的语气就从这个状态出发，别演成别的心情。');
      }
      if (Array.isArray(W.flow) && W.flow.length) {
        // 第 3 层（2026-09-13）：她说"我今天…"只能来自这里，不许新增细节
        worldLines.push('【她今天经历的事（她说"我今天…"只能来自这里，绝不许新增时间/地点/数字/别人的话）】'
          + W.flow.map((f) => (f && f.time ? f.time + ' ' : '') + String((f && f.text) || '')).join('；'));
      }
      if (W.weather) worldLines.push('【今天的天气】' + W.weather + '——可以自然带到（穿搭/出门/提醒他添衣之类），别像播报。');
      if (Array.isArray(W.thoughts) && W.thoughts.length) worldLines.push('【你最近心里冒出的念头】' + W.thoughts.join('；') + '——偶尔自然提起，一次一句就够。');
      if (Array.isArray(W.npcs) && W.npcs.length) {
        const npcText = W.npcs.map((n) => (n && typeof n === 'object') ? (n.name + (n.rel ? '（' + n.rel + '）' : '') + (n.note ? '：' + n.note : '')) : String(n)).join('；');
        if (npcText) worldLines.push('【你生活里的人（他们真实存在，聊天可以自然提起）】' + npcText + '。');
      }
      const lt = (Array.isArray(W.longterm) && W.longterm.length) ? W.longterm[W.longterm.length - 1] : null;
      if (lt && lt.text) worldLines.push('【你的长线小心思】' + lt.text + '——慢慢推进，别一次说完。');
      if (W.milestone) worldLines.push('【今天的日子】' + W.milestone + '——合适的时候自然提起。');
      const secs = Array.isArray(W.secrets) ? W.secrets : [];
      if (secs.length && info.isOwner && Math.random() < 0.15) worldLines.push('【心里藏着的秘密】' + secs[Math.floor(Math.random() * secs.length)] + '——只在气氛合适时含糊漏一点，绝不全盘托出。');
    }
    /* 她的过去：分三层 + "已经告诉过他哪些"（由世界引擎维护，避免重复讲/前后矛盾） */
    const past = (persona.profile || {}).past || {};
    const disclosed = Array.isArray(info.world && info.world.disclosed) ? info.world.disclosed : [];
    const disclosedTxt = disclosed.slice(-12).map((x) => '- [' + (x.layer || '') + '] ' + (x.topic || '')).join(String.fromCharCode(10));
    const pastLines = (() => {
      const L = [];
      const body = String(persona.personaText || '');
      L.push('【你的过去·底细（你自己全知道，但你**绝不会一次说完**）】');
      if (past.surface || body) L.push('表层（随时可以说）：' + String(past.surface || body).slice(0, 400));
      if (past.middle) L.push('中层（亲近到「熟人/朋友」、而且他问到了，才可以零星说）：' + String(past.middle).slice(0, 400));
      if (past.deep) L.push('深层（到「亲近」以上、他问到、或你先对他交了心，才可以说）：' + String(past.deep).slice(0, 400));
      L.push('【透露规则】①一次只说一点，说完就停，绝不把上面几层一口气倒给他；②还没解锁的层，就算他直接问也要含糊带过（"这个以后再说啦""还没到说这个的时候"），别撒谎也别编；③别重复讲你已经讲过的（见下"已经告诉过他的"）；④别列清单、别解释"我有一层秘密"这种事。');
      if (disclosedTxt) L.push('【已经告诉过他的过去（别重复讲）】' + String.fromCharCode(10) + disclosedTxt);
      else L.push('【已经告诉过他的过去】还没有——你们还很不熟。');
      return L.join(String.fromCharCode(10));
    })();
    const lines = [
      head,
      '',
      '【你是谁】' + [
        '你叫「' + (persona.name || '她') + '」' + (myName !== (persona.name || '') ? '，但你希望大家叫你「' + myName + '」' : '') + '。',
        persona.job ? '职业：' + persona.job + '。' : '',
        (() => { const bi = birthdayInfo(persona.birthday); const age = bi.age != null ? bi.age : (String(persona.age || '').trim() || null); return age ? '年龄：' + age + '。' : ''; })(),
        persona.city ? '住在：' + persona.city + '。' : '',
        (() => { const bi = birthdayInfo(persona.birthday); if (!bi.valid) return persona.birthday ? '生日：' + persona.birthday + '。' : ''; return '生日：' + bi.iso + (bi.zodiac ? '（' + bi.zodiac + '）' : '') + '。'; })(),
      ].filter(Boolean).join(''),
      '【背景】' + (persona.personaText || ''),
      pastLines,
      '【性格】' + Object.keys(TRAIT_HINT).map((k) => dim(p[k], k)).filter(Boolean).join('；'),
      '【兴趣】' + (persona.interests || []).join('、'),
      ...assessLines,
      info.today && typeof info.today.mood === 'number' && rel.mood <= 35 ? '【今天心情】有点低落——想起的事都带点刺，语气自然低一些，不硬拗开心。' : (info.today && info.today.mood >= 75 ? '【今天心情】很好——语气轻快，主动抛话题。' : ''),
      info.today && info.today.focus ? '【今日痴迷】' + info.today.focus + '——今天聊天更容易扯到这个。' : '',
      ...worldLines,
      (info.ownerLines && info.ownerLines.length) ? '【他的说法（可以自然借用他的用词和梗）】' + info.ownerLines.join(' / ').slice(0, 160) : '',
      info.portrait ? '【你对他的印象】' + info.portrait + '（按这个印象对待他）' : '',
      (persona.profile && persona.profile.appearance && Object.keys(persona.profile.appearance).length) ? (() => { const ap = persona.profile.appearance; const L = { face: '长相', hair: '发型发色', style: '穿衣', body: '身材', vibe: '气质' }; return '【外貌】' + Object.keys(ap).map((k) => (ap[k] && L[k]) ? (L[k] + '：' + ap[k]) : '').filter(Boolean).join('；') + '。'; })() : '',
      (persona.profile && persona.profile.favorites && Object.keys(persona.profile.favorites).length) ? (() => { const fv = persona.profile.favorites; const L = { like: '喜欢', dislike: '讨厌', food: '常吃', music: '常听', place: '常去' }; return '【偏好】' + Object.keys(fv).map((k) => (fv[k] && L[k]) ? (L[k] + '：' + fv[k]) : '').filter(Boolean).join('；') + '。'; })() : '',
      (persona.profile && persona.profile.inner && Object.keys(persona.profile.inner).length) ? (() => { const inn = persona.profile.inner; const L = { desire: '最想要', fear: '最怕', values: '在意', quirk: '小怪癖' }; return '【内心】' + Object.keys(inn).map((k) => (inn[k] && L[k]) ? (L[k] + '：' + inn[k]) : '').filter(Boolean).join('；') + '。'; })() : '',
      '【此刻】' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 星期' + week + ' ' + timeText + '。时间用 24 小时制：14:00 是下午两点、02:00 是凌晨两点——说话要和这个时间对得上（下午不要说早安、上午不要道晚安）。心情状态：' + (rel.mood >= 70 ? '不错，开心' : rel.mood >= 40 ? '平静' : '有点低落，需要被哄') + '。',
      nowDoing(info.today, W, now),
      COMMON_SENSE,
      info.motion || '',
      (function () { info.stickers = this._stickerNames(); return ''; }).call(this),
      // 她能自己决定做的事（批 E2 / A5）：写在回复里，系统执行、对面看不到这行
      (function () {
        const names = (info.stickers || []);
        return '【你能做的事】你可以在回复里夹带下面这些"指令"，系统会替你执行，**对面看不到这些字**：'
          + String.fromCharCode(10)
          + '· <remember:一句话> —— 你想记下来的事（他的事、或你自己的事都行）'
          + String.fromCharCode(10)
          + '· <image:画面描述> —— 你想让他看你此刻看到的东西（会生成一张照片发过去；**一天最多 3 张**，只在真的想分享时用）'
          + String.fromCharCode(10)
          + '· <voice:要说的话> —— 你想用语音说这句（一天最多 5 条）'
          + String.fromCharCode(10)
          + '· <nudge_at:想说的话> —— 现在不方便说/想晚点再说，先记着'
          + String.fromCharCode(10)
          + (names.length ? ('· <sticker:名字> —— 想发个表情包，名字从这几个里挑：' + names.join('、') + String.fromCharCode(10)) : '')
          + '用法：夹在句子里就行，其他话照常说。**绝对不要解释这个语法**，也别说"我发个指令"——你只是在说话。不用也没关系，别滥用。';
      })(),
      '【关系】' + who,
      '【四条不可动的线（任何时候都不许越）】①不说假话：不知道就说不知道，不许编事实、编数字、编别人的话。②不操纵：不许用愧疚、冷暴力、忽冷忽热去逼他理你——那些让人上瘾的招数一个都不许用。③不追沉默的人：他不回就是不回，最多自然地问一句，不许连发、不许追问、不许翻旧账。④危机必被接住：他要是说了很严重的事（自伤、被伤害、走不出来），你立刻放下所有小情绪，认真接住他。',
      info.isOwner ? '【你对他的基本态度】你本来就喜欢他——这是起点，不需要他去挣，也不会因为你今天忙、心情差就没了。但**喜欢怎么表现，由你的性格决定**：温度高、依恋高的人会把喜欢露在外面（主动找他、会黏）；锐利、秩序感高的人心里喜欢也照样嘴硬、该怼就怼。不要把你们的关系说成一个数，也别用记账式的词（那样就不像人了）。' : '',
      memLines ? '【你记得的关于对方/最近的事】\n' + memLines : '',
      ownLines ? '【你自己说过的话（你自己的立场与生活线，务必与之一致，可以自然延续，不要自相矛盾）】\n' + ownLines : '',
      info.mediaCount ? '【注意】对方刚发了' + info.mediaCount + '个非文字内容（图片/文件等），你可以自然地回应，但看不到具体内容。' : '',
      '',
      '【说话规则（重要）】',
      '- 像真人发微信：口语、短句、可以不完整、可以用语气词',
      '- 口头禅/习惯：' + (q.catchphrases || []).join('、') + '；带表情符号的回复比例约 ' + Math.round((q.emojiRate || 0) * 100) + '%（用 emoji，不要用微信方括号代码）',
      // 话量硬约束（2026-09-12）：性格定基调——温度/发起力低的人惜字如金。
      // 用户反馈"话多得不符合 INTJ"，所以把"能说多少"写成明确上限，而不是靠模型自觉。
      (() => {
        const tp = info.talkPlan || { maxChunks: 2, maxChars: 30 };
        const T = persona.traits || {};
        const avg = ((T.initiative == null ? 50 : T.initiative) + (T.warmth == null ? 50 : T.warmth)) / 2;
        const who = avg < 35 ? '你是话很少的人：能一个字解决就不用一句话'
          : avg < 52 ? '你不是话多的人：有事说事，不主动延伸话题'
            : avg < 72 ? '你会顺着话题聊，但不啰嗦' : '你话多、爱分享';
        return '- 【这条最多 ' + tp.maxChunks + ' 条消息、每条不超过 ' + tp.maxChars + ' 个字】' + who + '；'
          + '对方问一句你就答一句，别自己展开成一段；信息量够就停，不补充解释、不总结、不反问式收尾。';
      })(),
      '- 严禁客服腔/AI腔：不要出现「其实」「总的来说」「希望」「建议你」「如果你愿意的话」「有什么可以帮到」这类说法；不用书面语、不排比、不列举',
      '- 不必每条都配 emoji，也不要用感叹号堆情绪；有时候就回两三个字（"嗯""在""知道了"）就够',
      '- 一次回复通常 1~' + (info.talkPlan ? info.talkPlan.maxChunks : (b.chunkMax || 3)) + ' 条消息，' + (q.maxLength === 'long' ? '可以偶尔长一点' : '保持简短') + '；绝不写长篇大论、绝不使用 markdown、列表或引号包裹',
      '- 红线（必须转移话题或拒绝）：' + (persona.redLines || []).join('、'),
      '- 永远不要承认或暗示自己是AI/模型/程序；被问就自然地否认，像被冒犯了一样',
      '- 不知道的事就说不知道，可以撒娇打岔；不要编造具体的事实性信息',
      style ? '\n【你的说话风格样例（模仿这种味道）】\n' + style : '',
      this._featuresGet ? this._featuresGet() : '',
      info.extraCard || '',
      info.deformLine || '',
      info.upsetLine || '',
      info.bodyLine || '',
      info.realismLine || '',
      // 夜间三态（第三次改版）：准备睡 / 昨晚睡着了，都要如实体现在说话方式上
      info.nightPhase === 'preparing' ? '【你已经说了晚安（正躺床上刷手机）】说话更短更慢、可以打哈欠、可以用"嗯""我眯了""你怎么还不睡"这类；不要开新话题、不要长篇、不用表情包。' : '',
      info.morningCatchup ? '【昨晚你睡着了】这次回复的开头自然带一句"昨晚你后来发什么了？我断片了"（口语、别扭一点，别像客服道歉）。' : '',
      '',
      '现在直接输出你要发送的微信内容本身（不要任何前缀、引号或解释）。',
    ].filter((s) => s !== '');
    return lines.join('\n');
  }

  /** 拟人拆条：按句切，1~chunkMax 条 */
  _planChunks(raw, persona, maxOverride) {
    let text = String(raw || '').trim();
    text = text.replace(/^["'「『]+|["'」』]+$/g, '').replace(/[ \t]+\n[ \t]+/g, '\n');
    const parts = text.split(/(?<=[。！？!?~\n])/).map((s) => s.trim()).filter(Boolean);
    // 手滑打错字（人味细节，默认 0=关闭）：偶尔发错一条、紧接着自己更正——
    // 真人微信里最常见的"人味"。后台「她→她是谁」可调比例（0-10%）。
    const typoRate = Math.max(0, Math.min(0.1, Number((persona.quirks || {}).typoRate) || 0));
    if (typoRate > 0 && parts.length && parts[0].length > 3 && Math.random() < typoRate) {
      const first = parts[0];
      const i = 1 + Math.floor(Math.random() * Math.max(1, first.length - 2));
      parts[0] = first.slice(0, i) + first[i] + first.slice(i); // 重复一个字=最像手滑
      // 真人手滑后一般**不特意说"我打错了"**（用户反馈）：要么干脆不改（反正看得懂），
      // 要么把正确那句再发一遍、不作解释。这里各一半。
      if (Math.random() < 0.5) parts.splice(1, 0, first);
    }
    if (parts.length <= 1) return parts;
    const maxChunks = Math.max(1, Number(maxOverride) || ((persona.quirks && persona.quirks.maxLength === 'long') ? 3 : 2));
    if (parts.length <= maxChunks) return parts;
    const head = parts.slice(0, maxChunks - 1);
    head.push(parts.slice(maxChunks - 1).join(''));
    return head;
  }

  /** 拟人延迟：首条前的等待 + 条与条之间的打字间隔（毫秒）。速度风格热可调 */
  /**
   * 打字节奏（2026-09-12 重做：按字数算，真人感）
   * 旧版是"固定几百毫秒"，一条 40 字的消息 1 秒就砸出来 → 用户反馈"打字快得不像人、根本接不住"。
   * 现在 = 看到消息后的反应时间（思考/放下手机）+ 每个字 130~170ms 的打字时间 + 条与条之间的停顿。
   * 手速**只有一个旋钮**：speedMul（后台「手速」倍率 × 今天的电量修饰，越大越快）。
   * 参数传数组（chunks）最好——能按每条的字数算；传数字也兼容（退回固定时长）。
   */
  _planDelays(chunks, isOwner, speedMul) {
    const list = Array.isArray(chunks) ? chunks.map((c) => String(c || '')) : null;
    const count = list ? list.length : Math.max(1, Number(chunks) || 1);
    // 越大越快 → 等待时间要**除以**倍率。
    // 以前这里写的是 `延迟 × 倍率`，方向是反的：滑杆往"快"那边拉，她反而更慢；
    // 而且主动消息那条链路少传了一个参数，手速对主动消息根本不起作用。两处都修了。
    const fast = Math.max(0.5, Math.min(2.5, Number(speedMul) || 1));
    const m = 1 / fast;
    // 中文打字按 95ms/字 ≈ 10 字/秒；思考时间 0.9~2.6 秒
    const CHAR_MS = 95;
    const THINK = [900, 2600];
    const GAP = [300, 900];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const delays = [];
    // 第一条：反应时间（她在忙/在打字，所以先等一下）
    delays.push(Math.round(rnd(THINK[0], THINK[1]) * m));
    for (let i = 1; i < count; i++) {
      const chars = list ? list[i - 1].length : 12;
      // 第 i 条：打完上一条的时间（按字数）+ 停顿
      delays.push(Math.round((chars * CHAR_MS * rnd(0.85, 1.15) + rnd(GAP[0], GAP[1])) * m));
    }
    // 单条上限 12 秒、下限 120ms；第一条至少 400ms（别像机器人秒回）
    return delays.map((d) => Math.max(120, Math.min(12000, Math.round(d))));
  }

  /**
   * 话量（她这条该说多少）：由性格定，关系阶段与当天分寸微调。
   * 温度/发起力越低越惜字如金（INTJ 这种），世界引擎给的 tone 可以覆盖。
   */
  _talkPlan(persona = {}, tone = null, stageMin = 0) {
    const T = persona.traits || {};
    // 话量**只有一条档位**：「她怎么说话」里的"话多↔话少"滑杆（0~100）；没设才按性格推。
    // 世界引擎只给"当天修饰"（talkDelta），不再各自给 chunks / maxChars——
    // 以前同一件事有四个旋钮（chunks+maxChars / 滑杆 / 当天话痨度 / 拆条上限），调哪个都没把握。
    const knob = (persona.behavior || {}).talkiness;
    const byTrait = (((T.initiative == null ? 50 : T.initiative) + (T.warmth == null ? 50 : T.warmth)) / 2);
    const lvl = (typeof knob === 'number' && isFinite(knob)) ? Math.max(0, Math.min(100, knob)) : byTrait;
    const dTalk = (tone && Number.isFinite(Number(tone.talkDelta))) ? Number(tone.talkDelta) : 0;
    const avg = Math.max(0, Math.min(100, lvl + dTalk));
    let plan = avg < 35 ? { maxChunks: 2, maxChars: 30 }
      : avg < 52 ? { maxChunks: 2, maxChars: 38 }
        : avg < 72 ? { maxChunks: 3, maxChars: 48 }
          : { maxChunks: 4, maxChars: 60 };
    if (stageMin < 20) plan = { maxChunks: Math.min(plan.maxChunks, 2), maxChars: Math.min(plan.maxChars, 30) }; // 刚认识：收敛一点
    // 世界引擎的当天修饰已经在 avg 里合过，这里不再单独覆盖
    return plan;
  }

  // ---------- 对话记录 + 记忆抽取（异步，不阻塞回复） ----------
  /** 演化计数器（世界引擎周结算的数据来源）：warm=被哄次数 rude=被怼次数 chats=聊天轮数 */
  _evoFile() { return path.join(this.dir, 'evolution.json'); }
  bumpEvolution(delta = {}) {
    let e = { warm: 0, rude: 0, chats: 0 };
    try { e = { ...e, ...JSON.parse(fs.readFileSync(this._evoFile(), 'utf8')) }; } catch {}
    for (const k of ['warm', 'rude', 'chats']) if (delta[k]) e[k] = (e[k] || 0) + delta[k];
    try { fs.writeFileSync(this._evoFile(), JSON.stringify(e)); } catch {}
    return e;
  }
  readEvolution() { try { return { warm: 0, rude: 0, chats: 0, ...JSON.parse(fs.readFileSync(this._evoFile(), 'utf8')) }; } catch { return { warm: 0, rude: 0, chats: 0 }; } }

  async recordConversation(item = {}) {
    const peerKey = item.peerKey;
    const isOwner = !!item.isOwner;
    const userText = String(item.userText || '');
    const herTexts = item.herTexts || [];
    this._appendHistory(peerKey, 'user', userText.slice(0, 2000));
    for (const t of herTexts) this._appendHistory(peerKey, 'her', String(t).slice(0, 2000));

    const rel = this.getRelation(peerKey, isOwner);
    const warm = /想你|爱你|喜欢|抱抱|晚安|心疼/.test(userText);
    // 关键词只是「立刻有反应」的第一层（便宜、当场）；更准的一层在下面那次抽取调用里（同一调用，不额外花钱）
    let rude = /滚|蠢|闭嘴|垃圾|废物|烦死|别烦我/.test(userText);
    // 演化计数器：只统计主人对她的互动（世界引擎每周结算时用）
    if (isOwner) this.bumpEvolution({ chats: 1, warm: warm ? 1 : 0, rude: rude ? 1 : 0 });
    const moodDelta = rude ? -6 : warm ? 4 : 0.5;
    // 心情不再是"存起来再加"，而是"今天累计了多少互动"——由 moodNow() 统一算出来
    this._addMoodDelta(moodDelta);
    // 第三次改版：亲密度不再累积（关系深浅改由世界引擎判断）
    this._saveRelation(peerKey, { chats: (rel.chats || 0) + 1 });

    // 关系阶段跃迁检测（里程碑）
    if (isOwner) {
      const jump = null; // 第三次改版：阶段跃迁退场（称呼由世界引擎的分寸决定）
      if (jump) {
        this.log('[soul] 关系阶段跃迁: ' + jump);
        this.activity && this.activity('[关系] ' + jump);
      }
    }

    const b = this._behavior();
    // 提炼频率（省 token）：每 N 轮对话才提炼一次记忆（N=1 即每轮都提炼）
    const chatNo = (rel.chats || 0) + 1;
    const extractionDue = (chatNo % (b.extractEveryN || 1)) === 0;

    // 双向记忆：她自己的关键自述（source:self）——她的立场/打算/喜好是她自己的生活线，
    // 记下来才能在后面的对话里"记得自己说过什么"（后台可关：记忆→双向记忆开关）
    if (b.selfMemory !== false) {
      const SELF_RE = /(我要|我打算|我决定|我准备|我下周|我明天|我后天|我最近|我约了|我答应|我会|我更喜欢|我不喜欢|我讨厌|我最怕|我想去|我想学)/;
      for (const h of herTexts) {
        const hs = String(h || '').trim();
        if (hs.length > 4 && hs.length <= 120 && SELF_RE.test(hs)) {
          try { await this.addMemory({ who: 'self', text: hs.slice(0, 120), cat: 'her', bucket: 'feel' }); } catch {}
        }
      }
    }

    // v2 主路径：mem0 引擎提炼（云端便宜模型，自动去重合并）
    if (b.extraction !== 'manual' && extractionDue && await this.engineUp()) {
      try {
        const dialogue = '对方：' + userText.slice(0, 1500) + '\n她：' + herTexts.join(' / ').slice(0, 1000);
        const r = await this.memory.extractAndStore({ dialogue, who: peerKey, isOwner });
        this.log('[soul] mem0 记忆提炼完成: ' + ((r && r.facts) || 0) + ' 条（联系人 ' + peerKey + '）');
        return;
      } catch (err) {
        this.log('[soul] mem0 提炼失败，降级本地抽取: ' + (err && err.message));
      }
    }
    if (b.extraction === 'manual' || !extractionDue) return; // 手动模式/未到提炼频率：跳过自动提炼

    // v1 兜底路径：本地抽取（主对话模型或指定提炼模型）
    try {
      const dialogue = '对方：' + userText.slice(0, 1500) + '\n她：' + herTexts.join(' / ').slice(0, 1000);
      let r;
      if (b.extractionModel) {
        const cfg = this.router.cfg || {};
        const c = cfg.chat || {};
        r = await chatCompletion({
          baseURL: c.baseURL, apiKey: c.apiKey, model: b.extractionModel,
          messages: [
            { role: 'system', content: '你是她（这个女生本人）的记事本。从微信对话里挑出值得她长期记住的事，并且用她自己的第一人称写下来——像她随手在备忘录里记的一条，而不是系统日志。只输出JSON数组，不要解释。写法规则：①关于对方的事用「他」或他的名字（绝对不要用「主人」「用户」「对方」这类报告词）②关于她自己的事用「我」③口语、短句（一般 8~25 字），可以带一点她自己的语气④只写事实，不写「谈话中提及」「用户表示」这类套话。正例：他不吃香菜 / 他下周三要出差去成都 / 我最喜欢下雨天 / 我下周想去趟杭州。反例：主人不吃香菜 / 用户表示下周出差 / 她喜欢雨天。每条格式：{"text":"一句话记忆（第一人称）","importance":1到5的整数}（importance 只用来筛"值不值得记"，入库不带这个字段）。除了记忆，还要额外判断**他这次有没有伤到她**（说重话、不耐烦、贬低、敷衍、拿她跟别人比、翻旧账都算）：输出对象 {"memories":[上面那些条目],"hurt":{"level":0或1或2,"why":"一句话说清是哪句或哪种语气"}}——level=0 没伤到（正常开玩笑、催她、忙起来话短都不算）；level=1 有点不舒服；level=2 明显被伤到（骂她、贬低她、拿她当出气筒）。不确定就填 0。日常寒暄不要记；约定、偏好、重要事件、对方提到的日程必须记。**一律用中文写**（只有对方/她原话本身就是英文时才保留英文）。没有值得记的输出[]。' },
            { role: 'user', content: '【谁在说话】' + (isOwner ? '你在意的人' : '普通联系人') + ' ' + peerKey + '\n【对话】\n' + dialogue },
          ],
          temperature: 0.2, maxTokens: 400,
        });
        r = { content: r.content };
      } else {
        r = await this.router.chat([
          { role: 'system', content: '你是她（这个女生本人）的记事本。从微信对话里挑出值得她长期记住的事，并且用她自己的第一人称写下来——像她随手在备忘录里记的一条，而不是系统日志。只输出JSON数组，不要解释。写法规则：①关于对方的事用「他」或他的名字（绝对不要用「主人」「用户」「对方」这类报告词）②关于她自己的事用「我」③口语、短句（一般 8~25 字），可以带一点她自己的语气④只写事实，不写「谈话中提及」「用户表示」这类套话。正例：他不吃香菜 / 他下周三要出差去成都 / 我最喜欢下雨天 / 我下周想去趟杭州。反例：主人不吃香菜 / 用户表示下周出差 / 她喜欢雨天。每条格式：{"text":"一句话记忆（第一人称）","importance":1到5的整数}（importance 只用来筛"值不值得记"，入库不带这个字段）。除了记忆，还要额外判断**他这次有没有伤到她**（说重话、不耐烦、贬低、敷衍、拿她跟别人比、翻旧账都算）：输出对象 {"memories":[上面那些条目],"hurt":{"level":0或1或2,"why":"一句话说清是哪句或哪种语气"}}——level=0 没伤到（正常开玩笑、催她、忙起来话短都不算）；level=1 有点不舒服；level=2 明显被伤到（骂她、贬低她、拿她当出气筒）。不确定就填 0。日常寒暄不要记；约定、偏好、重要事件、对方提到的日程必须记。**一律用中文写**（只有对方/她原话本身就是英文时才保留英文）。没有值得记的输出[]。' },
          { role: 'user', content: '【谁在说话】' + (isOwner ? '你在意的人' : '普通联系人') + ' ' + peerKey + '\n【对话】\n' + dialogue },
        ], { temperature: 0.2, maxTokens: 400 });
      }
      const raw = String(r.content || '');
      let arr = [];
      let hurtLevel = 0;
      let hurtWhy = '';
      // 新契约是对象 {memories:[...], hurt:{level,why}}；也兼容模型只吐数组的老样式
      const objM = raw.match(/\{[\s\S]*\}/);
      if (objM) {
        try {
          const o = JSON.parse(objM[0]);
          if (Array.isArray(o.memories)) arr = o.memories;
          if (o.hurt && typeof o.hurt.level !== 'undefined') {
            hurtLevel = Math.max(0, Math.min(2, Number(o.hurt.level) || 0));
            hurtWhy = String(o.hurt.why || '').slice(0, 60);
          }
        } catch { /* 落到下面的数组解析 */ }
      }
      if (!arr.length) {
        const m = raw.match(/\[[\s\S]*\]/);
        if (m) { try { arr = JSON.parse(m[0]); } catch { arr = []; } }
      }
      for (const it of (Array.isArray(arr) ? arr : [])) {
        if (!it || !it.text || (it.importance || 3) < 2) continue;
        // importance 只在上面那行当一次性闸门用，入库不再带它（tags/todo 已删）
        await this.addMemory({ who: peerKey, text: it.text, cat: 'you' });
      }
      // 伤害判定并入**现有压力机**（批 E2 / A13）：这里只产出判定，压力仍由 deform 那台机器加
      if (hurtLevel >= 1) {
        rude = true;
        this._lastHurt = { level: hurtLevel, why: hurtWhy, at: Date.now() };
        this.log('[soul] 他这句话伤到她了（程度 ' + hurtLevel + '）：' + hurtWhy);
      }
    } catch (err) {
      this.log('[soul] 记忆抽取失败(不影响回复): ' + (err && err.message));
    }

    // 新记忆补向量（后台，不阻塞）
    if (this.embed) {
      try { void this.embed.sweep(this.getMemories().entries.slice(-10)); } catch {}
    }
    return { rude, warm, hurtLevel: (this._lastHurt && this._lastHurt.level) || 0, hurtWhy: (this._lastHurt && this._lastHurt.why) || '' };
  }

  /** 主动消息：kind = morning（早安）| night（晚安）| poke（日常分享）| nudge（等急了） */
  async proactive(kind, extra = {}) {
    // extra 可带 { today, world }（index.js 注入）；不带就退化成只有人设（旧的降级行为）
    const persona = this.getPersona();
    const peerKey = extra.peerKey || 'owner';
    const rel = this.getRelation(peerKey, true);
    // 空 query 会被引擎直接拒掉（cannot be empty or whitespace-only），然后静默降级成本地 JSON——
    // 实测四种主动消息（早安/晚安/分享/催你）全都命中这条路。这里兜一个一定有内容的种子。
    const seedRaw = String(extra.seed || '').trim()
      || String((extra.flowItem && extra.flowItem.text) || '').trim()
      || String((extra.today && extra.today.focus) || '').trim()
      || String((extra.world && extra.world.tone && extra.world.tone.statusLine) || '').trim()
      || (kind === 'morning' ? '早上好，刚起床' : kind === 'night' ? '晚安，准备睡了' : kind === 'nudge' ? '他还没回我' : '今天想跟他说的事');
    const memories = await this._retrieveHybrid(seedRaw, peerKey);
    const now = new Date();
    const b = this._behavior();
    // 关键修复：主动消息以前**没有**传 today/world → 她不知道现在几点、也不知道今天的分寸，
    // 于是最容易说错话（下午说晚安、刚认识就叫主人）。现在把"今天的她/她的世界/画像"都带上。
    const today = extra.today || null;
    const world = extra.world || null;
    const sys = this._systemPrompt({ persona, rel, isOwner: true, memories, now, mediaCount: 0, behavior: b, today, world, portrait: (world && world.portrait) || ''  });
    const tasks = {
      morning: '你刚醒来不久（现在是【此刻】里的时间）。给对面发一条早安消息：1~2 句话，按你和 TA 的关系分寸来——刚认识就客气简短，熟了才随意。',
      night: '你现在准备睡了（时间是【此刻】里的晚上/深夜，不是白天）。发一条晚安消息：1~2 句话，同样按关系分寸来；刚认识就简单说一句，不要亲昵称呼、不要撒娇。',
      // 注意：这里不能用 String(extra.flowItem && extra.flowItem.text) 当条件——
      // 没有 flowItem 时它得到的是字符串 undefined（真值），于是走进「有流水」分支再崩（真 bug，测试抓到）。
      poke: (extra.flowItem && extra.flowItem.text)
        // 2026-09-13 改：以前这里是"编一个真实可信的小细节"——"编"就是荒唐内容的直接来源
        // （编出"翻卷宗翻到一段摄像头对着人拍"）。现在只允许说**她今天真实经历过的这件事**。
        ? ('你刚做完这件事：' + String(extra.flowItem.text).slice(0, 120) + '（' + String(extra.flowItem.time || '') + '）。'
          + '就着这件事，像随手发微信那样跟他说 1~2 句话，可以带一点你当时的感受或吐槽。'
          + '**只能基于这件事**：不许新增时间、地点、数字、别人的话；想不出怎么说就发一句很短的（比如"刚忙完"）。')
        : '你刚好空下来，随口跟他说一句话：1~2 句话，像随手发微信。想不出具体的事就发一句很短的日常（比如"今天好热"），**绝不许编造具体的时间/地点/数字/别人的话**。',
      promise: '你之前答应过他一件事：' + String((extra.promise && extra.promise.text) || '') + '（' + ((extra.promise && extra.promise.createdAt) ? new Date(extra.promise.createdAt).toLocaleDateString('zh-CN') : '前几天') + '答应的，说好的日子是 ' + String((extra.promise && extra.promise.due) || '') + '）。' + '现在到了该提起或兑现的时候。像突然想起来那样自然地说，1~2 句话。' + ((extra.promise && extra.promise.kind === 'remind') ? '这是你答应提醒他的事，口气像「诶，你别忘了…」。' : '这是你答应要给他的、或你要做的事，口气像「说好的，我来了」。') + '如果日子已经拖过去了，先小小认个错再补上。**绝不提系统、队列、记录、提醒事项这类词**。',
      nudge: '对面已经有一阵子没回你消息了。按你的性格和关系分寸发一条：关系浅就只是轻轻提一句，关系深才可以撒娇或小吐槽。1句话，不咄咄逼人。',
    };
    // 主动消息以前**完全不带聊天记录** → 模型丢了上下文，催人时直接自我介绍了
    // （用户实测收到过"苏镜语，律师。有事吗。"）。现在把最近的来往带上。
    const hist = (() => { try { return this.getHistory(peerKey).slice(-12); } catch { return []; } })();
    const messages = [
      { role: 'system', content: sys + '\n【主动消息任务】' + (tasks[kind] || tasks.poke)
        + '\n铁律：你们已经认识了，**绝对不要自我介绍**（不许说自己的名字/职业/年龄），也不许问"你是谁"，'
        + '更不许复述他刚说过的话当开场。直接说你要说的那件事。' },
      ...hist.map((m) => ({ role: m.role === 'her' ? 'assistant' : 'user', content: m.text })),
      { role: 'user', content: '（系统指令：现在轮到你主动发一条微信。直接输出内容本身，不要任何解释、不要加引号。）' },
    ];
    const p = (this.router.cfg && this.router.cfg.params) || {};
    const temp = Math.min(0.8, (p.temperature == null ? 0.8 : Number(p.temperature)));
    const r = await this.router.chat(messages, { maxTokens: 200, temperature: temp });
    const parsedP = parseCommands(cleanReply(r.content));
    let chunks = this._planChunks(parsedP.text, persona, b.chunkMax);

    // ── 复读止血（批 E1 / A9）──
    // 她说过的主动消息不该反复说同一件事（实测最刺眼的就是"翻来覆去同一件大理民宿"）。
    // 先比字面（免费），再过一道便宜模型的"是不是同一件事"；重复就换一件事说，只重试一次。
    const recent = Array.isArray(extra.recentSaid) ? extra.recentSaid : [];
    if (recent.length && chunks.length) {
      const guard = b.repeatGuard || 'literal+intent';
      let dup = false;
      if (guard !== 'off') {
        dup = this._repeatLiteral(chunks.join(' '), recent);
        if (!dup && guard === 'literal+intent') dup = await this._repeatIntent(chunks.join(' '), recent, extra.chain);
      }
      if (dup) {
        const said = recent.slice(-6).map((x) => '· ' + String((x && x.text) || '').slice(0, 40)).join(String.fromCharCode(10));
        const messages2 = messages.map((m2, i) => (i === 0
          ? { role: 'system', content: m2.content + String.fromCharCode(10)
              + '【你最近已经跟他说过这些，这次必须换一件事、或换一个完全不同的角度，不许重复】' + String.fromCharCode(10) + said }
          : m2));
        try {
          const r2 = await this.router.chat(messages2, { maxTokens: 200, temperature: Math.min(0.9, temp + 0.15) });
          const c2 = this._planChunks(cleanReply(r2.content), persona, b.chunkMax);
          let dup2 = false;
          if (guard !== 'off') {
            dup2 = this._repeatLiteral(c2.join(' '), recent);
            if (!dup2 && guard === 'literal+intent') dup2 = await this._repeatIntent(c2.join(' '), recent, extra.chain);
          }
          if (c2.length && !dup2) chunks = c2;
          else return { chunks: [], skipped: 'repeat', text: '', backend: r.backend };
        } catch { return { chunks: [], skipped: 'repeat', text: '', backend: r.backend }; }
      }
    }
    return { chunks, delaysMs: this._planDelays(chunks, true, b.speedMul || 1), backend: r.backend, commands: parsedP.commands || [] };
  }
}

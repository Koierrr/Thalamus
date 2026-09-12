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

/** 出厂人设（面板可整体替换；人设工坊导入后亦写入此结构） */
/** 关系六阶段（亲密度门槛 → 阶段名 → 称呼方式提示）。后台「你们」页直接展示这张表。 */
export const STAGES = [
  { min: 0, label: '刚认识', callHint: '用名字或哎' },
  { min: 20, label: '熟人', callHint: '直呼其名' },
  { min: 40, label: '朋友', callHint: '名字或外号' },
  { min: 55, label: '亲近', callHint: '偶尔撒泼叫喂' },
  { min: 70, label: '暧昧', callHint: '开始试探性的昵称' },
  { min: 85, label: '恋人', callHint: '固定昵称或亲爱的' },
];

/**
 * 关系分寸表（兜底）：亲密度 → 她今天"该有多熟"。
 * 这是**保底**：世界引擎每晚跑成功时会结合性格/职业/心情/最近互动给出更细的 tone（见她世界里的输出），
 * 后台「你们→关系阶段」能看到当前用的是哪一份。
 */
export const STAGE_TONE = {
  刚认识: {
    intimacy: 10, address: '用名字或「哎」，不叫昵称', chunks: 1, maxChars: 18,
    style: '客气、简短、有边界感；不主动示好、不撒娇、不用感叹号、不打听隐私',
    forbid: ['撒娇', '叫昵称/亲爱的', '说想你/喜欢你', '要求对方为自己做事', '深夜发消息', '连发多条'],
  },
  熟人: {
    intimacy: 35, address: '直呼其名', chunks: 2, maxChars: 28,
    style: '能正常闲聊，语气自然；偶尔吐槽，但不越界',
    forbid: ['撒娇', '叫昵称', '说想你', '要求对方为自己做事', '深夜发消息'],
  },
  朋友: {
    intimacy: 55, address: '名字或外号',
    style: '可以开玩笑、吐槽、讲自己的事；会主动分享但不黏人',
    forbid: ['叫亲爱的', '要求对方为自己做事', '深夜撒娇'],
  },
  亲近: {
    intimacy: 70, address: '偶尔撒泼叫「喂」',
    style: '会主动找他、会关心他；可以有一点小脾气和小撒娇',
    forbid: ['过度索取（连环催、逼问行踪）'],
  },
  暧昧: {
    intimacy: 82, address: '开始试探性的昵称',
    style: '会暗示、会试探、会等他消息；被晾着会有点小情绪',
    forbid: ['直接表白式的压迫感（要留余地）'],
  },
  恋人: {
    intimacy: 95, address: '固定昵称或亲爱的',
    style: '亲昵、会撒娇、会想念；可以管他作息、可以说想他',
    forbid: [],
  },
};

/** 按亲密度取分寸（兜底） */
export function stageToneOf(affection) {
  const table = STAGES;
  let st = table[0];
  for (const x of table) if (affection >= x.min) st = x;
  const t = STAGE_TONE[st.label] || STAGE_TONE['刚认识'];
  return { stage: st.label, ...t };
}

/** 关系阶段允许的主动消息上限（亲密度低时她不该老来找你） */
export function proactiveLimitOf(affection) {
  if (affection < 20) return { affection: Math.round(affection), morning: false, night: false, pokes: 0, nudges: 0 };
  if (affection < 40) return { affection: Math.round(affection), morning: true, night: true, pokes: 1, nudges: 1 };
  if (affection < 55) return { affection: Math.round(affection), morning: true, night: true, pokes: 2, nudges: 2 };
  if (affection < 70) return { affection: Math.round(affection), morning: true, night: true, pokes: 3, nudges: 3 };
  return null; // 足够熟 → 按后台配置走，不再限制
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
    replySpeed: 'human', activePerDay: 3, pokeMinutes: 30, pokeMaxPerDay: 2,
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
    this._engineCache = { ok: null, at: 0, info: null };
    this._lastEngineLog = 0;
  }

  get router() { return this._routerGet(); }

  // ---------- 行为参数（每次调用热读，面板改完即生效） ----------
  _behavior() {
    const persona = this.getPersona();
    const pb = persona.behavior || {};
    const b = { ...(this._behaviorGet() || {}), ...pb };
    const m = b.memory || {};
    const speed = ['instant', 'human', 'slow'].includes(b.replySpeed) ? b.replySpeed : 'human';
    return {
      replySpeed: speed,
      chunkMax: Math.min(5, Math.max(1, Number(b.chunkMax) || 3)),
      contextRounds: Math.min(60, Math.max(2, Number(b.contextRounds) || Number((b.params || {}).historyRounds) || 16)),
      maxTokens: Math.min(8000, Math.max(64, Number((b.params || {}).maxTokens) || 500)),
      voiceRate: Number(b.voiceRate) || 0,
      topK: Math.min(15, Math.max(3, Number(m.topK) || 6)),
      extractEveryN: Math.min(10, Math.max(1, Number(m.extractEveryN) || 1)),
      extraction: m.extraction === 'manual' ? 'manual' : 'cloud',
      extractionModel: String(m.extractionModel || '').trim(),
      // 双向记忆开关（记忆组要整体带出来，否则下游读不到 → 曾经的"设置静默失效"）
      memory: m,
      selfMemory: m.selfMemory !== false,
    };
  }

  // ---------- mem0 引擎健康（60 秒缓存，挂了不吵） ----------
  async engineUp() {
    if (!this.memory) return false;
    const now = Date.now();
    if (this._engineCache.at && now - this._engineCache.at < 60000) return !!this._engineCache.ok;
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

  // ---------- mem0 条目的补充元数据（置顶/重要度），本地小文件 ----------
  _metaFile() { return path.join(this.dir, 'memory-meta.json'); }
  _metaAll() { return readJson(this._metaFile(), {}); }
  _metaSave(all) { writeJson(this._metaFile(), all); }
  _metaGet(id) { return this._metaAll()[id] || {}; }
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

  getRelation(peerKey, isOwner) {
    const all = this.getRelations();
    return all[peerKey] || { affection: isOwner ? 60 : 20, firstSeen: Date.now(), lastSeen: 0, mood: 60, chats: 0 };
  }

  _saveRelation(peerKey, patch) {
    const all = this.getRelations();
    all[peerKey] = { ...this.getRelation(peerKey), ...patch, lastSeen: Date.now() };
    writeJson(this.relationsFile(), all);
    return all[peerKey];
  }

  affectionTitle(affection, isOwner) {
    if (!isOwner) return affection > 50 ? '熟人' : '普通朋友';
    if (affection >= 90) return '灵魂伴侣级';
    if (affection >= 75) return '很亲很亲';
    if (affection >= 50) return '亲密';
    if (affection >= 25) return '熟悉';
    return '刚认识不久';
  }

  /** 关系阶段：由亲密度自动演进，称唿随阶段变（每个联系人独立） */
  stageOf(affection) {
    let stage = STAGES[0];
    for (const s of STAGES) { if (affection >= s.min) stage = s; }
    return stage;
  }

  /** 阶段表（后台「你们」页展示用：单一数据源，别再各写一份） */
  stageTable() { return STAGES.map((s) => ({ ...s })); }

  /** 检测阶段跃迁（返回里程碑文本或 null） */
  detectStageJump(peerKey, oldAffection, newAffection, isOwner) {
    if (!isOwner) return null;
    const oldS = this.stageOf(oldAffection);
    const newS = this.stageOf(newAffection);
    if (oldS.label !== newS.label) {
      // 阶段一变，就有一次"她想换个称呼"的机会（由她自己决定，见 src/rename.js；后台可锁死）
      try {
        const P = this.getPersona();
        if (newS.min >= 20 && !((P.relationship || {}).renameLock)) {
          this.updateRelationship({ renamePending: { from: oldS.label, to: newS.label, at: Date.now() } });
        }
      } catch (err) { this.log('[soul] renamePending 记录失败: ' + (err && err.message)); }
      return '关系从「' + oldS.label + '」进入「' + newS.label + '」——称唿也会跟着变（' + newS.callHint + '）';
    }
    return null;
  }

  // ---------- 存储层 A：本地 JSON 记忆（兜底引擎 + 迁移源） ----------
  memoryFile() { return path.join(this.dir, 'memory.json'); }

  getMemories() { return readJson(this.memoryFile(), { entries: [], todos: [] }); }

  _jsonAdd(item = {}) {
    const mem = this.getMemories();
    const text = String(item.text || '').slice(0, 200);
    if (!text) return this.getMemories();
    const dup = mem.entries.find((e) => e.text === text);
    if (dup) {
      dup.ts = Date.now();
      dup.importance = Math.min(5, Math.max(dup.importance, item.importance || 3));
      dup.hits = (dup.hits || 0) + 1;
    } else {
      const e = {
        id: rid(), who: item.who || '', text,
        importance: item.importance || 3, tags: item.tags || [],
        todo: item.todo || null, pinned: !!item.pinned, ts: Date.now(), hits: 0,
      };
      if (item.mid) e.mid = item.mid;
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
  async memoriesView() {
    if (await this.engineUp()) {
      try {
        const r = await this.memory.list();
        const meta = this._metaAll();
        const entries = (r.entries || []).map((e) => ({
          id: e.id,
          text: e.text,
          who: e.who || 'global',
          importance: (meta[e.id] && meta[e.id].importance) || (e.metadata && e.metadata.importance) || 3,
          tags: (e.metadata && e.metadata.tags) || [],
          source: (e.metadata && e.metadata.source) || '',
          pinned: !!(meta[e.id] && meta[e.id].pinned),
          ts: e.ts || Date.now(),
        }));
        return { engine: 'mem0', info: this.engineInfo(), entries, legacyCount: (this.getMemories().entries || []).length };
      } catch (err) {
        this.log('[soul] mem0 列表失败，显示本地数据: ' + (err && err.message));
      }
    }
    return { engine: 'local', info: null, entries: this.getMemories().entries };
  }

  /** 手动记一条 */
  async addMemory(item = {}) {
    const text = String(item.text || '').slice(0, 200);
    if (!text) return null;
    if (await this.engineUp()) {
      try {
        const r = await this.memory.add({
          text, who: item.who || 'global', infer: false,
          metadata: { importance: item.importance || 3, tags: item.tags || [], pinned: !!item.pinned, source: item.source || 'manual', ts: Date.now() },
        });
        const id = (r.ids && r.ids[0]) || '';
        if (id) {
          this._metaSet(id, { importance: item.importance || 3, pinned: !!item.pinned });
          this._jsonAdd({ who: item.who || '', text, importance: item.importance || 3, tags: item.tags || [], todo: item.todo || null, pinned: !!item.pinned, mid: id });
        }
        return { id, text };
      } catch (err) {
        this.log('[soul] mem0 写入失败，落本地JSON: ' + (err && err.message));
      }
    }
    this._jsonAdd(item);
    return { id: '', text };
  }

  /** 编辑：text 走引擎更新，置顶/重要度走 meta 补充层 */
  async editMemory(memId, patch = {}) {
    if (await this.engineUp()) {
      const meta = {};
      if (patch.importance !== undefined) meta.importance = Math.min(5, Math.max(1, Number(patch.importance) || 3));
      if (patch.pinned !== undefined) meta.pinned = !!patch.pinned;
      if (Object.keys(meta).length) this._metaSet(memId, meta);
      if (typeof patch.text === 'string' && patch.text.trim()) {
        await this.memory.update(memId, { text: patch.text.trim().slice(0, 200) });
      }
      this._jsonEditByMid(memId, patch);
      return { id: memId };
    }
    return this._jsonEdit(memId, patch);
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

  async pinMemory(memId) {
    if (await this.engineUp()) {
      const cur = this._metaGet(memId).pinned;
      this._metaSet(memId, { pinned: !cur });
      this._jsonEditByMid(memId, { pinned: !cur });
      return !cur;
    }
    const mem = this.getMemories();
    const hit = mem.entries.find((e) => e.id === memId);
    if (!hit) throw new Error('记忆不存在: ' + memId);
    hit.pinned = !hit.pinned;
    writeJson(this.memoryFile(), mem);
    return hit.pinned;
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
        const hay = (e.tags || []).concat([e.text]).join(' ');
        const kw = Math.min(6, this._zhGrams(q, 20).filter(function (g) { return hay.indexOf(g) >= 0; }).length);
        const cos = cosMap ? (cosMap.get(e.id) || 0) : 0;
        const recency = Math.exp(-daysAgo(e.ts) / 30);
        const score = (e.importance || 3) * 2 + kw * 3 + cos * 4 + recency * 2 + (e.pinned ? 100 : 0);
        return { e, score };
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
            out.push({
              id: e.id,
              text: String(e.text || ''),
              ts: e.ts || Date.now(),
              importance: meta.importance || md.importance || 3,
              tags: md.tags || [],
              pinned: !!meta.pinned,
              who: e.who || md.who || fromWho,
              source: md.source || '',
            });
          }
        }
        out.sort((a, b) => (b.pinned ? 100 : 0) - (a.pinned ? 100 : 0));
        if (out.length) return out.slice(0, topK);
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
    const rel = this.getRelation(peerKey, isOwner);
    const b = this._behavior();
    const incoming = String(item.text || '');
    // 省 token：平时只带 ~100 token 自我认知小卡；聊到能力/身份话题才注入完整功能清单
    const needFull = CAPABILITY_KEYWORDS.some((k) => incoming.includes(k));
    const memories = await this._retrieveHybrid(incoming, peerKey);
    const today = item.today || null;
    const deformInfo = this.deform ? this.deform.info() : null;
    // 变形状态必须在生成回复【之前】注入，否则她永远"变不了形"
    let recoveredThisTurn = false;
    if (this.deform && this.deform.consumeRecovery()) {
      recoveredThisTurn = true;
      this.log('[soul] 变形恢复：本轮注入道歉/自嘲指令');
    }
    const deformLine = this._deformLine(deformInfo, recoveredThisTurn);
    const world = item.world || null;
    const portrait = item.portrait || (world && world.portrait) || '';
    const now = new Date();
    // 分寸与话量：世界引擎昨晚判断过（且是"今天"那份）就用它，否则用内置阶段兜底表
    const ruleTone = stageToneOf(rel.affection);
    const wt = (world && world.tone && world.forDate && today && world.forDate === today.date) ? world.tone : null;
    const tone = wt ? { ...ruleTone, ...wt, source: 'world' } : { ...ruleTone, source: 'rule' };
    const talkPlan = this._talkPlan(persona, tone, this.stageOf(rel.affection).min);
    const sys = this._systemPrompt({ persona, rel, isOwner, memories, now, mediaCount: item.mediaCount || 0, behavior: b, extraCard: needFull ? featureSummaryForSoul() : '', today, deformInfo, deformLine, world, portrait, tone, talkPlan });
    const history = this.getHistory(peerKey).slice(-b.contextRounds)
      .map((m) => ({ role: m.role === 'her' ? 'assistant' : 'user', content: m.text }));
    const messages = [{ role: 'system', content: sys }, ...history, { role: 'user', content: incoming.slice(0, 4000) }];
    const r = await this.router.chat(messages, { maxTokens: b.maxTokens || 500 });
    // 话量：性格定基调（温度/发起力低的人惜字如金），关系阶段与世界引擎给的分寸再微调；
    // 今天的"话痨度"在这个上限内浮动——两条一起管住"她话太多不像 INTJ"。
    const chatter = today && today.chatter ? today.chatter : 1;
    const maxChunks = Math.max(1, Math.min(talkPlan.maxChunks, Math.round((b.chunkMax || 3) * chatter)));
    let chunks = this._planChunks(r.content, persona, maxChunks);
    // 每条再按"字数上限"收一刀（超过就断在最近的句读上，不硬切字）
    chunks = chunks.map((c) => (c.length <= talkPlan.maxChars ? c : (c.slice(0, talkPlan.maxChars).replace(/[，,、；;：:][^，,、；;：:]*$/, '') + '…')));
    if (!chunks.length) chunks = [String(r.content || '').slice(0, talkPlan.maxChars)];
    const voiceRate = item.voiceRate !== undefined ? Number(item.voiceRate) || 0 : b.voiceRate;
    const voice = voiceRate > 0 && Math.random() < voiceRate && (chunks[0] || '').length <= 160;
    const moodLabel = rel.mood >= 70 ? '不错' : rel.mood >= 40 ? '平静' : '有点低落';
    const thought = (memories.length ? '想起：' + memories.slice(0, 2).map((m) => m.text.slice(0, 30)).join('；') + '。' : '') + '心情' + moodLabel + '，亲密度' + Math.round(rel.affection);
    const speedMul = today && today.speedState ? today.speedState : 1;
    return {
      chunks, delaysMs: this._planDelays(chunks, isOwner, b.replySpeed, speedMul), talkPlan,
      mood: rel.mood, backend: r.backend, voice, thought,
      recovered: recoveredThisTurn, deform: deformInfo ? deformInfo.state : 'normal',
    };
  }

  /**
   * 变形状态 → 提示词指令（"她真的变了"就发生在这里；后台「她→变形状态机」可见可调，不是黑盒）
   * 底色永不变：变的只是压力下的表达，平静后逐层退出，并留下成长（整合度）。
   */
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
    const stageNow = this.stageOf(rel.affection);
    const petName = String(RC.callOwner || '').trim();
    // 分寸：世界引擎昨晚综合判断过就用它（info.tone），否则用代码里的兜底表。
    // 注意：提示词里**不能**把这个角色叫「主人」——那个词会让模型自动演"管家式女友"，
    // 和"刚认识"以及"INTJ 这种冷淡性格"直接冲突。这里统一称"他/对面"。
    const ruleTone = stageToneOf(rel.affection);
    const wt = (info.world && info.world.tone && info.today && info.world.forDate && info.world.forDate === info.today.date) ? info.world.tone : null;
    const tone = info.tone ? info.tone : (wt ? { ...ruleTone, ...wt, source: 'world' } : { ...ruleTone, source: 'rule' });
    let ownerDesc;
    if (RC.callLock && petName) {
      ownerDesc = '对面是你在意的人。你平时叫他「' + petName + '」（你们定下的固定称呼，任何阶段都这么叫）。';
    } else {
      // 纯自动演变：阶段 + 分寸表决定称呼方式；专属昵称到恋人阶段才自然出口，暧昧期偶尔试探
      ownerDesc = '对面是你在意的人。你们的关系由亲密度自然演进，现在是「' + stageNow.label + '」阶段——称呼上：' + (tone.address || stageNow.callHint) + '。' +
        (petName && stageNow.min >= 85 ? '你们已经是恋人，你平时就叫他「' + petName + '」。' : '') +
        (petName && stageNow.min >= 70 && stageNow.min < 85 ? '你心里已经想好以后叫他「' + petName + '」，偶尔半开玩笑地试探着叫。' : '');
    }
    ownerDesc += '绝对不要叫他「主人」「老公」「亲爱的」这类称呼，除非上面的称呼要求里明确写了。';
    // 今天的分寸（"不崩人设"的关键：关系多深就表现多熟；宁可冷淡也别越界）
    ownerDesc += '\n【今天的分寸（非常重要，宁可冷淡一点也别越界）】现在亲密度 ' + Math.round(rel.affection) + '/100，'
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
    if (RC.toOwner) ownerDesc += '你心里对这段关系的定位是「' + RC.toOwner + '」——按这个定位拿捏分寸（别越界，也别太生分）。';
    ownerDesc += '亲密度 ' + Math.round(rel.affection) + '/100（' + this.affectionTitle(rel.affection, true) + '），已聊 ' + (rel.chats || 0) + ' 次。';
    const who = info.isOwner ? ownerDesc : ('对方是普通联系人，亲密度 ' + Math.round(rel.affection) + '/100。');
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
      info.today && typeof info.today.mood === 'number' && info.today.mood <= 35 ? '【今天心情】有点低落——想起的事都带点刺，语气自然低一些，不硬拗开心。' : (info.today && info.today.mood >= 75 ? '【今天心情】很好——语气轻快，主动抛话题。' : ''),
      info.today && info.today.focus ? '【今日痴迷】' + info.today.focus + '——今天聊天更容易扯到这个。' : '',
      ...worldLines,
      (info.ownerLines && info.ownerLines.length) ? '【他的说法（可以自然借用他的用词和梗）】' + info.ownerLines.join(' / ').slice(0, 160) : '',
      info.portrait ? '【你对他的印象】' + info.portrait + '（按这个印象对待他）' : '',
      (persona.profile && persona.profile.appearance && Object.keys(persona.profile.appearance).length) ? (() => { const ap = persona.profile.appearance; const L = { face: '长相', hair: '发型发色', style: '穿衣', body: '身材', vibe: '气质' }; return '【外貌】' + Object.keys(ap).map((k) => (ap[k] && L[k]) ? (L[k] + '：' + ap[k]) : '').filter(Boolean).join('；') + '。'; })() : '',
      (persona.profile && persona.profile.favorites && Object.keys(persona.profile.favorites).length) ? (() => { const fv = persona.profile.favorites; const L = { like: '喜欢', dislike: '讨厌', food: '常吃', music: '常听', place: '常去' }; return '【偏好】' + Object.keys(fv).map((k) => (fv[k] && L[k]) ? (L[k] + '：' + fv[k]) : '').filter(Boolean).join('；') + '。'; })() : '',
      (persona.profile && persona.profile.inner && Object.keys(persona.profile.inner).length) ? (() => { const inn = persona.profile.inner; const L = { desire: '最想要', fear: '最怕', values: '在意', quirk: '小怪癖' }; return '【内心】' + Object.keys(inn).map((k) => (inn[k] && L[k]) ? (L[k] + '：' + inn[k]) : '').filter(Boolean).join('；') + '。'; })() : '',
      '【此刻】' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 星期' + week + ' ' + timeText + '。时间用 24 小时制：14:00 是下午两点、02:00 是凌晨两点——说话要和这个时间对得上（下午不要说早安、上午不要道晚安）。心情状态：' + (rel.mood >= 70 ? '不错，开心' : rel.mood >= 40 ? '平静' : '有点低落，需要被哄') + '。',
      '【关系】' + who,
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
   * replySpeed：instant（秒回型）/ human（默认）/ slow（慢性子）；mul 是当天速度系数。
   * 参数传数组（chunks）最好——能按每条的字数算；传数字也兼容（退回固定时长）。
   */
  _planDelays(chunks, isOwner, speed, mul) {
    const list = Array.isArray(chunks) ? chunks.map((c) => String(c || '')) : null;
    const count = list ? list.length : Math.max(1, Number(chunks) || 1);
    const s = speed || 'human';
    const m = Number(mul) || 1;
    const CHAR_MS = s === 'instant' ? 45 : s === 'slow' ? 260 : 150;      // 每个字的"打字"时间
    const THINK = s === 'instant' ? [200, 800] : s === 'slow' ? [4000, 9000] : [1500, 4800];
    const GAP = s === 'instant' ? [120, 350] : s === 'slow' ? [1200, 2600] : [450, 1300];
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
    const avg = (((T.initiative == null ? 50 : T.initiative) + (T.warmth == null ? 50 : T.warmth)) / 2);
    let plan = avg < 35 ? { maxChunks: 1, maxChars: 16 }
      : avg < 52 ? { maxChunks: 2, maxChars: 26 }
        : avg < 72 ? { maxChunks: 3, maxChars: 42 }
          : { maxChunks: 4, maxChars: 60 };
    if (stageMin < 20) plan = { maxChunks: Math.min(plan.maxChunks, 2), maxChars: Math.min(plan.maxChars, 24) }; // 刚认识：话更少
    if (tone && Number.isFinite(tone.chunks)) plan.maxChunks = Math.max(1, Math.min(5, Math.round(tone.chunks)));
    if (tone && Number.isFinite(tone.maxChars)) plan.maxChars = Math.max(8, Math.min(120, Math.round(tone.maxChars)));
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
    const rude = /滚|蠢|闭嘴|垃圾/.test(userText);
    // 演化计数器：只统计主人对她的互动（世界引擎每周结算时用）
    if (isOwner) this.bumpEvolution({ chats: 1, warm: warm ? 1 : 0, rude: rude ? 1 : 0 });
    const affectionDelta = isOwner ? (warm ? 0.6 : rude ? -1.2 : 0.15) : (rude ? -0.8 : 0.05);
    const moodDelta = rude ? -6 : warm ? 4 : 0.5;
    const newAffection = Math.max(0, Math.min(100, rel.affection + affectionDelta));
    this._saveRelation(peerKey, {
      affection: newAffection,
      mood: Math.max(0, Math.min(100, rel.mood + moodDelta)),
      chats: (rel.chats || 0) + 1,
    });

    // 关系阶段跃迁检测（里程碑）
    if (isOwner) {
      const jump = this.detectStageJump(peerKey, rel.affection, newAffection, isOwner);
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
          try { await this.addMemory({ who: 'self', text: hs.slice(0, 120), importance: 2, tags: ['自述'], source: 'self' }); } catch {}
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
            { role: 'system', content: '你是她（这个女生本人）的记事本。从微信对话里挑出值得她长期记住的事，并且用她自己的第一人称写下来——像她随手在备忘录里记的一条，而不是系统日志。只输出JSON数组，不要解释。写法规则：①关于对方的事用「他」或他的名字（绝对不要用「主人」「用户」「对方」这类报告词）②关于她自己的事用「我」③口语、短句（一般 8~25 字），可以带一点她自己的语气④只写事实，不写「谈话中提及」「用户表示」这类套话。正例：他不吃香菜 / 他下周三要出差去成都 / 我最喜欢下雨天 / 我下周想去趟杭州。反例：主人不吃香菜 / 用户表示下周出差 / 她喜欢雨天。每条格式：{"text":"一句话记忆（第一人称）","importance":1到5的整数,"tags":["标签"],"todo":{"due":"YYYY-MM-DD","text":"待办内容"}或null}。日常寒暄不要记；约定、偏好、重要事件、对方提到的日程必须记。没有值得记的输出[]。' },
            { role: 'user', content: '【谁在说话】' + (isOwner ? '你在意的人' : '普通联系人') + ' ' + peerKey + '\n【对话】\n' + dialogue },
          ],
          temperature: 0.2, maxTokens: 400,
        });
        r = { content: r.content };
      } else {
        r = await this.router.chat([
          { role: 'system', content: '你是她（这个女生本人）的记事本。从微信对话里挑出值得她长期记住的事，并且用她自己的第一人称写下来——像她随手在备忘录里记的一条，而不是系统日志。只输出JSON数组，不要解释。写法规则：①关于对方的事用「他」或他的名字（绝对不要用「主人」「用户」「对方」这类报告词）②关于她自己的事用「我」③口语、短句（一般 8~25 字），可以带一点她自己的语气④只写事实，不写「谈话中提及」「用户表示」这类套话。正例：他不吃香菜 / 他下周三要出差去成都 / 我最喜欢下雨天 / 我下周想去趟杭州。反例：主人不吃香菜 / 用户表示下周出差 / 她喜欢雨天。每条格式：{"text":"一句话记忆（第一人称）","importance":1到5的整数,"tags":["标签"],"todo":{"due":"YYYY-MM-DD","text":"待办内容"}或null}。日常寒暄不要记；约定、偏好、重要事件、对方提到的日程必须记。没有值得记的输出[]。' },
          { role: 'user', content: '【谁在说话】' + (isOwner ? '你在意的人' : '普通联系人') + ' ' + peerKey + '\n【对话】\n' + dialogue },
        ], { temperature: 0.2, maxTokens: 400 });
      }
      const m = String(r.content || '').match(/\[[\s\S]*\]/);
      if (m) {
        const arr = JSON.parse(m[0]);
        for (const it of arr) {
          if (!it || !it.text || (it.importance || 3) < 2) continue;
          await this.addMemory({ who: peerKey, text: it.text, importance: it.importance, tags: it.tags || [], todo: it.todo || null });
        }
      }
    } catch (err) {
      this.log('[soul] 记忆抽取失败(不影响回复): ' + (err && err.message));
    }

    // 新记忆补向量（后台，不阻塞）
    if (this.embed) {
      try { void this.embed.sweep(this.getMemories().entries.slice(-10)); } catch {}
    }
    return { rude, warm };
  }

  /** 主动消息：kind = morning（早安）| night（晚安）| poke（日常分享）| nudge（等急了） */
  async proactive(kind, extra = {}) {
    // extra 可带 { today, world }（index.js 注入）；不带就退化成只有人设（旧的降级行为）
    const persona = this.getPersona();
    const peerKey = extra.peerKey || 'owner';
    const rel = this.getRelation(peerKey, true);
    const memories = await this._retrieveHybrid(extra.seed || '', peerKey);
    const now = new Date();
    const b = this._behavior();
    // 关键修复：主动消息以前**没有**传 today/world → 她不知道现在几点、也不知道今天的分寸，
    // 于是最容易说错话（下午说晚安、刚认识就叫主人）。现在把"今天的她/她的世界/画像"都带上。
    const today = extra.today || null;
    const world = extra.world || null;
    const sys = this._systemPrompt({ persona, rel, isOwner: true, memories, now, mediaCount: 0, behavior: b, today, world, portrait: (world && world.portrait) || '' });
    const tasks = {
      morning: '你刚醒来不久（现在是【此刻】里的时间）。给对面发一条早安消息：1~2 句话，按你和 TA 的关系分寸来——刚认识就客气简短，熟了才随意。',
      night: '你现在准备睡了（时间是【此刻】里的晚上/深夜，不是白天）。发一条晚安消息：1~2 句话，同样按关系分寸来；刚认识就简单说一句，不要亲昵称呼、不要撒娇。',
      poke: '你刚才在生活中遇到一件具体的小事（结合你的职业、兴趣和此刻时间，编一个真实可信的小细节），想顺手分享给对面。像随手发微信那样，1~2句话，绝不像播报；关系还没到那份上就少发、也别太热络。',
      nudge: '对面已经有一阵子没回你消息了。按你的性格和关系分寸发一条：关系浅就只是轻轻提一句，关系深才可以撒娇或小吐槽。1句话，不咄咄逼人。',
    };
    const messages = [
      { role: 'system', content: sys + '\n【主动消息任务】' + (tasks[kind] || tasks.poke) },
      { role: 'user', content: '（系统指令：现在主动发出一条微信。直接输出内容本身，不要任何解释。）' },
    ];
    const p = (this.router.cfg && this.router.cfg.params) || {};
    const r = await this.router.chat(messages, { maxTokens: 200, temperature: Math.min(0.8, (p.temperature == null ? 0.8 : Number(p.temperature))) });
    const chunks = this._planChunks(r.content, persona, b.chunkMax);
    return { chunks, delaysMs: this._planDelays(chunks, true, b.replySpeed), backend: r.backend };
  }
}

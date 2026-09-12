// persona-workshop.js — 人格工坊（原人设工坊 · 全面升级）
// 你把任何关于她的资料丢进来（背景故事/测试结果/聊天记录/随手描述），
// AI 自动判断并生成完整草稿 → 你逐项确认 → 一键填进「人设（含人格测评）」「记忆」「她的设置」。
// 灵感与管线参考 perkfly/ex-skill (MIT)。原始素材只在本机解析；云端只收到节选与蒸馏请求。
// AI 辅助与对话接口共用同一个模型（走 ModelRouter.chat，自动带降级链）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from './model-router.js';

function rid() { return crypto.randomBytes(5).toString('hex'); }

const TS_RE = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2})(?::\d{2})?\s*(.*)$/;

export function parseChatExport(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const msgs = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = TS_RE.exec(t);
    if (m) {
      if (cur && (cur.speaker || cur.text)) msgs.push(cur);
      cur = { ts: m[1] + ' ' + m[2], speaker: (m[3] || '').trim(), text: '' };
      continue;
    }
    const prefixRe = /^(她|我|主人|对方|老婆|男友|女友|老公)[:：]\s*/;
    const pm = prefixRe.exec(t);
    if (pm) {
      if (cur && (cur.speaker || cur.text)) msgs.push(cur);
      cur = { ts: '', speaker: pm[1], text: t.slice(pm[0].length) };
      continue;
    }
    if (!cur) { cur = { ts: '', speaker: '', text: t }; continue; }
    if (!cur.speaker) { cur.speaker = t; continue; }
    cur.text = cur.text ? cur.text + '\n' + t : t;
  }
  if (cur && (cur.speaker || cur.text)) msgs.push(cur);
  return msgs;
}

export class PersonaWorkshop {
  constructor(options = {}) {
    this.soul = options.soul || null;
    this.routerGet = typeof options.router === 'function' ? options.router : () => options.router;
    this.log = options.logger || (() => {});
    this.sessionFile = options.sessionFile || null;
    this._cfgGet = typeof options.config === 'function' ? options.config : () => ({});
  }

  get router() { return this.routerGet(); }

  /** 工坊专用线路：配置了独立 API 就走它（失败自动回落对话接口），否则跟对话接口 */
  async _chat(msgs, opts = {}) {
    const w = ((this._cfgGet() || {}).workshop) || {};
    if (w.baseURL && w.model) {
      try {
        const r = await chatCompletion({ baseURL: w.baseURL, apiKey: w.apiKey || '', model: w.model, messages: msgs, temperature: opts.temperature, maxTokens: opts.maxTokens, timeoutMs: 180000 });
        return { content: r.content };
      } catch (err) {
        this.log('[workshop] 女娲专线失败，回落对话接口: ' + err.message);
      }
    }
    return this.router.chat(msgs, opts);
  }

  /** 分析：任意资料（描述/测试结果/聊天记录）→ 全字段人设草稿 */
  async analyze({ chatText, description } = {}) {
    const excerpt = String(chatText || '').slice(0, 14000);
    if (!excerpt.trim() && !String(description || '').trim()) throw new Error('至少贴一点她的资料（描述/测试结果/聊天记录都行）');
    const sys = [
      '你是一名人设分析师兼心理测评师。用户会给你关于一个"真实女生"的混合资料：背景描述、性格描述、MBTI/大五/九型人格测试结果、以及微信聊天记录片段。你的任务：产出一个可以直接使用的完整人设草稿（JSON）。',
      '只输出一个JSON对象，不要解释、不要代码围栏。字段：',
      '{"name":"昵称","birthday":"生日/星座","city":"城市","job":"职业","age":"年龄",',
      ' "personaText":"第三人称背景故事，200字内，把资料里的信息组织成连贯人生",',
      ' "personality":{"extraversion":0-100,"warmth":0-100,"clinginess":0-100,"sass":0-100,"initiative":0-100},',
      ' "quirks":{"catchphrases":["口头禅"],"emojiRate":0到1的小数,"maxLength":"short或medium或long"},',
      ' "relationship":{"toOwner":"她对用户的关系定位","callOwner":"她称呼用户的方式"},',
      ' "redLines":["禁忌话题"],"interests":["兴趣爱好"],',
      ' "assessments":{"mbti":"4字母，依据资料推断"},',
      ' "styleExamples":[{"user":"对方原话","her":"她的原话"}]最多6条,',
      ' "memorySeeds":[{"text":"值得她记住的事","importance":1-5,"tags":["标签"]}]最多10条,',
      ' "behavior":{"behavior":{"replySpeed":"instant或human或slow","chunkMax":1-8},"life":{"pokesPerDay":0-50,"wake":"HH:MM","sleep":"HH:MM"}}}',
      ' "appearanceText":"一段自然语言的外貌描述（长相/发型发色/穿衣/身材/气质揉成一段，80~150字）",',
      ' "npc":[{"name":"虚构朋友/同事名","desc":"一句话人设"}]0-3个,"secrets":[{"text":"她还没告诉用户的私人事件"}]0-2条,',
      ' "longterm":[{"text":"长线目标（如学插画/存钱）","progress":0-100}]0-3条,',
      ' "inner":{"desire":"最想要","fear":"最怕","values":"在意","quirk":"小怪癖"},',
      ' "favorites":{"like":"喜欢","dislike":"讨厌","food":"常吃","music":"常听","place":"常去"},',
      '规则：',
      '1. 硬事实（名字/生日/城市/职业/年龄/MBTI字母等）只填资料里明确给出的，没有就留空字符串——绝不编造。',
      '2. 资料没给MBTI但描述了性格时：按荣格八维推断一个最贴合的MBTI（认知功能栈内部一致，如"温柔真诚有主见"→IxFx系、Fi主导优先）。',
      '3. personality 五维与 quirks、assessments 必须相互一致，绝不要自相矛盾。',
      '4. styleExamples 必须来自聊天记录原文（可轻微截断）；没有聊天记录就给空数组。',
      '5. memorySeeds 提取资料里值得她长期记住的事（约定/偏好/事件/关系事实），没有就空数组。',
      '6. behavior 只在描述能支撑时给建议（如"她很高冷慢热"→human/slow；"元气话痨"→instant），否则整段留空对象。',
    ].join('\n');
    const user = [
      description ? '【补充说明】' + description : '',
      excerpt.trim() ? '【她的资料（可混合：描述/测试结果/聊天记录）】\n' + excerpt : '',
    ].filter(Boolean).join('\n\n');
    const r = await this._chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user || '（无输入）' }],
      { temperature: 0.4, maxTokens: 1400 }
    );
    const m = String(r.content || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('分析结果不是有效JSON（模型输出格式异常）');
    let d;
    try { d = JSON.parse(m[0]); } catch (err) { throw new Error('分析JSON解析失败: ' + err.message); }
    const clamp = (v, lo, hi, dft) => (typeof v === 'number' && v >= lo && v <= hi ? v : dft);
    const p5 = d.personality && typeof d.personality === 'object' ? d.personality : {};
    const q = d.quirks && typeof d.quirks === 'object' ? d.quirks : {};
    const a = d.assessments && typeof d.assessments === 'object' ? d.assessments : {};
    const beh = d.behavior && typeof d.behavior === 'object' ? d.behavior : {};
    return {
      id: rid(),
      createdAt: Date.now(),
      name: String(d.name || '').slice(0, 30),
      birthday: String(d.birthday || '').slice(0, 40),
      city: String(d.city || '').slice(0, 40),
      job: String(d.job || '').slice(0, 60),
      age: String(d.age || '').slice(0, 10),
      personaText: String(d.personaText || '').slice(0, 800),
      personality: {
        extraversion: clamp(p5.extraversion, 0, 100, null),
        warmth: clamp(p5.warmth, 0, 100, null),
        clinginess: clamp(p5.clinginess, 0, 100, null),
        sass: clamp(p5.sass, 0, 100, null),
        initiative: clamp(p5.initiative, 0, 100, null),
      },
      quirks: {
        catchphrases: Array.isArray(q.catchphrases) ? q.catchphrases.slice(0, 10).map((x) => String(x).slice(0, 30)) : [],
        emojiRate: clamp(q.emojiRate, 0, 1, null),
        maxLength: ['short', 'medium', 'long'].includes(q.maxLength) ? q.maxLength : '',
      },
      relationship: d.relationship && typeof d.relationship === 'object' ? { toOwner: String(d.relationship.toOwner || '').slice(0, 30), callOwner: String(d.relationship.callOwner || '').slice(0, 30) } : null,
      redLines: Array.isArray(d.redLines) ? d.redLines.slice(0, 10).map((x) => String(x).slice(0, 40)) : [],
      interests: Array.isArray(d.interests) ? d.interests.slice(0, 15).map((x) => String(x).slice(0, 30)) : [],
      assessments: {
        mbti: String(a.mbti || '').toUpperCase().slice(0, 4),
      },
      styleExamples: Array.isArray(d.styleExamples) ? d.styleExamples.slice(0, 6).map((s) => ({ user: String(s.user || '').slice(0, 200), her: String(s.her || '').slice(0, 200) })) : [],
      memorySeeds: Array.isArray(d.memorySeeds) ? d.memorySeeds.slice(0, 10).map((s) => ({ text: String(s.text || '').slice(0, 200), importance: Math.min(5, Math.max(1, Number(s.importance) || 3)), tags: Array.isArray(s.tags) ? s.tags.slice(0, 5).map((x) => String(x).slice(0, 20)) : [] })) : [],
      behavior: {
        behavior: beh.behavior && typeof beh.behavior === 'object' ? beh.behavior : {},
        life: beh.life && typeof beh.life === 'object' ? beh.life : {},
      },
      source: 'imported',
    };
  }

  /** 应用草稿：人设全字段（含人格测评）写入 + 记忆种子导入（mem0 引擎） */
  async apply(draft) {
    if (!draft) throw new Error('草稿为空');
    const cur = this.soul.getPersona();
    const patch = {
      name: draft.name || cur.name,
      birthday: draft.birthday || cur.birthday,
      city: draft.city || cur.city,
      job: draft.job || cur.job,
      age: draft.age || cur.age,
      personaText: draft.personaText || cur.personaText,
      interests: (draft.interests && draft.interests.length) ? draft.interests : cur.interests,
      redLines: (draft.redLines && draft.redLines.length) ? draft.redLines : cur.redLines,
      styleExamples: (draft.styleExamples && draft.styleExamples.length) ? draft.styleExamples : cur.styleExamples,
      quirks: {
        ...(cur.quirks || {}),
        ...(draft.quirks || {}),
        catchphrases: (draft.quirks && draft.quirks.catchphrases && draft.quirks.catchphrases.length) ? draft.quirks.catchphrases : ((cur.quirks || {}).catchphrases || []),
        emojiRate: (draft.quirks && typeof draft.quirks.emojiRate === 'number') ? draft.quirks.emojiRate : ((cur.quirks || {}).emojiRate || 0.4),
        maxLength: (draft.quirks && draft.quirks.maxLength) ? draft.quirks.maxLength : ((cur.quirks || {}).maxLength || 'short'),
      },
      source: 'imported',
    };
    if (draft.relationship && (draft.relationship.toOwner || draft.relationship.callOwner || draft.relationship.ownerCallsMe)) {
      patch.relationship = {
        ...(cur.relationship || {}),
        toOwner: draft.relationship.toOwner || (cur.relationship || {}).toOwner || '',
        callOwner: draft.relationship.callOwner || (cur.relationship || {}).callOwner || '',
        ownerCallsMe: draft.relationship.ownerCallsMe || (cur.relationship || {}).ownerCallsMe || '',
      };
    }
    if (draft.assessments) {
      const a = draft.assessments;
      const curA = cur.assessments || {};
      patch.assessments = {
        mbti: a.mbti || curA.mbti || '',
      };
    }
    // NPC/秘密/长线剧情 存入 profile
    if (draft.npc || draft.secrets || draft.longterm) {
      const curP = cur.profile || {};
      patch.profile = patch.profile || {};
      if (Array.isArray(draft.npc) && draft.npc.length) patch.profile.npcs = draft.npc;
      if (Array.isArray(draft.secrets) && draft.secrets.length) patch.profile.secrets = draft.secrets;
      if (Array.isArray(draft.longterm) && draft.longterm.length) patch.profile.longterm = draft.longterm;
    }
    if (draft.past && (draft.past.surface || draft.past.middle || draft.past.deep)) {
      try {
        const curP1 = (this.soul.getPersona().profile || {});
        const curPast = curP1.past || {};
        this.soul.savePersona({ profile: { ...curP1, past: { ...curPast, ...draft.past } } });
      } catch {}
    }
    if (draft.appearanceText) {
      try {
        const curP0 = (this.soul.getPersona().profile || {});
        const prevTxt = draft.appearanceTextLegacy ? '' : (curP0.appearanceText || '');
        this.soul.savePersona({ profile: { ...curP0, appearanceText: String(draft.appearanceText).slice(0, 800), appearancePrev: prevTxt, appearanceAt: Date.now(), appearanceFrom: { by: 'nwa' } } });
      } catch {}
    }
    if (draft.profile || draft.appearance || draft.favorites || draft.inner) {
      const pf = draft.profile || {};
      const curP = cur.profile || {};
      patch.profile = {
        appearance: { ...(curP.appearance || {}), ...(pf.appearance || {}), ...(draft.appearance || {}) },
        favorites: { ...(curP.favorites || {}), ...(pf.favorites || {}), ...(draft.favorites || {}) },
        inner: { ...(curP.inner || {}), ...(pf.inner || {}), ...(draft.inner || {}) },
      };
    }
    const persona = this.soul.savePersona(patch);
    let seeds = 0;
    for (const seed of draft.memorySeeds || []) {
      if (seed && seed.text) {
        try { await this.soul.addMemory({ who: '', text: seed.text, importance: seed.importance || 3, tags: seed.tags || [] }); seeds += 1; } catch {}
      }
    }
    this.log('[workshop] 人格草稿已应用: ' + persona.name + '，记忆种子 ' + seeds + ' 条');
    return { persona, seeds };
  }

  // ── 女娲造人：对话式多会话 ──

  _sessions() {
    try { return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')); } catch { return { sessions: [] }; }
  }
  _saveSessions(all) {
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    const tmp = this.sessionFile + '.tmp-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    fs.renameSync(tmp, this.sessionFile);
  }

  listSessions() {
    return (this._sessions().sessions || []).map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, msgCount: (s.messages || []).length, hasDraft: !!(s.draft && Object.keys(s.draft).length) }));
  }

  newSession() {
    const all = this._sessions();
    const s = {
      id: rid(), title: '新造人', createdAt: Date.now(), updatedAt: Date.now(),
      messages: [{ role: 'assistant', text: '嗯，你来了。这一炉人形，我们一起捏。先告诉我：你希望"她"是个什么样的人？说个大概就行，细节我来问。', at: Date.now() }],
      draft: {},
    };
    all.sessions.unshift(s);
    this._saveSessions(all);
    return s;
  }

  deleteSession(id) {
    const all = this._sessions();
    all.sessions = (all.sessions || []).filter((s) => s.id !== id);
    this._saveSessions(all);
  }

  getSession(id) {
    return (this._sessions().sessions || []).find((s) => s.id === id) || null;
  }

  /** 把女娲本轮产出的增量合进会话草稿（分区合并，种子/样例追加） */
  _mergeDraft(base, p) {
    const out = base || {};
    for (const k of ['name', 'birthday', 'city', 'job', 'age', 'personaText', 'relationship', 'redLines', 'interests', 'assessments', 'appearance', 'favorites', 'inner', 'behavior']) {
      if (p[k] === undefined || p[k] === null) continue;
      if (typeof p[k] === 'object' && !Array.isArray(p[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = { ...out[k], ...p[k] };
      else out[k] = p[k];
    }
    if (p.quirks) {
      const q0 = out.quirks || {};
      out.quirks = { ...q0, ...p.quirks };
      if (Array.isArray(p.quirks.catchphrases) && p.quirks.catchphrases.length) out.quirks.catchphrases = p.quirks.catchphrases;
    }
    if (Array.isArray(p.memorySeeds) && p.memorySeeds.length) out.memorySeeds = [...(out.memorySeeds || []), ...p.memorySeeds].slice(-30);
    if (Array.isArray(p.styleExamples) && p.styleExamples.length) out.styleExamples = [...(out.styleExamples || []), ...p.styleExamples].slice(-6);
    return out;
  }

  /** 和女娲聊一轮：她回应+追问，同时把新确认的信息揉进草稿 */
  /**
   * 体检校准：读她现在的**人设 + 最近记忆 + 日记/流水 + 关系现状**，
   * 让女娲（或任何模型）指出"她哪里不像人设 / 哪里自相矛盾"，并给出可执行的修改建议。
   * 这是"女娲"在造人之后的新职责（用户拍板的重定位）。
   */
  async audit({ limit = 30 } = {}) {
    const persona = this.soul ? this.soul.getPersona() : {};
    const memories = (this.soul && this.soul.getMemories) ? (this.soul.getMemories().entries || []) : [];
    const ws = (() => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'world-state.json'), 'utf8')); } catch { return {}; } })();
    const rels = (this.soul && this.soul.getRelations) ? this.soul.getRelations() : {};
    const relLines = Object.keys(rels).slice(0, 5).map((k) => k + '：亲密度 ' + Math.round((rels[k] && rels[k].affection) || 0) + '／聊过 ' + ((rels[k] && rels[k].chats) || 0)).join(String.fromCharCode(10));
    const mem = memories.slice(-limit).map((m) => '- ' + (m.text || '')).join(String.fromCharCode(10));
    const sys = [
      '你是女娲，负责"体检"一个已经存在的人设。',
      '只输出一个 JSON 对象：{"summary":"一句总评","findings":[{"what":"问题","why":"为什么是问题","fix":"具体怎么改（可直接写进人设的话）"}]}',
      'findings 最多 5 条，按重要性排序；每条 40 字以内，说人话，别用术语。',
      '重点找这几类问题：①她说话/行为跟人设的性格（MBTI+背景）不符 ②她的过去前后矛盾或根本没说清 ③设定里互相打架（比如既内向又到处社交） ④设定空得没法演（背景只有一句） ⑤关系阶段与她的态度不匹配。',
      '没问题就给空数组，别硬凑。',
    ].join(String.fromCharCode(10));
    const user = [
      '【人设】' + JSON.stringify({
        name: persona.name, birthday: persona.birthday, age: persona.age, city: persona.city, job: persona.job,
        mbti: (persona.assessments || {}).mbti, traits: persona.traits, interests: persona.interests,
        catchphrases: (persona.quirks || {}).catchphrases, personaText: String(persona.personaText || '').slice(0, 300),
        past: (persona.profile || {}).past || {}, appearanceText: String((persona.profile || {}).appearanceText || '').slice(0, 200),
      }),
      '【关系现状】' + (relLines || '（还没有记录）'),
      '【她最近的日记】' + String(ws.diary || '（还没跑过世界引擎）').slice(0, 300),
      '【她最近的生活流水】' + (Array.isArray(ws.flow) ? ws.flow.map((f) => (f.time || '') + ' ' + (f.text || '')).join('；').slice(0, 300) : '（无）'),
      '【她最近记住的事】' + String.fromCharCode(10) + (mem || '（空）'),
      '(只输出 JSON)',
    ].join(String.fromCharCode(10));
    const r = await this._chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.3, maxTokens: 900 });
    const m = String(r.content || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('体检失败：模型没有输出 JSON');
    let d = null;
    try { d = JSON.parse(m[0]); } catch { throw new Error('体检失败：JSON 解析不了'); }
    return {
      summary: String(d.summary || '').slice(0, 200),
      findings: (Array.isArray(d.findings) ? d.findings : []).slice(0, 5).map((x, i) => ({
        id: 'f' + (i + 1),
        what: String((x && x.what) || '').slice(0, 80),
        why: String((x && x.why) || '').slice(0, 120),
        fix: String((x && x.fix) || '').slice(0, 200),
      })).filter((x) => x.what || x.fix),
      at: Date.now(),
    };
  }

  async chat({ sessionId, message, images } = {}) {
    const all = this._sessions();
    let s = (all.sessions || []).find((x) => x.id === sessionId);
    if (!s) { s = this.newSession(); all = this._sessions(); s = all.sessions.find((x) => x.id === s.id); }
    const text = String(message || '').slice(0, 4000);
    // 图片（多模态）：用户在女娲页上传，直接作为图片消息交给女娲的模型（用户拍板"直接给模型"）
    const imgs = (Array.isArray(images) ? images : []).slice(0, 4)
      .map((x) => ({ data: String((x && (x.data || x.dataUrl)) || ''), mime: String((x && x.mime) || 'image/png') }))
      .filter((x) => /^[A-Za-z0-9+/=]{50,}$/.test(x.data.slice(x.data.indexOf(',') + 1) || x.data));
    if (!text.trim() && !imgs.length) throw new Error('消息为空');
    s.messages.push({ role: 'user', text: text || '（发了一张图）', at: Date.now(), images: imgs.map((x) => ({ mime: x.mime })), imageCount: imgs.length });
    const sys = [
      '你是女娲——造人的神明。你正在和"家长"一起，亲手捏一个会被完整创造出来的女生（"她"）。',
      '你的说话方式：女娲的口吻（温柔、笃定、带点神明的俏皮，比如"这一撮性子，我给你揉进去了"），先简短回应对方上一句，然后聚焦追问。每轮只挖1~3个信息点，问题要具体（给出选项让他好回答），不空泛。',
      '你的挖掘清单（越细越好，缺什么挖什么，挖完一个领域就换下一个；对方明确说"跳过/就这样"就尊重）：',
      '① 身份：名字/生日星座/城市/职业/年龄/家庭背景',
      '② 性格：外向·温柔·粘人·嘴碎·主动 五维、说话风格（句长/语气词/emoji习惯）、口头禅、小怪癖',
      '③ 人格测评：MBTI与荣格八维排序/大五/九型+翼型+本能副型（对方没测就按描述推一套并请他确认）',
      '④ 喜好与雷点：喜欢的食物音乐地方事物、讨厌的东西、雷点',
      '⑤ 内心：最核心的欲望、最深的恐惧、价值观（金钱/爱情）、关系期待',
      '⑥ 外貌（为生图打底）：**要写成一段自然语言的描述**（长相气质/发型发色/穿衣风格/身材揉成一段话），别只给五个词；如果家长发了照片，就按照片里看到的样子写。注意：现在外貌主要由「形象工坊」按定稿图自动生成，这里只在还没有照片时才需要你写。',
      '⑨ 她的过去（**现在最重要的活**）：她必须"有自己的过去，但不会一次说完"。你要像访谈一样问：老家/父母/兄弟姐妹/家里氛围 → 读书与专业/换过什么工作/为什么做现在这份 → 谈过恋爱吗/被谁伤过 → 最怕什么/最想要什么/有什么一直没做成的事。然后把这些整理成三段：',
      '   · pastSurface 表层（职业/城市/日常喜好这类，刚认识就该知道的）',
      '   · pastMiddle 中层（家庭大概、工作里的遭遇、朋友关系、一般经历）',
      '   · pastDeep 深层（创伤/心结/真正的梦想/重大经历——只说给她信任的人）',
      '   原则：不要追问得太狠（家长说跳过就跳过）；不清楚的就说"这段先留白，等你想清楚再补"，不要替她编。',
      '注意分工：**关系定位/称呼分寸/兴趣演化现在由世界引擎每晚判断**，你别再写 toOwner 这类定位；称呼只问"她希望他怎么叫她"。',
      '⑦ 记忆种子：家长和她之间该被永远记住的事（约定/纪念日/偏好/共同事件）',
      '⑧ 行为：回复速度/每天主动找家长的次数/作息',
      '【当前草稿】（已确认的信息都在这里，别重复问）：',
      JSON.stringify(s.draft || {}),
      '【输出格式】只输出一个JSON对象：{"reply":"女娲本轮的话","draft":{只含本轮新确认/修改的增量字段}}。draft 的分区：name/birthday/city/job/age/personaText/quirks{catchphrases,emojiRate,maxLength}/relationship{toOwner,callOwner,ownerCallsMe}/redLines/interests/assessments{mbti}/appearanceText(一段话)/past{surface,middle,deep}(她的过去三层，每层一段话)/favorites{like,dislike,food,music,place}/inner{desire,fear,values,quirk}/styleExamples/memorySeeds/behavior{behavior,life}。没有新增就 draft:{}。reply 里绝不要展示JSON或复述整个草稿。',
    ].join('\n');
    const history = s.messages.slice(-16);
    const msgs = [{ role: 'system', content: sys }, ...history.map((m, idx) => {
      const isLastUserWithImg = m.role === 'user' && idx === history.length - 1 && imgs.length;
      if (!isLastUserWithImg) return { role: m.role === 'user' ? 'user' : 'assistant', content: m.text };
      return { role: 'user', content: [
        { type: 'text', text: m.text || '（看看这几张图）' },
        ...imgs.map((im) => ({ type: 'image_url', image_url: { url: im.data.indexOf('data:') === 0 ? im.data : ('data:' + im.mime + ';base64,' + im.data) } })),
      ] };
    })];
    const r = await this._chat(msgs, { temperature: 0.7, maxTokens: 1200 });
    const m = String(r.content || '').match(/\{[\s\S]*\}/);
    let reply = String(r.content || '').trim();
    let patch = {};
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        reply = String(parsed.reply || '').trim() || reply;
        patch = parsed.draft && typeof parsed.draft === 'object' ? parsed.draft : {};
      } catch { /* 整段当回复 */ }
    }
    s.draft = this._mergeDraft(s.draft || {}, patch);
    s.messages.push({ role: 'assistant', text: reply, at: Date.now() });
    s.updatedAt = Date.now();
    if (s.title === '新造人') {
      const firstUser = s.messages.find((x) => x.role === 'user');
      if (firstUser) s.title = firstUser.text.slice(0, 12);
    }
    this._saveSessions(all);
    return { reply, draft: s.draft, sessionId: s.id };
  }
}

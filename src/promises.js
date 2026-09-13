// promises.js —— 承诺闭环（批 E3 / A8）
//
// 问题：她会答应你事（"周末把读后感讲给你听"、"明天提醒你带伞"），但答应完就飘了。
//       以前记忆条目上有个 todo 字段，写了却**没有任何读取点**——等于答应了没人记得。
//
// 这个模块是"到期"职责的**唯一权威**：新模块、独立状态文件（promises.json）、
// 复用现有 60 秒心跳，不新建定时器、不并入 life.js（life 的状态每天跨日重置，承诺必须跨天）。
//
// 三件事：
//   ① maybeExtract：每轮回复后（火后不管）用便宜模型抽出"她答应了什么 / 哪天 / 她反悔了什么"
//   ② tick：心跳里检查到没到期；她睡着就推到起床后；每条只主动提一次
//   ③ view/action：后台看得见、能取消/改期/补提（禁黑盒）
//
// 成本：只在主人轮次触发，一次约 0.001~0.003 元；解析失败不重试，等下一轮。
import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from './model-router.js';

/** 每天最多主动提几条承诺（写死，不做后台旋钮：防极端情况下刷屏） */
export const MAX_REMINDERS_PER_DAY = 3;
/** 过期这么久还没兑现 → 归为 missed，不再自动发（后台可手动补提） */
export const MISS_AFTER_MS = 72 * 3600 * 1000;
/** 与上一条消息的最小间隔（只防"两条挤在同一分钟"，不引入配额） */
export const COLLIDE_MS = 10 * 60 * 1000;

function dayKey(d) {
  const x = d instanceof Date ? d : new Date(d || Date.now());
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

/** 同一天内恒定的抖动（重启也不变）：用它把"起床后 15~45 分钟"摊开，避免每天都在同一分钟 */
function hash01(seed) {
  let h = 2166136261;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

function hm(t, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t));
  if (!m) return fallback;
  return Math.max(0, Math.min(23, Number(m[1]))) * 60 + Math.max(0, Math.min(59, Number(m[2])));
}

const SYS = '你是"她"（一个女生）的记事本。这次只做一件事：从刚结束的这段微信对话里，找出**她答应过的事**。'
  + '只输出一个 JSON 对象，不要解释：{"add":[{"text":"她答应的具体内容","kind":"self或remind","due":"YYYY-MM-DD","time":"HH:MM或null"}],"cancel":["要取消的编号"]}。'
  + '规则：'
  + '① text 用她的第一人称、40 字内（例：周末把那本书的读后感讲给他听）。'
  + '② kind：self=她答应自己要做的事或要给的东西；remind=她答应到点提醒他的事。'
  + '③ due 必填，必须是**绝对日期**（把"明天/周末/下周三"算成日期）；**说不清具体日子就别登记**，不要猜。没有到期日的不是承诺。'
  + '④ 只有在对话里明确出现"算了我不用了/不用提醒了"这类反悔、并且能对上下面的编号时，才把它填进 cancel。'
  + '⑤ 没有承诺就输出 {"add":[],"cancel":[]}。日常寒暄、闲聊、没说定的事都不算。';

export class Promises {
  constructor({ dir, soul, config, logger, activity } = {}) {
    this.dir = dir;
    this.soul = soul || null;
    this.cfgGet = typeof config === 'function' ? config : () => ({});
    this.log = typeof logger === 'function' ? logger : () => {};
    this.activity = typeof activity === 'function' ? activity : () => {};
    this._busy = false;
  }

  _file() { return path.join(this.dir, 'promises.json'); }

  _empty() {
    return { version: 1, items: [], done: [], lastSentAt: 0, lastExtractAt: 0, lastExtractOk: true, extractNote: '' };
  }

  _read() {
    try {
      const v = JSON.parse(fs.readFileSync(this._file(), 'utf8'));
      const base = this._empty();
      return {
        ...base,
        ...v,
        items: Array.isArray(v && v.items) ? v.items : [],
        done: Array.isArray(v && v.done) ? v.done : [],
      };
    } catch { return this._empty(); }
  }

  /** 原子写（tmp + rename）：写到一半断电也不会留下半截 JSON */
  _write(v) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this._file();
      const tmp = f + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
      fs.renameSync(tmp, f);
      return true;
    } catch (err) {
      this.log('[promises] 写队列失败: ' + (err && err.message));
      return false;
    }
  }

  _normText(s) { return String(s == null ? '' : s).replace(/[\s，。！？、；：""''（）()【】…~—\-·]/g, ''); }

  /** 待兑现（按到期时间排序） */
  list() {
    return this._read().items.filter((x) => x && x.status === 'pending').sort((a, b) => (a.dueTs || 0) - (b.dueTs || 0));
  }

  /** 后台视图 */
  view() {
    const v = this._read();
    return {
      items: v.items.slice().sort((a, b) => (a.dueTs || 0) - (b.dueTs || 0)),
      done: v.done.slice(-30),
      lastExtractAt: v.lastExtractAt || 0,
      lastExtractOk: v.lastExtractOk !== false,
      extractNote: v.extractNote || '',
      todaySent: v.items.filter((x) => x.status === 'sent' && x.sentAt && dayKey(x.sentAt) === dayKey(new Date())).length
        + v.done.filter((x) => x.status === 'sent' && x.sentAt && dayKey(x.sentAt) === dayKey(new Date())).length,
      maxPerDay: MAX_REMINDERS_PER_DAY,
    };
  }

  /** 抽取用的候选链：和记忆提炼/发前自检同一条（cfg.chain.memory） */
  _chain() {
    const c = (this.cfgGet() || {}).chain || {};
    return (Array.isArray(c.memory) ? c.memory : []).filter((x) => x && x.baseURL && x.model);
  }

  _parse(out) {
    const m = String(out || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const o = JSON.parse(m[0]);
      return (o && typeof o === 'object') ? o : null;
    } catch { return null; }
  }

  /**
   * 每轮之后抽一次（火后不管，绝不阻塞回复）。
   * 只在主人轮次跑：普通联系人抽了也没人送，还白花钱。
   */
  async maybeExtract({ peerKey, isOwner, userText, herTexts } = {}) {
    if (!isOwner) return { skipped: 'not-owner' };
    const chain = this._chain();
    const v0 = this._read();
    if (!chain.length) {
      // 没配抽取模型：整条链路静默停用，但在后台写明原因（不报错刷屏）
      if (v0.extractNote !== '没有配置记忆提炼模型，承诺抽取未启用') {
        v0.lastExtractAt = Date.now(); v0.lastExtractOk = false; v0.extractNote = '没有配置记忆提炼模型，承诺抽取未启用';
        this._write(v0);
      }
      return { skipped: 'no-chain' };
    }
    const pend = v0.items.filter((x) => x && x.status === 'pending').slice(0, 10);
    const list = pend.map((x, i) => (i + 1) + '. [' + (x.kind === 'remind' ? '提醒他' : '她要做') + '] ' + x.text + '（说好 ' + x.due + (x.time ? ' ' + x.time : '') + '）').join(String.fromCharCode(10));
    const now = new Date();
    const wk = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const q = '【今天是】' + dayKey(now) + '（周' + wk + '）现在 ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
      + String.fromCharCode(10) + String.fromCharCode(10)
      + (list ? ('【她还没兑现的（编号对应 cancel）】' + String.fromCharCode(10) + list + String.fromCharCode(10) + String.fromCharCode(10)) : '')
      + '【他刚说】' + String(userText || '').slice(0, 800) + String.fromCharCode(10) + String.fromCharCode(10)
      + '【她刚回】' + (Array.isArray(herTexts) ? herTexts.join(' ').slice(0, 600) : '');
    let out = null; let by = '';
    for (const c of chain) {
      try {
        const r = await chatCompletion({
          baseURL: c.baseURL, apiKey: c.apiKey || '', model: c.model,
          messages: [{ role: 'system', content: SYS }, { role: 'user', content: q }],
          temperature: 0, maxTokens: 220, timeoutMs: 12000,
        });
        out = this._parse(r && r.content);
        if (out) { by = c.model; break; }
      } catch { /* 这个候选挂了，换下一个 */ }
    }
    const v = this._read();
    v.lastExtractAt = Date.now();
    v.lastExtractOk = !!out;
    v.extractNote = out ? ('上次抽取成功（' + by + '）') : '上次抽取失败（解析不出来，等下一轮）';
    if (!out) { this._write(v); return { ok: false }; }

    let added = 0; let cancelled = 0; let dropped = 0;
    const nowMs = Date.now();
    // ① 反悔（按编号对回 pending）
    for (const c of (Array.isArray(out.cancel) ? out.cancel : [])) {
      const idx = Number(String(c).replace(/[^\d]/g, '')) - 1;
      const it = pend[idx];
      if (!it) continue;
      const t = v.items.find((x) => x.id === it.id);
      if (!t || t.status !== 'pending') continue;
      t.status = 'cancelled';
      t.cancelReason = '她自己反悔（这一轮说不用了）';
      v.done.push(t); v.items = v.items.filter((x) => x.id !== t.id);
      cancelled += 1;
    }
    // ② 新承诺
    for (const a of (Array.isArray(out.add) ? out.add : [])) {
      const text = String((a && a.text) || '').trim().slice(0, 60);
      if (text.length < 2) continue;
      const due = String((a && a.due) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) { dropped += 1; continue; }
      const time = (a && a.time && /^\d{1,2}:\d{2}$/.test(String(a.time).trim())) ? String(a.time).trim() : null;
      const [Y, M, D] = due.split('-').map(Number);
      const [hh, mm] = time ? time.split(':').map(Number) : [9, 0];
      const dueTs = new Date(Y, M - 1, D, hh || 9, mm || 0).getTime();
      if (dueTs < nowMs - 60 * 60 * 1000) {
        dropped += 1;
        this.activity('[承诺] 抽取出的日期算到了过去（' + due + '），已丢弃');
        continue;
      }
      const kind = (String((a && a.kind) || '') === 'remind') ? 'remind' : 'self';
      const nt = this._normText(text);
      const dup = v.items.find((x) => x && x.status === 'pending'
        && (this._normText(x.text) === nt || (x.due === due && this._normText(x.text).slice(0, 12) === nt.slice(0, 12))));
      if (dup) { dup.dupCount = (dup.dupCount || 1) + 1; continue; }   // 连着三轮说同一件事，只留一条
      v.items.push({
        id: 'p_' + Math.random().toString(36).slice(2, 8),
        text, kind, due, time, dueTs,
        createdAt: nowMs, roundTs: nowMs, peerKey: String(peerKey || ''), isOwner: true,
        quote: String(userText || '').slice(0, 60),
        status: 'pending', sentAt: 0, deferUntil: 0, attempts: 0, dupCount: 1, cancelReason: '',
      });
      added += 1;
    }
    this._write(v);
    if (added) this.activity('[承诺] 登记了 ' + added + ' 条她答应的事');
    if (cancelled) this.activity('[承诺] 她自己反悔了 ' + cancelled + ' 条');
    return { ok: true, added, cancelled, dropped, by };
  }

  /**
   * 心跳里每 60 秒走一次（方案里的判定表，按序）。
   * 需要外部给：isAsleep（与生活系统同一把睡眠尺子）、wake（今天起床 HH:MM）、
   * send（把 1~2 条发出去的闭包）、lastPokeAt（只读借用，不代写）。
   */
  async tick({ isAsleep, wake, send, lastPokeAt } = {}) {
    if (this._busy) return { skipped: 'busy' };
    const v = this._read();
    const pend = v.items.filter((x) => x && x.status === 'pending');
    if (!pend.length) return { skipped: 'empty' };          // ① 零开销
    const now = Date.now();
    // ⑦ 过期兜底：拖过 72 小时就归 missed，不再自动发
    let moved = 0;
    for (const it of pend.slice()) {
      if (now - (it.dueTs || 0) > MISS_AFTER_MS) {
        it.status = 'missed';
        v.done.push(it);
        v.items = v.items.filter((x) => x.id !== it.id);
        moved += 1;
        this.activity('[承诺] 「' + String(it.text).slice(0, 20) + '」拖过 3 天没兑现，已归为过期（后台可补提）');
      }
    }
    if (moved) this._write(v);
    const live = v.items.filter((x) => x && x.status === 'pending' && now >= (x.dueTs || 0));
    if (!live.length) return { skipped: 'not-due' };
    // ② 睡眠硬闸：她在睡就推到起床后（与生活系统共用同一把睡眠尺子）
    if (typeof isAsleep === 'function' && isAsleep()) {
      let changed = false;
      for (const it of live) {
        const d = this._deferTo(it, wake, now);
        if (it.deferUntil !== d) { it.deferUntil = d; changed = true; }
      }
      if (changed) this._write(v);
      return { skipped: 'asleep' };
    }
    // ④ 碰撞保护：和上一条消息至少隔 10 分钟
    const last = Math.max(Number(v.lastSentAt) || 0, Number(lastPokeAt) || 0);
    if (now - last < COLLIDE_MS) return { skipped: 'collide' };
    // 每日上限
    const sentToday = v.items.concat(v.done).filter((x) => x.status === 'sent' && x.sentAt && dayKey(x.sentAt) === dayKey(new Date())).length;
    if (sentToday >= MAX_REMINDERS_PER_DAY) return { skipped: 'daily-cap' };
    const it = live.filter((x) => !x.deferUntil || now >= x.deferUntil)[0];
    if (!it) return { skipped: 'deferred' };
    // ⑤ 发送：让她自己说（走她平时那套语气、拆条、延迟）
    this._busy = true;
    try {
      const out = await this.soul.proactive('promise', { promise: it });
      const chunks = (out && out.chunks) || [];
      if (!chunks.length) throw new Error('没有生成内容');
      if (typeof send === 'function') await send(chunks, (out && out.delaysMs) || []);
      it.status = 'sent'; it.sentAt = now;
      v.done.push(it);
      v.items = v.items.filter((x) => x.id !== it.id);
      v.lastSentAt = now;
      this._write(v);
      this.activity('[承诺] 到期提起：' + String(it.text).slice(0, 24));
      return { ok: true, id: it.id };
    } catch (err) {
      // ⑥ 发失败：记一笔、保持待兑现，下一跳再试；当日累计 3 次就当天不再试
      it.attempts = (it.attempts || 0) + 1;
      if (dayKey(it.lastTryAt || 0) !== dayKey(now)) it.attemptsToday = 0;
      it.attemptsToday = (it.attemptsToday || 0) + 1;
      it.lastTryAt = now;
      this._write(v);
      this.activity('[承诺] 到期提醒没发出去：' + ((err && err.message) || '未知').slice(0, 40));
      return { skipped: 'send-failed' };
    } finally { this._busy = false; }
  }

  /** 在睡：推到"今天起床 + 15~45 分钟"；如果起床时刻已经过了，就 now + 3 分钟 */
  _deferTo(it, wake, now) {
    const wk = hm(wake, 8 * 60);
    const d = new Date(now);
    const wakeTs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(wk / 60), wk % 60, 0, 0).getTime();
    if (wakeTs > now) {
      const jitter = 15 + Math.floor(hash01(dayKey(d) + it.id) * 30);   // 15~45 分钟，同一天恒定
      return wakeTs + jitter * 60000;
    }
    return now + 3 * 60000;
  }

  /** 后台操作：取消 / 改期 / 补提一次 */
  action({ id, op, due, reason } = {}) {
    const v = this._read();
    const it = v.items.find((x) => x && x.id === id) || v.done.find((x) => x && x.id === id);
    if (!it) return { ok: false, error: '没有这条承诺（可能已经被清理）' };
    if (op === 'cancel') {
      it.status = 'cancelled';
      it.cancelReason = String(reason || '后台手动取消').slice(0, 60);
      v.items = v.items.filter((x) => x.id !== id);
      if (!v.done.some((x) => x.id === id)) v.done.push(it);
      this._write(v);
      this.activity('[承诺] 后台取消了「' + String(it.text).slice(0, 20) + '」');
      return { ok: true };
    }
    if (op === 'reschedule') {
      const d2 = String(due || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d2)) return { ok: false, error: '请用 YYYY-MM-DD 的日期' };
      const [Y, M, D] = d2.split('-').map(Number);
      const [hh, mm] = it.time ? it.time.split(':').map(Number) : [9, 0];
      it.due = d2; it.dueTs = new Date(Y, M - 1, D, hh || 9, mm || 0).getTime();
      it.deferUntil = 0; it.attemptsToday = 0;
      if (it.status === 'missed') { it.status = 'pending'; if (!v.items.some((x) => x.id === id)) v.items.push(it); v.done = v.done.filter((x) => x.id !== id); }
      this._write(v);
      this.activity('[承诺] 后台把「' + String(it.text).slice(0, 20) + '」改到 ' + d2);
      return { ok: true };
    }
    if (op === 'remind') {
      // 补提一次：不管状态，重新放回队列并立刻可发
      it.status = 'pending'; it.dueTs = Date.now() - 1000; it.deferUntil = 0; it.attemptsToday = 0;
      if (!v.items.some((x) => x.id === id)) v.items.push(it);
      v.done = v.done.filter((x) => x.id !== id);
      this._write(v);
      this.activity('[承诺] 后台让它补提一次：' + String(it.text).slice(0, 20));
      return { ok: true };
    }
    return { ok: false, error: 'op 只能是 cancel / reschedule / remind' };
  }

  /** 后台调试：跑一次抽取但不入队（防"抽没抽到"变成黑盒） */
  async testExtract(dialogue) {
    const chain = this._chain();
    if (!chain.length) return { ok: false, error: '没有配置记忆提炼模型（承诺抽取走的就是它）' };
    const now = new Date();
    const wk = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const q = '【今天是】' + dayKey(now) + '（周' + wk + '）' + String.fromCharCode(10) + String.fromCharCode(10) + '【对话】' + String(dialogue || '').slice(0, 1400);
    for (const c of chain) {
      try {
        const r = await chatCompletion({
          baseURL: c.baseURL, apiKey: c.apiKey || '', model: c.model,
          messages: [{ role: 'system', content: SYS }, { role: 'user', content: q }],
          temperature: 0, maxTokens: 220, timeoutMs: 12000,
        });
        const o = this._parse(r && r.content);
        if (o) return { ok: true, by: c.model, parsed: o };
      } catch { /* 换下一个 */ }
    }
    return { ok: false, error: '抽取调用失败（或返回解析不出来）' };
  }
}

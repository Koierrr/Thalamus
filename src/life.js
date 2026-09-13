// life.js — 她的生活调度器
// 作息表 + 早晚安 + 日常分享（pokes）+ "等急了"升级链（nudge）。
// 所有触发按"日期+种类"去重（重启不重复发），抖动按日期确定性计算（像真人一样不整点发）。
// 本模块只决定"什么时候发什么"，怎么生成（soul.proactive）和怎么送出（sendToOwner）由外部注入。
//
// 2026-09-12 修复（"下午两点她说晚安"）：
//   旧逻辑是 `if (现在 >= 目标时刻) 就发`，没有上界 →
//     ① 下午 2 点打开插件，早安（目标 08:00）和晚安（目标 02:00）会同时补发；
//     ② 睡觉时间填 02:00（次日凌晨）被当成"当天 02:00"，于是从凌晨 2 点起一整天都算"该睡了"。
//   新逻辑：每个问候都有**时间窗**（支持跨天），窗口内才发；错过了就跳过并写明原因（不补发历史问候）。
//   另外：主动消息现在受两个新约束——安静时段（不打扰你）与关系阶段（刚认识就不该天天来找你）。

import fs from 'node:fs';
import path from 'node:path';

function hm(s) { const p = String(s || '').split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }
function dayKey(now) {
  const y = now.getFullYear(); const m = String(now.getMonth() + 1).padStart(2, '0'); const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
const wrap = (m) => ((Math.round(m) % 1440) + 1440) % 1440;

/**
 * 把"中心时刻 + 前后留白"变成一个跨天安全的区间。
 * end 可以 >1440，表示窗口跨到次日（睡觉时间填 02:00 时就是这样）。
 */
export function windowOf(centerMin, backMin, aheadMin) {
  const start = wrap(centerMin - backMin);
  return { start, end: start + backMin + aheadMin, center: wrap(centerMin) };
}
/** 现在（分钟，0~1439）是否落在窗口里（支持跨天） */
export function inWindowAt(nowMin, win) {
  const cur = wrap(nowMin);
  if (cur >= win.start && cur <= win.end) return true;
  if (win.end > 1440 && cur + 1440 >= win.start && cur + 1440 <= win.end) return true;
  return false;
}
/**
 * 相对窗口的位置：'before'（还没到）| 'in'（就在窗口里）| 'after'（错过了）
 * 用"从窗口起点往前走多少分钟"做环状判断（窗口可能跨天，直接比大小会算错）。
 */
export function windowPhase(nowMin, win) {
  const span = Math.max(0, win.end - win.start);
  const off = (((wrap(nowMin) - win.start) % 1440) + 1440) % 1440;
  if (off <= span) return 'in';
  const justPast = off - span;
  const untilNext = 1440 - off;
  return justPast < untilNext ? 'after' : 'before';
}

/**
 * 绝对时间版窗口判断（跨天安全）——Life.tick 用这个。
 * 上面那套 windowOf/windowPhase 是"同一天内的分钟数"比较，跨天场景（比如 02:00 睡）会算错：
 * 早上 7 点会被判成"已错过晚安窗口"，于是当晚的晚安永远不会发。这里改成绝对时间戳：
 *   · center = 今天(或次日)的那个时刻
 *   · crossFrom 给定时（睡觉时间在凌晨的情形）：如果现在已经过了这个"属于昨夜"的时刻，
 *     说明中心时刻其实在次日 → 推一天，避免把它当成"已经过去"。
 */
export function absWindowPhase(now, centerMin, backMin, aheadMin, crossFrom) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let center = base + centerMin * 60000;
  if (crossFrom != null && nowMin >= crossFrom) center += 86400000;
  const start = center - backMin * 60000;
  const end = center + aheadMin * 60000;
  if (now.getTime() < start) return 'before';
  if (now.getTime() <= end) return 'in';
  return 'after';
}

export class Life {
  constructor(options = {}) {
    this.dir = options.dir || '.';
    this._cfgGet = typeof options.config === 'function' ? options.config : () => options.config || {};
    this.log = options.logger || (() => {});
    this._file = path.join(this.dir, 'life-state.json');
  }

  cfgLife() {
    const c = this._cfgGet().life || {};
    return {
      enabled: c.enabled !== false,
      wake: c.wake || '08:30',
      sleep: c.sleep || '23:30',
      morningOn: c.morningOn !== false,
      nightOn: c.nightOn !== false,
      insomnia: c.insomnia === true,   // 今晚失不失眠（世界引擎写，决定她说了晚安后还醒多久）
      pokesPerDay: Number(c.pokesPerDay) || 2,
      pokeWindow: Array.isArray(c.pokeWindow) && c.pokeWindow.length === 2 ? c.pokeWindow : ['10:00', '22:00'],
      nudgeMinutes: Number(c.nudgeMinutes) || 20,
      nudgeMaxPerDay: Number(c.nudgeMaxPerDay) || 1,
      // 世界引擎给的主动上限（只能收紧最多几条，不再是配额）
      stageLimit: null,
      // 事件驱动分享要用的输入（index.js 注入）
      flow: Array.isArray(c.flow) ? c.flow : [],
      traits: (c.traits && typeof c.traits === 'object') ? c.traits : {},
      battery: c.battery == null ? null : Number(c.battery),
      mood: c.mood == null ? null : Number(c.mood),
    };
  }

  _state() { try { return JSON.parse(fs.readFileSync(this._file, 'utf8')); } catch { return {}; } }
  _save(s) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this._file, JSON.stringify(s, null, 2), 'utf8'); }

  /** 主人来消息了：清掉"等急了"的等待态 */
  noteOwnerActivity() {
    this._ownerActiveAt = Date.now();
    const s = this._state();
    if (s.pendingSince) { delete s.pendingSince; this._save(s); }
  }

  /** 确定性抖动：同一天同一触发，偏移固定（重启不重发、不整点） */
  _jitterFor(kind, now, minutes) {
    if (!minutes) return 0;
    const h = hashStr(dayKey(now) + ':' + kind);
    return (h % (2 * minutes + 1)) - minutes;
  }

  /** 同一天同一个 key 恒定的 0~1 随机数（"今天要不要说这件事"用它，避免每分钟重掷变成抽奖机） */
  _unitFor(kind, now) {
    const h = hashStr(dayKey(now) + '::' + kind);
    return (Math.abs(h) % 1000) / 1000;
  }

  /**
   * 她今天有多想说话（0~1）——主动分享的"冲动门"。
   * 由性格（发起力/依恋）+ 当天社交电量 + 心情决定：电量低、心情差 → 她今天就是不想理人。
   */
  _impulse(cfg = {}) {
    const t = cfg.traits || {};
    const num = (v, d) => (v == null || !isFinite(Number(v)) ? d : Number(v));
    const init = num(t.initiative, 50);
    const att = num(t.attachment, 50);
    const batt = num(cfg.battery, 60);
    const mood = num(cfg.mood, 60);
    const v = 0.15 + init / 400 + att / 800 + (batt - 50) / 300 + (mood - 50) / 300;
    return Math.max(0.05, Math.min(0.9, v));
  }

  /**
   * 夜间三态（第三次改版）：清醒 → 准备睡（说了晚安，还在刷手机）→ 真睡着
   * 她说了晚安≠立刻睡：收拾/刷手机/失眠都可能拖很久。多久真睡着由世界引擎的 insomnia 决定。
   */
  /** 算出"就寝三态"的字段（纯函数，不存盘——由调用方一起保存，避免被同 tick 的后续保存覆盖） */
  bedtimeFields(now, cfg = {}) {
    const t = (now instanceof Date ? now : new Date()).getTime();
    const insomnia = cfg.insomnia === true;
    const lo = insomnia ? 60 : 15;
    const hi = insomnia ? 120 : 45;
    const dur = Math.round((lo + Math.random() * (hi - lo)) * 60000);
    return { bedPhase: 'preparing', bedAt: t, bedDue: t + dur, bedInsomnia: insomnia };
  }

  /**
   * 现在这一刻，按她今天的作息，她**该不该在睡**（2026-09-13 加）。
   *
   * 为什么需要它：原来的夜间三态要求"她先发出晚安"才启动，于是只要那晚没发晚安
   * （世界引擎说不用发 / 电脑没开错过窗口 / 旧剧本没这个字段），她就**永远醒着**——
   * 用户实测"显示今天 01:10 睡，6 点找她照样秒回"。
   * 现在：**睡觉时间 +45 分钟**（容错：她可能刷会儿手机才真睡）到**起床时间**之间，
   * 一律算睡着，不再依赖她发过晚安。
   */
  _isAsleepByClock(now, cfg = {}) {
    const c = { ...this.cfgLife(), ...cfg };
    const cur = now.getHours() * 60 + now.getMinutes();
    const sleepMin = hm(c.sleep);
    const wakeMin = hm(c.wake);
    const hard = (sleepMin + 45) % 1440; // 入睡兜底时刻
    if (hard === wakeMin) return false;  // 区间为空（作息填得自相矛盾）→ 不判睡着
    // 跨天区间判断：hard <= wakeMin 时是 [hard, wakeMin)，否则是 [hard, 24h) ∪ [0, wakeMin)
    return hard <= wakeMin ? (cur >= hard && cur < wakeMin) : (cur >= hard || cur < wakeMin);
  }

  /** 现在是不是她的"白天"（起床时间 ~ 睡觉时间）。用来判断该不该把她从"睡着"叫醒，
   *  不然晚上 23:40（她 23:00 睡、已经进入睡前准备）会被误判成"早上了该醒"。 */
  _isDaytime(now, cfg = {}) {
    const c = { ...this.cfgLife(), ...cfg };
    const cur = now.getHours() * 60 + now.getMinutes();
    const wakeMin = hm(c.wake);
    const sleepMin = hm(c.sleep);
    return wakeMin <= sleepMin ? (cur >= wakeMin && cur < sleepMin) : (cur >= wakeMin || cur < sleepMin);
  }

  /** 对外：她现在是不是睡着的（tick 与 index.js 的回复闸门都用它） */
  isAsleepNow(now, cfg = {}) {
    const n = now instanceof Date ? now : new Date();
    const s = this._state();
    if (s.bedPhase === 'asleep' && !this._isAsleepByClock(n, cfg)) return false; // 起床时间到了 → 已醒
    if (s.bedPhase === 'asleep') return true;
    return this._isAsleepByClock(n, cfg);
  }

  /** 当前夜间状态：awake / preparing / asleep（每次 tick 或读取时自动推进） */
  nightPhase(now, cfg = {}) {
    const t = (now instanceof Date ? now : new Date()).getTime();
    const s = this._state();
    if (s.bedPhase === 'preparing' && s.bedDue && t >= s.bedDue) {
      s.bedPhase = 'asleep';
      this._save(s);
    }
    // 时间表兜底（2026-09-13）：到点就是睡着/醒来，不再依赖她发过晚安、也不依赖早上发过早安
    const byClock = this._isAsleepByClock(now instanceof Date ? now : new Date(), cfg);
    if (byClock && s.bedPhase !== 'asleep') {
      s.bedPhase = 'asleep';
      s.bedAt = s.bedAt || t;
      this._save(s);
    } else if (s.bedPhase === 'asleep' && this._isDaytime(now instanceof Date ? now : new Date(), cfg)) {
      // 天亮了（进了她的白天）→ 自动醒，不依赖她早上发过早安
      s.bedPhase = 'awake';
      s.bedAt = 0;
      s.bedDue = 0;
      this._save(s);
    }
    return s.bedPhase || 'awake';
  }

  /** 她睡着时你来消息了：记一笔，第二天早上她会自己提（"昨晚我断片了"） */
  markSleptThrough() {
    const s = this._state();
    s.morningCatchup = true;
    this._save(s);
    return true;
  }

  /** 取一次"昨晚断片"提示（只给一次） */
  consumeMorningCatchup() {
    const s = this._state();
    if (!s.morningCatchup) return false;
    s.morningCatchup = false;
    this._save(s);
    return true;
  }

  _inWindow(now, w) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const A = hm(w[0]); const B = hm(w[1]);
    if (A === B) return true; // 00:00-00:00 视为全天
    return A <= B ? (cur >= A && cur <= B) : (cur >= A || cur <= B);
  }

  /** 安静时段（她不该打扰你的时间） */
  isQuiet(now, quietHours) {
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(String(quietHours || '').trim());
    if (!m) return false;
    return this._inWindow(now, [m[1], m[2]]);
  }

  /**
   * 心跳：每次调用检查所有触发。now 可注入（测试用）。
   * 返回实际发出的消息列表 [{kind, text}]。
   */
  /** 解析世界引擎给的"明天大概什么时候想找他"（如 16:00 前后 / 通勤路上 17:30）→ 分钟数；没有就 null */
  _parseProactiveAt(txt) {
    const m = /(\d{1,2}):(\d{2})/.exec(String(txt || ''));
    if (!m) return null;
    const h = Number(m[1]); const mi = Number(m[2]);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return h * 60 + mi;
  }

  async tick(args = {}) {
    const soul = args.soul;
    const sendToOwner = args.sendToOwner;
    const now = args.now || new Date();
    const cfg = { ...this.cfgLife(), ...(args.overrides || {}) };
    const sent = [];
    if (!cfg.enabled || !soul || !sendToOwner) return sent;

    const s = this._state();
    if (s.date !== dayKey(now)) {
      s.date = dayKey(now); s.morning = false; s.night = false; s.pokes = 0; s.nudges = 0;
      s.bedPhase = 'awake'; s.bedAt = 0; s.bedDue = 0;
      s.backupDone = false; delete s.pendingSince; s.skipped = {}; delete s.claimedPokesOff;
      delete s.usedFlow; delete s.lastPokeAt;
    }

    const cur = now.getHours() * 60 + now.getMinutes();
    const lim = cfg.stageLimit || null;
    const allowMorning = !lim || lim.morning !== false;
    const allowNight = !lim || lim.night !== false;
    // 分享/催的上限：世界引擎给的 + 后台设的，取小（只是"最多几条"的天花板，不再是"必须发满 N 条"的配额）
    const maxPokes = lim && lim.pokes != null ? Math.min(cfg.pokesPerDay, lim.pokes) : (lim ? 0 : cfg.pokesPerDay);
    const maxNudges = lim && lim.nudges != null ? Math.min(cfg.nudgeMaxPerDay, lim.nudges) : (lim ? 0 : cfg.nudgeMaxPerDay);

    const skip = (what, why) => { s.skipped = { ...(s.skipped || {}), [what]: why }; };

    // ── 她已经睡着了：一条主动消息都不发（2026-09-13 起不依赖"发过晚安"）──
    if (this.isAsleepNow(now, cfg)) {
      if (s.bedPhase !== 'asleep') { s.bedPhase = 'asleep'; s.bedAt = s.bedAt || now.getTime(); this._save(s); }
      skip('all', '她已经睡了（' + String(cfg.sleep || '') + ' 睡 / ' + String(cfg.wake || '') + ' 起）——睡着不打扰');
      this._save(s);
      return sent;
    }

    const doSend = async (kind, extra = {}) => {
      const r = await soul.proactive(kind, extra);
      for (let i = 0; i < r.chunks.length; i++) {
        const d = i < r.delaysMs.length ? Math.min(r.delaysMs[i], 4000) : 500;
        if (d > 0) await new Promise((res) => setTimeout(res, d));
        await sendToOwner(String(r.chunks[i]).slice(0, 2000));
        sent.push({ kind, text: r.chunks[i] });
      }
    };

    // ── 早安：起床时刻 ±25min 抖动；窗口 = 起床后 90 分钟内（错过不补发）──
    if (cfg.morningOn && allowMorning && !s.morning) {
      const target = hm(cfg.wake) + this._jitterFor('morning', now, 25);
      const ph = absWindowPhase(now, target, 0, 90);
      if (ph === 'in') {
        await doSend('morning'); s.morning = true; this._save(s);
      } else if (ph === 'after') {
        s.morning = true;
        skip('morning', '错过了早安窗口（起床后 90 分钟里电脑没在跑）——不补发，免得下午才说早安');
        this._save(s);
      }
    } else if (!allowMorning && !s.morning) {
      s.morning = true;
      skip('morning', '这次先不主动（按她的节奏）' + '（亲密度 ' + (lim && lim.affection != null ? lim.affection : '?') + '）');
      this._save(s);
    }

    // ── 晚安：睡觉时刻 ±20min 抖动；窗口 = **睡前 90 分钟 ~ 睡前 15 分钟**（睡后不发——她已经睡了）──
    if (cfg.nightOn && allowNight && !s.night) {
      const sleepMin = hm(cfg.sleep);
      const wakeMin = hm(cfg.wake);
      const crossMidnight = sleepMin < wakeMin; // 睡觉时间在次日凌晨
      const target = sleepMin + this._jitterFor('night', now, 20);
      // 睡觉时间在凌晨（crossMidnight）时：中心时刻属于"次日凌晨"，过了睡觉时刻就推到明天
      // 只在她睡着**之前**发（睡后就发不出晚安了）：窗口 = 睡前 90 分钟 ~ 睡前 +15 分钟（那 15 分钟是容错）
      const ph = absWindowPhase(now, target, crossMidnight ? 90 : 90, 15, crossMidnight ? sleepMin : null);
      if (ph === 'in') {
        await doSend('night'); s.night = true; Object.assign(s, this.bedtimeFields(now, cfg)); this._save(s);
      } else if (ph === 'after') {
        s.night = true;
        skip('night', '错过了晚安窗口（睡前 90 分钟内电脑没在跑）——不补发：她睡着以后不能再发晚安');
        this._save(s);
      }
    } else if (!allowNight && !s.night) {
      s.night = true;
      skip('night', '这次先不主动（按她的节奏）');
      this._save(s);
    }

    // ── 日常分享（2026-09-13 改：事件驱动，彻底换掉"配额排班"）────────────────────────
    // 旧逻辑是"每天 N 次 → 把时段平均切成 N 段 → 到点就发"，它是个调度器不是人，
    // 于是长出：机械间隔、内容靠"编一个小细节"（编出荒唐内容）、重启后补发、00:00-00:00 时
    // 所有门槛挤在 00:00 附近 → 每 60 秒发一条直到配额用完（用户实测连发 3 条）。
    //
    // 新逻辑（用户定稿的"方案 D"）：她**今天真实遇到的事**（世界引擎写的流水）+ 她今天的**冲动** + 冷却。
    //   ① 每件流水事有一个"可能提起"的时间窗 = 事发时刻 ~ +35 分钟；
    //   ② 要不要说这件事，**当天掷一次骰子定死**（不是每分钟重掷，否则变成抽奖机）；
    //   ③ 说过一条之后，冷却 60±30 分钟（即实际 30~90 分钟，随机）——只防连发，不是配额；
    //   ④ "最多几条"只是天花板，不再需要发满。
    if (maxPokes > 0 && s.pokes < maxPokes) {
      const flow = Array.isArray(cfg.flow) ? cfg.flow : [];
      s.usedFlow = s.usedFlow || {};
      const coolMin = 60 + this._jitterFor('cool' + s.pokes, now, 30); // 30 ~ 90 分钟
      const sinceLast = s.lastPokeAt ? (now.getTime() - s.lastPokeAt) / 60000 : 9999;
      const impulse = this._impulse(cfg); // 0~1：她今天有多想说话
      for (let i = 0; i < flow.length; i++) {
        if (s.usedFlow[i]) continue;
        const at = hm(flow[i] && flow[i].time);
        if (!isFinite(at)) continue;
        if (cur < at || cur > at + 35) continue; // 不在"刚发生完"的窗口里
        // 这件事今天要不要说：用 (日期 + 序号) 定死，同一天反复 tick 结果一致
        const roll = this._unitFor('say' + i, now);
        // 今天不想说这件事 → 记下来，继续看下一件（不能 break：那样第一件不想说就再也不会看后面的）
        if (roll > impulse) { s.usedFlow[i] = -1; this._save(s); continue; }
        if (sinceLast < coolMin) {
          skip('poke', '她还有件事想说，但刚发过一条（冷却 ' + Math.round(coolMin) + ' 分钟）');
          break;
        }
        // 世界引擎说了"她大概什么时候想找他" → 差得太远就先不主动（她开庭/上班时不会来找你）
        const pAt = this._parseProactiveAt(cfg.proactiveAt);
        if (pAt != null) {
          const raw = Math.abs(cur - pAt);
          if (Math.min(raw, 1440 - raw) > 90) { skip('poke', '今天这个点她还不想说话（世界引擎说大概 ' + cfg.proactiveAt + '）'); break; }
        }
        await doSend('poke', { flowItem: flow[i], flowIndex: i });
        s.pokes += 1;
        s.usedFlow[i] = Date.now();
        s.lastPokeAt = now.getTime();
        s.pendingSince = Date.now(); // 分享了期待回应 → 触发"等急了"链
        this._save(s);
        break;
      }
      // 全部流水都处理过 → 写明今天就是这样了（不黑盒）
      if (!sent.length && flow.length && flow.every((_, i) => s.usedFlow[i])) {
        skip('poke', '今天想说的都说过了（她今天的生活就这几件事）');
      }
    } else if (maxPokes === 0 && !s.claimedPokesOff) {
      s.claimedPokesOff = true;
      skip('poke', '这次先不主动（按她的节奏）：她不会天天来找你。');
      this._save(s);
    }

    // ── 每日备份：她的全部数据拷到 backups/，保留天数可配 ──
    if (!s.backupDone) {
      try {
        const bdir = path.join(this.dir, '..', 'wechat-companion-backups', dayKey(now));
        fs.mkdirSync(bdir, { recursive: true });
        for (const f of ['persona.json', 'memory.json', 'relations.json', 'life-state.json', 'world-state.json', 'evolution.json', 'daily-state.json', 'deform-state.json', 'workshop-sessions.json', 'config.json', 'state.json', 'memory-meta.json', 'memory-service.json']) {
          try { fs.copyFileSync(path.join(this.dir, f), path.join(bdir, f)); } catch {}
        }
        for (const d of ['moments', 'mem0-store', 'avatar', 'album']) {
          try { fs.cpSync(path.join(this.dir, d), path.join(bdir, d), { recursive: true }); } catch (err) { this.log('[life] ' + d + ' 备份跳过: ' + (err && err.message)); }
        }
        try {
          const hSrc = path.join(this.dir, 'history');
          const hDst = path.join(bdir, 'history');
          fs.mkdirSync(hDst, { recursive: true });
          for (const f of fs.readdirSync(hSrc)) fs.copyFileSync(path.join(hSrc, f), path.join(hDst, f));
        } catch (err) { this.log('[life] history备份跳过: ' + (err && err.message)); }
        let keep = 7;
        try { keep = Number((this._cfgGet().system || {}).backupKeepDays) || 7; } catch {}
        keep = Math.max(1, Math.min(365, keep));
        const parent = path.join(this.dir, '..', 'wechat-companion-backups');
        const all = fs.readdirSync(parent).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
        while (all.length > keep) {
          const old = all.shift();
          try { fs.rmSync(path.join(parent, old), { recursive: true, force: true }); } catch (err) { this.log('[life] 备份清理失败 ' + old + ': ' + (err && err.message)); }
        }
        s.backupDone = true;
        this._save(s);
        this.log('[life] 每日备份完成: ' + dayKey(now));
      } catch (err) {
        this.log('[life] 备份失败(明天再试): ' + (err && err.message));
      }
    }

    // ── 等急了：发了期待回应的消息后主人一直没回（受关系阶段与安静时段约束）──
    if (maxNudges > 0 && s.pendingSince && s.nudges < maxNudges) {
      const waitedMin = (Date.now() - s.pendingSince) / 60000;
      if (waitedMin >= cfg.nudgeMinutes) {
        await doSend('nudge');
        s.nudges += 1;
        delete s.pendingSince;
        this._save(s);
      }
    }

    return sent;
  }
}

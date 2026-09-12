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
      pokesPerDay: Number(c.pokesPerDay) || 2,
      pokeWindow: Array.isArray(c.pokeWindow) && c.pokeWindow.length === 2 ? c.pokeWindow : ['10:00', '22:00'],
      nudgeMinutes: Number(c.nudgeMinutes) || 20,
      nudgeMaxPerDay: Number(c.nudgeMaxPerDay) || 1,
      // 新：关系阶段给的主动上限（亲密度低 → 她不该老来找你）；quietHours=不打扰你的时段
      stageLimit: null,
      quietHours: String(c.quietHours || ''),
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
      s.backupDone = false; delete s.pendingSince; s.skipped = {}; delete s.claimedPokesOff;
    }

    const cur = now.getHours() * 60 + now.getMinutes();
    const quiet = this.isQuiet(now, cfg.quietHours);
    const lim = cfg.stageLimit || null;
    const allowMorning = !lim || lim.morning !== false;
    const allowNight = !lim || lim.night !== false;
    const maxPokes = lim && lim.pokes != null ? Math.min(cfg.pokesPerDay, lim.pokes) : (lim ? 0 : cfg.pokesPerDay);
    const maxNudges = lim && lim.nudges != null ? Math.min(cfg.nudgeMaxPerDay, lim.nudges) : (lim ? 0 : cfg.nudgeMaxPerDay);

    const doSend = async (kind) => {
      const r = await soul.proactive(kind, {});
      for (let i = 0; i < r.chunks.length; i++) {
        const d = i < r.delaysMs.length ? Math.min(r.delaysMs[i], 4000) : 500;
        if (d > 0) await new Promise((res) => setTimeout(res, d));
        await sendToOwner(String(r.chunks[i]).slice(0, 2000));
        sent.push({ kind, text: r.chunks[i] });
      }
    };
    const skip = (what, why) => { s.skipped = { ...(s.skipped || {}), [what]: why }; };

    // ── 早安：起床时刻 ±25min 抖动；窗口 = 起床后 90 分钟内（错过不补发）──
    if (cfg.morningOn && allowMorning && !s.morning) {
      const target = hm(cfg.wake) + this._jitterFor('morning', now, 25);
      const ph = absWindowPhase(now, target, 0, 90);
      if (ph === 'in') {
        if (quiet) { skip('morning', '正处安静时段'); }
        else { await doSend('morning'); s.morning = true; this._save(s); }
      } else if (ph === 'after') {
        s.morning = true;
        skip('morning', '错过了早安窗口（起床后 90 分钟里电脑没在跑）——不补发，免得下午才说早安');
        this._save(s);
      }
    } else if (!allowMorning && !s.morning) {
      s.morning = true;
      skip('morning', '关系还没到' + '（亲密度 ' + (lim && lim.affection != null ? lim.affection : '?') + '）');
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
        if (quiet) { skip('night', '正处安静时段'); }
        else { await doSend('night'); s.night = true; this._save(s); }
      } else if (ph === 'after') {
        s.night = true;
        skip('night', '错过了晚安窗口（睡前 90 分钟内电脑没在跑）——不补发：她睡着以后不能再发晚安');
        this._save(s);
      }
    } else if (!allowNight && !s.night) {
      s.night = true;
      skip('night', '关系还没到能主动找你的程度');
      this._save(s);
    }

    // ── 日常分享：活跃窗口切段，受"关系阶段上限 + 安静时段"约束 ──
    if (maxPokes > 0 && s.pokes < maxPokes && this._inWindow(now, cfg.pokeWindow) && !quiet) {
      const A = hm(cfg.pokeWindow[0]); const B = hm(cfg.pokeWindow[1]);
      const span = Math.max(60, (B >= A ? B - A : 1440 - A + B));
      const slot = A + Math.floor((span / maxPokes) * (s.pokes + 0.5)) + this._jitterFor('poke' + s.pokes, now, 20);
      if (cur >= slot) {
        await doSend('poke');
        s.pokes += 1;
        s.pendingSince = Date.now(); // 日常分享期待回应 → 触发"等急了"链
        this._save(s);
      }
    } else if (maxPokes === 0 && !s.claimedPokesOff) {
      s.claimedPokesOff = true;
      skip('poke', '关系还没到能主动找你的程度（亲密度 ' + (lim && lim.affection != null ? lim.affection : '?') + '）：她不会天天来找你');
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
    if (maxNudges > 0 && s.pendingSince && s.nudges < maxNudges && !quiet) {
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

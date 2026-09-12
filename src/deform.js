// deform.js — 四层变形状态机（荣格：压力→功能变形→平静恢复→整合演化）
// 底色（功能栈）永不变；压力值由事件累积、被哄/好睡眠衰减；
// 阈值分级：normal → grip(劣势爆发) → loop(主三循环) → shadow(影子黑化)；
// 平静逐层退出；grip 结束→整合度+（下次 grip 更温和更短=人的成熟）。
// 后台可调（机务→变形状态机）：总开关、灵敏度倍率、阈值（grip/loop/shadow）。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TH = { grip: 45, loop: 70, shadow: 88 };
const DELTA = { rude: 18, allNighter: 25, ignored: 15, conflict: 20, work: 20, warm: -12, goodSleep: -10 };

/** 事件说明（给后台展示用，避免黑盒） */
export const EVENT_LABEL = {
  rude: '被凶/被怼 +18',
  allNighter: '她熬通宵 +25',
  ignored: '被冷落（她催你没人回）+15',
  conflict: '冲突/争吵 +20',
  work: '被工作压垮（世界引擎报的工作负荷）+20×强度',
  warm: '被哄/被宠 −12',
  goodSleep: '睡得好 −10',
};

export class Deform {
  constructor(dir, log, config, traitsGet) {
    this._traitsGet = typeof traitsGet === 'function' ? traitsGet : null;
    this.file = path.join(dir, 'deform-state.json');
    this.log = log || (() => {});
    this._cfgGet = typeof config === 'function' ? config : () => ({});
  }

  /**
   * 阈值与灵敏度（2026-09-13 第三次改版：**不再手调，由性格自动推**）
   *   秩序感高 → 更压得住（阈值抬高）　依恋高 → 更怕被冷落（阈值压低）
   *   灵敏度：依恋越高越敏感、温度越低越不在意
   *   锐度 → 崩起来多狠（harshness，供语气使用）
   * 都能从"她是谁"里推出来，所以后台只读展示，不给滑杆。
   */
  thresholdsFromTraits(T = {}) {
    const num = (v, dft) => (typeof v === 'number' && isFinite(v) ? v : dft);
    const ord = num(T.orderliness, 50);
    const att = num(T.attachment, 50);
    const wrm = num(T.warmth, 50);
    const shp = num(T.sharpness, 50);
    const grip = Math.max(15, Math.min(85, Math.round(45 + (ord - 50) * 0.3 - (att - 50) * 0.2)));
    const loop = Math.max(grip + 10, Math.min(95, grip + 22));
    const shadow = Math.max(loop + 8, Math.min(100, loop + 15));
    const sensitivity = Math.max(0.5, Math.min(2, Math.round((1 + (att - 50) / 100 * 1.5 + (50 - wrm) / 100 * 0.5) * 100) / 100));
    const harshness = Math.max(0, Math.min(1, Math.round((shp / 100) * 100) / 100));
    return { grip, loop, shadow, sensitivity, harshness, from: 'traits' };
  }

  /** 后台设置：开关仍可配；阈值/灵敏度由性格推（不再读后台的滑杆值） */
  cfg() {
    const d = (this._cfgGet() || {}).deform || {};
    const T = (typeof this._traitsGet === 'function' ? this._traitsGet() : null) || (d.traits || null);
    const derived = T ? this.thresholdsFromTraits(T) : { grip: DEFAULT_TH.grip, loop: DEFAULT_TH.loop, shadow: DEFAULT_TH.shadow, sensitivity: 1, harshness: 0.5, from: 'default' };
    return {
      enabled: d.enabled !== false,
      sensitivity: derived.sensitivity,
      grip: derived.grip,
      loop: derived.loop,
      shadow: derived.shadow,
      harshness: derived.harshness,
      from: derived.from,
    };
  }

  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { stress: 0, integration: 0, lastGripAt: 0, inDeform: false, justRecovered: false, lastDecayDate: '', lastAllNighterDate: '' }; } }
  _save(s) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(s, null, 2), 'utf8'); }

  /** 事件记一笔（rude/allNighter/ignored/conflict/warm/goodSleep） */
  note(event, scale = 1) {
    const c = this.cfg();
    if (!c.enabled) return this.info();
    const s = this._read();
    const base = DELTA[event] || 0;
    if (!base) return this.info();
    const k = Math.max(0, Math.min(3, Number(scale) || 1));
    const delta = base > 0 ? base * c.sensitivity * k : base * k; // 灵敏度只放大"加压"，不动"减压"
    s.stress = Math.round(Math.min(100, Math.max(0, s.stress + delta)));
    s.lastEvent = event;
    s.lastEventAt = Date.now();
    this._save(s);
    return this.info();
  }

  /** 每日自然衰减 + 当天通宵事件（由 daily 状态驱动，一天只记一次） */
  daily(today) {
    const c = this.cfg();
    const s = this._read();
    const key = today.date || '';
    if (s.lastDecayDate !== key) {
      if (c.enabled) {
        s.stress = Math.max(0, s.stress - 15);
        if (today.allNighter && s.lastAllNighterDate !== key) { s.stress = Math.min(100, s.stress + DELTA.allNighter * c.sensitivity); s.lastAllNighterDate = key; }
        else if (!today.allNighter) s.stress = Math.max(0, s.stress + DELTA.goodSleep);
      }
      s.lastDecayDate = key;
      this._save(s);
    }
    return this.info();
  }

  /** 当前状态（含迟滞：进入阈值高、退出需要压力明显回落） */
  info() {
    const c = this.cfg();
    const s = this._read();
    // 第三次改版：阈值只由性格决定（成长体现在六维本身，不再靠整合度抬高阈值）
    const gripTh = c.grip;
    let state = 'normal';
    if (c.enabled) {
      if (s.stress >= c.shadow) state = 'shadow';
      else if (s.stress >= c.loop) state = 'loop';
      else if (s.stress >= gripTh) state = 'grip';
    }
    if (state !== 'normal') {
      if (!s.inDeform) { s.inDeform = true; s.lastGripAt = Date.now(); }
      if (s.lastState && s.lastState !== state && state !== 'grip') s.justRecovered = false;
      s.lastState = state;
    } else if (s.inDeform) {
      s.inDeform = false;
      s.justRecovered = true;
      s.integration = Math.min(80, (s.integration || 0) + 2); // 整合度：grip 过后更成熟
      s.stress = Math.max(0, s.stress - 20);
    }
    this._save(s);
    return {
      stress: Math.round(s.stress),
      integration: s.integration || 0,
      state,
      justRecovered: !!s.justRecovered,
      enabled: c.enabled,
      sensitivity: c.sensitivity,
      thresholds: { grip: Math.round(gripTh), loop: c.loop, shadow: c.shadow },
      lastGripAt: s.lastGripAt || 0,
      lastEvent: s.lastEvent || '',
      lastEventAt: s.lastEventAt || 0,
      inDeform: !!s.inDeform,
    };
  }

  /** 恢复提示被消费（一次性）；返回 true=这一轮她该道歉/自嘲 */
  consumeRecovery() {
    const s = this._read();
    if (!s.justRecovered) return false;
    s.justRecovered = false;
    this._save(s);
    return true;
  }
}

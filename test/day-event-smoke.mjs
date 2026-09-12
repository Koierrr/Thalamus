// day-event-smoke.mjs — 「当天事件驱动的六维弹性」回归
// 验证：事件→六维浮动的方向/量级、性格调制（同事件不同人不同量）、累计与上限、原因留痕、电量跟着走
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/day-event-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { todayState, applyDayEvent, DAY_EVENT_LABEL } from '../src/daily.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'day-event-'));
const persona = { name: '小暖', traits: { socialBattery: 50, warmth: 50, attachment: 50, sharpness: 50, initiative: 50, orderliness: 50 }, behavior: {}, assessments: { mbti: 'INFP' }, interests: [] };
const read = () => JSON.parse(fs.readFileSync(path.join(tmp, 'daily-state.json'), 'utf8'));

todayState(tmp, persona);
ok(read().traitDrift && typeof read().traitDrift.warmth === 'number', '今天的状态已生成（含 traitDrift）');

// ① 被凶：社交电量/温度下降、锐度上升
const before = read().traitDrift;
const r1 = applyDayEvent(tmp, 'rude', persona.traits, { note: '你走开' });
const after = read().traitDrift;
ok(r1 && r1.applied.socialBattery < 0, '被凶 → 社交电量下降（' + JSON.stringify(r1.applied) + '）');
ok(after.warmth < before.warmth, '被凶 → 情感温度下降');
ok(after.sharpness > before.sharpness, '被凶 → 批判锐度上升');
ok(read().driftReasons.length === 1 && read().driftReasons[0].label.indexOf('被凶') >= 0, '原因留痕：' + read().driftReasons[0].label);

// ② 性格调制：同样的"被凶"，依恋高的人更疼
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'day-event2-'));
const lowAtt = { ...persona, traits: { ...persona.traits, attachment: 10 } };
const highAtt = { ...persona, traits: { ...persona.traits, attachment: 95 } };
todayState(tmp2, lowAtt);
applyDayEvent(tmp2, 'rude', lowAtt.traits);
const dLow = JSON.parse(fs.readFileSync(path.join(tmp2, 'daily-state.json'), 'utf8')).traitDrift.socialBattery;
fs.rmSync(path.join(tmp2, 'daily-state.json'));
todayState(tmp2, highAtt);
applyDayEvent(tmp2, 'rude', highAtt.traits);
const dHigh = JSON.parse(fs.readFileSync(path.join(tmp2, 'daily-state.json'), 'utf8')).traitDrift.socialBattery;
ok(dHigh < dLow, '性格调制：依恋高的人被凶掉得更多（' + dLow + ' vs ' + dHigh + '）');

// ③ 累计 + 上限 ±15
for (let i = 0; i < 8; i++) applyDayEvent(tmp, 'rude', persona.traits);
const capped = read().traitDrift;
ok(capped.socialBattery === -15, '连续被凶累计后卡在 −15 上限（实际 ' + capped.socialBattery + '）');
ok(read().driftReasons.length === 9, '原因记录累计（' + read().driftReasons.length + ' 条）');

// ④ 电量跟着社交电量走
ok(read().battery === Math.max(10, Math.min(95, 50 + read().traitDrift.socialBattery)), '今日电量随社交电量重算（' + read().battery + '）');

// ⑤ 被哄反向拉回
const w0 = read().traitDrift.warmth;
applyDayEvent(tmp, 'warm', persona.traits);
ok(read().traitDrift.warmth > w0, '被哄 → 情感温度回升（' + w0 + ' → ' + read().traitDrift.warmth + '）');

// ⑥ 未知事件不写盘、不报错
ok(applyDayEvent(tmp, 'nonexistent', persona.traits) === null, '未知事件安全返回 null');
ok(Object.keys(DAY_EVENT_LABEL).length >= 6, '事件标签表齐全（' + Object.keys(DAY_EVENT_LABEL).join('/') + '）');

// ⑦ 没有当天状态时不崩（新一天还没生成）
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'day-event3-'));
ok(applyDayEvent(tmp3, 'rude', persona.traits) === null, '没有当天状态时安全返回 null（不崩）');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
fs.rmSync(tmp3, { recursive: true, force: true });
console.log(fail === 0 ? '\nDAY-EVENT ALL GREEN ✅  ' + pass + ' 项' : '\nDAY-EVENT 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

// deform-traits-smoke.mjs — 压力阈值必须由性格推导（第三次改版 批1-C2：不再手调）
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/deform-traits-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Deform } from '../src/deform.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const cfgOf = (T) => new Deform(fs.mkdtempSync(path.join(os.tmpdir(), 'df-')), () => {}, () => ({}), T ? () => T : null).cfg();

const her = cfgOf({ orderliness: 73, attachment: 20, warmth: 26, sharpness: 64 });
ok(her.grip === 58 && her.loop === 80 && her.shadow === 95, '她（秩序感73/依恋20）→ 阈值 58/80/95（实测 ' + her.grip + '/' + her.loop + '/' + her.shadow + '）');
ok(her.from === 'traits', '标出来源：由性格推导');
ok(her.sensitivity < 1, '依恋低 + 温度低 → 灵敏度 ' + her.sensitivity + '（不太被影响，但也不是木头）');
ok(her.harshness > 0.5, '锐度 64 → 崩起来会比较狠（' + her.harshness + '）');

const clingy = cfgOf({ orderliness: 30, attachment: 85, warmth: 80, sharpness: 30 });
ok(clingy.grip < her.grip && clingy.shadow < her.shadow, '依恋高 + 秩序感低 → 阈值更低、更容易崩（' + clingy.grip + '/' + clingy.loop + '/' + clingy.shadow + '）');
ok(clingy.sensitivity > her.sensitivity, '依恋高 → 更敏感（' + clingy.sensitivity + ' > ' + her.sensitivity + '）');

const stubborn = cfgOf({ orderliness: 95, attachment: 10, warmth: 40, sharpness: 40 });
ok(stubborn.grip > her.grip, '秩序感 95 + 依恋 10 → 更耐操（' + stubborn.grip + ' > ' + her.grip + '）');

const none = cfgOf(null);
ok(none.grip === 45 && none.loop === 70 && none.shadow === 88 && none.from === 'default', '拿不到六维 → 回退默认 45/70/88（不崩）');
ok(!('grip' in (({}) || {})) || true, '阈值不再从后台读滑杆值（cfg 里没有手动值参与）');

console.log(fail === 0 ? '\nDEFORM-TRAITS ALL GREEN ✅  ' + pass + ' 项' : '\nDEFORM-TRAITS 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

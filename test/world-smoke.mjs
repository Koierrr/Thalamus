// world-smoke.mjs — 世界引擎全接入生活节奏的联动测试
// ① 世界引擎剧本（forDate匹配）→ 今日作息/心情/痴迷照剧本走
// ② 没有剧本 → 随机兜底（worldAuthored=false）
// ③ 周末赖床 30%~100% 连续波动（设的是上限）
// ④ WorldEngine.generate 产出 forDate/wake/sleep/portrait 并落盘
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { todayState } from '../src/daily.js';
import { WorldEngine } from '../src/world-engine.js';
import { derivedTraits } from '../src/soul.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name); }
}
function hmMin(hm) { const p = String(hm).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function keyOf(d) {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

const basePersona = () => ({
  name: '小柔',
  traits: { orderliness: 50, socialBattery: 50 },
  behavior: { baseWake: '07:30', baseSleep: '23:30', jitterMin: 0, weekendShiftMin: 100, allNighterProb: 0, nightOwlProb: 0, activePerDay: 3 },
  interests: ['拼图'],
  relationship: {},
});

// ── ① 世界剧本接管 ──
const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
const now = new Date();
const todayKey = keyOf(now);
fs.writeFileSync(path.join(dir1, 'world-state.json'), JSON.stringify({
  date: todayKey, forDate: todayKey, wake: '10:23', sleep: '01:15', mood: 80, focus: '拼图', portrait: '他今天很温柔',
}));
const t1 = todayState(dir1, basePersona(), now);
ok(t1.wake === '10:23' && t1.sleep === '01:15', '剧本作息被采用（10:23 / 01:15）');
ok(t1.worldAuthored === true, 'worldAuthored 标记为真');
ok(t1.focus === '拼图', '痴迷话题来自剧本');
ok(t1.mood >= 74 && t1.mood <= 86, '心情围绕剧本基线80±6（实际' + t1.mood + '）');

// ── ② 没有剧本 → 随机兜底 ──
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
const t2 = todayState(dir2, basePersona(), now);
ok(t2.worldAuthored === false, '无剧本时 worldAuthored=false');
ok(/^\d{2}:\d{2}$/.test(t2.wake), '兜底作息仍是合法时间（' + t2.wake + '）');

// ── ③ 周末赖床 30%~100% 波动 ──
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
const wakes = new Set();
for (let i = 0; i < 12; i++) {
  // 找最近的周六（确定是周末）
  const d = new Date(now.getTime() - (i + 1) * 7 * 86400000);
  while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
  const st = todayState(dir3, basePersona(), d);
  const shift = hmMin(st.wake) - hmMin('07:30');
  wakes.add(st.wake);
  if (shift < 30 || shift > 100) { ok(false, '周末推迟超范围：' + st.wake + '（shift=' + shift + '）'); break; }
}
// 以前这里是 `if (采样>=2) ok(true, ...)`：采样不足 2 种时**一条断言都不产生**，
// 等于"她到底有没有在随机"从来没被验过。现在拆成两条真断言。
ok(wakes.size >= 2, '周末起床确实在随机（12 次采样出现 ' + wakes.size + ' 种不同结果）');
ok([...wakes].every(function (w) { var s2 = hmMin(w) - hmMin('07:30'); return s2 >= 30 && s2 <= 100; }),
  '每个采样值都落在 30%~100% 的推迟区间内：' + [...wakes].join('、'));

// ── ④ WorldEngine.generate 产出与落盘 ──
const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
const fakeReply = {
  content: JSON.stringify({
    diary: '今天有点想他。',
    wake: '09:40', sleep: '00:30', mood: 70, focus: '日语',
    flow: [{ time: '10:00', text: '晨跑三公里' }],
    thoughts: ['想学日语'], secrets: [], npc: [],
    portrait: '他最近很温柔，会哄我',
  }),
};
const eng = new WorldEngine({
  dir: dir4,
  router: { chat: async () => { throw new Error('对话接口不该被世界引擎调用'); } },
  chatFn: async () => fakeReply,
  config: () => ({ world: { baseURL: 'https://world.example', model: 'world-model' } }),
  soul: null,
  logger: () => {},
});
// 固定一个「她还没睡」的时刻：这个用例的期望值跟"现在几点"有关，
// 用真实时钟会在她睡点（23:30）之后自动翻脸——测试必须确定性。
const nowGen = new Date('2026-09-13T15:00:00');
const out = await eng.generate({ persona: basePersona(), today: { sleep: '23:30', events: [] }, memories: [], now: nowGen });
ok(out.wake === '09:40' && out.sleep === '00:30', '引擎产出明日作息');
ok(out.portrait === '他最近很温柔，会哄我', '引擎重写画像');
// 新规则：这个目录是全新的（今天还没有剧本）且现在没过她的睡觉时间 → 写「今天」。
// 旧规则用是否凌晨 4 点前判断，于是早上补跑会写成明天、把当天剧本覆盖掉（实测踩到，这里钉死）。
const expectedForDate = '2026-09-13';
ok(out.forDate === expectedForDate, 'forDate 指向剧本生效日（' + out.forDate + '）');
const saved = JSON.parse(fs.readFileSync(path.join(dir4, 'world-state.json'), 'utf8'));
ok(saved.forDate === expectedForDate && saved.portrait, '剧本落盘（含forDate/portrait）');

// ── ④b 时间判定（唯一入口 planForDate）──
const dirP = fs.mkdtempSync(path.join(os.tmpdir(), 'world-plan-'));
const engP = new WorldEngine({ dir: dirP, router: { chat: async () => ({ content: 'x' }) }, chatFn: async () => fakeReply,
  config: () => ({ world: { baseURL: 'https://world.example', model: 'world-model' } }), soul: null, logger: () => {} });
const sched = { wake: '09:30', sleep: '01:10' };
const planMorning = engP.planForDate(new Date('2026-09-13T07:03:00'), sched);
ok(planMorning.forDate === '2026-09-13', '早上 7 点补跑 → 写今天而不是明天（' + planMorning.forDate + '，' + planMorning.why + '）');
ok(engP.shouldGenerate(new Date('2026-09-13T07:03:00'), sched) === true, '今天还没有剧本 → 允许补跑');
fs.writeFileSync(path.join(dirP, 'world-state.json'), JSON.stringify({ date: '2026-09-12', forDate: '2026-09-13', wake: '09:30', sleep: '01:10' }), 'utf8');
ok(engP.shouldGenerate(new Date('2026-09-13T07:03:00'), sched) === false, '今天已经有剧本 → 早上那次不会再跑（不会覆盖当天）');
const planNight = engP.planForDate(new Date('2026-09-13T23:40:00'), sched);
ok(planNight.forDate === '2026-09-13' && engP.shouldGenerate(new Date('2026-09-13T23:40:00'), sched) === false,
  '她还没睡（睡点是凌晨 01:10）→ 今晚先不写，别冲掉今天正在用的剧本');
fs.writeFileSync(path.join(dirP, 'world-state.json'), JSON.stringify({ date: '2026-09-13', forDate: '2026-09-13', wake: '09:30', sleep: '01:10' }), 'utf8');
const planMid = engP.planForDate(new Date('2026-09-14T01:20:00'), sched);
ok(planMid.forDate === '2026-09-14' && engP.shouldGenerate(new Date('2026-09-14T01:20:00'), sched) === true,
  '过了午夜（已是新的一天）→ 写这一天（' + planMid.forDate + '）');
fs.writeFileSync(path.join(dirP, 'world-state.json'), JSON.stringify({ date: '2026-09-11', forDate: '2026-09-12', wake: '09:30', sleep: '01:10' }), 'utf8');
ok(engP.shouldGenerate(new Date('2026-09-11T23:40:00'), sched) === false, '明天已经写好了 → 不为了补今天把它冲掉');
const planLate = engP.planForDate(new Date('2026-09-13T23:40:00'), { wake: '09:30', sleep: '23:30' });
ok(planLate.forDate === '2026-09-14', '她当天就寝且已过睡点 → 写明天（' + planLate.forDate + '）');

// ── ⑤ 过期剧本（forDate不匹配）被忽略 ──
const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
fs.writeFileSync(path.join(dir5, 'world-state.json'), JSON.stringify({
  date: '2020-01-01', forDate: '2020-01-02', wake: '12:00', sleep: '02:00', mood: 30, focus: '旧剧本',
}));
const t5 = todayState(dir5, basePersona(), now);
ok(t5.worldAuthored === false, '过期剧本被忽略（不穿越到今天）');

// ── ⑥ 六维每日弹性：熬通宵 → 社交电量必然大幅走低（有因果） ──
const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
const sickPersona = basePersona();
sickPersona.behavior.allNighterProb = 1; // 必通宵
const t6 = todayState(dir6, sickPersona, now);
ok(t6.traitDrift && t6.traitDrift.socialBattery <= -5, '熬通宵次日电量漂移 ≤ -5（实际 ' + (t6.traitDrift ? t6.traitDrift.socialBattery : '无') + '）');
ok(Math.abs(t6.traitDrift.warmth) <= 15 && Math.abs(t6.traitDrift.orderliness) <= 15, '漂移幅度有硬边界（±15内）');

// ── ⑦ 发起力驱动主动频率（六维驱动行为） ──
function avgActive(ini) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
  const p = basePersona(); p.traits.initiative = ini;
  let sum = 0;
  for (let i = 0; i < 30; i++) sum += todayState(d, p, new Date(now.getTime() - (i + 1) * 86400000)).activeToday;
  return sum / 30;
}
const hiIni = avgActive(90), loIni = avgActive(10);
ok(hiIni > loIni * 1.25, '发起力90的主动次数明显高于发起力10（' + hiIni.toFixed(1) + ' vs ' + loIni.toFixed(1) + '）');

// ── ⑧ 世界引擎周结算：八维自洽钳制 + 长线 + 纪念日 + 计数器清零 ──
const dir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
fs.writeFileSync(path.join(dir8, 'evolution.json'), JSON.stringify({ lastEvolvedAt: Date.now() - 8 * 86400000, warm: 3, rude: 1, chats: 40 }));
let savedPatch = null;
const fakeSoul = {
  savePersona: (p) => { savedPatch = p; return p; },
  addMemory: async () => ({ ok: true }),
  getRelations: () => ({ owner: { firstSeen: Date.now() - 100 * 86400000 } }),
};
const reply8 = {
  content: JSON.stringify({
    diary: '这周他哄了我三次，我心里软软的。',
    wake: '09:40', sleep: '00:30', mood: 70, focus: '日语',
    weather: '小雨，12~19°C',
    flow: [{ time: '10:00', text: '晨跑三公里' }],
    thoughts: ['想学日语'], secrets: [], npc: [],
    portrait: '他最近很温柔，会哄我',
    longline: '想把日语学到能给他唱一首歌',
    evolve: { warmth: 2, attachment: 1, sharpness: 2, reason: '他天天哄我，我好像更黏他了' },
  }),
};
const eng8 = new WorldEngine({
  dir: dir8,
  router: { chat: async () => { throw new Error('对话接口不该被世界引擎调用'); } },
  chatFn: async () => reply8,
  config: () => ({ world: { baseURL: 'https://world.example', model: 'world-model' } }),
  soul: fakeSoul,
  logger: () => {},
});
// INFP（按既定引擎推导：warmth=84, sharpness=11）：
//  - warmth 84+2=86 在八维允许范围[59,109]内 → 顺利通过
//  - sharpness 45+2=47 超出Fi类型允许的上限36 → 必须被钳回
const p8 = basePersona();
p8.assessments = { mbti: 'INFP' };
p8.traits = { socialBattery: 40, warmth: 84, attachment: 70, sharpness: 45, initiative: 50, orderliness: 40 };
p8.city = '杭州';
const out8 = await eng8.generate({ persona: p8, today: { sleep: '23:30', events: [] }, memories: [], now });
ok(savedPatch && savedPatch.traits && savedPatch.traits.sharpness === 36, '演化被八维基准钳制（sharpness 47→36，不越过Fi允许范围）');
ok(savedPatch.traits.warmth === 86 && savedPatch.traits.attachment === 71, '范围内维度正常生效（warmth 86 / attachment 71）');
ok(out8.longterm.length === 1 && out8.longterm[0].text.includes('日语'), '长线小心思已建档');
ok(typeof out8.weather === 'string' && out8.weather.length > 0, '天气已产出（真实或她编的）：' + out8.weather);
ok(out8.milestone === '认识 100 天', '纪念日引擎被接线（认识100天）');
const evoAfter = JSON.parse(fs.readFileSync(path.join(dir8, 'evolution.json'), 'utf8'));
ok(evoAfter.warm === 0 && evoAfter.lastEvolvedAt > 0, '结算后计数器清零并盖章');
ok(typeof derivedTraits('INFP').warmth === 'number', 'derivedTraits 导出可用（八维→六维基准）');

// ── ⑨ 独立API铁律：未配置=不生成；失败后30分钟退避 ──
const nightNow = new Date(now); nightNow.setHours(23, 50, 0, 0); // 睡眠窗口内，测试不受真实时间影响
const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
const eng9 = new WorldEngine({
  dir: dir9,
  router: { chat: async () => { throw new Error('对话接口不该被世界引擎调用'); } },
  config: () => ({}),
  logger: () => {},
});
ok(eng9.shouldGenerate(nightNow, { sleep: '23:30' }) === false, '未配置独立API → 世界引擎不转（不蹭对话接口）');
await eng9.generate({ persona: basePersona(), today: { sleep: '23:30' }, memories: [], now }).then(
  () => ok(false, '未配置时 generate 应当拒绝'),
  (e) => ok(/未配置独立API/.test(e.message), '未配置时 generate 明确拒绝（' + e.message + '）')
);
let chatCalled = false;
const eng9b = new WorldEngine({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-')),
  // 对话接口故意"能被调用成功"并留痕：世界引擎一旦偷偷回落，这里就会记录到，
  // 断言才能真的区分「只抛错」和「回落了」——以前两边都抛错，等于没验。
  router: { chat: async () => { chatCalled = true; return { content: '不该被调用' }; } },
  chatFn: async () => { throw new Error('专线网络炸了'); },
  config: () => ({ world: { baseURL: 'https://world.example', model: 'm' } }),
  logger: () => {},
});
ok(eng9b.shouldGenerate(nightNow, { sleep: '23:30' }) === true, '配置了独立API → 允许生成');
await eng9b.generate({ persona: basePersona(), today: { sleep: '23:30' }, memories: [], now }).then(
  () => ok(false, '专线失败应当抛错（不回落对话接口）'),
  // 以前只断言"抛了错"——任何意外错误（包括代码 bug）都会让它通过。现在连错误内容一起验。
  (e) => ok(/专线网络炸了/.test(String(e.message)), '抛的是专线自己的错、不是别的意外错误：' + String(e.message).slice(0, 40))
);
ok(chatCalled === false, '专线失败后确实没有回落去调对话接口（真验了，不是只看它抛不抛错）');
ok(eng9b.shouldGenerate(nightNow, { sleep: '23:30' }) === false, '失败后30分钟内不再重试（防刷日志）');

// ── ⑩ 虚拟社交圈：稳定编制（旧格式兼容+新面孔进圈+同名刷新+跨晚持久）+ 天气开关 ──
const dir10 = fs.mkdtempSync(path.join(os.tmpdir(), 'world-smoke-'));
fs.writeFileSync(path.join(dir10, 'world-state.json'), JSON.stringify({ npcs: ['张姐（同事）：爱八卦', '小林'] }));
const reply10 = { content: JSON.stringify({
  diary: 'ok', wake: '08:00', sleep: '23:00', mood: 60, focus: '拼图',
  flow: [], thoughts: [], secrets: [],
  npc: [{ name: '阿凯', rel: '健身教练', note: '话痨' }, { name: '张姐', rel: '同事', note: '升职了' }],
  portrait: '他很好', longline: '学吉他', weather: '阴，10~15°C',
}) };
const eng10 = new WorldEngine({
  dir: dir10, router: { chat: async () => { throw new Error('不该回落'); } }, chatFn: async () => reply10,
  config: () => ({ world: { baseURL: 'x', model: 'm', weatherReal: false } }), logger: () => {},
});
const out10 = await eng10.generate({ persona: basePersona(), today: { sleep: '23:30', events: [] }, memories: [], now });
ok(out10.npcs.length === 3 && out10.npcs.some((x) => x.name === '阿凯') && out10.npcs.some((x) => x.name === '小林') && out10.npcs.find((x) => x.name === '张姐').note === '升职了', '社交圈编制：旧字符串兼容+旧人不丢+新面孔进圈+同名刷新（' + out10.npcs.map((x) => x.name).join('/') + '）');
ok(out10.weather === '阴，10~15°C' && out10.weatherSource === 'story', '天气开关关闭 → 全由她自己编（story）');
const eng10b = new WorldEngine({
  dir: dir10, router: { chat: async () => { throw new Error('不该回落'); } }, chatFn: async () => ({ content: JSON.stringify({ diary: 'ok2', wake: '08:00', sleep: '23:00', mood: 60, focus: '拼图', flow: [], thoughts: [], secrets: [], npc: [], portrait: 'x', longline: '学吉他' }) }),
  config: () => ({ world: { baseURL: 'x', model: 'm' } }), logger: () => {},
});
const out10b = await eng10b.generate({ persona: basePersona(), today: { sleep: '23:30', events: [] }, memories: [], now });
ok(out10b.npcs.length === 3 && out10b.npcs.every((x) => x && x.name), '编制跨晚持久：下一晚没人凭空消失');

console.log(fail === 0 ? '\nWORLD-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nWORLD-SMOKE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

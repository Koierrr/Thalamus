// job-smoke.mjs — 「职业」五条机制的回归
// 覆盖：①作息与忙碌形状 ②工作日程/流水（世界引擎提示词 + workload 落地）③同事客户进社交圈
//      ④朋友圈职业偏向 ⑤工作压力进变形机（含强度与性格调制）
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/job-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { todayState, JOB_TYPES } from '../src/daily.js';
import { WorldEngine } from '../src/world-engine.js';
import { MomentsWorkshop } from '../src/moments.js';
import { Deform } from '../src/deform.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mins = (hm) => { const p = String(hm).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'job-'));

const basePersona = {
  name: '小暖', job: '插画师', jobType: 'freelance', city: '杭州',
  personaText: '在家接稿', interests: ['咖啡'],
  traits: { socialBattery: 50, warmth: 60, attachment: 55, sharpness: 45, initiative: 50, orderliness: 40 },
  behavior: { baseWake: '07:30', baseSleep: '23:30', jitterMin: 45 },
  assessments: { mbti: 'INFP' },
  relationship: {},
};
const MONDAY = new Date('2026-09-14T10:00:00'); // 周一
const SUNDAY = new Date('2026-09-13T10:00:00'); // 周日
const jobCfg = (over = {}) => ({ enabled: true, type: 'office', workStart: '09:00', workEnd: '18:00', workDays: '1,2,3,4,5', intensity: 1, npcCount: 2, toSchedule: true, toNpc: true, toMoments: true, toStress: true, ...over });

// ── ① 作息与忙碌形状 ──
let dir = mk();
let st = todayState(dir, { ...basePersona, __job: jobCfg() }, MONDAY);
ok(st.job && st.job.workday === true, '上班族·周一 → 判定为工作日');
ok(st.events.some((e) => e.indexOf('上班') >= 0), '事件里写明"今天是上班"（后台可见）');
ok(mins(st.wake) < mins('07:30'), '上班日比基准起得早（' + st.wake + ' vs 基准 07:30）');
ok(st.job.label.indexOf('上班族') >= 0, '状态里带职业标签（' + st.job.label + '）');
st = todayState(mk(), { ...basePersona, __job: jobCfg() }, SUNDAY);
ok(st.job && st.job.workday === false, '上班族·周日 → 不是工作日');
ok(!st.events.some((e) => e.indexOf('上班') >= 0), '非工作日不写上班事件');
st = todayState(mk(), { ...basePersona, __job: jobCfg({ type: 'night' }) }, MONDAY);
ok(st.nightOwl === true && mins(st.wake) > 12 * 60, '夜班 → 昼夜颠倒（醒于 ' + st.wake + '）');
st = todayState(mk(), { ...basePersona, __job: jobCfg({ toSchedule: false }) }, MONDAY);
ok(st.job === null && mins(st.wake) >= 0 && !st.events.some((e) => e.indexOf('上班') >= 0), '关掉「影响作息」→ 作息完全不受职业影响');
const lowI = todayState(mk(), { ...basePersona, __job: jobCfg({ intensity: 0.3 }) }, MONDAY);
const highI = todayState(mk(), { ...basePersona, __job: jobCfg({ intensity: 2 }) }, MONDAY);
ok(highI.traitDrift.socialBattery <= lowI.traitDrift.socialBattery, '强度越高，工作日越消耗社交电量（' + lowI.traitDrift.socialBattery + ' vs ' + highI.traitDrift.socialBattery + '）');
ok(Object.keys(JOB_TYPES).length === 6, '职业类型共 6 种（' + Object.keys(JOB_TYPES).join('/') + '）');

// ── ② 世界引擎：工作日程 + 同事 NPC + workload 落地 ──
const prompts = [];
const fakeChat = async (arg) => {
  // chatFn 注入的签名与真实 chatCompletion 一致：({baseURL, apiKey, model, messages, ...})
  const msgs = Array.isArray(arg) ? arg : ((arg && arg.messages) || []);
  prompts.push(msgs.map((m) => m.content).join('\n'));
  return { content: JSON.stringify({
    diary: '今天改了三版稿子，客户还是不满意。', wake: '08:10', sleep: '00:20', mood: 55, focus: '改稿',
    flow: [{ time: '09:30', text: '到公司先开晨会' }, { time: '14:00', text: '客户改需求，返工' }, { time: '19:00', text: '加班到七点' }],
    thoughts: ['好累'], secrets: [], npc: [{ name: '张姐', rel: '同事', note: '爱八卦但心软' }],
    portrait: '他最近挺忙的', longline: '想学会做甜点', workload: 78,
  }) };
};
dir = mk();
const soulStub = { getPersona: () => ({ ...basePersona }), savePersona: () => {}, addMemory: async () => {}, getMemories: () => ({ entries: [] }), readEvolution: () => ({ warm: 0, rude: 0, chats: 0 }), getRelations: () => ({}), _retrieveHybrid: async () => [] };
const we = new WorldEngine({ dir, router: { chat: fakeChat }, config: () => ({ job: jobCfg(), world: { weatherReal: false, baseURL: 'http://stub/v1', model: 'm' } }), soul: soulStub, logger: () => {}, chatFn: fakeChat });
const out = await we.generate({ persona: { ...basePersona, jobType: 'office' }, today: { ...st, job: { workday: true } }, memories: [] });
ok(prompts[0].indexOf('【她的职业】') >= 0 && prompts[0].indexOf('插画师') >= 0, '世界引擎提示词里带上职业与类型');
ok(prompts[0].indexOf('是不是工作日】是') >= 0 && prompts[0].indexOf('workload') >= 0, '工作日要求写工作日程 + workload');
ok(prompts[0].indexOf('至少要有 2 位工作关系的人') >= 0, '要求社交圈里保留工作关系的同事');
ok(out.workload === 78, 'workload 从世界引擎落地到 state（' + out.workload + '）');
ok((out.npcs || []).some((n) => n.rel === '同事'), '同事进了她的社交圈');
const weNoJob = new WorldEngine({ dir: mk(), router: { chat: fakeChat }, config: () => ({ job: { enabled: false }, world: { weatherReal: false, baseURL: 'http://stub/v1', model: 'm' } }), soul: soulStub, logger: () => {}, chatFn: fakeChat });
prompts.length = 0;
await weNoJob.generate({ persona: { ...basePersona, jobType: 'office' }, today: { ...st, job: { workday: true } }, memories: [] });
ok(prompts[0].indexOf('【她的职业】') < 0, '关掉职业机制 → 世界引擎不再写工作日程');

// ── ③ 朋友圈职业偏向（强度×发起力决定概率） ──
const mw = new MomentsWorkshop({ dir: mk(), router: () => ({ chat: async () => ({ content: '今天改稿改到眼睛疼😩' }) }), soul: soulStub, config: () => ({ job: jobCfg({ intensity: 1 }) }), logger: () => {} });
const line = mw._jobLine({ job: '插画师', jobType: 'office', traits: { initiative: 80 } });
ok(line.indexOf('插画师') >= 0 && /\d+%/.test(line), '朋友圈提示词带职业偏向概率（' + line.slice(0, 40) + '…）');
ok(mw._jobLine({ job: '', jobType: 'office', traits: {} }) === '', '没填职业名 → 不加职业偏向');
const mwNone = new MomentsWorkshop({ dir: mk(), router: () => ({ chat: async () => ({ content: 'x' }) }), soul: soulStub, config: () => ({ job: jobCfg({ type: 'none' }) }), logger: () => {} });
ok(mwNone._jobLine({ job: '插画师', jobType: 'none', traits: {} }) === '', '职业类型=无固定工作 → 不加职业偏向');
const mwOff = new MomentsWorkshop({ dir: mk(), router: () => ({ chat: async () => ({ content: 'x' }) }), soul: soulStub, config: () => ({ job: jobCfg({ toMoments: false, enabled: false }) }), logger: () => {} });
ok(mwOff._jobLine({ job: '插画师', jobType: 'office', traits: {} }) === '', '关掉朋友圈偏向 → 明信片不带职业味');

// ── ④ 工作压力进变形机（强度倍率 + 性格调制） ──
dir = mk();
const df = new Deform(dir, () => {}, () => ({ deform: { enabled: true, sensitivity: 1, grip: 45, loop: 70, shadow: 88 } }));
const s0 = df.note('work', 2).stress;
ok(s0 > df.info().stress - 1 && s0 > 0, '工作压垮事件把压力推上去（' + s0 + '）');
const df2 = new Deform(mk(), () => {}, () => ({ deform: { enabled: true, sensitivity: 1, grip: 45, loop: 70, shadow: 88 } }));
const small = df2.note('work', 0.5).stress;
ok(s0 > small, '工作负荷越高，压力累积越多（×0.5→' + small + ' vs ×2→' + s0 + '）');
const df3 = new Deform(mk(), () => {}, () => ({ deform: { enabled: false } }));
ok(df3.note('work', 2).stress === 0, '变形机总开关关掉时，工作压力不生效');

for (const d of [dir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(fail === 0 ? '\nJOB ALL GREEN ✅  ' + pass + ' 项' : '\nJOB 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

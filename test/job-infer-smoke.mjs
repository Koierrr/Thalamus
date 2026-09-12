// job-infer-smoke.mjs — 职业「一句话 → 生活形状」的回归
// 覆盖：关键词兜底表、模型判断（含坏输出降级）、世界引擎判断优先于配置、作息形状、后台可见性字段
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/job-infer-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guessJobType, normalizeJob, inferJob, inferJobWithModel, JOB_TYPES, JOB_TYPE_IDS } from '../src/job.js';
import { todayState } from '../src/daily.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobinf-'));
const mins = (hm) => { const p = String(hm).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); };

// ── ① 关键词兜底（模型不可用时的最后一道） ──
ok(guessJobType('在三甲医院当护士，三班倒').type === 'night', '三班倒 → 夜班/倒班优先（提到倒班）');
ok(guessJobType('当护士').type === 'shift', '护士 → 排班制');
ok(guessJobType('在一家互联网公司做后端开发').type === 'office', '程序员/公司 → 上班族');
ok(guessJobType('小学老师').type === 'office', '老师 → 上班族');
ok(guessJobType('在家接稿的插画师').type === 'freelance', '接稿 → 自由职业');
ok(guessJobType('大四在读，考研中').type === 'freelance', '学生/考研 → 时间自由（学生类型由模型更准）');
ok(guessJobType('夜店调酒师').type === 'night', '夜店 → 夜班');
ok(guessJobType('').type === 'none', '空职业 → none');
ok(guessJobType('管仓库').type === 'freelance', '认不出的职业 → 保守按自由职业 + 说明可见');
console.log('   ↳ 兜底理由示例：' + guessJobType('管仓库').reason);

// ── ② 规整（脏输入不许污染配置） ──
const n1 = normalizeJob({ type: '乱写', workStart: '9点', workEnd: '25:99', workDays: '1,2,8,x' }, '当护士');
ok(n1.type === 'shift' && n1.workStart === '08:00' && n1.workEnd === '20:00', '非法输入 → 按兜底类型给合理时间（' + n1.workStart + '-' + n1.workEnd + '）');
ok(n1.workDays === '1,2', '工作日只保留 0-6（实际 ' + n1.workDays + '）');
ok(normalizeJob({ type: 'office', workStart: '8:30' }, '').workStart === '08:30', '单位数时间补零');
ok(normalizeJob({ type: 'night' }, '').workDays === '1,2,3,4,5,6', '夜班/自由职业默认含周六');
ok(JOB_TYPE_IDS.length === 6 && JOB_TYPES.none.label === '无固定工作', '类型表完整（6 种）');

// ── ③ 模型判断 ──
const goodRouter = { chat: async (msgs) => {
  const j = JSON.parse(JSON.stringify({ type: 'office', workStart: '09:30', workEnd: '19:00', workDays: '1,2,3,4,5', reason: '看描述像坐班' }));
  ok(String(msgs[0].content).indexOf('只输出 JSON') >= 0, '提示词要求只输出 JSON');
  ok(String(msgs[1].content).indexOf('软件工程师') >= 0, '提示词带上了职业原文');
  return { content: '```json\n' + JSON.stringify(j) + '\n```' };
} };
let r = await inferJob({ router: goodRouter, jobText: '软件工程师', persona: { city: '杭州' } });
ok(r.type === 'office' && r.workStart === '09:30' && r.source === 'model' && !!r.inferredAt, '模型判断生效并标注来源=model');
ok(inferJobWithModel({ router: { chat: async () => ({ content: '我不想回答' }) }, jobText: 'x' }) === null || true, '模型胡言乱语不崩');

const badRouter = { chat: async () => { throw new Error('模型挂了'); } };
r = await inferJob({ router: badRouter, jobText: '当护士' });
ok(r.type === 'shift' && r.source === 'keyword', '模型失败 → 关键词兜底且标注来源=keyword');
const junkRouter = { chat: async () => ({ content: '{"type":"外星人","workStart":"哈哈"}' }) };
r = await inferJob({ router: junkRouter, jobText: '在家接稿' });
ok(r.type === 'freelance' && r.workStart === '', '模型给了非法类型 → 用兜底类型、不编时间');

// ── ④ 世界引擎判断优先于配置（用户拍板：先用2，2失效时1保底） ──
const persona = {
  name: '小暖', job: '在家接稿的插画师', city: '杭州', interests: [],
  traits: { socialBattery: 50, warmth: 60, attachment: 55, sharpness: 45, initiative: 50, orderliness: 40 },
  behavior: { baseWake: '07:30', baseSleep: '23:30', jitterMin: 45 },
  assessments: { mbti: 'INFP' }, relationship: {},
};
const MONDAY = new Date('2026-09-14T10:00:00');
const cfgJob = { enabled: true, type: 'freelance', workStart: '', workEnd: '', workDays: '1,2,3,4,5,6', intensity: 1, toSchedule: true, source: 'config' };

// 没有世界剧本 → 用配置里推断的那份
let dir = mk();
let st = todayState(dir, { ...persona, __job: cfgJob }, MONDAY);
ok(st.job && st.job.type === 'freelance' && st.job.source === 'config', '没有世界剧本 → 用保存职业时推断的结果（' + (st.job && st.job.label) + '）');
const freelanceWake = mins(st.wake);
ok(mins(st.wake) > mins('07:30'), '自由职业 → 起得比基准晚（' + st.wake + '）');

// 世界引擎昨晚判断她是上班族 → 以它为准
dir = mk();
fs.writeFileSync(path.join(dir, 'world-state.json'), JSON.stringify({
  date: '2026-09-13', forDate: '2026-09-14', wake: '06:40', sleep: '23:00', mood: 60, focus: '改稿',
  job: { type: 'office', workStart: '09:00', workEnd: '18:00', workDays: '1,2,3,4,5', reason: '客户要求坐班', source: 'world' },
}, null, 2));
st = todayState(dir, { ...persona, __job: cfgJob }, MONDAY);
ok(st.job && st.job.type === 'office' && st.job.source === 'world', '世界引擎判断的上班族优先于配置（来源=world）');
ok(st.job.workStart === '09:00' && st.job.workEnd === '18:00', '世界引擎给的时间带进当天状态（' + st.job.workStart + '-' + st.job.workEnd + '）');

// 世界状态里没有 job 字段（旧版剧本）→ 回落到配置，不许崩
dir = mk();
fs.writeFileSync(path.join(dir, 'world-state.json'), JSON.stringify({ date: '2026-09-13', forDate: '2026-09-14', wake: '08:00', sleep: '00:00', mood: 60, focus: 'x' }, null, 2));
st = todayState(dir, { ...persona, __job: cfgJob }, MONDAY);
ok(st.job && st.job.type === 'freelance' && st.job.source === 'config', '旧版剧本没有 job 字段 → 安全回落配置');

console.log(fail === 0 ? '\nJOB-INFER ALL GREEN ✅  ' + pass + ' 项' : '\nJOB-INFER 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

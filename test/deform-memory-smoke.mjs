// deform-memory-smoke.mjs — 变形状态机"真接线" + 双向记忆"真联动"的专项测试
// 背景：这两块之前都是半成品黑盒——变形算出来了却没进提示词（字段名不匹配+恢复在生成后才消费），
// 她自己的自述存了却检索不到。本测试就是钉死这两条链路。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Deform } from '../src/deform.js';
import { Soul } from '../src/soul.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dm-smoke-'));

// ── ① 变形状态机：压力、灵敏度、开关、阈值、整合度、恢复 ──
const d1 = new Deform(tmp(), () => {}, () => ({}));
d1.note('rude');
ok(d1.info().stress === 18, '被凶一次 +18（实际 ' + d1.info().stress + '）');
d1.note('warm');
ok(d1.info().stress === 6, '被哄一次 −12（实际 ' + d1.info().stress + '）');

const d2 = new Deform(tmp(), () => {}, () => ({ deform: { sensitivity: 2 } }));
d2.note('rude');
ok(d2.info().stress === 36, '灵敏度×2 → 加压翻倍（实际 ' + d2.info().stress + '）');
d2.note('warm');
ok(d2.info().stress === 24, '灵敏度不放大减压（仍 −12，实际 ' + d2.info().stress + '）');

const d3 = new Deform(tmp(), () => {}, () => ({ deform: { enabled: false } }));
d3.note('rude'); d3.note('allNighter');
const i3 = d3.info();
ok(i3.stress === 0 && i3.state === 'normal' && i3.enabled === false, '总开关关掉 → 压力不再累积、永远是稳态');

const d4 = new Deform(tmp(), () => {}, () => ({ deform: { grip: 20, loop: 50, shadow: 80 } }));
d4.note('rude'); // 18 < 20
ok(d4.info().state === 'normal', '自定义阈值：18 分还不到 20 → 正常');
d4.note('conflict'); // 38 ≥ 20
const i4 = d4.info();
ok(i4.state === 'grip' && i4.thresholds.grip === 20, '过阈值1 → 劣势爆发 Grip（阈值 20）');
for (let k = 0; k < 3; k++) d4.note('rude');
ok(['loop', 'shadow'].includes(d4.info().state), '压力继续累积 → 进入更深层（' + d4.info().state + '）');

// 恢复：把压力降下去 → justRecovered + 整合度+2；consumeRecovery 只能消费一次
const d5 = new Deform(tmp(), () => {}, () => ({ deform: { grip: 30 } }));
d5.note('rude'); d5.note('conflict'); // 38 → grip
const s5 = JSON.parse(fs.readFileSync(d5.file, 'utf8'));
s5.stress = 0; fs.writeFileSync(d5.file, JSON.stringify(s5));
const i5 = d5.info(); // 退出变形
ok(i5.justRecovered === true && i5.integration === 2 && i5.state === 'normal', '平静退出 → 标记"刚缓过来"且整合度 +2');
ok(d5.consumeRecovery() === true && d5.consumeRecovery() === false, '恢复提示只消费一次（不会每轮都道歉）');
const st5 = JSON.parse(fs.readFileSync(d5.file, 'utf8'));
st5.integration = 80; fs.writeFileSync(d5.file, JSON.stringify(st5));
const i5b = d5.info();
ok(i5b.thresholds.grip === 42, '整合度让阈值1抬高（30 + 80×0.15 = 42：越来越不容易被逼变形）');

// ── ② 变形与双向记忆"真的进了提示词" ──
function mkSoul(opts = {}) {
  const dir = tmp();
  let captured = null;
  const router = { async chat(messages) { captured = messages; return { content: '嗯嗯', backend: 'stub' }; } };
  const soul = new Soul({ dir, router, logger: () => {}, behavior: () => ({ chunkMax: 3, contextRounds: 8, topK: 6, extractEveryN: 1, replySpeed: 'human', memory: opts.memory || {} }) });
  soul._captured = () => captured;
  return soul;
}

const soulA = mkSoul();
soulA.deform = { info: () => ({ state: 'grip', stress: 60, integration: 0, enabled: true, thresholds: { grip: 45, loop: 70, shadow: 88 } }), consumeRecovery: () => false };
await soulA.reply({ peerKey: 'p:1', isOwner: true, text: '在干嘛', today: null });
const sysA = soulA._captured()[0].content;
ok(sysA.includes('变形中') && sysA.includes('劣势功能爆发'), '变形状态真的进了提示词（Grip 风格指令）');

const soulB = mkSoul();
soulB.deform = { info: () => ({ state: 'normal', stress: 0, integration: 30, enabled: true, thresholds: { grip: 45, loop: 70, shadow: 88 } }), consumeRecovery: () => true };
const outB = await soulB.reply({ peerKey: 'p:1', isOwner: true, text: '在吗', today: null });
const sysB = soulB._captured()[0].content;
ok(sysB.includes('刚缓过来') && /道歉|自嘲/.test(sysB), '恢复那一轮注入了道歉/自嘲指令');
ok(outB.recovered === true, '返回值标记本轮是恢复轮（recovered=true）');

const soulC = mkSoul();
soulC.savePersona({ traits: { socialBattery: 50, warmth: 50, attachment: 50, sharpness: 50, initiative: 50, orderliness: 50 } });
soulC.deform = { info: () => ({ state: 'normal', stress: 0, integration: 0, enabled: true, thresholds: {} }), consumeRecovery: () => false };
await soulC.reply({ peerKey: 'p:1', isOwner: true, text: '早', today: { traitDrift: { warmth: 10, socialBattery: -6 }, chatter: 1, speedState: 1 } });
const sysC = soulC._captured()[0].content;
ok(sysC.includes('你今天是 60%') && sysC.includes('你今天是 44%'), '六维每日弹性真的生效（基准50+漂移：温度60%、电量44%）');

// ── ③ 双向记忆：她自己的话要能被检索到、要单独注入 ──
const soulD = mkSoul();
await soulD.addMemory({ who: 'self', text: '我下周要去趟杭州', importance: 2, tags: ['自述'], source: 'self' });
await soulD.addMemory({ who: 'p:1', text: '主人不吃香菜', importance: 3, tags: [], source: 'manual' });
const hits = await soulD._retrieveHybridLocal('杭州 出差', 'p:1');
ok(hits.some((h) => String(h.text).includes('杭州')), '她自己说过的话能被检索到（联动的前提）');
await soulD.reply({ peerKey: 'p:1', isOwner: true, text: '下周有空吗', today: null });
const sysD = soulD._captured()[0].content;
ok(sysD.includes('你自己说过的话') && sysD.includes('杭州'), '她自己的话被单独注入提示词（要求立场一致）');
ok(sysD.includes('你记得的关于对方') && sysD.includes('香菜'), '对方的事照常注入（两条线分开，不混淆）');

const soulE = mkSoul({ memory: { selfMemory: false } });
await soulE.addMemory({ who: 'self', text: '我打算去学吉他', importance: 2, tags: ['自述'], source: 'self' });
const hitsE = await soulE._retrieveHybridLocal('吉他', 'p:1');
ok(!hitsE.some((h) => String(h.text).includes('吉他')), '关掉双向记忆开关 → 她自己的话不再被检索');
const before = soulE.getMemories().entries.length;
await soulE.recordConversation({ peerKey: 'p:1', isOwner: true, userText: '你今天干嘛了', herTexts: ['我明天想去公园跑步'] });
ok(soulE.getMemories().entries.length === before, '关掉开关后也不再抽取新的自述');
const soulF = mkSoul();
await soulF.recordConversation({ peerKey: 'p:1', isOwner: true, userText: '你今天干嘛了', herTexts: ['我明天想去公园跑步', '嗯'] });
const selfMems = soulF.getMemories().entries.filter((e) => e.who === 'self' || e.source === 'self');
ok(selfMems.length === 1 && selfMems[0].text.includes('公园'), '开着时会把她的自述归档（"我明天想去公园跑步"）');

// ── ④ 人味细节：手滑打错字后自己更正（默认关，开了要有） ──
const soulG = mkSoul();
let sawTypo = false;
for (let i = 0; i < 300; i++) {
  const chunks = soulG._planChunks('今天天气不错。我出去走了一圈。', { quirks: { typoRate: 0.1, maxLength: 'short' } });
  if (chunks.some((c) => String(c).includes('啊打错了'))) { sawTypo = true; break; }
}
ok(sawTypo, '手滑更正真的会发生（typoRate=10% 采样 300 次至少命中一次）');
const soulH = mkSoul();
let noTypo = true;
for (let i = 0; i < 50; i++) {
  const chunks = soulH._planChunks('今天天气不错。我出去走了一圈。', { quirks: { typoRate: 0, maxLength: 'short' } });
  if (chunks.some((c) => String(c).includes('啊打错了'))) { noTypo = false; break; }
}
ok(noTypo, '默认关闭时永不出现错字（typoRate=0）');

console.log(fail === 0 ? '\nDEFORM-MEMORY-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nDEFORM-MEMORY-SMOKE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

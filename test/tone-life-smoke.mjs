// tone-life-smoke.mjs — "她怎么说话"的回归：时间窗（下午不说晚安）+ 关系分寸 + 主动消息上限
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/tone-life-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Life, windowOf, windowPhase, inWindowAt } from '../src/life.js';
import { proactiveLimit, toneForToday, DEFAULT_TONE, Soul } from '../src/soul.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tone-'));
const at = (h, m = 0) => new Date('2026-09-14T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00');

// ── ① 时间窗工具（跨天正确）──
const nightWin = windowOf(120, 60, 120); // 中心 02:00，睡前 1h ~ 睡后 2h
ok(inWindowAt(120, nightWin), '02:00 在"晚安窗口"里');
ok(inWindowAt(60, nightWin), '01:00（睡前 1 小时）在窗口里');
ok(inWindowAt(240, nightWin), '04:00（睡后 2 小时）在窗口里');
ok(!inWindowAt(14 * 60, nightWin), '14:00 不在晚安窗口里 ← 这就是你遇到的 bug');
ok(windowPhase(14 * 60, nightWin) === 'after', '14:00 相对晚安窗口是"已错过"（不补发）');
ok(windowPhase(20 * 60, windowOf(8 * 60, 0, 90)) === 'after', '20:00 相对早安窗口是"已错过"');
ok(windowPhase(7 * 60, windowOf(8 * 60, 0, 90)) === 'before', '07:00 相对早安窗口是"还没到"');

// ── ② 生活调度：下午 2 点启动 → 不补发早安/晚安 ──
const fakeSoul = (record) => ({ proactive: async (kind) => { record.push(kind); return { chunks: ['x'], delaysMs: [0] }; } });
const baseCfg = { life: { enabled: true, wake: '08:00', sleep: '02:00', morningOn: true, nightOn: true, pokesPerDay: 8, pokeWindow: ['10:00', '22:00'], nudgeMinutes: 60, nudgeMaxPerDay: 4, quietHours: '' } };
let sentKinds = [];
let dir = mk();
let life = new Life({ dir, config: () => baseCfg, logger: () => {} });
let out = await life.tick({ soul: fakeSoul(sentKinds), sendToOwner: async () => {}, now: at(14) });
ok(!sentKinds.includes('morning') && !sentKinds.includes('night'), '下午 14:00 启动：不补发早安、不补发晚安（实际发了：' + (sentKinds.join(',') || '无') + '）');
const st = JSON.parse(fs.readFileSync(path.join(dir, 'life-state.json'), 'utf8'));
ok(st.skipped && st.skipped.morning && /错过/.test(st.skipped.morning), '错过的原因写进状态里（后台/日志能查）：' + st.skipped.morning.slice(0, 24) + '…');

// 早上 8:05 启动 → 发早安（在窗口里）
sentKinds = []; dir = mk();
life = new Life({ dir, config: () => baseCfg, logger: () => {} });
await life.tick({ soul: fakeSoul(sentKinds), sendToOwner: async () => {}, now: at(8, 5) });
ok(sentKinds.includes('morning'), '早上 08:05 启动：发早安 ✅');

// 凌晨 1:30 启动 → 发晚安（跨天窗口）
sentKinds = []; dir = mk();
life = new Life({ dir, config: () => baseCfg, logger: () => {} });
await life.tick({ soul: fakeSoul(sentKinds), sendToOwner: async () => {}, now: at(1, 30) });
ok(sentKinds.includes('night'), '凌晨 01:30（睡前 1 小时）启动：发晚安 ✅（跨天判断正确）');

// 睡着之后（03:30，睡后 1.5 小时）→ 不能再说晚安（她已经睡了）
sentKinds = []; dir = mk();
life = new Life({ dir, config: () => baseCfg, logger: () => {} });
await life.tick({ soul: fakeSoul(sentKinds), sendToOwner: async () => {}, now: at(3, 30) });
ok(!sentKinds.includes('night'), '睡着之后（03:30）不会发晚安 —— 睡后不该再有"晚安"');
const st3 = JSON.parse(fs.readFileSync(path.join(dir, 'life-state.json'), 'utf8'));
ok(st3.night !== true, '而且不会被误标成今天已发过——今晚的窗口还留着（睡前会正常发）');

// 她睡着时：一条主动消息都不发（2026-09-13 起：睡眠窗口取代了旧的「安静时段」）
// 这组配置是 02:00 睡 / 08:00 起 → 入睡兜底 02:45，05:00 一定在睡
sentKinds = []; dir = mk();
life = new Life({ dir, config: () => ({ life: { ...baseCfg.life } }), logger: () => {} });
await life.tick({ soul: fakeSoul(sentKinds), sendToOwner: async () => {}, now: at(5, 0) });
ok(sentKinds.length === 0, '她睡着时（凌晨 5:00）一条主动消息都不发');
// 同一个点，如果她已经醒了（08:05，起床 08:00）→ 早安照发
sentKinds = []; dir = mk();
life = new Life({ dir, config: () => ({ life: { ...baseCfg.life } }), logger: () => {} });
await life.tick({ soul: fakeSoul(sentKinds), sendToOwner: async () => {}, now: at(8, 5) });
ok(sentKinds.includes('morning'), '醒来之后（08:05）早安照发——不再有"安静时段"挡着');

// ── ③ 关系阶段：刚认识就不主动 ──
sentKinds = []; dir = mk();
life = new Life({ dir, config: () => ({ life: { ...baseCfg.life, wake: '08:00', sleep: '02:00' } }), logger: () => {} });
await life.tick({ soul: fakeSoul(sentKinds), sendToOwner: async () => {}, now: at(14), overrides: { stageLimit: { affection: 0, morning: false, night: false, pokes: 0, nudges: 0 } } });
ok(sentKinds.length === 0, '亲密度 0（刚认识）：她完全不主动（' + (sentKinds.join(',') || '一条都没发') + '）');
const st2 = JSON.parse(fs.readFileSync(path.join(dir, 'life-state.json'), 'utf8'));
ok(st2.skipped && /按她的节奏/.test(String(st2.skipped.poke || '')), '被限流时写明原因（不再提亲密度）：' + String(st2.skipped.poke).slice(0, 40));

// ── 第三次改版：分寸与主动上限不再由亲密度决定，改由世界引擎的 tone 决定 ──
const defLim = proactiveLimit(null);
ok(defLim.morning === true && defLim.night === true && defLim.pokes === 3, '世界引擎没给分寸时：默认放开到按后台配置走（不再因刚认识就封杀）');
const tight = proactiveLimit({ proactive: { morning: false, pokes: 1 } });
ok(tight.morning === false && tight.pokes === 1 && tight.night === true, '世界引擎可以收紧主动（它说早上不用就不发）');
const t1 = toneForToday({ forDate: '2026-09-13', tone: { address: '叫阿泽', chunks: 1 } }, { date: '2026-09-13' });
ok(t1.address === '叫阿泽' && t1.source === 'world', '今天有效的分寸 → 用世界引擎给的');
const t2 = toneForToday({ forDate: '2026-09-12', tone: { address: '旧的' } }, { date: '2026-09-13' });
ok(t2.source === 'default' && !/旧的/.test(t2.address), '世界引擎给的分寸过期 → 自动作废回默认（不会拿昨天的分寸说今天的话）');
ok(DEFAULT_TONE.forbid.length > 0, '默认分寸也带边界（别太热络/别撒娇）');

// ── ④ 默认分寸（旧的三档分寸表已随亲密度一起退场：现在由世界引擎的 tone 唯一决定）──
ok(Array.isArray(DEFAULT_TONE.forbid) && DEFAULT_TONE.forbid.length > 0, '默认分寸带边界（' + DEFAULT_TONE.forbid.slice(0, 2).join('、') + '…）——不认识就该客气');
ok(/名字|哎/.test(DEFAULT_TONE.address), '默认称呼是"名字/哎"，不是亲昵称呼：' + DEFAULT_TONE.address);

// ── ⑤ 提示词：不能出现"主人"这个角色标签；必须带今天的分寸 ──
const soul = new Soul({ dir: mk(), router: { chat: async () => ({ content: '嗯' }), cfg: {} }, logger: () => {} });
const sys = soul._systemPrompt({
  persona: { name: '苏镜语', birthday: '2004-02-03', job: '律师', jobType: 'office', personaText: '上海做律师', interests: ['旅行'], quirks: { catchphrases: ['嗯'] }, traits: { warmth: 25, attachment: 20, sharpness: 64, orderliness: 73 }, assessments: { mbti: 'INTJ' }, relationship: { toOwner: '好朋友' } },
  rel: { affection: 0, chats: 0, mood: 50 },
  isOwner: true, memories: [], now: at(14), behavior: {}, today: { date: '2026-09-14' }, world: null,
});
ok(!/【主人】/.test(sys) && !/对方是【主人】/.test(sys), '提示词里不再有"【主人】"这个角色标签');
ok(/绝对不要叫他「主人」/.test(sys), '明确禁止她叫"主人/老公/亲爱的"');
ok(/【今天的分寸/.test(sys) && /世界引擎还没给过分寸/.test(sys), '提示词里带了「今天的分寸」（世界引擎没给 → 用默认分寸，并写明来历）');
ok(!/亲密度/.test(sys), '提示词里不再出现「亲密度」（数值化退场）');
ok(/14:00（下午）/.test(sys), '时间用 24 小时制 + 中文时段告诉了她：14:00（下午）');
ok(/下午不要说早安/.test(sys), '并明确提醒她"下午不要说早安"');
ok(/INTJ/.test(sys) && /依恋强度/.test(sys), 'INTJ 与六维仍在提示词里（性格锚点没丢）');
// 世界引擎给了 tone → 以它为准
const sys2 = soul._systemPrompt({
  persona: { name: '苏镜语', traits: {}, assessments: {}, relationship: {}, interests: [] },
  rel: { affection: 0, chats: 0, mood: 50 }, isOwner: true, memories: [], now: at(14), behavior: {},
  today: { date: '2026-09-14' },
  world: { forDate: '2026-09-14', tone: { intimacy: 5, address: '叫他先生', style: '非常客气', forbid: ['任何主动示好'], reason: '刚认识一周' } },
});
ok(/叫他先生/.test(sys2) && /非常客气/.test(sys2) && /刚认识一周/.test(sys2), '世界引擎判断的分寸优先生效（并写明理由）');
// 世界引擎的 tone 不是今天的 → 不采用（防止用昨天/明天的分寸说话）
const sys3 = soul._systemPrompt({
  persona: { name: '苏镜语', traits: {}, assessments: {}, relationship: {}, interests: [] },
  rel: { affection: 0, chats: 0, mood: 50 }, isOwner: true, memories: [], now: at(14), behavior: {},
  today: { date: '2026-09-14' }, world: { forDate: '2026-09-13', tone: { intimacy: 99, address: '叫老公', style: '超甜', forbid: [] } },
});
ok(!/叫老公/.test(sys3), '昨天/明天的分寸不会被误用（只认 forDate 对得上的那份）');

// ── ⑥ 打字节奏与话量（用户反馈"打字快得不像人""话多不像 INTJ"）──
const soulP = new Soul({ dir: mk(), router: { chat: async () => ({ content: 'x' }), cfg: {} }, logger: () => {} });
const short = soulP._planDelays(['嗯'], true, 1);
const long = soulP._planDelays(['x'.repeat(40)], true, 1);
ok(short[0] >= 400, '看到消息后先等一会儿（≥400ms），不是秒回（' + short[0] + 'ms）');
ok(long[0] >= 400, '第一条也不是瞬发');
const twoChunks = soulP._planDelays(['x'.repeat(30), 'y'.repeat(30)], true, 1);
ok(twoChunks.length === 2 && twoChunks[1] > 2000, '第二条要等"打完第一条"的时间（30 字 → ' + twoChunks[1] + 'ms）');
ok(twoChunks[1] > short[0], '越长的消息等得越久（按字数算，不再固定几百毫秒）');
ok(soulP._planDelays(['x'.repeat(200)], true, 1)[1] === undefined && soulP._planDelays(['x'.repeat(200), 'y'], true, 1)[1] <= 12000, '单条等待有上限（≤12 秒），不会等到天荒地老');
const fastK = soulP._planDelays(['x'.repeat(30), 'y'.repeat(30)], true, 2);
const slowK = soulP._planDelays(['x'.repeat(30), 'y'.repeat(30)], true, 0.5);
ok(fastK[1] < slowK[1] * 0.6, '手速滑杆方向正确：越大越快（×2 → ' + fastK[1] + 'ms ／ ×0.5 → ' + slowK[1] + 'ms）');

const planIntj = soulP._talkPlan({ traits: { initiative: 44, warmth: 25 } }, null, 0);
const planWarm = soulP._talkPlan({ traits: { initiative: 80, warmth: 85 } }, null, 60);
ok(planIntj.maxChunks <= 2 && planIntj.maxChars <= 32, 'INTJ 型（温度/发起力低）话不多：最多 ' + planIntj.maxChunks + ' 条 / ' + planIntj.maxChars + ' 字');
ok(planWarm.maxChunks >= 3 && planWarm.maxChars > planIntj.maxChars, '外向热情型可以说更多（' + planWarm.maxChunks + ' 条 / ' + planWarm.maxChars + ' 字）');
ok(soulP._talkPlan({ traits: { initiative: 44, warmth: 25 } }, { talkDelta: 30 }, 30).maxChunks >= soulP._talkPlan({ traits: { initiative: 44, warmth: 25 } }, null, 30).maxChunks, '世界引擎给的当天话量修饰真的起作用（话量只有这一条档位）');
// 提示词里必须写清"最多几条/每条几个字"，否则模型还是会长篇大论
const sysTalk = soulP._systemPrompt({
  persona: { name: '苏镜语', traits: { initiative: 44, warmth: 25 }, quirks: {}, interests: [], assessments: {}, relationship: {} },
  rel: { affection: 0, chats: 0, mood: 50 }, isOwner: true, memories: [], now: at(14), behavior: {},
  today: { date: '2026-09-14' }, world: null, talkPlan: planIntj,
});
ok(/这条最多 \d+ 条消息、每条不超过 \d+ 个字/.test(sysTalk), '提示词里写明了话量上限（防话唠）');
ok(/严禁客服腔|AI腔/.test(sysTalk), '提示词里禁止客服腔/AI腔');
ok(/不要主动延伸|能一个字解决/.test(sysTalk), '提示词里要求"有事说事、不主动延伸"');

// ── ⑦ 称呼：专属昵称真的生效 + 「他是谁」已退场（2026-09-13 改）──
// 黑盒修复：以前「专属昵称」只在"关系阶段跃迁"时才进提示词，而阶段已经退场 → 填了等于没填。
const sysPet = soulP._systemPrompt({
  persona: { name: '苏镜语', traits: {}, quirks: {}, interests: [], assessments: {}, relationship: { callOwner: '阿泽' } },
  rel: { chats: 12, mood: 60 }, isOwner: true, memories: [], now: at(14), behavior: {},
  today: { date: '2026-09-14' }, world: null,
});
ok(/阿泽/.test(sysPet), '「专属昵称」会进她的提示词（以前填了等于没填）');
ok(/熟度够/.test(sysPet), '并写明：熟度够才这么叫，不够就按分寸的叫法（不越界）');
const sysLock = soulP._systemPrompt({
  persona: { name: '苏镜语', traits: {}, quirks: {}, interests: [], assessments: {}, relationship: { callOwner: '阿泽', callLock: true } },
  rel: { chats: 12, mood: 60 }, isOwner: true, memories: [], now: at(14), behavior: {},
  today: { date: '2026-09-14' }, world: null,
});
ok(/认定要叫他「阿泽」/.test(sysLock), '勾了「锁定称呼」→ 不管分寸多客气都用这个叫法');
// 「他是谁」已退场（2026-09-13 用户拍板：她从零认识你，认知全部来自记忆）
const sysNoWho = soulP._systemPrompt({
  persona: { name: '苏镜语', traits: {}, quirks: {}, interests: [], assessments: {}, relationship: {} },
  rel: { chats: 0, mood: 50 }, isOwner: true, memories: [], now: at(14), behavior: {},
  today: { date: '2026-09-14' }, world: null,
  ownerProfile: { name: '阿泽', basic: '杭州，做后端开发，经常加班；不喝咖啡，喜欢猫。' },
});
ok(!/关于他/.test(sysNoWho) && !/别装不认识/.test(sysNoWho), '「他是谁」已退场：即使传了 ownerProfile 也不再进提示词');
const fastD = soulP._planDelays(['x'.repeat(20), 'y'.repeat(20)], true, 2);
const slowD = soulP._planDelays(['x'.repeat(20), 'y'.repeat(20)], true, 0.5);
ok(fastD[0] < slowD[0] && fastD[1] < slowD[1], '手速倍率真的生效（×2 → ' + fastD[1] + 'ms ／ ×0.5 → ' + slowD[1] + 'ms）');
const d30 = soulP._planDelays(['x'.repeat(30), 'y'.repeat(30)], true, 1)[1];
ok(d30 < 4500, '默认手速下 30 字等待 <4.5 秒（实测 ' + d30 + 'ms；旧版要 5.5 秒以上）');
ok(soulP._talkPlan({ traits: { initiative: 44, warmth: 25 } }, null, 62).maxChars >= 28, 'INTJ 的话量放宽到至少 28 字（不再憋成半句）');

console.log(fail === 0 ? '\nTONE-LIFE ALL GREEN ✅  ' + pass + ' 项' : '\nTONE-LIFE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

// interest-smoke.mjs — 兴趣/口头禅长期演化的回归
// 覆盖：性格→变化倾向、概率门控（不是每周都变）、保底与上限、她自己换的留历史、用户手改不留、世界引擎接线
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/interest-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changeTendency, applyInterestChanges, manualReplacement, INTEREST_MIN, INTEREST_MAX, PHRASE_MIN, PHRASE_MAX } from '../src/interest.js';
import { WorldEngine } from '../src/world-engine.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'int-'));

// ── ① 性格 → 倾向 ──
const explorer = changeTendency({ initiative: 90, orderliness: 15, warmth: 70, sharpness: 60 }, 80);
const steady = changeTendency({ initiative: 15, orderliness: 90, warmth: 40, sharpness: 30 }, 0);
ok(explorer.interest > steady.interest, '爱尝新的人（高发起力+低秩序感）兴趣变化倾向更高（' + explorer.interest + ' vs ' + steady.interest + '）');
ok(explorer.phrase > steady.phrase, '温度/锐度高 + 关系近 → 口头禅更容易变（' + explorer.phrase + ' vs ' + steady.phrase + '）');
ok(/发起力/.test(explorer.why) && /倾向/.test(explorer.why), '倾向可解释（后台要显示给用户看）：' + explorer.why.slice(0, 40) + '…');
ok(changeTendency({}, 0).interest > 0 && changeTendency({}, 0).interest < 1, '缺省性格也给 0~1 之间的合理值');

// ── ② 概率门控：不是每周都变 ──
const persona = {
  interests: ['咖啡', '拼图', '老电影'],
  quirks: { catchphrases: ['好呀', '嘿嘿'] },
};
let res = applyInterestChanges({ persona, traits: { initiative: 10, orderliness: 95, warmth: 30, sharpness: 20 }, suggestion: { interestsAdd: '露营', phraseAdd: '哎哟' }, roll: () => 0.99 });
ok(!res.changed, '倾向低 + 骰子不利 → 这周什么都不变（她不是每周都变心）');
ok(res.notes.length >= 1, '没变也留下说明（后台能看到"本可以加但没加"）');

res = applyInterestChanges({ persona, traits: { initiative: 90, orderliness: 15 }, suggestion: { interestsAdd: '露营', phraseAdd: '哎哟' }, roll: () => 0.01 });
ok(res.changed && res.interests.includes('露营') && res.phrases.includes('哎哟'), '倾向高 + 骰子有利 → 新增生效');
ok(res.log.length === 2 && res.log.every((x) => x.op === 'add' && x.at > 0), '她自己换的写进了历史（' + res.log.map((x) => x.text).join('、') + '）');

// ── ③ 保底与上限 ──
res = applyInterestChanges({ persona: { interests: ['a', 'b', 'c'], quirks: { catchphrases: ['x', 'y'] } }, traits: { initiative: 90, orderliness: 10 }, suggestion: { interestDrop: 'a', phraseDrop: 'x' }, roll: () => 0.01 });
ok(res.interests.length === INTEREST_MIN && res.phrases.length === PHRASE_MIN, '保底：兴趣不会少于 ' + INTEREST_MIN + '、口头禅不会少于 ' + PHRASE_MIN);
ok(res.notes.some((n) => /保底/.test(n)), '触发保底时给出说明');
const many = { interests: Array.from({ length: INTEREST_MAX }, (_, i) => '兴趣' + i), quirks: { catchphrases: ['一', '二', '三', '四', '五'] } };
res = applyInterestChanges({ persona: many, traits: { initiative: 95, orderliness: 5 }, suggestion: { interestsAdd: '新来的', phraseAdd: '新的说法' }, roll: () => 0.01 });
ok(res.interests.length === INTEREST_MAX && res.phrases.length === PHRASE_MAX, '上限：兴趣 ≤' + INTEREST_MAX + '、口头禅 ≤' + PHRASE_MAX + '（满了就淡出最早的）');
ok(res.interests[res.interests.length - 1] === '新来的', '新的排在最后（顺序=加入顺序）');

// ── ④ 脏输入 ──
res = applyInterestChanges({ persona, traits: {}, suggestion: { interestsAdd: '咖啡' }, roll: () => 0.01 });
ok(!res.changed, '重复的兴趣不会被加第二遍');
res = applyInterestChanges({ persona, traits: {}, suggestion: { interestsAdd: ' 咖啡   ' }, roll: () => 0.01 });
ok(!res.changed, '带空格的重复项也认得出来');
res = applyInterestChanges({ persona, traits: {}, suggestion: { interestsAdd: '' }, roll: () => 0.01 });
ok(!res.changed && res.log.length === 0, '空建议 → 什么都不做');
ok(manualReplacement({ interests: ['x', 'x', 'y'], quirks: { catchphrases: ['z', 'z'] } }).interests.length === 2, '用户手改：去重，且不产生历史');

// ── ⑤ 世界引擎接线：周结算那一轮才带、落地后进 world-state ──
const prompts = [];
const stubSoul = (() => {
  let p = { ...persona, quirks: { ...persona.quirks } };
  return {
    getPersona: () => p,
    savePersona: (patch) => { p = { ...p, ...patch }; return p; },
    addMemory: async () => {},
    readEvolution: () => ({ warm: 5, rude: 0, chats: 40 }),
    getMemories: () => ({ entries: [] }),
    getRelations: () => ({}),
  };
})();
// 让"满 7 天"成立：预置一个 8 天前的 evolution.json
const dir = mk();
fs.writeFileSync(path.join(dir, 'evolution.json'), JSON.stringify({ lastEvolvedAt: Date.now() - 8 * 86400000, warm: 5, rude: 0, chats: 40 }));
const chatFn = async (arg) => {
  const msgs = Array.isArray(arg) ? arg : ((arg && arg.messages) || []);
  prompts.push(msgs.map((m) => m.content).join('\n'));
  return { content: JSON.stringify({
    diary: '这周迷上了露营。', wake: '08:00', sleep: '23:30', mood: 60, focus: '露营', flow: [], thoughts: [], secrets: [], npc: [],
    portrait: '他挺忙', longline: '想学做甜点',
    evolve: { warmth: 1, reason: '这周他老哄我' },
    interestsAdd: '露营', interestDrop: '', phraseAdd: '哎哟', phraseDrop: '', interestsReason: '同事拉我去露营了',
  }) };
};
const we = new WorldEngine({ dir, router: { chat: chatFn }, config: () => ({ world: { weatherReal: false, baseURL: 'http://stub/v1', model: 'm' } }), soul: stubSoul, logger: () => {}, chatFn });
const out = await we.generate({ persona: stubSoul.getPersona(), today: { sleep: '23:30', events: [] }, memories: [] });
ok(prompts[0].indexOf('兴趣与口头禅') >= 0, '周结算那一轮，提示词里带上了兴趣/口头禅要求');
ok(prompts[0].indexOf('她的性格倾向是') >= 0, '提示词里把性格倾向告诉了编剧（变不变由性格决定）');
ok(prompts[0].indexOf('interestsAdd') >= 0, '输出 schema 里有 interestsAdd/phraseAdd 字段');
ok(Array.isArray(out.tendency ? [out.tendency] : null) || !!out.tendency, 'world-state 里存了这次的变化倾向（后台可显示）');
ok(Array.isArray(out.interestLog), 'world-state 里存了变化历史字段（' + (out.interestLog || []).length + ' 条）');
// 非结算日：带了"刚结算过"的账本 → 不带这些字段
prompts.length = 0;
const dir2 = mk();
fs.writeFileSync(path.join(dir2, 'evolution.json'), JSON.stringify({ lastEvolvedAt: Date.now() - 3600000, warm: 0, rude: 0, chats: 3 }));
const we2 = new WorldEngine({ dir: dir2, router: { chat: chatFn }, config: () => ({ world: { weatherReal: false, baseURL: 'http://stub/v1', model: 'm' } }), soul: stubSoul, logger: () => {}, chatFn });
await we2.generate({ persona: stubSoul.getPersona(), today: { sleep: '23:30', events: [] }, memories: [] });
ok(prompts[0].indexOf('兴趣与口头禅') < 0, '不是结算日 → 不打扰编剧（省 token、也不乱改）');
// 全新安装（没有账本）= 首次运行 → 视作该结算一次
prompts.length = 0;
const dir3 = mk();
const we3 = new WorldEngine({ dir: dir3, router: { chat: chatFn }, config: () => ({ world: { weatherReal: false, baseURL: 'http://stub/v1', model: 'm' } }), soul: stubSoul, logger: () => {}, chatFn });
await we3.generate({ persona: stubSoul.getPersona(), today: { sleep: '23:30', events: [] }, memories: [] });
ok(prompts[0].indexOf('兴趣与口头禅') >= 0, '全新安装（第一次跑）= 第一次结算，会带上兴趣/口头禅');
fs.rmSync(dir3, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });
console.log(fail === 0 ? '\nINTEREST ALL GREEN ✅  ' + pass + ' 项' : '\nINTEREST 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

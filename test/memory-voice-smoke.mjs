// memory-voice-smoke.mjs — 记忆口吻 + 手滑行为 的回归
// 背景：用户反馈①记忆条目是"主人不吃香菜"这种第三人称报告体，非常人机 ②手滑后不该特意说"啊打错了"
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/memory-voice-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Soul } from '../src/soul.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const root = process.cwd();
const soulSrc = fs.readFileSync(path.join(root, 'src', 'soul.js'), 'utf8');
const pySrc = fs.readFileSync(path.join(root, 'python', 'memory_service.py'), 'utf8');

// ── ① 两条抽取链路都要求第一人称 ──
ok((soulSrc.match(/用她自己的第一人称/g) || []).length >= 2, '本地抽取提示词（2 处）都要求她的第一人称');
ok(soulSrc.indexOf('主人不吃香菜') > 0 && soulSrc.indexOf('反例：主人不吃香菜') > 0, '本地提示词里明确把「主人不吃香菜」列为反例');
ok(pySrc.indexOf('custom_fact_extraction_prompt') > 0, 'mem0 sidecar 也配了自定义抽取提示词');
ok(/关于对方用「他」/.test(pySrc) && /绝对不要用「主人」/.test(pySrc), 'mem0 提示词同样禁止「主人/用户」报告词');
ok(soulSrc.indexOf('你是记忆抽取器') < 0, '旧的第三人称抽取提示词已彻底移除');

// ── ② 手滑行为：不再出现"啊打错了" ──
ok(soulSrc.indexOf('啊打错了') < 0, '代码里不再有「啊打错了」这句台词');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
const soul = new Soul({ dir: mk(), router: { chat: async () => ({ content: 'x' }), cfg: {} }, logger: () => {} });
const persona = { quirks: { typoRate: 1 }, traits: {} };
let sawCorrect = false, sawNoCorrect = false, sawAnnounce = false;
for (let i = 0; i < 200; i++) {
  const out = soul._planChunks('我今天去了那家咖啡馆坐着改稿子', persona, 3);
  const joined = out.join('|');
  if (/啊打错了|打错了/.test(joined)) sawAnnounce = true;
  if (out.length >= 2 && out[1] === '我今天去了那家咖啡馆坐着改稿子') sawCorrect = true;
  if (out.length === 1) sawNoCorrect = true;
}
ok(!sawAnnounce, '手滑时永远不会说「打错了」（200 次抽样）');
ok(sawCorrect && sawNoCorrect, '两种真人口滑都出现过：直接重发正确句（' + sawCorrect + '）/ 干脆不纠（' + sawNoCorrect + '）');

console.log(fail === 0 ? '\nMEMORY-VOICE ALL GREEN ✅  ' + pass + ' 项' : '\nMEMORY-VOICE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

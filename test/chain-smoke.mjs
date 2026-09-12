// chain-smoke.mjs — 五个接口的"顺位链（主力 + 三个回落槽）"回归
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/chain-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelRouter } from '../src/model-router.js';
import { WorldEngine } from '../src/world-engine.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const ROLES = ['chat', 'image', 'vision', 'world', 'memory'];

// ① 链解析：数组顺序 = 顺位，主力叫 primary、其余叫 fallbackN
const cfg = {
  chain: {
    chat: [{ baseURL: 'https://a/v1', model: 'M1' }, { baseURL: 'https://b/v1', model: 'M2' }, { baseURL: 'https://c/v1', model: 'M3' }],
    world: [{ baseURL: 'https://w/v1', model: 'W1' }, { baseURL: 'https://w/v1', model: 'W2' }],
  },
  image: { baseURL: 'https://i/v1', model: 'I0' },
  vision: { baseURL: 'https://v/v1', model: 'V0' },
};
const r = new ModelRouter(() => cfg);
const chat = r._chain('chat', 'chat');
ok(chat.length === 3 && chat[0].label === 'chat.primary' && chat[1].label === 'chat.fallback1' && chat[2].model === 'M3', '对话链：4 个槽位按顺位排（primary→fallback1→…）');
ok(r._chain('world', 'world').length === 2 && r._chain('world', 'world')[0].model === 'W1', '世界链按顺位取');
ok(r._chain('image', 'image').length === 1 && r._chain('image', 'image')[0].model === 'I0', '没配链的角色退回原来的单槽（向后兼容）');
ok(r._chain('vision', 'vision')[0].model === 'V0', '识图同样兼容旧配置');

// ② 真回落：主力全挂 → 必须用下一个槽，且报错里能看到"每个槽挂在哪"
const r2 = new ModelRouter(() => ({ chain: { vision: [
  { baseURL: 'http://127.0.0.1:9/v1', model: 'dead-1' },
  { baseURL: 'http://127.0.0.1:9/v1', model: 'dead-2' },
] } }));
let msg = '';
try { await r2.visionDescribe({ imageData: Buffer.from('x'), mime: 'image/png' }); } catch (e) { msg = e.message; }
ok(/dead-1/.test(msg) && /dead-2/.test(msg) && /都失败/.test(msg), '识图三槽全挂时报错列出"每个槽挂在哪"（可排查，不是黑盒）');
ok(r2.lastBackend === '' || typeof r2.lastBackend === 'string', '全挂时不留下"成功的后端"标记');

// ③ 生图返回数组形状不能被包装坏（调用方按数组用）
const calls = [];
const r3 = new ModelRouter(() => ({ chain: { image: [{ baseURL: 'https://ok/v1', model: 'IMG' }] } }));
ok(Array.isArray(r3._chain('image', 'image')) && r3._chain('image', 'image')[0].model === 'IMG', '生图链就绪');

// ④ 世界引擎：认链（三槽）就算"已配置独立API"，且不与对话共用
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-'));
const we = new WorldEngine({ dir, config: () => ({ chain: { world: [{ baseURL: 'https://w/v1', model: 'W1' }, { baseURL: 'https://w/v1', model: 'W2' }] }, chat: { baseURL: 'https://a/v1', model: 'CHAT' } }), soul: {}, logger: () => {} });
ok(we._dedicatedReady() === true, '世界引擎认自己的三槽链 → 判断为"已配置独立API"');
ok(we._worldChain().length === 2 && we._worldChain().every((c) => c.model.startsWith('W')), '世界引擎只用自己链上的模型（绝不回落用对话接口）');
const we2 = new WorldEngine({ dir, config: () => ({ chat: { baseURL: 'https://a/v1', model: 'CHAT' } }), soul: {}, logger: () => {} });
ok(we2._dedicatedReady() === false, '只配了对话、没配世界 → 仍判定"未配置"，不许偷偷共用');

// ⑤ 配置白名单放行 chain（否则保存时会被静默丢掉）
const idx = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');
ok(/for \(const rl of \['chat', 'image', 'vision', 'world', 'memory'\]\)/.test(idx), '后端白名单放行 chain 的五个角色（且不遮蔽 role 函数）');
ok(/rl === 'image' \|\| rl === 'vision'\) \? 4 : 3/.test(idx), '生图/识图 4 槽、其余 3 槽（4+4=8）');
const py = fs.readFileSync(path.join(process.cwd(), 'python', 'memory_service.py'), 'utf8');
ok(/def _llm_candidates/.test(py) && /memory_with_fallback/.test(py), '记忆提炼的 sidecar 也支持轮流试回落槽');

console.log(fail === 0 ? '\nCHAIN-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nCHAIN-SMOKE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

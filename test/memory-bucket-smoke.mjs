// memory-bucket-smoke.mjs — 记忆桶化 + 遗忘曲线 + 迁移的专项测试
//
// 钉死这几条：①三个桶的默认判定 ②归属按正文前缀判（世界流水归"世界"、成长归"她"）
// ③遗忘曲线的形状（固化不衰减、其余随时间降但永不归零、被想起后回升）④改桶真的落进 meta
// ⑤迁移：判桶 + 补回缺失的 mid + 损坏条目进人工清单 + 可重复跑 ⑥想起时间的 6 小时节流
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Soul } from '../src/soul.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memb-smoke-'));
const mkSoul = (dir) => new Soul({ dir, router: { chat: async () => ({ content: 'x' }), cfg: {} }, logger: () => {} });

// ── ① 默认判桶 ──
const s1 = mkSoul(tmp());
ok(s1._bucketOf({ who: '', text: '我叫锦鲤' }) === 'permanent', '手写的条目（who 为空）→ 固化');
ok(s1._bucketOf({ who: 'self', text: '（生活）早上去楼下买了咖啡' }) === 'dynamic', '世界引擎写的流水 → 会淡忘');
ok(s1._bucketOf({ who: 'self', text: '（成长）今天想通了一件事' }) === 'feel', '她的成长 → 她自己的感受');
ok(s1._bucketOf({ who: 'self', text: '我最喜欢下雨天', cat: 'her' }) === 'feel', '她自己的话（cat=her）→ 她自己的感受');
ok(s1._bucketOf({ who: 'p1', text: '他不吃香菜' }) === 'dynamic', '关于他的普通事 → 会淡忘');

// ── ② 归属按正文前缀判 ──
ok(s1.catOf({ who: 'self', text: '（生活）去了咖啡馆' }) === 'world', '（生活）→ 归属是「世界」');
ok(s1.catOf({ who: 'self', text: '（成长）想通了一件事' }) === 'her', '（成长）→ 归属是「她」');
ok(s1.catOf({ who: 'self', text: '我打算下周去杭州' }) === 'her', '她自己的自述 → 归属是「她」');
ok(s1.catOf({ who: 'p1', text: '他不吃香菜' }) === 'you', '关于他的事 → 归属是「我」');

// ── ③ 遗忘曲线 ──
const DAY = 86400000;
ok(s1._bucketWeight('permanent', 0, Date.now() - 365 * DAY) === 1, '固化的条目不随时间衰减（一年前也是 1）');
const fresh = s1._bucketWeight('dynamic', 0, Date.now());
ok(fresh > 0.95, '刚记下的条目权重接近 1（实测 ' + fresh.toFixed(2) + '）');
const old = s1._bucketWeight('dynamic', 0, Date.now() - 60 * DAY);
ok(old < 0.4, '两个月没提过的条目明显降权（实测 ' + old.toFixed(2) + '）');
const veryOld = s1._bucketWeight('dynamic', 0, Date.now() - 3650 * DAY);
ok(veryOld >= 0.25 && veryOld < 0.3, '再久也不会归零（下限 0.25，实测 ' + veryOld.toFixed(2) + '）——只降权不删');
const revived = s1._bucketWeight('dynamic', Date.now() - 1 * DAY, Date.now() - 60 * DAY);
ok(revived > old + 0.3, '被想起过就从"上次想起"算 → 权重回升（' + old.toFixed(2) + ' → ' + revived.toFixed(2) + '）');
ok(s1._bucketWeight('feel', 0, Date.now() - 60 * DAY) > old, '她自己的感受衰减更慢（同样 60 天，感受比普通事高）');

// ── ④ 改桶真的落进 meta ──
const s2 = mkSoul(tmp());
await s2.addMemory({ who: 'p1', text: '他不吃香菜' });
const e2 = s2.getMemories().entries[0];
ok(e2 && e2.bucket === 'dynamic', '落本地时带上 bucket 字段');
ok(await s2.engineUp() === false, '引擎不可达（本测试跑本地兜底路径）');
await s2.setBucket(e2.id, 'permanent');
ok(s2._bucketOf(e2) === 'permanent', '改桶后 _bucketOf 立刻读到新桶');
const metaRaw = JSON.parse(fs.readFileSync(path.join(s2.dir, 'memory-meta.json'), 'utf8'));
ok(metaRaw.v === 2 && metaRaw.entries && metaRaw.entries[e2.id], 'meta 文件是 v2 结构（{v:2,entries:{…}}）');
ok(metaRaw.entries[e2.id].bucket === 'permanent', 'meta 里存的确实是新桶');
let threw = false;
try { await s2.setBucket(e2.id, '不存在的桶'); } catch { threw = true; }
ok(threw, '未知的桶会被拒绝（不会写进脏数据）');

// ── ⑤ 迁移：判桶 + 补 mid + 损坏清单 + 可重复跑 ──
const dir3 = tmp();
const legacy = [
  { id: 'a1', who: '', text: '我叫锦鲤', ts: Date.now() - 5 * DAY },
  { id: 'a2', who: 'self', text: '（生活）早上去楼下买了咖啡', ts: Date.now() - 4 * DAY },
  { id: 'a3', who: 'self', text: '（成长）今天想通了一件事', ts: Date.now() - 3 * DAY },
  { id: 'a4', who: '', text: '正文坏掉了\ufffd\ufffd\ufffd', ts: Date.now() - 2 * DAY },
];
fs.mkdirSync(dir3, { recursive: true });
fs.writeFileSync(path.join(dir3, 'memory.json'), JSON.stringify({ entries: legacy, todos: [] }), 'utf8');
// 故意留一份旧格式的 meta：迁移应该把它留档成 v1，再重建成 v2
fs.writeFileSync(path.join(dir3, 'memory-meta.json'), JSON.stringify({ a1: { importance: 5, pinned: true } }), 'utf8');
const s3 = mkSoul(dir3);
const r3 = await s3.migrateBuckets();
ok(r3.total === 4 && r3.migrated === 3 && r3.review === 1, '迁移统计正确：4 条里 3 条入桶、1 条进人工清单（' + JSON.stringify(r3) + '）');
const after = JSON.parse(fs.readFileSync(path.join(dir3, 'memory.json'), 'utf8')).entries;
ok(after.find((x) => x.id === 'a1').bucket === 'permanent', '迁移后：手写的进固化桶');
ok(after.find((x) => x.id === 'a2').bucket === 'dynamic' && after.find((x) => x.id === 'a2').cat === 'world', '迁移后：世界流水 → 会淡忘 + 归属世界');
ok(after.find((x) => x.id === 'a3').bucket === 'feel', '迁移后：成长 → 她自己的感受');
ok(fs.existsSync(path.join(dir3, 'memory-meta.v1.json')), '旧格式的 meta 被留档成 memory-meta.v1.json（可回退）');
const rev = JSON.parse(fs.readFileSync(path.join(dir3, 'memory-meta-review.json'), 'utf8'));
ok(rev.items.length === 1 && rev.items[0].id === 'a4', '损坏的条目进了人工处置清单（不自动删、不自动进桶）');
const meta3 = JSON.parse(fs.readFileSync(path.join(dir3, 'memory-meta.json'), 'utf8'));
ok(meta3.v === 2 && Object.keys(meta3.entries).length === 3, 'meta 重建为 v2，只收进 3 条健康条目');
const r3b = await s3.migrateBuckets();
ok(r3b.migrated === 3 && r3b.review === 1, '迁移可重复跑：第二次结果一致（幂等，不会重复记账）');

// ── ⑥ 想起时间的 6 小时节流 ──
const s4 = mkSoul(tmp());
await s4.addMemory({ who: 'p1', text: '他喜欢喝美式' });
const e4 = s4.getMemories().entries[0];
const first = s4.touchMemories([e4]);
ok(first === true && s4._metaGet(e4.id).lastHit > 0, '第一次想起 → 记下时间');
const second = s4.touchMemories([e4]);
ok(second === false, '6 小时内再次想起 → 不重复写（节流生效）');

console.log(fail === 0 ? '\nMEMORY-BUCKET ALL GREEN ✅  ' + pass + ' 项' : '\nMEMORY-BUCKET 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

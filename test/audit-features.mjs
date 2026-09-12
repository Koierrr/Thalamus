// audit-features.mjs — 功能状态数据源体检
// 它是「功能状态」页签 + 她的自我认知卡的共同数据源，脏数据会同时污染两处。
// 检查：字段完整性 / status 枚举合法 / planned·shelved 必须写明卡点或计划 / id 唯一 / 分组合理 /
//      自我认知卡里的"会什么·还不会什么"必须与实际条目一致。
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/audit-features.mjs
import { FEATURE_STATUS, featureGroups, featureSummaryForSoul, featureGistForSoul } from '../src/feature-status.js';

let bad = 0;
const err = (m) => { console.log('❌ ' + m); bad++; };
const OK = new Set(['done', 'partial', 'building', 'planned', 'shelved']);
const ids = new Set();
for (const f of FEATURE_STATUS) {
  for (const k of ['id', 'group', 'name', 'status', 'detail']) {
    if (!f[k] || String(f[k]).trim() === '') err('条目缺字段 ' + k + '：' + (f.name || f.id || JSON.stringify(f).slice(0, 40)));
  }
  if (!OK.has(f.status)) err('status 非法：' + f.id + ' = ' + f.status);
  if (ids.has(f.id)) err('id 重复：' + f.id);
  ids.add(f.id);
  if ((f.status === 'partial' || f.status === 'planned' || f.status === 'shelved') && !f.blocked && !f.plan) {
    err('未完成条目没写清卡点或计划：' + f.id);
  }
  if (f.status === 'done' && (String(f.detail).includes('还没') || String(f.detail).includes('未上线'))) {
    err('标了 done 但 detail 里写着"还没/未上线"（状态与描述矛盾）：' + f.id);
  }
}
const groups = featureGroups();
if (groups.length < 5) err('分组过少（' + groups.length + '）');
const soul = featureSummaryForSoul();
if (!soul.includes('你完全会') || !soul.includes('还不会')) err('自我认知摘要缺少"会/不会"两段');
const gist = featureGistForSoul();
if (gist.length > 700) err('常驻小卡过长（' + gist.length + ' 字符，省 token 原则要求 ~100 token）');
// 会什么/不会什么 与条目一致性抽样
const doneNames = FEATURE_STATUS.filter((f) => f.status === 'done').map((f) => f.name.split('（')[0]);
const missed = doneNames.filter((n) => !soul.includes(n));
if (missed.length > 3) err('自我认知漏掉太多已完成能力：' + missed.slice(0, 5).join('、'));

console.log('条目 ' + FEATURE_STATUS.length + ' 条 / 分组 ' + groups.length + ' 个 / 摘要 ' + soul.length + ' 字符 / 常驻小卡 ' + gist.length + ' 字符');
const byStatus = {};
for (const f of FEATURE_STATUS) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
console.log('状态分布：' + JSON.stringify(byStatus));
console.log(bad === 0 ? '✅ 功能状态数据源健康' : '⚠️ 有 ' + bad + ' 处问题');
process.exit(bad === 0 ? 0 : 1);

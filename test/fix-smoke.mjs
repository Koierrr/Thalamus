// fix-smoke.mjs — 2026-09-13 现场故障的防回归（用户真机验收报的一串问题）
// 每一条都对应一个真实发生过的 bug，钉死它别再回来。
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/fix-smoke.mjs
import fs from 'node:fs';
import { WorldEngine } from '../src/world-engine.js';
import os from 'node:os';
import path from 'node:path';
import { applyDayEvent } from '../src/daily.js';
import { Life } from '../src/life.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const idx = read('src/index.js');
const lifeSrc = read('src/life.js');
const soul = read('src/soul.js');
const daily = read('src/daily.js');
const py = read('python/memory_service.py');
const html = read('src/console.html');

// ── ① 「教她记一件事不生效」：记忆引擎的 /add 里 cfg 必须有定义 ──
{
  const postBlock = (() => { const i = py.indexOf('def do_POST'); const j = py.indexOf('\n    def ', i + 5); return py.slice(i, j < 0 ? undefined : j); })();
  // 只看代码行（注释里会引用"以前写错的那一行"，不能算数）
  const NL = String.fromCharCode(10);
  const postCode = postBlock.split(NL).filter((l) => !/^\s*#/.test(l)).join(NL);
  ok(/m, err, cfg = get_memory\(\)/.test(postCode), '记忆引擎 do_POST 接住了 cfg（/add 的回落重试要用它）');
  ok(!/m, err, _ = get_memory\(\)/.test(postCode), 'do_POST 里没有再把 cfg 丢掉（否则每次写记忆都 NameError）');
  ok(/if path == '\/quit'/.test(py), '记忆引擎有体面退出入口（插件才能重启它）');
}

// ── ② 「引擎一直跑旧代码」：必须能重启 ──
{
  ok(/_restartMemoryEngine\s*\(/.test(idx) && /_spawnMemoryEngine\s*\(/.test(idx), '插件有"重启记忆引擎"的能力');
  ok(/path === 'panel\/mem-engine\/restart'/.test(idx), '有手动重启的路由');
  ok(/重启记忆引擎/.test(html), '后台有「重启记忆引擎」按钮');
  ok(/插件启动/.test(idx), '插件启动时总是重启一次引擎（保证跑的是当前代码+当前配置）');
}

// ── ③ 「六维每 60 秒被加一次」：一天只算一次 ──
{
  ok(/rest: \{[^\n]*once: true/.test(daily), '「睡得好」标了一天只算一次');
  ok(/good: \{[^\n]*once: true/.test(daily), '「今天过得不错」标了一天只算一次');
  ok(/work: \{[^\n]*once: true/.test(daily), '「被工作压垮」标了一天只算一次');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-once-'));
  fs.writeFileSync(path.join(dir, 'daily-state.json'), JSON.stringify({ date: '2026-09-13', traitDrift: {}, driftReasons: [] }), 'utf8');
  const traits = { socialBattery: 59 };
  const r1 = applyDayEvent(dir, 'rest', traits, { note: '睡得好' });
  const r2 = applyDayEvent(dir, 'rest', traits, { note: '睡得好' });
  const r3 = applyDayEvent(dir, 'rest', traits, { note: '睡得好' });
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'daily-state.json'), 'utf8'));
  ok(r1 && r1.applied && r1.applied.socialBattery === 5, '第一次照常加成（社交电量 +5）');
  ok(r2 && r2.skipped === true && r3 && r3.skipped === true, '第二、三次直接跳过（哪怕心跳每分钟调一次）');
  ok((st.driftReasons || []).length === 1, '只留下一条记录（不是每分钟一条）:' + (st.driftReasons || []).length);
  ok((st.traitDrift || {}).socialBattery === 5, '当天六维只被加了 1 次（+5，不再顶到 +15 上限）');
  // 被哄这类"可以发生很多次"的，仍然允许重复
  const w1 = applyDayEvent(dir, 'warm', traits, {});
  const w2 = applyDayEvent(dir, 'warm', traits, {});
  ok(w1 && w2 && !w2.skipped, '「被哄」这类可重复事件不受影响（她可以被哄很多次）');
}

// ── ④ 「主动分享连发」：换成事件驱动，且不再有配额排班 ──
{
  ok(!/span \/ maxPokes/.test(lifeSrc), '旧的"配额排班"算法已删除（它就是连发的根源）');
  ok(/_impulse\s*\(/.test(lifeSrc) && /_unitFor\s*\(/.test(lifeSrc), '新机制在：冲动强度 + 当天定死的骰子');
  ok(/60 \+ this\._jitterFor\('cool'/.test(lifeSrc), '冷却 = 60 分钟 ±30（实际 30~90 分钟）');
  ok(/flowItem/.test(lifeSrc) && /cfg\.flow/.test(lifeSrc), '分享挂在她今天真实的流水上（不再"编一个小细节"）');
  ok(!/poke: '你刚才在生活中遇到一件具体的小事/.test(soul), '旧的"编一个小细节"提示词已删除（它就是荒唐内容的来源）');
  ok(/'你刚做完这件事：'/.test(soul), '新提示词要求她只能说她真实做过的那件事');
  // 行为：同一件流水不会被说两次
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-flow-'));
  const sent = [];
  const life = new Life({ dir, config: () => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', pokesPerDay: 9, nudgeMinutes: 20, nudgeMaxPerDay: 0 } }), logger: () => {} });
  const okSoul = { async proactive(kind, extra) { return { chunks: ['[' + kind + '] ' + ((extra || {}).flowItem || {}).text], delaysMs: [0] }; } };
  const imp = life._impulse({ traits: { initiative: 90, attachment: 90 }, battery: 95, mood: 95 });
  let day = null; let hit = -1;
  for (let d = 15; d < 30 && !day; d++) {
    const dd = '2026-09-' + String(d).padStart(2, '0');
    for (let i = 0; i < 50; i++) if (life._unitFor('say' + i, new Date(dd + 'T11:00:00')) <= imp) { day = dd; hit = i; break; }
  }
  const flow = []; for (let i = 0; i < 50; i++) flow.push({ time: '11:00', text: '第' + i + '件事' });
  const over = { flow, traits: { initiative: 90, attachment: 90 }, battery: 95, mood: 95 };
  await life.tick({ soul: okSoul, sendToOwner: async (t) => sent.push(t), now: new Date(day + 'T11:10:00'), overrides: over });
  await life.tick({ soul: okSoul, sendToOwner: async (t) => sent.push(t), now: new Date(day + 'T11:20:00'), overrides: over });
  ok(sent.filter((t) => t.includes('[poke]')).length === 1, '同一件事不会被重复分享（第二次 tick 不再发同一件）');
}

// ── ⑤ 「6 点找她也会回」：睡着由时钟决定，不再依赖她先发晚安 ──
{
  ok(/_isAsleepByClock\s*\(/.test(lifeSrc) && /_isDaytime\s*\(/.test(lifeSrc), '睡眠由"她今天的作息"决定（入睡兜底 + 天亮自动醒）');
  ok(/isAsleepNow\s*\(/.test(idx), '回复闸门用了新的睡眠判定');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-sleep-'));
  const life = new Life({ dir, config: () => ({ life: { enabled: true, wake: '08:30', sleep: '01:20' } }), logger: () => {} });
  const at = (h, m) => new Date('2026-09-13T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00');
  ok(life.nightPhase(at(6, 0), { wake: '08:30', sleep: '01:20' }) === 'asleep', '06:00 她（01:20 睡 / 08:30 起）就是在睡觉——不再看她有没有发过晚安');
  ok(life.nightPhase(at(3, 0), { wake: '08:30', sleep: '01:20' }) === 'asleep', '03:00 也是睡着');
  ok(life.nightPhase(at(12, 0), { wake: '08:30', sleep: '01:20' }) === 'awake', '中午 12:00 自动醒着（天亮不用等她发早安）');
}

// ── ⑥ 安静时段已废弃（B2：睡眠窗口取代它，两套规则会打架）──
{
  ok(!/b\.quietHours/.test(idx) && !/quietHours: /.test(idx), '_sanitizeConfig 不再接受 quietHours');
  ok(!/itemBlock\('安静时段'/.test(html), '后台「安静时段」栏已删除');
  ok(!/每日主动次数/.test(html), '后台「每日主动次数」配额滑杆已删除（事件驱动后不需要它）');
}

// ── ⑦ 「我发的消息不是一定要回的」：醒着也可能不回，但不黑盒 ──
{
  ok(/_replyPolicy\s*\(/.test(idx), '有"这次要不要回"的策略函数');
  ok(/已读不回/.test(idx) && /已读不回/.test(html) === false || /已读不回/.test(idx), '不回时会在实况直播写明原因（禁黑盒）');
  ok(/this\._skipStreak \|\| 0\) >= 1\) pSkip = 0/.test(idx), '连续不回最多 1 次（免得你会以为她坏了）');
}

// ── ⑧ 「苏镜语、律师。怎么了？」：主动消息必须带上下文、禁止自我介绍 ──
{
  ok(/getHistory\(peerKey\)/.test(soul), '主动消息带上了最近的聊天记录');
  ok(/绝对不要自我介绍/.test(soul), '明令不许自我介绍/报名字职业');
  ok(/peerKey: ownerKey/.test(idx), '主动消息拿到了主人的会话 key（否则取不到聊天记录）');
}

// ── ⑧b 记忆分类筛选：芯片与筛选必须用同一个字段（否则点了没反应）──
{
  ok(/entries\.forEach\(function\(e\)\{var w=e\.catLabel/.test(html), '分类芯片按 e.catLabel 生成（不再按 e.who）');
  ok(/FILTER&&\(\(e\.catLabel/.test(html), '筛选也是比 e.catLabel（两处同一字段才对得上）');
  ok(/'归属'/.test(html) && /CATOPTS/.test(html), '教她记一件事有「归属」三选一');
  ok(/cat: \['you', 'her', 'world'\]\.includes\(item\.cat\)/.test(soul), '归属会落进 metadata.cat（catOf 优先读它）');
  ok(/catLabel\(cat\) \{ return cat === 'her' \? '她' : \(cat === 'world' \? '世界' : '我'\)/.test(soul), '三类标签就是「我 / 她 / 世界」');
  ok(/if \(src === 'life'\) return 'world'/.test(soul), '她的生活流水归到「世界」（以前错算成「她」）');
  ok(/cat: String\(body\.cat \|\| ''\)/.test(idx), '后端 add 路由透传 cat');
}

// ── ⑨ 场景：睡着 + 一直没回 —— 两条都不该发任何东西 ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-quiet-'));
  const sent = [];
  const life = new Life({ dir, config: () => ({ life: { enabled: true, wake: '08:30', sleep: '01:20', pokesPerDay: 5, nudgeMinutes: 10, nudgeMaxPerDay: 3 } }), logger: () => {} });
  fs.writeFileSync(path.join(dir, 'life-state.json'), JSON.stringify({ date: '2026-09-13', pendingSince: Date.now() - 300 * 60000, pokes: 0, nudges: 0, bedPhase: 'awake' }), 'utf8');
  await life.tick({ soul: { async proactive() { return { chunks: ['x'], delaysMs: [0] }; } }, sendToOwner: async (t) => sent.push(t), now: new Date('2026-09-13T06:00:00'), overrides: { flow: [{ time: '05:50', text: '夜里的事' }] } });
  ok(sent.length === 0, '凌晨 6:00：哪怕她"还想说"、哪怕你一直没回，也一条都不发');
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'life-state.json'), 'utf8'));
  ok(/她已经睡了/.test(String((st.skipped || {}).all || '')), '而且后台写明"她已经睡了"');
}


// ── ⑨a 决定 12：清模型前缀 ──
{
  ok(/export function cleanReply/.test(soul), '决定 12：有"清模型前缀"的函数');
  ok(/cleanReply\(r\.content\)/.test(soul), '聊天与主动消息两条链路都过了它');
  const { cleanReply } = await import('../src/soul.js');
  ok(cleanReply('response起诉状刚写完，现在就差这一笔钱了。') === '起诉状刚写完，现在就差这一笔钱了。', '「response起诉状…」被清成正常句子');
  ok(cleanReply('assistant: 嗯，刚起') === '嗯，刚起', '英文角色标记也被清掉');
  ok(cleanReply('她：我不太想聊这个') === '我不太想聊这个', '中文角色标记（带冒号）被清掉');
  ok(cleanReply('他说她今天不来') === '他说她今天不来', '正常句子里的"她"字不会被误删');
  ok(cleanReply('好呀') === '好呀', '正常回复原样通过');
}

// ── ⑨b 常识四层 ──
{
  const sc = read('src/selfcheck.js');
  ok(/export async function reviewReply/.test(sc), '常识第 4 层：有"发之前自检"的模块');
  ok(/宁可放过也不要瞎改/.test(sc), '自检的判据写明了"宁可放过也别瞎改"（不误伤正常聊天）');
  ok(/nowDoing/.test(soul) && /export function nowDoing/.test(soul), '常识第 1 层：会算出"她此刻在做什么"');
  ok(/正在睡觉/.test(soul) && /不可能在上班、不可能刚下庭、不可能去银行/.test(soul), '第 1 层写明了"睡着时不可能在上班/刚下庭/去银行"');
  ok(/export const COMMON_SENSE/.test(soul) && /银行\/法院\/政府/.test(soul), '常识第 2 层：六条底线清单进了提示词');
  ok(/只有微信这一个/.test(soul) && /绝不许编造具体的时间\/地点\/数字/.test(soul), '底线清单含"只有微信"和"不许编造具体细节"');
  ok(/她今天经历的事（她说"我今天…"只能来自这里/.test(soul), '常识第 3 层：她"今天干了什么"只能来自流水');
  ok(/selfCheckReview/.test(idx) && /常识自检\] 改了一句/.test(idx), '第 4 层接线了，且改写会写进实况直播（禁黑盒）');
  ok(/_behavior\(\) \|\| \{\}\)\.selfCheck !== false/.test(idx), '第 4 层的开关默认开、读的是人设里的开关');
  ok(/发之前自检一遍/.test(html), '后台「她怎么说话」里有第 4 层的开关');
  // 行为：自检模块在没有候选模型时必须跳过（不能因此卡住她的回复）
  const { reviewReply } = await import('../src/selfcheck.js');
  const rv = await reviewReply({ chain: [], situation: 'x', userText: 'y', reply: 'z' });
  ok(rv && rv.skipped === true, '没有可用模型时自检直接跳过（原样发，不卡住她）');
  const rv2 = await reviewReply({ chain: [{ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }], situation: 'x', userText: 'y', reply: 'z', timeoutMs: 800 });
  ok(rv2 && rv2.skipped === true, '自检调用失败也跳过（原样发）');
}

// ── ⑩ 批 C：世界引擎归属（早安晚安/时间说明/她的过去/生活节奏只读）──
{
  // C1 早安/晚安永远允许（世界引擎只准管分享与催促）
  ok(/proactiveLimit\(toneNow\), morning: true, night: true/.test(idx), 'C1 早安/晚安永远允许（不受世界引擎"明天别主动"影响）');

  // C2 世界引擎什么时候跑：面板写清计划时间/实际时间/为什么晚
  ok(/它是\*\*什么时候跑\*\*的/.test(html) && /每个自然日只跑一次/.test(html), 'C2 面板写清了它的触发规则');
  ok(/不是计划时间/.test(html), 'C2 面板说明了"上次生成"是实际跑成功的时刻，不是计划时间');

  // C3 她的过去：世界引擎生成 + 后台只读 + 重新生成
  const we = read('src/world-engine.js');
  ok(/"past":\{"surface"/.test(we), 'C3 提示词里加了 past 三层字段');
  ok(/pastMissing/.test(we) && /还没有过去/.test(we), 'C3 没有过去时让它编一份、已有则只补一点点');
  ok(/this\.soul\.savePersona\(\{ profile: \{ \.\.\.\(persona\.profile \|\| \{\}\), past: next \} \}\)/.test(we), 'C3 生成的三层会写回人设');
  ok(/path === 'panel\/past'/.test(idx) && /panel\/past\/regen/.test(idx), 'C3 有只读读接口与"重新生成"接口');
  ok(/世界引擎自己长出来的 · 只读/.test(html) && /重新生成她的过去/.test(html), 'C3 后台改成只读 + 「重新生成」按钮');
  ok(!/保存她的过去/.test(html), 'C3 后台不再提供"保存她的过去"（用户不再手写）');

  // C3 行为验证：用桩模型跑一次 generate，past 必须被写回
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-past-'));
    const saved = [];
    const fakeSoul = {
      savePersona: (patch) => { saved.push(patch); },
      getRelations: () => ({}),
      getPersona: () => ({ name: '苏镜语' }),
      addMemory: async () => {},
    };
    const stub = JSON.stringify({
      diary: '今天还行。', wake: '08:00', sleep: '01:00', mood: 60, focus: '案子',
      flow: [{ time: '10:00', text: '去了咖啡馆' }], thoughts: ['累'], secrets: [],
      past: { surface: '在上海做律师，喜欢旅行', middle: '老家在苏州，父母做小生意', deep: '大三那年父亲生病，差点退学' },
      tone: { intimacy: 20, address: '叫名字', style: '客气', forbid: [], reason: '刚认识' },
    });
    const w = new WorldEngine({
      dir,
      router: { chat: async () => { throw new Error('不该走对话接口'); } },
      chatFn: async () => ({ content: stub }),
      config: () => ({ world: { baseURL: 'https://w.example', model: 'm' } }),
      soul: fakeSoul,
      logger: () => {},
    });
    await w.generate({ persona: { name: '苏镜语', job: '律师', city: '上海', traits: {}, behavior: {}, interests: [], assessments: {}, relationship: {}, profile: {} }, today: { sleep: '01:00', events: [] }, memories: [], now: new Date('2026-09-13T23:40:00') });
    const pp = saved.filter((x) => x && x.profile && x.profile.past).pop();
    ok(!!pp, 'C3 端到端：真跑一次 generate 后，她的过去被写回人设');
    ok(pp && /苏州/.test(pp.profile.past.middle) && /退学/.test(pp.profile.past.deep), 'C3 三层内容都完整写进去了');
  }

  // C4 生活节奏：世界引擎接手后控件只读
  ok(/lockRhythm/.test(html) && /rhInputs/.test(html), 'C4 世界引擎接手作息后，那几个控件会被锁成只读');
  ok(/由\*\*世界引擎\*\*管/.test(html), 'C4 面板写明"这几项现在由世界引擎管"（不黑盒）');
}

console.log(fail === 0 ? '\nFIX-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nFIX-SMOKE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

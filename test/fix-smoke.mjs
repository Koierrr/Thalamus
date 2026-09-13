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
  ok(/const cat = \['you', 'her', 'world'\]\.includes\(item\.cat\)/.test(soul) && /metadata: \{ cat, ts: Date\.now\(\) \}/.test(soul), '归属会落进 metadata.cat（catOf 优先读它）');
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
  ok(/return \{ \.\.\.proactiveLimit\(tone\), morning: true, night: true \}/.test(idx) && /_stageLimitNow\(toneNow\)/.test(idx), 'C1 早安/晚安永远允许（不受世界引擎"明天别主动"影响；上限构造收在 _stageLimitNow 一处）');

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

// ── ⑪ 批 E1：感知用户行为（A6）+ 复读止血（A9）──
{
  const { Soul } = await import('../src/soul.js');
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fix-e1-'));
  const s1 = new Soul({ dir: mk(), router: { chat: async () => ({ content: '好' }), cfg: {} }, logger: () => {} });

  // A6：把"你隔了多久才回我"说给她
  const nowT = new Date('2026-09-13T15:00:00');
  const hist = [{ role: 'user', text: '在吗', ts: nowT.getTime() - 3 * 3600000 }, { role: 'her', text: '在', ts: nowT.getTime() - 2 * 3600000 }];
  const line = s1._motionLine(hist, nowT);
  ok(/他上一条消息是3 小时前发的/.test(line), 'A6 提示词里带上他上一条是几小时前发的');
  ok(/你上次回他是2 小时前/.test(line), 'A6 也带上你上次回他是多久前');
  ok(/上班时间/.test(line), 'A6 会说明现在是上班时间这类场景');
  ok(/第一句话/.test(s1._motionLine([], nowT)), 'A6 没有历史时说这是你们今天的第一句话');
  ok(/深夜/.test(s1._motionLine(hist, new Date('2026-09-13T02:30:00'))), 'A6 深夜找他时会给不同的语气提示');
  ok(s1._gapCN(30 * 1000) === '刚刚' && s1._gapCN(5 * 60000) === '5 分钟前' && s1._gapCN(26 * 3600000) === '1 天前', 'A6 时长说人话：刚刚 / 分钟前 / 天前');

  // A9：字面判重
  const said = [{ at: Date.now(), text: '今天去看了那家大理的民宿，价格比想象中便宜' }];
  ok(s1._repeatLiteral('今天去看了那家大理的民宿，价格比想象中便宜', said) === true, 'A9 字面完全一样 → 判为重复');
  ok(s1._repeatLiteral('今天去看了那家大理的民宿价格比想象中便宜', said) === true, 'A9 只差标点/空的 → 字面层就抓到');
  ok(s1._repeatLiteral('今天去看了大理那家民宿，价格比想的便宜', said) === false, 'A9 大幅换说法字面层会放过（这是设计：交给 intent 层，不误伤）');
  ok((await s1._repeatIntent('今天去看了大理那家民宿，价格比想的便宜', said, [])) === false, 'A9 没有配判重模型时 intent 层安全返回 false（不联网、不拦她）');
  ok(s1._repeatLiteral('楼下新开了一家面包店，排队好长', said) === false, 'A9 说的是另一件事 → 不算重复');
  ok(s1._repeatLiteral('嗯', said) === false, 'A9 太短的不判（避免误伤）');

  // A9：主动消息里真的会跳过重复（stub 模型固定吐同一句 → 重试后仍重复 → 这次不发）
  const rep1 = '今天去看了那家大理的民宿，价格比想象中便宜';
  const s2 = new Soul({ dir: mk(), router: { chat: async () => ({ content: rep1 }), cfg: { params: {} } }, logger: () => {} });
  const out2 = await s2.proactive('poke', { recentSaid: said });
  ok(out2 && out2.skipped === 'repeat' && (!out2.chunks || out2.chunks.length === 0), 'A9 主动消息重复 → 这次不发（skipped=repeat）而不是复读');

  // A9：关掉判重（off）就该照常发
  // 注意：行为配置走的是 options.behavior（一个函数），不是 options.config()——第一次就写错了，测试自己纠的
  const s3 = new Soul({ dir: mk(), router: { chat: async () => ({ content: rep1 }), cfg: { params: {} } }, logger: () => {},
    behavior: () => ({ repeatGuard: 'off' }) });
  const out3 = await s3.proactive('poke', { recentSaid: said });
  ok(out3 && out3.chunks && out3.chunks.length > 0, 'A9 把开关设成 off → 不判重，照常发');
}

// ── ⑫ 批 E2：指令协议（解析 / 去重 / 限次）──
{
  const { parseCommands, filterCommands, emptyUsage, hasBrokenCommand, usageLine } = await import('../src/commands.js');

  const r1 = parseCommands('今天路过那家店，拍了张照 <image:傍晚的窗台，暖光> 你看');
  ok(r1.text === '今天路过那家店，拍了张照 你看', 'E2 指令从可见文字里被摘掉了（你永远看不到这行）：' + r1.text);
  ok(r1.commands.length === 1 && r1.commands[0].kind === 'image' && r1.commands[0].arg === '傍晚的窗台，暖光', 'E2 指令内容被正确解析出来');

  const r2 = parseCommands('你上次说的那个 <remember:他下周三要去成都出差> 我记着。');
  ok(r2.commands[0].kind === 'remember' && /成都/.test(r2.commands[0].arg), 'E2 记得住 remember 指令');

  const r3 = parseCommands('好<voice:今天有点累，先睡了><sticker:晚安猫>晚安');
  ok(r3.commands.length === 2 && r3.commands[0].kind === 'voice' && r3.commands[1].kind === 'sticker', 'E2 一条回复里能带多个指令');
  ok(r3.text === '好晚安', 'E2 多个指令摘掉后文字依然通顺：' + r3.text);

  ok(parseCommands('没有指令的普通一句话').commands.length === 0, 'E2 普通回复不会被误判出指令');
  ok(parseCommands('<image:>').commands.length === 0, 'E2 空的指令内容会被丢掉');
  ok(parseCommands('看看这段代码 a<b 和 c>d').commands.length === 0, 'E2 正文里出现尖括号不会误伤');
  ok(hasBrokenCommand('她写坏了 <image:忘了收尾') === true, 'E2 半截指令能被识别出来（只告警，不阻断发送）');

  // 去重与限次（这是"必须带闸门"的部分）
  const day = '2026-09-13';
  const usage = emptyUsage(day);
  const f1 = filterCommands([
    { kind: 'image', arg: 'a' }, { kind: 'image', arg: 'a' }, { kind: 'image', arg: 'b' },
    { kind: 'voice', arg: 'v' }, { kind: '不认识的', arg: 'x' }, { kind: 'sticker', arg: '' },
  ], usage, day);
  ok(f1.ok.length === 2 && f1.ok[0].kind === 'image' && f1.ok[1].kind === 'voice', 'E2 一条回复里：图片只放行 1 张、语音 1 条');
  ok(f1.dropped.length === 4, 'E2 被拦下的都记了原因（' + f1.dropped.map((d) => d.why).join(' / ') + '）');
  ok(f1.dropped[0].why === '这条回复里已经有过一样的', 'E2 同样内容的重复指令被去重');

  // 每日上限：把图片刷到上限
  let u = emptyUsage(day);
  let sent = 0;
  for (let i = 0; i < 6; i++) {
    const f = filterCommands([{ kind: 'image', arg: 'p' + i }], u, day);
    u = f.usage; sent += f.ok.length;
  }
  ok(sent === 3, 'E2 图片一天最多 3 张（实际放行 ' + sent + ' 张）');
  const fOver = filterCommands([{ kind: 'image', arg: 'p9' }], u, day);
  ok(fOver.ok.length === 0 && /用满了/.test(fOver.dropped[0].why), 'E2 到顶之后会明确说"今天用满了"：' + fOver.dropped[0].why);
  ok(/记住一件事/.test(usageLine(u, day)), 'E2 后台能看到当天用量：' + usageLine(u, day));
}

// ── ⑬ 批 E2：自定义表情包库（存/查/取/删 + 名字模糊匹配）──
{
  const st = await import('../src/stickers.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-sticker-'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');   // 够用的假 PNG 头

  ok(st.listStickers(dir).length === 0, 'E2 表情包库一开始是空的（不会因为文件不存在就报错）');
  const a1 = st.addSticker(dir, { name: '晚安猫', ext: '.png', data: png, tags: ['晚安'] });
  ok(a1.ok === true && a1.item.name === '晚安猫', 'E2 能加一个表情包');
  ok(st.listStickers(dir).length === 1 && st.listStickers(dir)[0].exists === true, 'E2 加完之后列得出来、文件真的在');
  ok(st.readSticker(dir, '晚安猫') && st.readSticker(dir, '晚安猫').data.length === png.length, 'E2 按名字能取到图片内容（她要发的时候用）');

  // 同名覆盖：不该在目录里堆两份
  const a2 = st.addSticker(dir, { name: '晚安猫', ext: '.png', data: Buffer.concat([png, png]) });
  ok(a2.ok === true && st.listStickers(dir).length === 1, 'E2 同名再上传 = 覆盖，不会变成两个');
  ok(st.readSticker(dir, '晚安猫').data.length === png.length * 2, 'E2 覆盖后取到的是新图');

  // 名字模糊匹配（模型不一定记得准名字）
  ok(st.matchStickerName(dir, '晚安猫') === '晚安猫', 'E2 名字完全一样 → 直接命中');
  ok(st.matchStickerName(dir, '晚安猫咪') === '晚安猫', 'E2 名字多一个字 → 也能对上');
  st.addSticker(dir, { name: '开心狗', ext: '.jpg', data: png });
  ok(st.matchStickerName(dir, '狗') === '开心狗', 'E2 只记得一半 → 按包含关系对上');
  ok(st.matchStickerName(dir, '完全无关的词') === null, 'E2 实在对不上就返回 null（不会乱发一张图）');

  // 错误路径都要说人话
  ok(st.addSticker(dir, { name: '', ext: '.png', data: png }).ok === false, 'E2 名字为空会被拒绝');
  ok(/只支持/.test(st.addSticker(dir, { name: 'x', ext: '.exe', data: png }).error), 'E2 不支持的格式会被拒绝并说明原因');
  ok(/太大/.test(st.addSticker(dir, { name: 'x', ext: '.png', data: Buffer.alloc(st.MAX_STICKER_BYTES + 1) }).error), 'E2 超过 5MB 会被拒绝并说明原因');

  // 停用与删除
  st.setStickerEnabled(dir, '开心狗', false);
  ok(st.matchStickerName(dir, '狗') === null && st.readSticker(dir, '开心狗') === null, 'E2 停用之后她就挑不到、也发不出去了');
  const rm = st.removeSticker(dir, '开心狗');
  ok(rm.ok === true && st.listStickers(dir).length === 1, 'E2 能删掉一个表情包');
  ok(st.removeSticker(dir, '不存在').ok === false, 'E2 删不存在的会明确报错，不会静默成功');
}

// ── ⑭ 批 E2：伤害判定（A13）与「说不说原因由性格定」（A14）──
{
  const { Soul } = await import('../src/soul.js');
  const mk2 = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fix-hurt-'));

  // A13：判定由那次已经在跑的抽取调用顺手给出（同一调用，不额外花钱），结果喂现有压力机
  const hurtJson = JSON.stringify({ memories: [{ text: '他说我不懂事', importance: 4 }], hurt: { level: 2, why: '他说我不懂事' } });
  const sHurt = new Soul({ dir: mk2(), router: { chat: async () => ({ content: hurtJson }), cfg: {} }, logger: () => {} });
  const sig = await sHurt.recordConversation({ peerKey: 'p1', isOwner: true, userText: '你怎么这么不懂事', herTexts: ['……'] });
  ok(sig && sig.rude === true, 'A13 模型判定被伤到 → 走的是原来那条 rude 通道（没有新增平行系统）');
  ok(sig && sig.hurtLevel === 2, 'A13 伤害程度被带出来（level=2）');
  ok(/不懂事/.test(sig.hurtWhy || ''), 'A13 判定的原因也带出来了：' + (sig.hurtWhy || ''));
  ok(sHurt.getMemories().entries.some((e) => /不懂事/.test(e.text)), 'A13 同一次调用里的记忆照样入库（没有因为多判一项就丢记忆）');

  // 老样式（模型只吐数组）不能坏
  const arrJson = JSON.stringify([{ text: '他喜欢喝美式', importance: 4 }]);
  const sOld = new Soul({ dir: mk2(), router: { chat: async () => ({ content: arrJson }), cfg: {} }, logger: () => {} });
  const sig2 = await sOld.recordConversation({ peerKey: 'p1', isOwner: true, userText: '我喝美式', herTexts: ['好'] });
  ok(sOld.getMemories().entries.some((e) => /美式/.test(e.text)), 'A13 兼容老样式（只吐数组）的记忆抽取');
  ok(sig2 && sig2.hurtLevel === 0, 'A13 老样式下伤害程度按 0 处理（不会误判）');

  // 关键词层仍然当场生效
  const sKw = new Soul({ dir: mk2(), router: { chat: async () => ({ content: '[]' }), cfg: {} }, logger: () => {} });
  const sig3 = await sKw.recordConversation({ peerKey: 'p1', isOwner: true, userText: '闭嘴', herTexts: ['……'] });
  ok(sig3 && sig3.rude === true, 'A13 关键词层照样当场生效（闭嘴）');

  // A14：说不说原因由性格定
  const sP = new Soul({ dir: mk2(), router: { chat: async () => ({ content: '[]' }), cfg: {} }, logger: () => {} });
  const upset = { state: 'grip' };
  const sharp = sP._upsetLine(upset, { traits: { sharpness: 70, attachment: 20, warmth: 30 } });
  ok(/直接点出来/.test(sharp), 'A14 锐利的人：直接点出来是哪句不舒服');
  const sticky = sP._upsetLine(upset, { traits: { sharpness: 20, attachment: 70, warmth: 30 } });
  ok(/不会主动说原因/.test(sticky), 'A14 黏人又嘴软的人：闷着不说原因，等他察觉');
  const warmOne = sP._upsetLine(upset, { traits: { sharpness: 20, attachment: 20, warmth: 70 } });
  ok(/软软地暗示/.test(warmOne), 'A14 温和的人：软软地暗示一下');
  const plain = sP._upsetLine(upset, { traits: { sharpness: 20, attachment: 20, warmth: 20 } });
  ok(/简短地提一句/.test(plain), 'A14 其它性格：简短提一句、不展开');
  ok(sP._upsetLine({ state: 'normal' }, { traits: { sharpness: 90 } }) === '', 'A14 心情正常时不会多说这句（不占提示词）');

  // 三种性格给出的是**三份不同的说法**（不是同一句换皮）
  ok(new Set([sharp, sticky, warmOne, plain]).size === 4, 'A14 四种性格给出四份不同的行为要求');
}

// ── ⑮ 批 E3：承诺闭环（队列 / 到期 / 睡眠推迟 / 碰撞 / 过期 / 日上限 / 后台操作）──
{
  const { Promises, MAX_REMINDERS_PER_DAY } = await import('../src/promises.js');
  const newP = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-prom-'));
    const sent = [];
    const P = new Promises({
      dir,
      soul: { proactive: async () => ({ chunks: ['诶，说好的读后感我讲给你听'], delaysMs: [0] }) },
      config: () => ({ chain: { memory: [] } }),
      logger: () => {}, activity: () => {},
    });
    const write = (items, extra) => {
      fs.writeFileSync(path.join(dir, 'promises.json'), JSON.stringify(Object.assign({ version: 1, items, done: [], lastSentAt: 0, lastExtractAt: 0, lastExtractOk: true }, extra || {})), 'utf8');
    };
    const send = async (chunks) => { sent.push(chunks.join(' ')); };
    return { dir, P, write, send, sent };
  };
  const item = (over) => Object.assign({
    id: 'p_t1', text: '周末把那本书的读后感讲给他听', kind: 'self', due: '2026-09-13', time: null,
    dueTs: Date.now() - 60000, createdAt: Date.now() - 86400000, roundTs: Date.now() - 86400000,
    peerKey: 'a:p', isOwner: true, quote: '', status: 'pending', sentAt: 0, deferUntil: 0, attempts: 0, dupCount: 1, cancelReason: '',
  }, over || {});

  // ① 空队列：零开销直接返回
  const A = newP();
  A.write([]);
  const r1 = await A.P.tick({ isAsleep: () => false, wake: '08:30', send: A.send });
  ok(r1 && r1.skipped === 'empty', 'E3 队列为空时直接返回（不发请求、不打扰）');

  // ② 到点了、她醒着 → 让她自己说出来，然后归档
  const B = newP();
  B.write([item()]);
  const r2 = await B.P.tick({ isAsleep: () => false, wake: '08:30', send: B.send });
  ok(r2 && r2.ok === true && B.sent.length === 1, 'E3 到期且醒着 → 真的发了（' + B.sent.length + ' 条）');
  const vB = JSON.parse(fs.readFileSync(path.join(B.dir, 'promises.json'), 'utf8'));
  ok(vB.items.length === 0 && vB.done.length === 1 && vB.done[0].status === 'sent', 'E3 发完就归档（不会重复提第二遍）');
  ok(vB.lastSentAt > 0, 'E3 记下最后一次发送时间（供碰撞保护用）');

  // ③ 她在睡 → 推到起床后（不发送）
  const C = newP();
  C.write([item()]);
  const r3 = await C.P.tick({ isAsleep: () => true, wake: '08:30', send: C.send });
  const vC = JSON.parse(fs.readFileSync(path.join(C.dir, 'promises.json'), 'utf8'));
  ok(r3 && r3.skipped === 'asleep' && C.sent.length === 0, 'E3 她在睡觉 → 不发送（她睡着不该被自己的提醒吵醒）');
  ok(vC.items[0].deferUntil > Date.now(), 'E3 并且排到起床之后（' + new Date(vC.items[0].deferUntil).toLocaleTimeString('zh-CN') + '）');

  // ④ 碰撞保护：刚发过一条就别挤在一起
  const D = newP();
  D.write([item()], { lastSentAt: Date.now() - 60000 });
  const r4 = await D.P.tick({ isAsleep: () => false, wake: '08:30', send: D.send });
  ok(r4 && r4.skipped === 'collide' && D.sent.length === 0, 'E3 与上一条消息隔不到 10 分钟 → 这一跳先不发');

  // ⑤ 拖过 72 小时 → 归为过期，不再自动发
  const E2x = newP();
  E2x.write([item({ dueTs: Date.now() - 80 * 3600 * 1000 })]);
  await E2x.P.tick({ isAsleep: () => false, wake: '08:30', send: E2x.send });
  const vE = JSON.parse(fs.readFileSync(path.join(E2x.dir, 'promises.json'), 'utf8'));
  ok(E2x.sent.length === 0 && vE.done.some((x) => x.status === 'missed'), 'E3 拖过 3 天 → 归为过期（不赖在队列里）');

  // ⑥ 每日上限：一天最多主动提 3 条
  const F = newP();
  F.write([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }), item({ id: 'd' })]);
  let sentCount = 0;
  for (let i = 0; i < 6; i++) {
    const v = JSON.parse(fs.readFileSync(path.join(F.dir, 'promises.json'), 'utf8'));
    v.lastSentAt = 0;                                  // 绕过碰撞保护，专门测日上限
    fs.writeFileSync(path.join(F.dir, 'promises.json'), JSON.stringify(v), 'utf8');
    const rr = await F.P.tick({ isAsleep: () => false, wake: '08:30', send: F.send });
    if (rr && rr.ok) sentCount += 1;
  }
  ok(sentCount === MAX_REMINDERS_PER_DAY, 'E3 一天最多提 ' + MAX_REMINDERS_PER_DAY + ' 条（实测 ' + sentCount + ' 条）');

  // ⑦ 后台操作：取消 / 改期 / 补提
  const G = newP();
  G.write([item({ id: 'g1' })]);
  ok(G.P.action({ id: 'g1', op: 'cancel', reason: '说的是别的事' }).ok === true, 'E3 后台能取消一条承诺');
  const vG = JSON.parse(fs.readFileSync(path.join(G.dir, 'promises.json'), 'utf8'));
  ok(vG.items.length === 0 && /别的事/.test(vG.done[0].cancelReason), 'E3 取消时记下原因（后台看得见）');
  G.write([item({ id: 'g2' })]);
  ok(G.P.action({ id: 'g2', op: 'reschedule', due: '2026-10-01' }).ok === true, 'E3 后台能改期');
  ok(JSON.parse(fs.readFileSync(path.join(G.dir, 'promises.json'), 'utf8')).items[0].due === '2026-10-01', 'E3 改期真的写进去了');
  ok(G.P.action({ id: 'g2', op: 'reschedule', due: '不是日期' }).ok === false, 'E3 改期会校验日期格式并明确报错');
  ok(G.P.action({ id: 'g2', op: 'remind' }).ok === true, 'E3 后台能"补提一次"');
  ok(G.P.action({ id: '不存在', op: 'cancel' }).ok === false, 'E3 操作不存在的条目会明确报错');
  ok(G.P.action({ id: 'g2', op: '乱写' }).ok === false, 'E3 不认识的操会被拒绝');

  // ⑧ 后台视图
  const view = G.P.view();
  ok(view && typeof view.todaySent === 'number' && view.maxPerDay === MAX_REMINDERS_PER_DAY, 'E3 后台能看到今天提了几条（' + view.todaySent + '/' + view.maxPerDay + '）');

  // ⑨ 没配抽取模型时：整条链路静默停用，但后台写明原因（不报错刷屏）
  const H = newP();
  const r9 = await H.P.maybeExtract({ peerKey: 'a:p', isOwner: true, userText: '周末讲给我听', herTexts: ['好呀'] });
  const vH = JSON.parse(fs.readFileSync(path.join(H.dir, 'promises.json'), 'utf8'));
  ok(r9 && r9.skipped === 'no-chain' && vH.lastExtractOk === false && /没有配置/.test(vH.extractNote), 'E3 没配抽取模型 → 静默停用并在后台写明原因');
  // 普通联系人不抽（抽了也没人送，白花钱）
  const r10 = await H.P.maybeExtract({ peerKey: 'a:x', isOwner: false, userText: '周末讲给我听', herTexts: ['好'] });
  ok(r10 && r10.skipped === 'not-owner', 'E3 普通联系人轮次不抽取（省掉没意义的调用）');
}

// ── ⑯ 批 E3：她的身体（生理期引擎 / 披露分层 / 电量折算 / 提示词闸门）──
{
  const BS = await import('../src/body-state.js');
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-body-'));

  // ① 建档：个体化且幂等
  const st1 = BS.ensureState(dirB, '苏镜语|59');
  const st2 = BS.ensureState(dirB, '苏镜语|59');
  ok(st1 && st1.version === 1 && st1.anchor, 'A10 首次调用会建档（含锚点）');
  ok(st1.cycleDays >= 26 && st1.cycleDays <= 32, 'A10 周期长度落在 26~32 天（实测 ' + st1.cycleDays + '）');
  ok(st1.periodLen >= 3 && st1.periodLen <= 5, 'A10 经期长度落在 3~5 天（实测 ' + st1.periodLen + '）');
  ok(st1.salt && st1.salt.length === 8, 'A10 个体差异来自建档时的随机 salt');
  ok(st2.anchor === st1.anchor && st2.cycleDays === st1.cycleDays, 'A10 再调用一次不会重建（周期终生固定）');
  ok(/任意锚点都与既有历史自洽/.test(st1.createdNote || ''), 'A10 建档说明可后台展示（禁黑盒）');

  // ② 周期推演：纯函数、任意日期可算
  const fake = { cycleDays: 28, periodLen: 4, anchor: '2026-09-01', periodNote: '怕冷', preNote: '烦躁' };
  const p1 = BS.periodFor(fake, '2026-09-01');
  ok(p1.cycleDay === 1 && p1.phase === 'menstrual' && p1.note === '怕冷', 'A10 锚点当天 = 经期第 1 天（带个体感受）');
  ok(BS.periodFor(fake, '2026-09-04').phase === 'menstrual', 'A10 第 4 天仍在经期');
  ok(BS.periodFor(fake, '2026-09-05').phase === 'mid' && BS.periodFor(fake, '2026-09-05').note === '', 'A10 第 5 天进平稳期（平稳期没有任何效果）');
  ok(BS.periodFor(fake, '2026-09-28').phase === 'premenstrual', 'A10 周期末 4 天是经前期（' + BS.periodFor(fake, '2026-09-28').phase + '）');
  ok(BS.periodFor(fake, '2026-09-29').cycleDay === 29 % 28 + 1 - 1 + 1 || BS.periodFor(fake, '2026-09-29').cycleDay === 1, 'A10 跨周期会绕回来（第 ' + BS.periodFor(fake, '2026-09-29').cycleDay + ' 天）');
  ok(JSON.stringify(BS.periodFor(fake, '2026-10-01')) === JSON.stringify(BS.periodFor(fake, '2026-10-01')), 'A10 同一个日期算两次结果一致（纯函数）');
  ok(BS.periodFor(fake, '2027-09-01').cycleDay >= 1, 'A10 未来日期也能算');

  // ③ 披露档位：由熟度一个数决定（常量 30/60/80）
  ok(BS.disclosureTier(10) === 1 && BS.disclosureTier(29) === 1, 'A10 熟度 <30 → 一档');
  ok(BS.disclosureTier(30) === 2 && BS.disclosureTier(59) === 2, 'A10 熟度 30~59 → 二档');
  ok(BS.disclosureTier(60) === 3 && BS.disclosureTier(79) === 3, 'A10 熟度 60~79 → 三档');
  ok(BS.disclosureTier(80) === 4 && BS.disclosureTier(99) === 4, 'A10 熟度 80+ → 四档');

  // ④ 合成视图 + 电量折算
  const day1 = BS.periodFor(fake, '2026-09-01');
  const body = { period: day1, daily: { sleep: '没睡好', ailment: '胃有点不舒服', note: '想吃清淡的' }, lowEnergy: true, disclosureTier: 2, note: 'x', source: 'world' };
  const eff = BS.bodyEffects(body);
  ok(eff.battery <= -20, 'A10 经期头两天 + 没睡好 + 小毛病 → 电量明显下降（' + eff.battery + '）');
  ok(eff.activeMul < 1, 'A10 经期头两天 → 主动频率打折（×' + eff.activeMul + '）');
  const effPre = BS.bodyEffects({ period: BS.periodFor(fake, '2026-09-28'), daily: null, lowEnergy: false });
  ok(effPre.battery === -5 && effPre.dr.attachment === 2, 'A10 经前期：电量 -5、依恋 +2（走的还是既有六维管道）');
  const effSleep = BS.bodyEffects({ period: null, daily: { sleep: '熬了夜', ailment: '没有' }, lowEnergy: true });
  ok(effSleep.battery === -8 && effSleep.dr.sharpness === -2, 'A10 熬夜：电量 -8、锐利 -2（没睡好是钝，不是凶）');
  ok(BS.bodyEffects(null).battery === 0, 'A10 没有身体状态时一切折算为 0（不会影响她）');

  // ⑤ 提示词闸门：只能从这里来 + 按熟度分层 + 没有情况时不加空话
  const line2 = BS.bodyPromptLine(body, 35);
  ok(/只能从这里来/.test(line2) && /绝不许新增/.test(line2), 'A10 提示词里写明"身体只能从这里来，绝不许新增症状"');
  ok(/不是心情变坏/.test(line2), 'A10 明确写"这是身体状态，不是心情变坏"（态度仍按今天的分寸）');
  ok(/熟度 30~59/.test(line2) && !/老朋友来了/.test(line2), 'A10 二档：不许说破生理期');
  const line4 = BS.bodyPromptLine(body, 85);
  ok(/老朋友来了/.test(line4), 'A10 四档：可以半开玩笑地承认');
  const line1 = BS.bodyPromptLine(body, 5);
  ok(/一个字都不提/.test(line1), 'A10 一档：身体的事一个字都不提');
  ok(BS.bodyPromptLine({ period: { phase: 'mid', cycleDay: 20, note: '' }, daily: { sleep: '睡得不错', ailment: '没有' }, lowEnergy: false }, 50) === '', 'A10 平稳期 + 睡得好 + 没毛病 → 不占提示词');
  ok(BS.bodyPromptLine(null, 50) === '', 'A10 没有身体状态 → 空字符串');

  // ⑥ 总开关：默认开；关掉后整条链路静默
  ok(BS.bodyEnabled(dirB) === true, 'A10 默认开启（不加配置就是开）');
  fs.writeFileSync(path.join(dirB, 'config.json'), JSON.stringify({ body: { enabled: false } }), 'utf8');
  ok(BS.bodyEnabled(dirB) === false, 'A10 关掉后 bodyEnabled 为假');
  ok(BS.bodyView({ dir: dirB, today: { date: '2026-09-13' }, world: null, intimacy: 50 }) === null, 'A10 关掉后身体视图返回 null（下游全部跳过）');
  fs.writeFileSync(path.join(dirB, 'config.json'), JSON.stringify({ body: { enabled: true } }), 'utf8');
  const bv = BS.bodyView({ dir: dirB, today: { date: '2026-09-13' }, world: null, intimacy: 50 });
  ok(bv && bv.period && typeof bv.period.cycleDay === 'number', 'A10 开着时即使世界引擎没跑，生理期照算（引擎停摆不冻结她的身体）');
  ok(bv && bv.source === 'none', 'A10 引擎没跑时标明数据来源（后台可见）');
  const bv2 = BS.bodyView({ dir: dirB, today: { date: '2026-09-13' }, world: { body: { forDate: '2026-09-13', sleep: '熬了夜', ailment: '没有', note: '' } }, intimacy: 50 });
  ok(bv2 && bv2.daily && bv2.lowEnergy === true && bv2.source === 'world', 'A10 引擎写过就用它，并因此判为低能量');
  const bv3 = BS.bodyView({ dir: dirB, today: { date: '2026-09-13' }, world: { body: { forDate: '2026-09-14', sleep: '熬了夜', ailment: '没有', note: '' } }, intimacy: 50 });
  ok(bv3 && bv3.daily === null, 'A10 引擎写的是别的日期 → 不采信（避免拿明天的身体当今天）');
}

// ── ⑰ 批 E3：想念曲线（先升后降 / 强度由依恋定 / 参考她自己过得怎样）──
{
  const { longingCurve, longingLine, settleScale } = await import('../src/longing.js');
  const D = 86400000;
  const at = (days, over) => longingCurve(Object.assign({ absenceMs: days * D, attachment: 50, battery: 60, workload: 0 }, over || {}));

  // ① 先升
  const d0 = at(0.2), d1 = at(1), d3 = at(3);
  ok(d0.value < d1.value, 'A11 刚开始惦记时是往上走的（0.2 天 ' + d0.value.toFixed(2) + ' < 1 天 ' + d1.value.toFixed(2) + '）');
  ok(d1.phase === 'rising' || d1.phase === 'peak', 'A11 一天多的状态是"开始惦记/最想"');
  ok(at(2).phase === 'peak' || at(2).value >= at(1).value - 0.05, 'A11 峰值落在 1~3 天这个窗口里');

  // ② 后降（这是用户点名要的那一半）
  const d5 = at(5), d7 = at(7), d14 = at(14);
  ok(d7.value < d3.value, 'A11 过了峰值就往下走（3 天 ' + d3.value.toFixed(2) + ' → 7 天 ' + d7.value.toFixed(2) + '）');
  ok(d14.value < d7.value, 'A11 两周比一周更淡（7 天 ' + d7.value.toFixed(2) + ' → 14 天 ' + d14.value.toFixed(2) + '）——不是"越不来越黏你"');
  ok(d14.phase === 'fading', 'A11 两周时的状态是"淡了"');
  ok(d14.value >= 0, 'A11 再久也不会变成负数（只淡不积怨）');

  // ③ 强度由依恋定
  const low = at(2, { attachment: 5 }), high = at(2, { attachment: 95 });
  ok(high.value > low.value, 'A11 同样两天没来：依恋高的更想（' + low.value.toFixed(2) + ' → ' + high.value.toFixed(2) + '）');
  ok(high.peakDay >= low.peakDay, 'A11 依恋高的人峰值来得不早于依恋低的（' + low.peakDay.toFixed(1) + ' 天 vs ' + high.peakDay.toFixed(1) + ' 天）');

  // ④ 参考她自己最近过得怎样
  const tired = at(2, { battery: 20 }), fresh = at(2, { battery: 95 });
  ok(fresh.value > tired.value, 'A11 她自己电量低（累）时想念淡一些（' + tired.value.toFixed(2) + ' vs ' + fresh.value.toFixed(2) + '）');
  const busy = at(2, { workload: 80 }), free = at(2, { workload: 10 });
  ok(free.value > busy.value, 'A11 她自己忙得脚不沾地时也想得少（' + busy.value.toFixed(2) + ' vs ' + free.value.toFixed(2) + '）');

  // ⑤ 说人话：给一句状态描述，**不给分数**
  const line = longingLine(at(1.5), { who: '你' });
  ok(/想你|惦记/.test(line), 'A11 说人话那句能读：' + line);
  ok(!/\d+\s*\/\s*100|分数|好感度/.test(line), 'A11 后台那句话里不出现分数');
  ok(longingLine(at(0)) === '', 'A11 刚说过话时不显示任何想念（不占地方）');
  const fadedLine = longingLine(at(14));
  ok(/习惯|淡/.test(fadedLine), 'A11 两周后那句是"淡了"而不是"更想你"：' + fadedLine);
  ok(longingLine(at(1.5), { who: '他' }).indexOf('他') >= 0, 'A11 那句话的主语可切换（给她看用"他"）');

  // ⑥ 回来那一刻的结算量：0~1，且淡了之后结算得更轻
  ok(settleScale(at(2)) > settleScale(at(14)), 'A11 "回来才算总账"时，两周回来的那一笔比两天回来的轻（' + settleScale(at(14)).toFixed(2) + ' vs ' + settleScale(at(2)).toFixed(2) + '）');
  ok(settleScale(null) === 0, 'A11 没有曲线时不结算');
  ok(settleScale(at(30)) >= 0 && settleScale(at(30)) <= 1, 'A11 结算量始终在 0~1');
}

// ── ⑱ 批 E4：长对话摘要（治断片）/ 起点 / 四条线 / 人味 / 记忆健康度 ──
{
  const HS = await import('../src/history-summary.js');
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-sum-'));

  // ① 摘要的存与取
  ok(HS.getSummary(dirS, 'p1') === null, 'E4 还没有摘要时读取返回 null（调用方据此决定"不裁"）');
  HS.saveSummary(dirS, 'p1', { text: '他下周三要去成都出差，我们说好回来一起看那部老片', upto: 123, count: 20 });
  const s1 = HS.getSummary(dirS, 'p1');
  ok(s1 && /成都/.test(s1.text) && s1.count === 20, 'E4 摘要能存能取');
  ok(HS.getSummary(dirS, 'p2') === null, 'E4 摘要按人分开存（不会串台）');

  // ② 生成摘要：正常 / 太少轮次 / 模型失败（三种都要能分辨）
  const mk = (older) => older.map((t, i) => ({ role: i % 2 ? 'her' : 'user', text: t, ts: Date.now() - (10 - i) * 60000 }));
  const turns = mk(['他说明天去成都', '我说好呀', '他说周三回来', '我说那一起看电影']);
  const good = await HS.summarizeOlder({ dir: dirS, peerKey: 'p9', older: turns, chat: async () => ({ content: '他周三去成都出差，说好回来一起看电影。' }), logger: () => {} });
  ok(good && /成都/.test(good.text) && good.count === 4, 'E4 能把一段老对话压成记忆');
  const tooFew = await HS.summarizeOlder({ dir: dirS, peerKey: 'p9', older: mk(['嗯', '好']), chat: async () => ({ content: 'x' }), logger: () => {} });
  ok(tooFew === null, 'E4 太短的一段不总结（没必要花这个钱）');
  const fails = await HS.summarizeOlder({ dir: dirS, peerKey: 'p9', older: turns, chat: async () => { throw new Error('模型挂了'); }, logger: () => {} });
  ok(fails === null, 'E4 模型失败时返回 null —— 调用方的规则是**总结没好就不裁历史**，所以她不会断片');
  const empty = await HS.summarizeOlder({ dir: dirS, peerKey: 'p9', older: turns, chat: async () => ({ content: '   ' }), logger: () => {} });
  ok(empty === null, 'E4 模型返回空内容也当失败（不会把空摘要写进去）');

  // ③ A12：起点与"表现由性格定"真的进了她的提示词
  const { Soul } = await import('../src/soul.js');
  const dirT = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-e4-'));
  const sP = new Soul({ dir: dirT, router: { chat: async () => ({ content: 'x' }), cfg: {} }, logger: () => {} });
  const sys = sP._systemPrompt({
    persona: { name: '苏镜语', traits: { warmth: 30, attachment: 40 }, quirks: {}, interests: [], assessments: {}, relationship: {} },
    rel: {}, isOwner: true, memories: [], now: new Date(), mediaCount: 0, behavior: {}, today: null, world: null, portrait: '', tone: {}, talkPlan: { maxChunks: 2 },
  });
  ok(/你本来就喜欢他/.test(sys), 'A12 起点写进提示词：她本来就喜欢你（不需要他去挣）');
  ok(/喜欢怎么表现，由你的性格决定/.test(sys), 'A12 表现由性格定，写在提示词里');
  ok(!/亲密度/.test(sys) && !/好感度/.test(sys), 'A12 提示词里不再有"亲密度/好感度"这类记账词');

  // ④ A16：四条不可动的线每一轮都在
  ok(/四条不可动的线/.test(sys), 'A16 四条线在提示词里');
  ok(/不说假话/.test(sys) && /不操纵/.test(sys) && /不追沉默的人/.test(sys) && /危机必被接住/.test(sys), 'A16 四条都在：不说假话 / 不操纵 / 不追沉默的人 / 危机必被接住');
  ok(/自伤/.test(sys) && /立刻放下所有小情绪/.test(sys), 'A16 第④条写明了"危机优先于任何小情绪"');
  const FS = await import('../src/feature-status.js');
  const bl = (FS.FEATURE_STATUS || []).find((x) => x.id === 'bottom-lines');
  ok(bl && bl.status === 'done' && /不说假话/.test(bl.detail), 'A16 能力清单里也有这一条（禁黑盒）');
  ok(fs.existsSync(path.join('docs', '设计约束.md')), 'A16 约束文档在盘上（docs/设计约束.md）');

  // ⑤ A17：人味是性格与状态的结果
  const r1 = sP._realism({ traits: { orderliness: 30, attachment: 30 }, quirks: {} }, { battery: 30, allNighter: false });
  ok(r1.sleepy > 0.3 && r1.terse < 1, 'A17 电量低 → 犯困且话更短（sleepy ' + r1.sleepy.toFixed(2) + ' / terse ' + r1.terse + '）');
  ok(r1.fuzzy >= 0.3, 'A17 秩序感低 + 依恋低 → 更容易记不清小细节（' + r1.fuzzy.toFixed(2) + '）');
  const r2 = sP._realism({ traits: { orderliness: 90, attachment: 90 }, quirks: {} }, { battery: 90, allNighter: false });
  ok(r2.sleepy === 0 && r2.fuzzy < 0.1 && r2.terse === 1, 'A17 秩序感高、睡得饱 → 不困、不糊、话不变短（人味是减法，不是加戏）');
  const r3 = sP._realism({ traits: { orderliness: 20, attachment: 20 }, quirks: {} }, { battery: 95, allNighter: true });
  ok(r3.sleepy >= 0.5, 'A17 通宵了 → 困（哪怕电量显示还行）');
  const line = sP._realismLine(r1, {});
  ok(line.length > 0 && /电量不高/.test(line), 'A17 电量低时提示词里会说"能一句说完就别用三句"：' + line.slice(0, 40));
  const tired = sP._realism({ traits: { orderliness: 30, attachment: 50 }, quirks: {} }, { battery: 8, allNighter: false });
  const lineTired = sP._realismLine(tired, {});
  ok(/困/.test(lineTired), 'A17 电量很低时才说"困"（阈值不是随便挂的）：' + lineTired.slice(0, 40));
  const line2 = sP._realismLine({ sleepy: 0, terse: 1, fuzzy: 0.6 }, {});
  ok(/记不太清/.test(line2) && /不许编/.test(line2), 'A17 记不清就直说记不清、绝不许编（与「不说假话」咬合）');
  ok(sP._realismLine({ sleepy: 0, terse: 1, fuzzy: 0 }, {}) === '', 'A17 没有可说的就不占提示词');
  ok(((sP._behavior() || {}).realism) === true, 'A17 人味总开关默认开');

  // ⑥ 记忆写失败可见（降级不许静默）
  const h0 = sP._memHealth();
  ok(h0.degraded === 0, 'E4 一开始没有降级记录');
  sP._bumpMemHealth('引擎连接超时', '他不吃香菜');
  const h1 = sP._memHealth();
  ok(h1.degraded === 1 && /超时/.test(h1.lastReason) && /香菜/.test(h1.lastText), 'E4 写失败会被记下来（原因 + 是哪条）');
  sP._bumpMemHealth('又失败了', 'x');
  ok(sP._memHealth().degraded === 2, 'E4 反复失败会累加（后台能看出严重程度）');
  sP._clearMemHealth();
  ok(sP._memHealth().degraded === 0, 'E4 引擎恢复后计数清零（不会一直红着）');
  ok(fs.existsSync(path.join(dirT, 'memory-health.json')), 'E4 健康度落盘（重启也看得见）');
}

// ── ⑲ N3：记忆写引擎失败后自动补迁 ──
{
  const { Soul } = await import('../src/soul.js');
  const mkN = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fix-n3-'));
  const s = new Soul({ dir: mkN(), router: { chat: async () => ({ content: 'x' }), cfg: {} }, logger: () => {} });
  await s.addMemory({ who: 'p1', text: '他喜欢喝美式' });
  const e1 = s.getMemories().entries[0];
  ok(e1 && e1.pending === true && !e1.mid, 'N3 引擎挂着时写入会标成"待补迁"（不再静默留在本地）');
  ok(s.pendingMemoryCount() === 1, 'N3 待补迁条数可查（后台要显示）');
  // 引擎恢复（换成桩）→ 心跳会调它
  s.memory = { health: async () => ({ ready: true }), add: async () => ({ ids: ['m-abc'] }) };
  s._engineCache = { ok: null, at: 0, info: null };
  const r = await s.syncPendingMemories(5);
  const e2 = s.getMemories().entries[0];
  ok(r.synced === 1 && e2.mid === 'm-abc' && !e2.pending, 'N3 引擎恢复后自动补迁进引擎（引擎 id 补上、待办标记清掉）');
  ok(s.pendingMemoryCount() === 0, 'N3 补迁完待办清零');
  const r2 = await s.syncPendingMemories(5);
  ok(r2.synced === 0 && r2.left === 0, 'N3 没有待补迁时零开销（不发请求）');
  const s2 = new Soul({ dir: mkN(), router: { chat: async () => ({ content: 'x' }), cfg: {} }, logger: () => {} });
  await s2.addMemory({ who: 'p1', text: '她说不吃辣' });
  const r3 = await s2.syncPendingMemories(5);
  ok(r3.synced === 0 && r3.left === 1 && s2.pendingMemoryCount() === 1, 'N3 引擎还没好 → 原样留着，下次再试（不假装成功）');
}

// ── ⑳ N2：主动性闸门（"她该不该主动"只在一个地方判）──
{
  const G = await import('../src/proactive-gate.js');
  const K = '2026-09-13';
  const NOW = new Date('2026-09-13T15:00:00').getTime();

  ok(G.DEFAULT_GAP_MIN === 45, 'N2 默认两条主动之间至少隔 45 分钟');
  const d0 = G.newDay(K);
  ok(d0.date === K && d0.used === 0 && Object.keys(d0.byKind).length === 0, 'N2 新的一天从零开始记账');
  ok(G.rollDay(d0, K).used === 0, 'N2 同一天翻页不清账');
  ok(G.rollDay({ date: K, used: 3, byKind: { poke: 3 } }, '2026-09-14').used === 0, 'N2 跨天自动重开一本（昨天的额度不带过来）');
  ok(G.rollDay(null, K).used === 0 && G.rollDay(undefined, K).date === K, 'N2 账本还没建立时不报错（真机踩过的坑）');
  ok(G.countsAgainstBudget('poke') === true && G.countsAgainstBudget('nudge') === true, 'N2 日常分享和催你共用一本账');
  ok(G.countsAgainstBudget('morning') === false && G.countsAgainstBudget('night') === false, 'N2 早安/晚安是作息，不占这本账');

  const base = { kind: 'poke', day: d0, dayKey: K, budget: 2, gapMin: 45, lastAt: 0, now: NOW };
  const g1 = G.gate({ ...base, paused: true });
  ok(g1.ok === false && /暂停/.test(g1.why), 'N2 你把她暂停了 → 不发，而且说得出来（' + g1.why + '）');
  const g2 = G.gate({ ...base, asleep: true, allowed: false, inWindow: false });
  ok(g2.ok === false && /睡/.test(g2.why), 'N2 她睡着了 → 一条都不发（' + g2.why + '）');
  ok(G.gate({ ...base, paused: true, asleep: true }).why === '你把她暂停了', 'N2 顺序固定：你暂停 > 她睡着 > 世界引擎说不做 > 不在时间窗（后台说的原因是"最外层"那个）');
  const g3 = G.gate({ ...base, allowed: false });
  ok(g3.ok === false && /世界引擎/.test(g3.why), 'N2 世界引擎说今天不做这件事 → 不发（' + g3.why + '）');
  const g4 = G.gate({ ...base, inWindow: false });
  ok(g4.ok === false && /时间窗/.test(g4.why), 'N2 不在她今天的主动时间窗 → 不发（' + g4.why + '）');
  const g5 = G.gate({ ...base, lastAt: NOW - 10 * 60000 });
  ok(g5.ok === false && /冷却/.test(g5.why) && /35 分钟/.test(g5.why), 'N2 距上一条才 10 分钟 → 冷却挡住，并算出还差多久：' + g5.why);
  const g6 = G.gate({ ...base, lastAt: NOW - 46 * 60000 });
  ok(g6.ok === true && g6.why === '', 'N2 过了 45 分钟 → 放行（放行就不占地方）');
  ok(G.gate({ ...base, day: { date: K, used: 2, byKind: { poke: 2 } } }).ok === false, 'N2 今天额度用完 → 日常分享不发');
  ok(G.gate({ ...base, kind: 'morning', day: { date: K, used: 9, byKind: { poke: 9 } } }).ok === true, 'N2 额度用完了也照样说早安（作息不受这本账管）');
  ok(G.gate({ ...base, gapMin: 0, lastAt: NOW - 60000 }).ok === true, 'N2 间隔填 0 → 真的不冷却（后台填 0 就是 0，不再被当成默认 45）');
  ok(G.gate({ ...base, gapMin: 90, lastAt: NOW - 60 * 60000 }).ok === false, 'N2 间隔改成 90 分钟 → 60 分钟时仍然挡住（配置说了算）');
  ok(G.gate({ ...base, gapMin: '' }).ok === true, 'N2 间隔没填 → 回落默认值，不该崩');

  const r1 = G.record(d0, 'poke', NOW);
  ok(r1.day.used === 1 && r1.day.byKind.poke === 1 && r1.lastAt === NOW, 'N2 发出分享记一笔（占额度 + 记下时间）');
  const r2 = G.record(r1.day, 'morning', NOW);
  ok(r2.day.used === 1 && r2.day.byKind.morning === 1, 'N2 发了早安只记明细、不动额度');
  ok(G.record(r2.day, 'poke', NOW).day.used === 2, 'N2 第二次分享再记一笔（额度累加）');
  const r3 = G.record(undefined, 'poke', NOW);
  ok(r3.day.used === 1 && r3.lastAt === NOW, 'N2 今天第一次主动（还没有账本）不会崩');
  ok(G.rollDay(r3.day, '2026-09-14').used === 0, 'N2 第二天账本又是新的');

  const l1 = G.gateLine({ date: K, used: 1, byKind: { poke: 1, morning: 1 } }, 2, NOW - 90 * 60000, NOW);
  ok(/今天主动 1\/2 次/.test(l1) && /1 小时 30 分钟/.test(l1) && /分享 1/.test(l1) && /早安 1/.test(l1), 'N2 后台那句话说得清（额度 / 距上一条 / 明细）：' + l1);
  ok(!/距上一条 2 小时/.test(l1), 'N2 90 分钟不会四舍五入说成"2 小时"（后台的话不能骗人）');
  const l2 = G.gateLine(G.newDay(K), 2, 0, NOW);
  ok(/今天还没主动过/.test(l2) && /0\/2/.test(l2), 'N2 还没主动过时也说得清：' + l2);

  // 接线：life.js 真的走这个闸门，而不是又各判一套
  ok(/from '\.\/proactive-gate\.js'/.test(lifeSrc), 'N2 她的生活模块用的是同一个闸门文件');
  const gateCalls = (lifeSrc.match(/checkGate\(/g) || []).length;
  ok(gateCalls >= 4, 'N2 四类主动（早安/晚安/分享/催）都过同一道闸门：' + gateCalls + ' 处');
  ok(/record\(s\.gateDay, kind, now\.getTime\(\)\)/.test(lifeSrc), 'N2 记账用的是这一跳的时间（用 Date.now() 会让回放和时钟跳变算错冷却）');
  ok(/Math\.max\(Number\(s\.lastProactiveAt\)\s*\|\|\s*0, Number\(s\.lastPokeAt\)\s*\|\|\s*0\)/.test(lifeSrc), 'N2 老存档里的上一条时间也算进冷却（升级不倒退）');
  ok(/gateView\s*\(/.test(lifeSrc) && /relation\.gate/.test(html) && /她主动找你的闸门/.test(html), 'N2 后台首页写着闸门状态（禁黑盒）');
  ok(/两条主动至少隔多久（分钟）/.test(html) && /proactiveGapMin:gap/.test(html), 'N2 后台能设这个间隔（禁黑盒：凡是她会做的，后台都能看见能改）');
  ok(/proactiveGapMin/.test(idx) && /Math\.max\(0, Math\.min\(600/.test(idx), 'N2 后端接住这个设置并夹在 0~600 之间');
}

// ── ㉑ N2 行为：两分钟内不会连发两条（冷却真在跑）──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-gap-'));
  const sent = [];
  const life = new Life({
    dir,
    config: () => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', pokesPerDay: 5, nudgeMinutes: 20, nudgeMaxPerDay: 0, proactiveGapMin: 45 } }),
    logger: () => {},
  });
  const soulG = { async proactive(kind, extra) { return { chunks: ['[' + kind + '] ' + ((extra || {}).flowItem || {}).text], delaysMs: [0] }; } };
  const imp = life._impulse({ traits: { initiative: 95, attachment: 95 }, battery: 95, mood: 95 });
  let day = null;
  for (let d = 15; d < 30 && !day; d++) {
    const dd = '2026-09-' + String(d).padStart(2, '0');
    for (let i = 0; i < 80; i++) if (life._unitFor('gap' + i, new Date(dd + 'T11:00:00')) <= imp) { day = dd; break; }
  }
  const flow = [{ time: '11:00', text: '第一件' }, { time: '11:20', text: '第二件' }, { time: '11:40', text: '第三件' }];
  const ov = { flow, traits: { initiative: 95, attachment: 95 }, battery: 95, mood: 95 };
  await life.tick({ soul: soulG, sendToOwner: async (t) => sent.push(t), now: new Date(day + 'T11:05:00'), overrides: ov });
  await life.tick({ soul: soulG, sendToOwner: async (t) => sent.push(t), now: new Date(day + 'T11:15:00'), overrides: ov });
  await life.tick({ soul: soulG, sendToOwner: async (t) => sent.push(t), now: new Date(day + 'T11:35:00'), overrides: ov });
  const pokes = sent.filter((t) => t.includes('[poke]'));
  ok(pokes.length === 1, 'N2 三次心跳（11:05/11:15/11:35）只发出 1 条主动：收到 ' + pokes.length + ' 条');
  const gv = life.gateView(new Date(day + 'T11:35:00'));
  ok(gv && /今天主动 1\/5 次/.test(gv.line), 'N2 后台也能看出她今天主动了几次：' + (gv && gv.line));
  ok(gv && gv.gapMin === 45, 'N2 后台知道当前间隔是 45 分钟');
}

// ── ㉒ 「后台填 0 就是 0」（同类坑一起堵：配额项填 0 被悄悄改成默认值）──
{
  const mkz = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fix-zero-'));
  const z = new Life({ dir: mkz(), config: () => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', pokesPerDay: 0, nudgeMaxPerDay: 0, proactiveGapMin: 0 } }), logger: () => {} });
  const zc = z.cfgLife();
  ok(zc.pokesPerDay === 0, 'N2「每日主动」填 0 → 就是 0（不再被改成 2）');
  ok(zc.nudgeMaxPerDay === 0, 'N2「每天最多等几次」填 0 → 就是 0（不再被改成 1）');
  ok(zc.proactiveGapMin === 0, 'N2「两条主动至少隔多久」填 0 → 就是 0（不再被改成 45）');
  const z2 = new Life({ dir: mkz(), config: () => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', pokesPerDay: '', nudgeMaxPerDay: null, proactiveGapMin: undefined } }), logger: () => {} });
  const zc2 = z2.cfgLife();
  ok(zc2.pokesPerDay === 2 && zc2.nudgeMaxPerDay === 1 && zc2.proactiveGapMin === 45, 'N2 没填 / 填了空 → 才回落默认值（2 / 1 / 45）');
  ok(/B\.pokeMaxPerDay=\(v!==''&&isFinite/.test(html), 'N2 后台那个输入框本身也不再把 0 改成 2（界面与后端同一套规矩）');
  // 额度为 0 时：当天一条主动都不发，但早安照发（作息不受额度管）
  const G2 = await import('../src/proactive-gate.js');
  const zDay = { day: G2.newDay('2026-09-13'), dayKey: '2026-09-13', budget: 0, gapMin: 0, lastAt: 0, now: Date.now() };
  ok(G2.gate({ ...zDay, kind: 'poke' }).ok === false, 'N2 额度为 0 → 日常分享一条都不发（"每日主动 0"真的等于 0）');
  ok(G2.gate({ ...zDay, kind: 'morning' }).ok === true, 'N2 额度为 0 也照样说早安（作息不受这本账管）');
}

// ── ㉓ 「日常分享时段」真的生效 + 后台额度与心跳同一个数（2026-09-14 真机排查）──
{
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fix-win-'));
  const soulW = { async proactive(kind, extra) { return { chunks: ['[' + kind + '] ' + ((extra || {}).flowItem || {}).text], delaysMs: [0] }; } };
  const cfgW = (win) => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', pokesPerDay: 5, nudgeMinutes: 20, nudgeMaxPerDay: 0, pokeWindow: win } });

  // ① 时段外：一条都不发，并写明原因（以前这个设置存了根本没人读）
  const d1 = mk(); const sent1 = [];
  const life1 = new Life({ dir: d1, config: () => cfgW(['14:00', '18:00']), logger: () => {} });
  await life1.tick({ soul: soulW, sendToOwner: async (t) => sent1.push(t), now: new Date('2026-09-15T11:05:00'), overrides: { flow: [{ time: '11:00', text: '上午的事' }], traits: { initiative: 95, attachment: 95 }, battery: 95, mood: 95 } });
  ok(!sent1.some((t) => t.includes('[poke]')), '时段外不发分享（设的是 14:00~18:00，11:05 不该发）');
  const st1 = JSON.parse(fs.readFileSync(path.join(d1, 'life-state.json'), 'utf8'));
  ok(/日常分享时段/.test((st1.skipped || {}).poke || ''), '时段外会在后台写明"现在不在你设的日常分享时段"：' + (st1.skipped || {}).poke);

  // ② 时段内：照常发
  const life2 = new Life({ dir: mk(), config: () => cfgW(['14:00', '18:00']), logger: () => {} });
  const imp2 = life2._impulse({ traits: { initiative: 95, attachment: 95 }, battery: 95, mood: 95 });
  let day2 = null;
  for (let d = 15; d < 30 && !day2; d++) { const dd = '2026-09-' + String(d).padStart(2, '0'); for (let i = 0; i < 80; i++) if (life2._unitFor('win' + i, new Date(dd + 'T15:00:00')) <= imp2) { day2 = dd; break; } }
  ok(!!day2, '找到一个"今天想说这句话"的日子（后面两条基于它）');
  const sent2 = [];
  await life2.tick({ soul: soulW, sendToOwner: async (t) => sent2.push(t), now: new Date((day2 || '2026-09-15') + 'T15:05:00'), overrides: { flow: [{ time: '15:00', text: '下午的事' }], traits: { initiative: 95, attachment: 95 }, battery: 95, mood: 95 } });
  ok(sent2.filter((t) => t.includes('[poke]')).length === 1, '时段内照常分享（15:05 在 14:00~18:00 里）');
  ok(life2._inWindow(new Date('2026-09-15T00:30:00'), ['00:00', '00:00']) === true, '00:00-00:00 仍表示"全天不限制"（老配置不会被这次改动搞坏）');

  // ③ 后台显示的额度 = 心跳实际用的额度（以前显示 0/12、实际 0/0）
  const gv0 = life2.gateView(new Date((day2 || '2026-09-15') + 'T15:30:00'), { stageLimit: { morning: true, night: true, pokes: 0, nudges: 0 } });
  ok(gv0 && /今天主动 1\/0 次/.test(gv0.line), '世界引擎说今天不主动 → 后台额度也按它的算（已发 1 次 / 上限 0）：' + (gv0 && gv0.line));
  const gv1 = life2.gateView(new Date((day2 || '2026-09-15') + 'T15:30:00'));
  ok(gv1 && /今天主动 1\/5 次/.test(gv1.line), '没有世界引擎上限时按配置显示（上限 5 次）：' + (gv1 && gv1.line));
  ok(/gateView\(new Date\(\), \{ stageLimit: this\._stageLimitNow\(/.test(idx) && /stageLimit: this\._stageLimitNow\(toneNow\)/.test(idx), '心跳和后台用的是同一个「世界引擎上限」方法（两处同一个数）');
  ok(/_inWindow\(now, cfg\.pokeWindow\)/.test(lifeSrc), '「日常分享时段」真的接线了（不再是死代码）');
  ok(/日常分享时段/.test(html) && /00:00-00:00 = 全天不限制/.test(html), '后台写明了这个时段怎么用（禁黑盒）');
}

// ── ㉔ 2026-09-14 真机抓到的三个真 bug（心跳 TDZ / 凌晨"还没起床" / 报错不带原始响应）──
{
  // ① 心跳 TDZ：today 必须在第一处使用之前声明，否则整条心跳（早安/晚安/分享/催/承诺/补迁）每跳全废
  const tickAt = idx.indexOf('async _lifeTick(');
  // 先滤掉注释行（本仓的既有教训：注释里引用旧写法会骗过源级断言）
  const tickBody = idx.slice(tickAt, tickAt + 6000).split(String.fromCharCode(10)).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(String.fromCharCode(10));
  const declAt = tickBody.indexOf('const today = this.today();');
  const useAt = tickBody.indexOf('today.wake');
  ok(tickAt >= 0 && declAt >= 0 && useAt > declAt, '心跳里「const today」声明在第一处使用之前（写在后面会让每跳抛 TDZ，心跳全废且只在日志留一行 warn）');
  ok(/心跳失败\(下轮再试\)/.test(idx), '心跳失败仍会留一行 warn（便于真机排障）');

  // ② 凌晨 1 点不再告诉她"还没起床"（这就是她口出"刚醒"的源头）
  const { nowDoing } = await import('../src/soul.js');
  const nd1 = nowDoing({ wake: '08:30', sleep: '01:20' }, { flow: [{ time: '08:30', text: '赖床刷手机' }] }, new Date('2026-09-14T01:00:00'));
  ok(!/你还没起床/.test(nd1) && !/你刚醒|你刚起/.test(nd1), '凌晨 1 点不再说"你还没起床"：' + nd1.slice(0, 60));
  ok(/夜里/.test(nd1) && /准备睡|还没睡/.test(nd1) && /01:20/.test(nd1), '凌晨 1 点（她 01:20 才睡）会告诉她"现在是夜里、你要么还没睡要么在准备睡"：' + nd1.slice(0, 96));
  const nd3 = nowDoing({ wake: '08:30', sleep: '01:20' }, {}, new Date('2026-09-14T03:00:00'));
  ok(/正在睡觉/.test(nd3), '03:00 她确实在睡 → 仍然是"正在睡觉"（这条没被改坏）');
  const nd12 = nowDoing({ wake: '08:30', sleep: '01:20' }, { flow: [{ time: '08:30', text: '赖床刷手机' }, { time: '15:00', text: '看庭审材料' }] }, new Date('2026-09-14T12:00:00'));
  ok(/刚做完/.test(nd12) && !/夜里/.test(nd12), '白天照常给她"刚做完这件事"的锚：' + nd12.slice(0, 60));

  // ④ 补生成今天之后，daily-state 的作息要跟着剧本走（否则两处存同一件事、睡眠判定用旧值）
  const { todayState } = await import('../src/daily.js');
  const dD = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-day-'));
  const nowLocal = new Date();
  const dayK = nowLocal.getFullYear() + '-' + String(nowLocal.getMonth() + 1).padStart(2, '0') + '-' + String(nowLocal.getDate()).padStart(2, '0');
  fs.writeFileSync(path.join(dD, 'daily-state.json'), JSON.stringify({ date: dayK, wake: '08:30', sleep: '01:20', body: null }), 'utf8');
  fs.writeFileSync(path.join(dD, 'world-state.json'), JSON.stringify({ forDate: dayK, wake: '08:30', sleep: '01:00' }), 'utf8');
  const stDay = todayState(dD, { traits: {}, behavior: {} });
  ok(stDay && stDay.sleep === '01:00', '补生成剧本后，今天的作息会跟着刷新（01:20 → 01:00）：' + (stDay && stDay.sleep));
  ok(stDay && stDay.wake === '08:30', '起床时间不变时也不会被改坏');

  // ③ 模型返回异常形状时，报错必须带原始响应（否则"缺少 content"查不动）
  const routerSrc = read('src/model-router.js');
  ok(/chat 返回缺少 content（原始响应/.test(routerSrc), '模型返回异常形状会把原始响应带进报错（真机上摘要链每次都失败，只有一句"缺少 content"根本查不动）');
}

// ── ㉕ 作息基准：世界引擎"真的去推"（2026-09-14 用户发现：基准和我填的一模一样）──
{
  const { WorldEngine } = await import('../src/world-engine.js');
  const dW = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-rhythm-'));
  fs.writeFileSync(path.join(dW, 'world-state.json'), JSON.stringify({
    date: '2026-09-13', forDate: '2026-09-14', wake: '09:30', sleep: '01:30',
    tone: { rhythm: { baseWake: '09:30', baseSleep: '01:30', weekendShiftMin: 60, nightOwlProb: 0.3, allNighterProb: 0.05, why: '她是夜猫子' } },
  }), 'utf8');
  let seen = '';
  const replyW = {
    content: JSON.stringify({
      diary: '今天还行', wake: '10:00', sleep: '02:00', mood: 60, focus: '大理',
      flow: [{ time: '10:00', text: '起床' }], thoughts: [], secrets: [], npc: [], portrait: '他最近忙',
      longline: '学吉他', statusLine: '有点困', insomnia: false, proactiveAt: '20:00',
      rhythm: { baseWake: '10:00', baseSleep: '02:00', weekendShiftMin: 60, nightOwlProb: 0.3, allNighterProb: 0.05, rhythmWhy: '她连着几天两点睡，把基准往后挪半小时' },
      tone: { intimacy: 40, address: '用名字', style: '轻松点', talkDelta: 0, proactive: { morning: true, night: true, pokes: 2, nudges: 1 }, forbid: [], reason: '刚熟' },
      body: { sleep: '没睡好', ailment: '没有', note: '' },
    }),
  };
  const engW = new WorldEngine({
    dir: dW,
    router: { chat: async () => { throw new Error('不该走对话接口'); } },
    chatFn: async (m) => { seen = JSON.stringify(m); return replyW; },
    config: () => ({ world: { baseURL: 'https://world.example', model: 'world-model', weatherReal: false } }),
    soul: null, logger: () => {},
  });
  const outW = await engW.generate({
    persona: { name: '苏镜语', traits: { orderliness: 30 }, behavior: { baseWake: '08:00', baseSleep: '02:00', jitterMin: 45 } },
    today: { date: '2026-09-13', wake: '08:30', sleep: '01:20', events: [] },
    memories: [],
  });
  ok(/当前生效的基准是：起床 09:30 \/ 睡觉 01:30/.test(seen), '提示词拿"上一晚推的基准 09:30/01:30"当当前生效基准（不再是后台设的 08:00/02:00）');
  ok(!/当前生效的基准是：起床 08:00/.test(seen), '不再把后台设的值当唯一基准（这就是"和我填的一模一样"的根源）');
  ok(/单次最多挪 ±60 分钟/.test(seen), '提示词明令它自己重新判断基准、且单次最多挪 ±60 分钟（防每天大起大落）');
  ok(!!(outW && outW.tone && outW.tone.rhythm && /往后挪半小时/.test(String(outW.tone.rhythm.why))), 'rhythm 的"为什么"被解析保存（后台能看见它这次调没调）：' + (outW && outW.tone && outW.tone.rhythm && outW.tone.rhythm.why));
  ok(!!(outW && outW.tone && outW.tone.rhythm && outW.tone.rhythm.baseWake === '10:00'), '它推出来的新基准（10:00 起）覆盖旧的 09:30（下一晚会以这个为新起点）');
  let mdW = '';
  try { const fl = fs.readdirSync(path.join(dW, 'diary')); mdW = fs.readFileSync(path.join(dW, 'diary', fl[fl.length - 1]), 'utf8'); } catch { /* 没留档不致命 */ }
  ok(/为什么：/.test(mdW), '日记的「作息基准」一节会写"为什么"（改基准要有交代）');

  // 模型漏了 tone 的那一晚：昨天的分寸保住，但顶层那几项照常更新（不能整套静默退回昨天）
  const dW2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-notone-'));
  fs.writeFileSync(path.join(dW2, 'world-state.json'), JSON.stringify({
    date: '2026-09-13', forDate: '2026-09-14', wake: '09:00', sleep: '01:00',
    tone: { intimacy: 42, address: '叫哎', style: '有点闷', talkDelta: -5, proactive: { morning: true, night: true, pokes: 2, nudges: 1 }, forbid: ['别提工作'], reason: '他最近忙', statusLine: '旧的', rhythm: { baseWake: '09:30', baseSleep: '01:30' } },
  }), 'utf8');
  const engN = new WorldEngine({
    dir: dW2,
    router: { chat: async () => { throw new Error('不该走对话接口'); } },
    chatFn: async () => ({ content: JSON.stringify({ diary: '还行', wake: '09:30', sleep: '01:30', mood: 60, focus: 'x', flow: [], thoughts: [], secrets: [], npc: [], portrait: 'x', longline: 'y', statusLine: '今天有点累', proactiveAt: '21:00', rhythm: { baseWake: '10:00', baseSleep: '02:00' } }) }),
    config: () => ({ world: { baseURL: 'https://world.example', model: 'm', weatherReal: false } }),
    soul: null, logger: () => {},
  });
  const outN = await engN.generate({ persona: { name: '苏镜语', traits: {}, behavior: { baseWake: '08:00', baseSleep: '02:00' } }, today: { date: '2026-09-13', wake: '09:00', sleep: '01:00', events: [] }, memories: [] });
  ok(!!(outN && outN.tone && outN.tone.intimacy === 42), '模型漏 tone 时，昨天的分寸保住（熟度仍是 42，不会被冲成默认 10）：' + (outN && outN.tone && outN.tone.intimacy));
  ok(!!(outN && outN.tone && outN.tone.statusLine === '今天有点累'), '即使漏 tone，顶层那句"她今天状态"照常更新：' + (outN && outN.tone && outN.tone.statusLine));
  ok(!!(outN && outN.tone && outN.tone.rhythm && outN.tone.rhythm.baseWake === '10:00'), '即使漏 tone，作息基准也照常更新（不然那一晚的作息会静默退回昨天）');
}

// ── ㉖ 第五次改版原定但漏做的四处（2026-09-14 逐条对齐计划后补齐）──
{
  // ① 治断片：两个旋钮（总结起始轮数 + 自定义总结提示词）
  ok(/summaryStart: Math\.min\(40/.test(soul), '「聊到多少轮才开始总结」已接线（默认 6，2-40）');
  ok(/olderCount >= b\.summaryStart/.test(soul), '攒够起始轮数才去调用总结模型（不够就先多带上下文）');
  ok(/sysPrompt: bp\.summaryPrompt/.test(soul), '「自定义总结提示词」已透传到总结器');
  ok(/summaryStart/.test(idx) && /summaryPrompt/.test(idx), '后端接住这两个设置（进白名单，否则存了不生效）');
  ok(/聊到多少轮才开始总结/.test(html) && /自定义总结提示词/.test(html), '后台能看见能改这两个设置（禁黑盒）');

  // ② 摘要发生要在实况直播看得见
  ok(/\[总结\] 把最早的/.test(soul), '总结完成会往实况直播写一行（原计划里就有，之前漏做）');

  // ③ 摘要提示词的两条硬规则 + 自定义提示词真的生效
  const { SUMMARY_SYS, summarizeOlder } = await import('../src/history-summary.js');
  ok(/开头先交代这件事发生在哪天/.test(SUMMARY_SYS), '总结提示词要求"开头写日期"（她才能分清先后）');
  ok(/没意义的寒暄/.test(SUMMARY_SYS), '总结提示词要求"没意义的闲聊不要记"');
  let sysSeen = '';
  const sumOut = await summarizeOlder({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fix-sum-')), peerKey: 'p1',
    older: [{ role: 'user', text: 'a' }, { role: 'her', text: 'b' }, { role: 'user', text: 'c' }, { role: 'her', text: 'd' }],
    chat: async (o) => { sysSeen = String(o.messages[0].content); return { content: '记下了：他喜欢吃辣（2026年9月14日）' }; },
    sysPrompt: '我的总结要求：只记跟吃有关的事',
  });
  ok(sysSeen === '我的总结要求：只记跟吃有关的事', '用户自定义的总结提示词真的顶替了内置的：' + sysSeen.slice(0, 30));
  ok(!!(sumOut && /记下了/.test(sumOut.text)), '总结照常拿到结果：' + (sumOut && sumOut.text));

  // ④ 指令跨轮重复抑制（《爱语》的教训：模型会每回一次就重复输出同一指令）
  const { filterCommands, emptyUsage, usageLine, RECENT_KEEP } = await import('../src/commands.js');
  const dK = '2026-09-14';
  ok(RECENT_KEEP === 3, '跨轮去重看最近 3 轮');
  const r1 = filterCommands([{ kind: 'image', arg: '大理海景' }], emptyUsage(dK), dK, { recent: [] });
  ok(r1.ok.length === 1, '第一次用某条指令 → 正常执行');
  const r2 = filterCommands([{ kind: 'image', arg: '大理海景' }], r1.usage, dK, { recent: r1.ok });
  ok(r2.ok.length === 0 && /连着几轮/.test((r2.dropped[0] || {}).why || ''), '下一轮又用同一条 → 压掉并写明原因：' + (r2.dropped[0] || {}).why);
  ok(Number(r2.usage.repeatBlocked) === 1, '压掉的次数会记账（后台看得见）');
  ok(/压掉 1 次连着重复的指令/.test(usageLine(r2.usage, dK)), '后台那句用量里会显示压掉了几次：' + usageLine(r2.usage, dK));
  const r3 = filterCommands([{ kind: 'image', arg: '律所窗外的天' }], r2.usage, dK, { recent: r1.ok });
  ok(r3.ok.length === 1, '换成另一件事/另一条指令 → 照常执行（不是把整类指令禁掉）');
  ok(/cmd-recent\.json/.test(idx) && /_rememberCommands\(/.test(idx), '插件会记住最近几轮用过的指令（跨轮去重要用）');
}

// ── ㉗ 远程访问口令（内网穿透的门锁，2026-09-14）──
{
  const urlAt = idx.indexOf('const url = new URL(req.url');
  const guardAt = idx.indexOf('if (!this._accessOk(req, url))');
  const firstRouteAt = idx.indexOf('path === \'panel/conn-test\'');
  ok(guardAt > urlAt && guardAt < firstRouteAt, '口令校验插在“算出路径”之后、任何路由之前（否则有接口能绕过）');
  ok(/_keyEq\(/.test(idx) && /timingSafeEqual/.test(idx), '口令用定长比较（不用 === 泄露长度/前缀）');
  ok(/'x-access-key'/.test(idx) && /Bearer/.test(idx) && /Basic/.test(idx) && /searchParams/.test(idx), '口令支持 ?key= / X-Access-Key / Bearer / Basic 四种带法');
  ok(/out\.security = \{ \.\.\.\(out\.security \|\| \{\}\), accessKey/.test(idx), '口令进配置白名单（否则保存不生效）');
  ok(/accessKeySet/.test(idx) && /accessKey: ''/.test(idx), '后台接口只说“设了没有”，不回口令原文');
  ok(/function ckey\(\)/.test(html) && /function wurl\(/.test(html), '后台页会自己带口令（含图片链接）');
  ok(/localStorage\.setItem\('ckey'/.test(html) && /history\.replaceState/.test(html), '地址里带的 ?key= 会存下来并从地址栏抹掉（免得截图/历史带出去）');
  ok(/远程访问（内网穿透用）/.test(html) && /清掉口令/.test(html), '后台有口令设置与“清掉口令”（禁黑盒）');
  ok(/function ckey\(\)/.test(idx) && /localStorage\.setItem\("ckey"/.test(idx), '她的房间页同样会带口令并记住它');
  ok(/只把 43121 这一个端口映射出去/.test(html), '后台写明：只映射 43121，别暴露 43122/43123');
}

// ── ㉘ 真机验收又抓到的两个（启动竞态让她整晚离线 / 补生成剧本后身体不刷新）──
{
  // ① 启动时设置源没就绪 → 不能把"本该在跑的她"关掉；而且要补几次重试自愈
  ok(/typeof s\.enabled !== 'boolean'\) return;/.test(idx), '设置没就绪时不动她（以前 undefined 被当成 false → 她不上线且再无回调）');
  ok(/for \(const ms of \[2000, 8000, 20000, 60000\]\)/.test(idx), '启动时立即应用一次 + 补四次重试（设置晚到也能自愈；setEnabled 幂等）');

  // ② 世界剧本今天被重新生成过（剧本里有 body）→ 派生的身体状态要跟着刷新
  const { todayState } = await import('../src/daily.js');
  const dB = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-body2-'));
  const nowB = new Date();
  const k2 = nowB.getFullYear() + '-' + String(nowB.getMonth() + 1).padStart(2, '0') + '-' + String(nowB.getDate()).padStart(2, '0');
  fs.writeFileSync(path.join(dB, 'daily-state.json'), JSON.stringify({ date: k2, wake: '08:30', sleep: '01:00', body: { period: { cycleDay: 26, phase: 'mid' }, daily: null, lowEnergy: false, disclosureTier: 1, note: '', source: 'none' } }), 'utf8');
  fs.writeFileSync(path.join(dB, 'world-state.json'), JSON.stringify({ forDate: k2, wake: '08:30', sleep: '01:00', tone: { intimacy: 40 }, body: { forDate: k2, sleep: '没睡好', ailment: '没有', note: '' } }), 'utf8');
  const stB = todayState(dB, { traits: {}, behavior: {}, name: '苏镜语' });
  ok(stB && /没睡好/.test(JSON.stringify(stB.body || {})), '补生成剧本后，今天的身体状态会跟着刷新（不再一直空着）：' + JSON.stringify(stB.body || {}).slice(0, 90));
}

// ── ㉙ 首页「今天的她」不许再变空（读了不存在的全局 P + 错误被无声吞掉）──
{
  const i0 = html.indexOf('function tToday(');
  const tBody = i0 >= 0 ? html.slice(i0, i0 + 2600) : '';
  ok(i0 >= 0 && tBody.length > 200, '首页有「今天的她」这张卡的渲染函数');
  ok(!/P\.behavior/.test(tBody), '不再读那个从没被赋值过的全局 P（一读就 ReferenceError → 卡片只剩标题）');
  ok(/panel\/persona/.test(tBody) && /talkiness/.test(tBody), '话量从人设里读（跟「她」页同一个来源）');
  ok(/读取失败：/.test(tBody), '读取失败会写在卡片上，不再被 .catch(function(){}) 吞掉变空白（禁黑盒）');
  ok(!/P\.behavior/.test(html), '整份控制台里都没有这个幽灵全局了');
}

console.log(fail === 0 ? '\nFIX-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nFIX-SMOKE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

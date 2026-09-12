// rename.js — 「她希望你叫她」的自主演进（她自己决定，不是世界引擎替她编）
// 触发：关系阶段跃迁（由 soul.detectStageJump 记下 renamePending）
// 做法：给她一次"想说点什么"的机会，让她的对话模型自己决定要不要换个称呼，
//      并给一句第一人称的理由。代码只做护栏：长度/字符/跟本名重复/跟阶段不搭。
// 后台可以看她的改名记录，也可以"锁死"让她不再自己改。

/** 昵称护栏：1~8 个中文/字母/数字/间隔号，去引号空格 */
export function sanitizeNick(raw) {
  let n = String(raw == null ? '' : raw).trim();
  n = n.replace(/^["'「『（(]+/, '').replace(/["'」』）)]+$/, '').replace(/\s+/g, '');
  if (!/^[\u4e00-\u9fa5A-Za-z0-9·]{1,8}$/.test(n)) return '';
  return n;
}

/** 阶段 → 允许的亲密味道（防止"刚认识就叫亲爱的"这种崩人设） */
const STAGE_FLAVOR = {
  刚认识: '还早，一般不会改（真要改也只能是本名的顺口叫法，别用昵称）',
  熟人: '可以顺口、自然一点（比如名字叠字）',
  朋友: '可以带点玩笑或外号的味道',
  亲近: '可以更亲近、更私密一点',
  暧昧: '可以带一点只有你俩懂的甜',
  恋人: '可以是很亲昵、专属的那种',
};

export function buildRenamePrompt(persona, from, to) {
  const rc = persona.relationship || {};
  const cur = String(rc.ownerCallsMe || '').trim();
  const sys = [
    '你就是「' + (persona.name || '她') + '」本人，不是助手、不是AI。',
    '现在你要做一个很小的私人决定：希望大家（尤其是他）怎么叫你。',
    '只输出一个 JSON 对象，不要解释、不要代码块：{"changed":true或false,"name":"新的称呼","reason":"一句第一人称的理由"}',
    '规则：①name 只能是 1~6 个汉字的昵称（或名字叠字），不要英文、不要表情、不要标点；',
    '②不想要改就 changed:false，name 留空字符串——大多数时候保持不变才是正常的；',
    '③称呼要跟关系阶段搭：' + (STAGE_FLAVOR[to] || '自然一点即可') + '；',
    '④不要跟本名「' + (persona.name || '') + '」完全一样（那样等于没改）；',
    '⑤reason 是你自己心里的想法，一句第一人称的话，20 字以内，别人看不到你写它。',
  ].join('\n');
  const user = [
    '【你们的关系】刚刚从「' + from + '」走到了「' + to + '」。',
    cur ? '【现在的叫法】他平时叫你「' + cur + '」。' : '【现在的叫法】他平时直接叫你的名字「' + (persona.name || '') + '」。',
    '【你自己】' + String(persona.personaText || '').slice(0, 160),
    '【你今天的性格】温度' + (persona.traits?.warmth ?? 50) + '／依恋' + (persona.traits?.attachment ?? 50) + '／发起力' + (persona.traits?.initiative ?? 50),
    '要不要在这个节点给自己换个叫法？',
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/**
 * 让她自己决定要不要改称呼。
 * @returns {Promise<{changed:boolean,name:string,reason:string,same?:boolean,raw?:string}|null>}
 */
export async function decideRename({ router, persona, from, to, log }) {
  const say = (m) => { try { log && log(m); } catch {} };
  let out = '';
  try {
    const r = await router.chat(buildRenamePrompt(persona, from, to), { temperature: 0.8, maxTokens: 200 });
    out = String((r && r.content) || '');
  } catch (err) {
    say('[rename] 决策调用失败: ' + (err && err.message));
    return null;
  }
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) { say('[rename] 没有 JSON 输出，放弃这次'); return null; }
  let d = null;
  try { d = JSON.parse(m[0]); } catch { say('[rename] JSON 解析失败'); return null; }
  if (!d || d.changed !== true) return { changed: false, name: '', reason: '', raw: out.slice(0, 120) };
  const name = sanitizeNick(d.name);
  if (!name) { say('[rename] 名字不合法，放弃: ' + JSON.stringify(d.name)); return { changed: false, name: '', reason: '', raw: out.slice(0, 120) }; }
  const cur = String(((persona.relationship || {}).ownerCallsMe) || '').trim();
  if (name === cur || (!cur && name === String(persona.name || '').trim())) {
    return { changed: false, name, reason: String(d.reason || '').slice(0, 40), same: true };
  }
  return { changed: true, name, reason: String(d.reason || '').slice(0, 40), raw: out.slice(0, 120) };
}

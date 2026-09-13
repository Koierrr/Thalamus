// selfcheck.js — 常识四层 · 第 4 层：发之前过一道"自检"（2026-09-13 加，用户要求"4 加开关"）
//
// 干什么：她这条回复生成完之后，用**便宜模型**再审一遍——跟
//   【此刻她在做什么】/她的作息/现实常识 有没有冲突？
//   有冲突就按她的处境把这句话改写成一句自然的微信，再发。
//
// 三条铁律：
//   ① 默认开，后台「她→她怎么说话」里可以关（用户明确要求带开关）
//   ② 自检失败/超时/没配模型 → **原样发**，绝不因为自检把她的回复卡住或吞掉
//   ③ 每次改写都要在首页「实况直播」里写明原因（禁黑盒：不许悄悄改她说的话）
import { chatCompletion } from './model-router.js';

const SYS = [
  '你是一个严格的「事实与常识校对员」。下面给你一个女生的处境、对方刚说的话、以及她准备发出去的微信。',
  '判断这句回复有没有和她的处境冲突（例：她在睡觉却说自己刚下班；周日却说要去银行办事；人在上海却说马上到深圳；',
  '编造了具体数字或别人的话；用了她根本没有的工具），或者明显违反现实常识。',
  '只输出一个 JSON：',
  '{"ok":true,"reason":""}',
  '或 {"ok":false,"reason":"一句话说明哪里不对","fix":"按她的处境改写成一句自然的微信（保持她的语气和长度，别加解释）"}',
  '没问题就 ok=true。**宁可放过也不要瞎改**：她随口一句「今天好累」是正常的，别把正常聊天判成错。',
].join('\n');

/**
 * 审一遍她的回复。
 * @returns {Promise<{ok:boolean, reason?:string, fix?:string, by?:string, skipped?:boolean}>}
 */
export async function reviewReply(opts = {}) {
  const cands = (Array.isArray(opts.chain) ? opts.chain : []).filter((c) => c && c.baseURL && c.model);
  if (!cands.length) return { skipped: true, reason: '没有可用的自检模型' };
  const reply = String(opts.reply || '').slice(0, 400);
  if (!reply.trim()) return { skipped: true, reason: '没有内容要审' };
  const q = '【她的处境】\n' + String(opts.situation || '').slice(0, 1400)
    + '\n\n【对方刚说】' + String(opts.userText || '').slice(0, 300)
    + '\n\n【她准备发的】' + reply;
  const timeoutMs = Number(opts.timeoutMs) || 12000;
  for (const c of cands) {
    try {
      const r = await chatCompletion({
        baseURL: c.baseURL, apiKey: c.apiKey || '', model: c.model,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: q }],
        temperature: 0, maxTokens: 320, timeoutMs,
      });
      const m = String((r && r.content) || '').match(/\{[\s\S]*\}/);
      if (!m) continue;
      let d = null;
      try { d = JSON.parse(m[0]); } catch { continue; }
      if (!d || typeof d !== 'object') continue;
      if (d.ok === false && String(d.fix || '').trim()) {
        return { ok: false, reason: String(d.reason || '和她的处境对不上').slice(0, 120), fix: String(d.fix).trim().slice(0, 400), by: c.model };
      }
      return { ok: true, by: c.model };
    } catch { /* 这个候选挂了，换下一个 */ }
  }
  return { skipped: true, reason: '自检调用失败（已原样发出）' };
}

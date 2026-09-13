// history-summary.js —— 长对话摘要（批 E4：治断片）
//
// 问题：她跟她/他的聊天记录只有最近 N 轮进提示词，更早的**直接被砍掉**。
//       结果聊久了就断片——你半小时前说过的事，她完全不记得。
//
// 现在：被砍掉的那部分**先总结成一条记忆**（进她的记忆系统，能被她检索到），
//       提示词里用"你们之前聊过的（这是你自己记得的）"这一段代替原始记录。
//       **总结还没好的时候绝不裁**——宁可提示词长一点，也不让她断片（用户明确要求）。
//
// 目录：<companionDir>/history-summary/<peerKey>.json（原子写）
import fs from 'node:fs';
import path from 'node:path';

export const SUMMARY_MAX_CHARS = 600;

function fileOf(dir, peerKey) {
  return path.join(dir, 'history-summary', encodeURIComponent(String(peerKey || 'unknown')) + '.json');
}

/** 读已有摘要；没有就 null */
export function getSummary(dir, peerKey) {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(dir, peerKey), 'utf8'));
    if (v && typeof v.text === 'string' && v.text.trim()) return v;
  } catch { /* 还没有 */ }
  return null;
}

export function saveSummary(dir, peerKey, { text, upto, count } = {}) {
  try {
    const f = fileOf(dir, peerKey);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify({ text: String(text || '').slice(0, SUMMARY_MAX_CHARS), upto: upto || Date.now(), count: count || 0, at: Date.now() }, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

export const SUMMARY_SYS = '你负责把一段微信聊天记录压缩成一小段"她自己的记忆"。'
  + '用第一人称、口语、不要编号、不要标题，60~120 字，只写**聊过的事和结论**：'
  + '他提过的具体信息（人名/地点/时间/偏好）、你答应过的事、你们说定的结果、气氛上的变化。'
  + '不要写"他们聊了…"这种旁观说法，也不要写寒暄。只输出这段记忆本身，不要解释。';

/**
 * 把"老的那一段"总结成一小段记忆。失败返回 null（调用方据此**不裁**）。
 * chat 是模型调用函数（与记忆提炼同一条链），由调用方注入，方便测试。
 */
export async function summarizeOlder({ dir, peerKey, older, chat, logger, timeoutMs } = {}) {
  const turns = Array.isArray(older) ? older : [];
  if (turns.length < 4 || typeof chat !== 'function') return null;
  const text = turns.map((m) => ((m && m.role === 'her') ? '她：' : '他：') + String((m && m.text) || '').slice(0, 300)).join(String.fromCharCode(10));
  try {
    const r = await chat({
      messages: [
        { role: 'system', content: SUMMARY_SYS },
        { role: 'user', content: '【聊天记录】' + String.fromCharCode(10) + text.slice(0, 6000) },
      ],
      temperature: 0.2, maxTokens: 260, timeoutMs: Number(timeoutMs) || 20000,
    });
    const out = String((r && r.content) || '').trim().replace(/^["「]|["」]$/g, '').slice(0, SUMMARY_MAX_CHARS);
    if (out.length < 8) return null;
    return { text: out, upto: (turns[turns.length - 1] && turns[turns.length - 1].ts) || Date.now(), count: turns.length };
  } catch (err) {
    try { if (logger) logger('[soul] 长对话摘要失败（这轮先不裁历史）: ' + (err && err.message)); } catch { /* noop */ }
    return null;
  }
}

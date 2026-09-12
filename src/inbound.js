// inbound.js — 入站消息解析（从 index.js 抽出来，单独可测）
// 为什么单独放一个文件：这段逻辑曾经写在 index.js 里、而且写在"用它的那行"之后，
// 于是每条消息都在 TDZ 抛错（Cannot access 'text' before initialization），
// 整个入站处理中断 → 她收到消息却永远不回。抽成纯函数后可以单测，不会再被顺序搞死。

/** 从一条 ilink 消息里取出正文（文本 + 引用上下文） */
export function parseInboundText(msg = {}) {
  let text = '';
  for (const item of msg.item_list || []) {
    if (item && item.type === 1 && item.text_item && item.text_item.text) text += item.text_item.text;
  }
  const ref = msg.ref_message;
  if (ref && (ref.title || ref.content)) {
    const parts = [];
    if (ref.title) parts.push(String(ref.title));
    if (ref.content) parts.push(String(ref.content));
    text = '[引用: ' + parts.join(' | ') + ']\n' + text;
  }
  return { text: String(text).trim() };
}

/** 这条消息里有没有媒体（图片/文件/视频/语音）——决定要不要走下载解密 */
export function hasMedia(msg = {}) {
  const MEDIA = new Set([2, 3, 4, 5]);
  return (msg.item_list || []).some((it) => it && MEDIA.has(it.type));
}

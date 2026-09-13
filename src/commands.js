// commands.js —— 她的"指令协议"（批 E2 / A5）
//
// 她要"自己决定"做一些事（记住一件事、发张照片、发条语音、晚点再找你、发个表情包），
// 但她只会写字——所以约定：她把指令写在回复**文字里**，形如 <image:傍晚的窗台>；
// 插件负责 ①把它从可见文字里摘掉（你永远不该看到这行）②去重 ③限次 ④真正执行。
//
// 为什么要"限次 + 去重"：这几个动作里 image 要花钱（生图）、voice 要花钱（TTS）、
// 表情包发多了就是刷屏。没有闸门的话，模型一旦学会这个语法就会滥用。
//
// 这个文件是纯函数：不碰网络、不碰磁盘，方便直接测。

/** 认识的指令（名字 → 中文名，用于后台展示与日志） */
export const CMD_KIND = {
  remember: '记住一件事',
  image: '发一张她拍的照片',
  voice: '发一条语音',
  nudge_at: '约好晚点再找你',
  sticker: '发一个表情包',
};

/** 每条回复内的上限（防止一条消息里塞 5 张图） */
export const PER_REPLY = { image: 1, voice: 1, sticker: 1, remember: 2, nudge_at: 2 };

/** 每个自然日的上限（防止一天刷你一脸图） */
export const PER_DAY = { image: 3, voice: 5, sticker: 8, remember: 20, nudge_at: 5 };

/** 跨轮去重要记几轮（最近这几轮里用过的同一条指令，这轮就不再执行） */
export const RECENT_KEEP = 3;

const RE = /<\s*(remember|image|voice|nudge_at|sticker)\s*[:：]\s*([^<>]{1,300}?)\s*>/gi;

/**
 * 从她的回复里把指令摘出来，并返回"给你看的干净文字"。
 * 顺带把摘掉指令后留下的空行/双空格收拾一下（不然你会看到莫名其妙的空行）。
 */
export function parseCommands(raw) {
  const commands = [];
  const text = String(raw == null ? '' : raw)
    .replace(RE, (m, kind, arg) => {
      const k = String(kind).toLowerCase();
      const a = String(arg == null ? '' : arg).trim();
      if (a) commands.push({ kind: k, arg: a });
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, commands };
}

/** 文字里是否还残留半截指令（模型偶尔会写坏，比如漏了 >）——用于日志告警，不阻断发送 */
export function hasBrokenCommand(text) {
  return /<\s*(remember|image|voice|nudge_at|sticker)\s*[:：]/i.test(String(text || ''));
}

/** 当天已用量的容器（由调用方落盘保存；这里只管结构） */
export function emptyUsage(dayKey) {
  return { date: dayKey, used: {} };
}

/**
 * 去重 + 限次。返回 { ok: [...], dropped: [{kind, arg, why}] }。
 * why 是中文原因，会进后台日志（禁黑盒：被拦下来也要看得见）。
 */
export function filterCommands(commands, usage, dayKey, opts = {}) {
  const perReply = { ...PER_REPLY, ...(opts.perReply || {}) };
  const perDay = { ...PER_DAY, ...(opts.perDay || {}) };
  const u = (usage && usage.date === dayKey) ? usage : emptyUsage(dayKey);
  const usedDay = u.used || (u.used = {});
  const usedReply = {};
  const recent = Array.isArray(opts.recent) ? opts.recent : [];
  const recentK = recent.map((r) => ({ kind: String((r && r.kind) || '').toLowerCase(), key: String((r && r.arg) || '').replace(/\s+/g, '') }));
  const seen = new Set();
  const ok = [];
  const dropped = [];
  for (const c of (Array.isArray(commands) ? commands : [])) {
    const kind = String((c && c.kind) || '').toLowerCase();
    const arg = String((c && c.arg) || '').trim();
    if (!CMD_KIND[kind]) { dropped.push({ kind, arg, why: '不认识的指令' }); continue; }
    if (!arg) { dropped.push({ kind, arg, why: '内容是空的' }); continue; }
    // 去重：同一条回复里同样的指令只说一次；同一天同样的内容也不重复（记住一件事尤其不能重复写）
    const key = kind + '\u0000' + arg.replace(/\s+/g, '');
    if (seen.has(key)) { dropped.push({ kind, arg, why: '这条回复里已经有过一样的' }); continue; }
    // 跨轮重复（《爱语》的教训：模型会每回一次消息就重复输出同一条指令，直到完全停不下来）。
    // 最近几轮里刚用过同一条 → 这一轮压掉并记账（记账进 usage.repeatBlocked，后台看得见）。
    if (recentK.some((r) => r && r.kind === kind && r.key === arg.replace(/\s+/g, ''))) {
      u.repeatBlocked = (Number(u.repeatBlocked) || 0) + 1;
      dropped.push({ kind, arg, why: '连着几轮都在用同一条指令（先压一压，免得像复读）' });
      continue;
    }
    seen.add(key);
    const rn = usedReply[kind] || 0;
    if (rn >= (perReply[kind] || 0)) { dropped.push({ kind, arg, why: '这条回复里' + CMD_KIND[kind] + '的次数到顶了' }); continue; }
    const dn = usedDay[kind] || 0;
    if (dn >= (perDay[kind] || 0)) { dropped.push({ kind, arg, why: '今天' + CMD_KIND[kind] + '已经用满了（上限 ' + (perDay[kind] || 0) + ' 次）' }); continue; }
    usedReply[kind] = rn + 1;
    usedDay[kind] = dn + 1;
    ok.push({ kind, arg });
  }
  return { ok, dropped, usage: u };
}

/** 后台展示用：把今天的用量写成一句人话 */
export function usageLine(usage, dayKey) {
  const u = (usage && usage.date === dayKey) ? (usage.used || {}) : {};
  const parts = Object.keys(CMD_KIND).map((k) => CMD_KIND[k] + ' ' + (u[k] || 0) + '/' + (PER_DAY[k] || 0));
  const rb = Number((usage && usage.date === dayKey ? usage.repeatBlocked : 0) || 0);
  return parts.join(' · ') + (rb ? ('　（今天压掉 ' + rb + ' 次连着重复的指令）') : '');
}

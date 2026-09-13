// stickers.js —— 自定义表情包库（批 E2 / A7）
//
// 你可以往库里丢表情包（图片），她聊天时会**自己挑一个发**（用 <sticker:名字>）。
// 为什么单独一个模块：表情包的"存/查/取文件"和"她怎么决定用哪个"是两件事，
// 前者是纯文件操作（好测、不出错），后者交给她自己判断（提示词里给她清单）。
//
// 目录结构：<companionDir>/stickers/ 放图片；<companionDir>/stickers.json 存索引。
import fs from 'node:fs';
import path from 'node:path';

export const MAX_STICKERS = 120;
export const MAX_STICKER_BYTES = 5 * 1024 * 1024;   // 单张 5MB（微信表情包一般远小于这个）
export const ALLOWED_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function stickersDir(dir) { return path.join(dir, 'stickers'); }
export function stickersIndexFile(dir) { return path.join(dir, 'stickers.json'); }

function readIndex(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(stickersIndexFile(dir), 'utf8'));
    return { v: 1, items: Array.isArray(raw && raw.items) ? raw.items : [] };
  } catch { return { v: 1, items: [] }; }
}

function writeIndex(dir, idx) {
  fs.mkdirSync(dir, { recursive: true });
  const f = stickersIndexFile(dir);
  const tmp = f + '.tmp-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  fs.renameSync(tmp, f);   // 原子替换：写到一半断电也不会把索引写坏
}

/** 列出全部表情包（含文件是否真的还在） */
export function listStickers(dir) {
  const idx = readIndex(dir);
  return idx.items.map((it) => ({ ...it, exists: !!it.file && fs.existsSync(path.join(stickersDir(dir), it.file)) }));
}

/**
 * 新增一个表情包。name 是她说 <sticker:名字> 时用的名字（同名会覆盖图片）。
 * 返回 { ok, item } 或 { ok:false, error }（中文原因，直接能给用户看）。
 */
export function addSticker(dir, { name, ext, data, tags }) {
  const n = String(name == null ? '' : name).trim().slice(0, 20);
  if (!n) return { ok: false, error: '名字不能为空' };
  const e = String(ext || '').toLowerCase();
  if (!ALLOWED_EXT[e]) return { ok: false, error: '只支持 png / jpg / gif / webp 这几种图片' };
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  if (!buf.length) return { ok: false, error: '图片内容是空的' };
  if (buf.length > MAX_STICKER_BYTES) return { ok: false, error: '图片太大了（单张上限 5MB，现在是 ' + (buf.length / 1024 / 1024).toFixed(1) + 'MB）' };
  const idx = readIndex(dir);
  if (idx.items.length >= MAX_STICKERS && !idx.items.some((x) => x.name === n)) {
    return { ok: false, error: '表情包最多存 ' + MAX_STICKERS + ' 个，先删掉一些再加' };
  }
  fs.mkdirSync(stickersDir(dir), { recursive: true });
  const file = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + e;
  fs.writeFileSync(path.join(stickersDir(dir), file), buf);
  const old = idx.items.find((x) => x.name === n);
  if (old) {
    // 同名覆盖：把旧图删掉，免得目录里越堆越多
    try { if (old.file && old.file !== file) fs.unlinkSync(path.join(stickersDir(dir), old.file)); } catch { /* noop */ }
    old.file = file; old.bytes = buf.length; old.addedAt = Date.now(); old.enabled = true;
    if (Array.isArray(tags)) old.tags = tags.slice(0, 6).map((t) => String(t).slice(0, 10));
  } else {
    idx.items.push({ name: n, file, bytes: buf.length, addedAt: Date.now(), enabled: true, tags: Array.isArray(tags) ? tags.slice(0, 6).map((t) => String(t).slice(0, 10)) : [] });
  }
  writeIndex(dir, idx);
  return { ok: true, item: idx.items.find((x) => x.name === n) };
}

/** 删除（连图片一起删） */
export function removeSticker(dir, name) {
  const n = String(name == null ? '' : name).trim();
  const idx = readIndex(dir);
  const i = idx.items.findIndex((x) => x.name === n);
  if (i < 0) return { ok: false, error: '没有这个表情包' };
  const it = idx.items[i];
  try { fs.unlinkSync(path.join(stickersDir(dir), it.file)); } catch { /* 文件可能已经不在了 */ }
  idx.items.splice(i, 1);
  writeIndex(dir, idx);
  return { ok: true };
}

/** 开关（她还能不能用这个） */
export function setStickerEnabled(dir, name, enabled) {
  const n = String(name == null ? '' : name).trim();
  const idx = readIndex(dir);
  const it = idx.items.find((x) => x.name === n);
  if (!it) return { ok: false, error: '没有这个表情包' };
  it.enabled = enabled !== false;
  writeIndex(dir, idx);
  return { ok: true };
}

/** 按名字取图片内容（她要发的时候用）；取不到返回 null */
export function readSticker(dir, name) {
  const n = String(name == null ? '' : name).trim();
  const idx = readIndex(dir);
  const it = idx.items.find((x) => x.name === n && x.enabled !== false);
  if (!it || !it.file) return null;
  const p = path.join(stickersDir(dir), it.file);
  try {
    const data = fs.readFileSync(p);
    return { name: it.name, data, ext: path.extname(it.file).toLowerCase(), mime: ALLOWED_EXT[path.extname(it.file).toLowerCase()] || 'image/png' };
  } catch { return null; }
}

/** 名字模糊匹配：她说"晚安猫"、库里叫"晚安猫咪"也能对上（模型不一定记得准） */
export function matchStickerName(dir, wanted) {
  const w = String(wanted == null ? '' : wanted).replace(/\s+/g, '').trim();
  if (!w) return null;
  const list = listStickers(dir).filter((x) => x.enabled !== false && x.exists);
  if (!list.length) return null;
  const exact = list.find((x) => x.name === w);
  if (exact) return exact.name;
  const contains = list.find((x) => x.name.includes(w) || w.includes(x.name));
  if (contains) return contains.name;
  // 退一步：按字重合度找个最像的（宁可发个相近的，也别让她"想发表情包却发不出去"）
  let best = null; let bestScore = 0;
  for (const x of list) {
    const a = new Set(x.name); let hit = 0;
    for (const ch of w) if (a.has(ch)) hit++;
    const score = hit / Math.max(1, Math.max(a.size, w.length));
    if (score > bestScore) { bestScore = score; best = x.name; }
  }
  return bestScore >= 0.5 ? best : null;
}

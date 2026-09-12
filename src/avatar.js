// avatar.js — 形象工坊 + 相册（她的样子与她的照片）
// 分工：①形象档案（多角度定稿图 + 外貌文字）→ 给生图当"底图"，保证长相一致
//      ②生图：图生图（拿定稿图当底图，最像她）/ 文生图（用外貌文字兜底）
//      ③相册：生成的图落盘 + 索引，可发到微信（发图能力已实测可用）
// 所有文件都放在数据目录（avatar/ 与 album/），后台用 /panel/avatar/file、/panel/album/file 读图。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { editImage } from './model-router.js';

const MAX_REF_BYTES = 8 * 1024 * 1024;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const ANGLES = ['正面', '左侧脸', '右侧脸', '45度', '全身', '半身', '表情', '其他'];

const rid = () => crypto.randomBytes(5).toString('hex');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/** 旧版五项外貌 → 一段自然语言（只在没有新描述时兜底，不让老数据白填） */
export function legacyAppearanceText(ap = {}) {
  const L = { face: '长相', hair: '发型发色', style: '穿衣', body: '身材', vibe: '气质' };
  const bits = Object.keys(L).filter((k) => ap[k]).map((k) => L[k] + '：' + String(ap[k]).slice(0, 60));
  return bits.length ? bits.join('；') + '。' : '';
}
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + Date.now(); fs.writeFileSync(t, JSON.stringify(v, null, 2), 'utf8'); fs.renameSync(t, f); };

export class AvatarWorkshop {
  constructor({ dir, routerGet, soul, cfgGet, logger } = {}) {
    this.dir = dir || '.';
    this.routerGet = typeof routerGet === 'function' ? routerGet : () => (routerGet || {});
    this.soul = soul || null;
    this.cfgGet = typeof cfgGet === 'function' ? cfgGet : () => ({});
    this.log = logger || (() => {});
    this.avatarDir = path.join(this.dir, 'avatar');
    this.albumDir = path.join(this.dir, 'album');
    this.indexFile = path.join(this.albumDir, 'index.json');
    fs.mkdirSync(this.avatarDir, { recursive: true });
    fs.mkdirSync(this.albumDir, { recursive: true });
  }

  /* ── 形象档案 ── */

  refs() {
    const p = this.soul ? this.soul.getPersona() : {};
    const list = Array.isArray(((p.profile || {}).avatarRefs)) ? p.profile.avatarRefs : [];
    return list.filter((r) => r && r.id && fs.existsSync(path.join(this.avatarDir, r.file || '')));
  }
  main() {
    const p = this.soul ? this.soul.getPersona() : {};
    const mid = ((p.profile || {}).avatarMain) || '';
    const list = this.refs();
    return list.find((r) => r.id === mid) || list[0] || null;
  }
  /** 某张定稿图的绝对路径（给 HTTP 层用，避免在处理函数里碰 path 模块） */
  refFile(recOrId) {
    const rec = typeof recOrId === 'string' ? this.refs().find((r) => r.id === recOrId) : recOrId;
    if (!rec || !rec.file) throw new Error('找不到这张定稿图');
    return path.join(this.avatarDir, rec.file);
  }

  /** 外貌档案：现在是一段描述（旧版五项自动合并进来，不让老数据丢） */
  appearanceText() {
    const p = this.soul ? this.soul.getPersona() : {};
    const prof = p.profile || {};
    if (prof.appearanceText && String(prof.appearanceText).trim()) return String(prof.appearanceText).trim();
    return legacyAppearanceText(prof.appearance || {});
  }

  /** 旧版五项 → 一段话（只在没有新描述时用） */
  appearanceLegacy() {
    const p = this.soul ? this.soul.getPersona() : {};
    return (p.profile || {}).appearance || {};
  }

  /** 保存一段描述（手改时把"自动生成的那版"留个底，随时能恢复） */
  saveAppearanceText(text, extra = {}) {
    const p = this.soul.getPersona();
    const prof = p.profile || {};
    const prev = prof.appearanceText || '';
    const next = String(text || '').slice(0, 800);
    this.soul.savePersona({ profile: { ...prof, appearanceText: next, appearancePrev: prev, appearanceFrom: extra.from || prof.appearanceFrom || null, appearanceAt: Date.now() } });
    return next;
  }

  /**
   * 看定稿图 → 生成一段外貌描述（用「识图」槽位；没配就明确报错，不静默失败）
   * 这就是用户要的"根据形象工坊上传的照片自动改变"。
   */
  async describeAppearance({ refId } = {}) {
    const p = this.soul ? this.soul.getPersona() : {};
    const rec = refId ? this.refs().find((r) => r.id === refId) : this.main();
    if (!rec) throw new Error('还没有形象定稿图：先去「女娲 → 形象工坊」上传她的照片');
    const v = (this.cfgGet() || {}).vision || {};
    const chat = (this.cfgGet() || {}).chat || {};
    const baseURL = v.baseURL || chat.baseURL, apiKey = v.apiKey || chat.apiKey, model = v.model;
    if (!baseURL || !model) throw new Error('识图接口没配好：去「大脑 → ⑤ 识图 VLM」填模型名（留空 Key 沿用对话接口），点「测连通」确认');
    const buf = fs.readFileSync(this.refFile(rec));
    const { ModelRouter } = await import('./model-router.js');
    const mr = new ModelRouter({ vision: { baseURL, apiKey, model } });
    const text = await mr.visionDescribe({
      imageData: buf, mime: rec.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
      prompt: '用一个自然段描述这个人的外貌（供 AI 以后保持长相一致用）：长相特征、发型发色、大致年龄感、穿衣风格、气质。'
        + '只描述看得见的，不要编造身份；80~150 字，中文，不要分点、不要小标题。',
    });
    const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 800);
    if (!clean) throw new Error('识图模型没有返回内容');
    this.saveAppearanceText(clean, { from: { refId: rec.id, angle: rec.angle, file: rec.file, at: Date.now() } });
    this.log('[avatar] 按定稿图（' + rec.angle + '）生成外貌描述 ' + clean.length + ' 字');
    return { text: clean, from: { refId: rec.id, angle: rec.angle, at: Date.now() } };
  }

  appearance() {
    const p = this.soul ? this.soul.getPersona() : {};
    return (p.profile || {}).appearance || {};
  }
  /** 外貌档案 → 生图提示词（文生图兜底用；图生图靠底图，不用这段） */
  appearancePrompt(persona) {
    const desc = this.appearanceText();
    const name = String(((persona || {}).relationship || {}).ownerCallsMe || (persona || {}).name || '');
    return [
      '照片里的人是一位年轻女生' + (name ? '（她叫' + name + '）' : ''),
      desc,
      '写实自然的生活照风格，手机随手拍，真实光线，不精修、不海报感，不要多人',
    ].filter(Boolean).join('。');
  }

  /** 上传一张定稿图（base64） */
  addRef({ dataBase64, mime, angle, name } = {}) {
    const mt = String(mime || 'image/png').toLowerCase();
    const ext = EXT_BY_MIME[mt];
    if (!ext) throw new Error('只支持 PNG / JPG / WebP / GIF 图片（收到 ' + mt + '）');
    const buf = Buffer.from(String(dataBase64 || ''), 'base64');
    if (!buf.length) throw new Error('图片内容为空');
    if (buf.length > MAX_REF_BYTES) throw new Error('图片太大（' + Math.round(buf.length / 1024 / 1024) + 'MB），请压到 8MB 以内');
    const id = rid();
    const file = id + '.' + ext;
    fs.writeFileSync(path.join(this.avatarDir, file), buf);
    const p = this.soul.getPersona();
    const list = Array.isArray(((p.profile || {}).avatarRefs)) ? p.profile.avatarRefs.slice() : [];
    const rec = { id, file, angle: String(angle || '其他').slice(0, 10), name: String(name || '').slice(0, 40), addedAt: Date.now(), bytes: buf.length };
    list.push(rec);
    this.soul.savePersona({ profile: { ...(p.profile || {}), avatarRefs: list, avatarMain: (p.profile || {}).avatarMain || id } });
    this.log('[avatar] 新增形象定稿图 ' + rec.angle + ' ' + Math.round(buf.length / 1024) + 'KB');
    return rec;
  }
  setMain(id) {
    const list = this.refs();
    if (!list.some((r) => r.id === id)) throw new Error('找不到这张图');
    const p = this.soul.getPersona();
    this.soul.savePersona({ profile: { ...(p.profile || {}), avatarMain: id } });
    return true;
  }
  removeRef(id) {
    const p = this.soul.getPersona();
    const prof = p.profile || {};
    const list = (Array.isArray(prof.avatarRefs) ? prof.avatarRefs : []).filter((r) => r.id !== id);
    const gone = (Array.isArray(prof.avatarRefs) ? prof.avatarRefs : []).find((r) => r.id === id);
    if (gone && gone.file) { try { fs.unlinkSync(path.join(this.avatarDir, gone.file)); } catch {} }
    const main = prof.avatarMain === id ? (list[0] ? list[0].id : '') : prof.avatarMain;
    this.soul.savePersona({ profile: { ...prof, avatarRefs: list, avatarMain: main } });
    return list;
  }

  /* ── 相册 ── */

  album() { return readJson(this.indexFile, { items: [] }).items || []; }
  _saveAlbum(items) { writeJson(this.indexFile, { items: items.slice(-200) }); }
  albumFile(rec) { return path.join(this.albumDir, rec.file); }

  _pushAlbum(rec) {
    const items = this.album();
    items.push(rec);
    this._saveAlbum(items);
    return rec;
  }
  removeAlbum(id) {
    const items = this.album();
    const gone = items.find((x) => x.id === id);
    if (gone) { try { fs.unlinkSync(this.albumFile(gone)); } catch {} }
    this._saveAlbum(items.filter((x) => x.id !== id));
    return true;
  }
  markSent(id) {
    const items = this.album();
    const it = items.find((x) => x.id === id);
    if (it) { it.sentAt = Date.now(); this._saveAlbum(items); }
    return it || null;
  }

  /**
   * 生成一张"她的生活照"。
   * mode='i2i'：拿定稿图当底图走 /images/edits（长相最一致，推荐）
   * mode='t2i'：纯文字（接口不支持图生图时用；没有定稿图时自动降级到这个）
   */
  async generate({ scene, mode = 'i2i', size = '1024x1024' } = {}) {
    const persona = this.soul ? this.soul.getPersona() : {};
    const img = (this.cfgGet() || {}).image || {};
    if (!img.baseURL || !img.model) {
      throw new Error('生图接口没配好：去「大脑 → ② 生图接口」填 BaseURL + 模型名（留空 Key 会沿用对话接口），点「测连通」确认，再回来生成');
    }
    const theme = String(scene || '').trim().slice(0, 120);
    const styleLine = '生活感手机随手拍风格照片，真实自然光，日常构图，不要精修海报感；画面里的女生和参考图是同一个人';
    const prompt = [theme || '她此刻的日常随手拍', styleLine, this.appearancePrompt(persona)].filter(Boolean).join('。');
    const main = this.main();
    const useI2i = mode === 'i2i' && main;
    const t0 = Date.now();
    let out = null;
    let usedMode = useI2i ? 'i2i' : 't2i';
    if (useI2i) {
      const buf = fs.readFileSync(path.join(this.avatarDir, main.file));
      out = await editImage({ baseURL: img.baseURL, apiKey: img.apiKey, model: img.model, prompt, image: buf, filename: main.file, size });
    } else {
      out = await this.routerGet().image(prompt, { n: 1, size });
    }
    const first = Array.isArray(out) ? out[0] : out;
    if (!first) throw new Error('生图接口返回为空');
    let data = null;
    if (first.b64) data = Buffer.from(first.b64, 'base64');
    else if (first.url) {
      const r = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('下载生成的图片失败：HTTP ' + r.status);
      data = Buffer.from(await r.arrayBuffer());
    }
    if (!data || !data.length) throw new Error('生图接口既没给图片数据也没给可下载的地址');
    const id = rid();
    const file = id + '.png';
    fs.writeFileSync(path.join(this.albumDir, file), data);
    const rec = { id, file, scene: theme, mode: usedMode, createdAt: Date.now(), bytes: data.length, ms: Date.now() - t0 };
    this._pushAlbum(rec);
    this.log('[avatar] 生成生活照 ' + usedMode + ' ' + Math.round(data.length / 1024) + 'KB ' + rec.ms + 'ms');
    return rec;
  }
}

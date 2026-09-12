// moments.js — 朋友圈工坊
// 她"生产"朋友圈：文案（对话模型，带人设+近期记忆）+ 配图（生图模型）。
// v1 发布方式：半自动——草稿在面板复制/取图，由主人从她的手机亲手发出（零封号风险）。
// v2 实验：视觉驱动 PC 自动发布（取决于微信版本适配，默认关闭）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function rid() { return crypto.randomBytes(5).toString('hex'); }

export class MomentsWorkshop {
  constructor(options = {}) {
    this.dir = options.dir || '.';
    this.routerGet = typeof options.router === 'function' ? options.router : () => options.router;
    this.soul = options.soul || null;
    this.cfgGet = typeof options.config === 'function' ? options.config : () => (options.config || {});
    this.log = options.logger || (() => {});
    this._dir = path.join(this.dir, 'moments');
    fs.mkdirSync(this._dir, { recursive: true });
  }

  get router() { return this.routerGet(); }

  /** 她从世界剧本里带过来的"今天的分寸"（朋友圈也不能越界：不能刚认识就发"想他"） */
  _toneLine() {
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(this.dir, 'world-state.json'), 'utf8'));
      const t = ws && ws.tone;
      if (!t) return '';
      return '- 你和看这条圈的人的关系分寸：熟度约 ' + (t.intimacy == null ? 10 : t.intimacy) + '/100，称呼：' + (t.address || '按关系来')
        + '；语气：' + (t.style || '自然') + ((t.forbid && t.forbid.length) ? ('；不要出现：' + t.forbid.join('、')) : '')
        + '。朋友圈是按关系分寸发的——关系浅就别写得像恋人。';
    } catch { return ''; }
  }

  /** 职业偏向：这条圈有多大概率聊工作（强度 × 发起力决定；只影响提示词，不改她的底色） */
  _jobLine(persona) {
    const job = (this.cfgGet() || {}).job || {};
    if (job.enabled === false) return '';
    const type = job.type || persona.jobType || 'none';
    if (!persona.job || type === 'none') return '';
    const inten = typeof job.intensity === 'number' ? job.intensity : 1;
    const initiative = (persona.traits || {}).initiative == null ? 50 : persona.traits.initiative;
    const chance = Math.round(Math.max(0.1, Math.min(0.9, inten * 0.55 * (0.6 + initiative / 125))) * 100);
    return '- 你的职业是' + persona.job + '：这条圈约 ' + chance + '% 的概率会聊到工作上的事（赶稿/客户/同事/通宵…）；'
      + (chance >= 45 ? '这次优先考虑工作相关的话题。' : '但别每条都聊工作，生活更要紧。');
  }

  draftsFile() { return path.join(this._dir, 'drafts.json'); }

  list() {
    try { return JSON.parse(fs.readFileSync(this.draftsFile(), 'utf8')).drafts || []; } catch { return []; }
  }

  _save(drafts) {
    const tmp = this.draftsFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ drafts }, null, 2), 'utf8');
    fs.renameSync(tmp, this.draftsFile());
  }

  /** 生成一条朋友圈草稿：文案 + 0~1 张配图 */
  async generate(options = {}) {
    const persona = this.soul ? this.soul.getPersona() : {};
    const memories = this.soul ? await this.soul._retrieveHybrid(options.theme || '今天过得怎么样', 'owner') : [];
    const memLines = memories.map((m) => '- ' + m.text).join('\n');
    const now = new Date();
    const timeDesc = now.getHours() + '点' + (now.getMinutes() < 10 ? '0' : '') + now.getMinutes() + '分';

    // ① 文案
    const sys = [
      '你是' + String(((persona.relationship || {}).ownerCallsMe) || persona.name || '一个真实的女生') + '。',
      '你要发一条微信朋友圈。要求：',
      '- 像真人随手发的：口语、有烟火气、可以不完整、可以带一两个emoji',
      '- 1~3句话，绝对不要小作文、不要标题党',
      '- 内容结合：你的性格兴趣、最近的生活、此刻时间（现在约' + timeDesc + '）',
      memLines ? '- 你最近记得的事（可以自然呼应，不要罗列）：\n' + memLines : '',
      this._jobLine(persona),
      this._toneLine(),
      options.theme ? '- 灵感方向：' + options.theme : '',
      '- 直接输出文案本身，不要引号、不要解释、不要话题标签堆砌',
    ].filter(Boolean).join('\n');
    const chatRes = await this.router.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: '（系统指令：输出这条朋友圈文案。）' }],
      { maxTokens: 150 }
    );
    const text = String(chatRes.content || '').trim().replace(/^["'「]|["'」]$/g, '').slice(0, 600);

    // ② 配图（生图角色；失败不影响文案）
    const images = [];
    try {
      const appearance = (persona.personaText || '').slice(0, 120);
      const prompt = [
        '生活感手机随手拍风格照片，真实自然光，日常构图，不要精修海报感。',
        '主题：' + (options.imageTheme || text.slice(0, 60)),
        appearance ? '画面中是同一个年轻女生的日常视角' : '',
      ].filter(Boolean).join('。');
      const imgs = await this.router.image(prompt, { n: 1 });
      for (let i = 0; i < imgs.length; i++) {
        const name = rid() + '-' + i + '.jpg';
        const file = path.join(this._dir, name);
        if (imgs[i].url) {
          const res = await fetch(imgs[i].url);
          if (res.ok) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        } else if (imgs[i].b64) {
          fs.writeFileSync(file, Buffer.from(imgs[i].b64, 'base64'));
        }
        if (fs.existsSync(file) && fs.statSync(file).size > 0) images.push(file);
      }
    } catch (err) {
      this.log('[moments] 配图失败（文案保留）: ' + (err && err.message));
    }

    const draft = {
      id: rid(),
      text,
      images,
      status: 'draft',
      createdAt: Date.now(),
      backend: chatRes.backend || '',
    };
    const drafts = this.list();
    drafts.unshift(draft);
    while (drafts.length > 50) drafts.pop();
    this._save(drafts);
    return draft;
  }

  deleteDraft(id) {
    for (const d of this.list()) {
      if (d.id === id) for (const img of d.images || []) { try { fs.unlinkSync(img); } catch {} }
    }
    this._save(this.list().filter((d) => d.id !== id));
  }

  markPosted(id) {
    const drafts = this.list();
    const hit = drafts.find((d) => d.id === id);
    if (!hit) throw new Error('草稿不存在: ' + id);
    hit.status = 'posted';
    hit.postedAt = Date.now();
    this._save(drafts);
    return hit;
  }
}

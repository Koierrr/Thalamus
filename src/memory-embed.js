// memory-embed.js — 她的"想起来"引擎（本地语义检索）
// 用本机 Ollama 的嵌入模型（默认 bge-m3）给记忆算向量，检索时按语义相似度加权。
// 向量只存在本机 dataDir，绝不外发。Ollama 不可用时自动降级（调用方回退关键词检索）。

import fs from 'node:fs';
import path from 'node:path';

function round5(x) { return Math.round(x * 100000) / 100000; }

export class MemoryEmbed {
  constructor(options = {}) {
    this.dir = options.dir || '.';
    this.url = String(options.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = options.embedModel || 'bge-m3';
    this.log = options.logger || (() => {});
    this._file = path.join(this.dir, 'memory-vectors.json');
    this._store = null;
    this._warmed = false;
    this._external = options.embedFn || null; // 注入外部向量函数（云端API模式）
  }

  _load() {
    if (!this._store) {
      try { this._store = JSON.parse(fs.readFileSync(this._file, 'utf8')); } catch { this._store = { model: this.model, vectors: {} }; }
      if (this._store.model !== this.model) this._store = { model: this.model, vectors: {} };
    }
    return this._store;
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this._file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._store), 'utf8');
    fs.renameSync(tmp, this._file);
  }

  async embed(text) {
    if (this._external) return this._external(text);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('embed timeout')), 30000);
    try {
      const res = await fetch(this.url + '/api/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: String(text || '').slice(0, 2000) }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('embed HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data.embedding) || !data.embedding.length) throw new Error('embed 空返回');
      return data.embedding;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 给没有向量的记忆补向量（每次最多 cap 条，避免阻塞） */
  async ensureVectors(entries, cap = 20) {
    const store = this._load();
    let dirty = false;
    let n = 0;
    for (const e of entries) {
      if (n >= cap) break;
      if (!e || !e.id || store.vectors[e.id]) continue;
      try {
        store.vectors[e.id] = (await this.embed(e.text)).map(round5);
        dirty = true; n += 1;
      } catch (err) {
        this.log('[embed] 向量化失败: ' + (err && err.message));
        break;
      }
    }
    if (dirty) this._save();
    return n;
  }

  async sweep(entries) { return this.ensureVectors(entries, 50); }

  /** 余弦相似度：返回 Map(entryId → 0~1) */
  async search(queryVec, entries) {
    const store = this._load();
    const map = new Map();
    for (const e of entries) {
      const v = store.vectors[e.id];
      if (!v || v.length !== queryVec.length) continue;
      let dot = 0; let na = 0; let nb = 0;
      for (let i = 0; i < v.length; i++) { dot += v[i] * queryVec[i]; na += v[i] * v[i]; nb += queryVec[i] * queryVec[i]; }
      map.set(e.id, (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0);
    }
    return map;
  }

  /** 开机预热：把模型先拉进内存，第一条真消息就不用等冷加载 */
  async warmup() {
    if (this._warmed) return;
    this._warmed = true;
    try { await this.embed('你好'); this.log('[embed] 语义记忆引擎预热完成'); } catch (err) { this._warmed = false; this.log('[embed] 预热失败（不影响聊天）: ' + (err && err.message)); }
  }
}

// memory-client.js — mem0 记忆引擎 sidecar 客户端（127.0.0.1:43122）
// 原则：sidecar 挂了绝不炸主服务。所有请求带超时，失败抛错，
// 由 soul/index 捕获后自动降级回本地 JSON 记忆引擎。
// sidecar 本体：python/memory_service.py（mem0 本地模式：faiss 向量 + bge-m3 嵌入 + 云端便宜模型提炼）

export class MemoryClient {
  /** getUrl: () => 'http://127.0.0.1:43122' （热读配置） */
  constructor(getUrl) {
    this._getUrl = typeof getUrl === 'function' ? getUrl : () => getUrl;
  }

  get base() {
    return String(this._getUrl() || 'http://127.0.0.1:43122').replace(/\/+$/, '');
  }

  async _req(method, p, body, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await fetch(this.base + p, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = {};
      try { data = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error('sidecar 返回非 JSON: ' + text.slice(0, 120)); }
      if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 引擎健康检查：活着返回信息对象，挂了返回 null（不抛错） */
  async health() {
    try { return await this._req('GET', '/health', null, 4000); } catch { return null; }
  }

  /** 记忆条目入库（infer=true 时 mem0 自动提炼去重；false=原样入库） */
  add({ text, who, metadata, infer = false }) {
    return this._req('POST', '/add', { text: String(text || ''), user_id: String(who || 'global'), metadata: metadata || {}, infer: !!infer }, 60000);
  }

  /** 对话记忆提炼：把一段对话丢给 mem0，由它的 LLM 提炼值得记的事并自动去重合并 */
  extractAndStore({ dialogue, who, isOwner }) {
    return this._req('POST', '/extract', { dialogue: String(dialogue || ''), user_id: String(who || 'global'), isOwner: !!isOwner }, 90000);
  }

  /** 检索：mem0 向量+关键词混合，返回 [{ id, text, score, ts, ... }] */
  search({ query, who, topK = 6 }) {
    return this._req('POST', '/search', { query: String(query || '').slice(0, 500), user_id: String(who || 'global'), limit: Number(topK) || 6 }, 20000);
  }

  /** 全量列表（后台记忆页用），who 省略=全部联系人 */
  list(who) {
    const q = who ? ('?user_id=' + encodeURIComponent(who)) : '';
    return this._req('GET', '/list' + q, null, 20000);
  }

  update(id, patch) {
    return this._req('POST', '/update', { id: String(id || ''), data: patch || {} }, 30000);
  }

  remove(id) {
    return this._req('POST', '/delete', { id: String(id || '') }, 30000);
  }

  /** 一次性迁移旧 JSON 记忆：entries=[{text,who,importance,tags,pinned,ts}] */
  migrate(entries) {
    return this._req('POST', '/migrate', { entries: Array.isArray(entries) ? entries.slice(0, 5000) : [] }, 300000);
  }
}

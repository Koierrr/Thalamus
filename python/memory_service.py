# -*- coding: utf-8 -*-
# memory_service.py — 她的记忆引擎 sidecar（mem0 本地模式）
# 端口 127.0.0.1:43122
#   向量库: faiss（本地文件）  嵌入: bge-m3（本地 Ollama）  提炼: 云端便宜模型（OpenAI 兼容）
# 设计原则：mem0 负责提炼(什么值得记)、去重合并、向量检索；插件侧引擎挂了自动降级本地JSON。
# 配置文件查找顺序：环境变量 MEMORY_SERVICE_CONFIG → 脚本同目录 memory-service.json
# 由插件自动写入配置并拉起；也可用 启动记忆引擎.bat 手动启动（看得见日志）。

import json
import os
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 43122

_lock = threading.RLock()
_state = {'memory': None, 'error': None, 'cfg': None}


def _config_file():
    home_cfg = os.path.join(os.path.expanduser('~'), '.dsh', 'wechat-companion', 'memory-service.json')
    for p in (os.environ.get('MEMORY_SERVICE_CONFIG'), os.path.join(HERE, 'memory-service.json'), home_cfg):
        if p and os.path.exists(p):
            return p
    return None


def load_config():
    p = _config_file()
    if not p:
        return {}
    try:
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


# 配置自愈：mtime 变了就自动重载（修掉"引擎先于配置启动"的永久缓存错误）
_cfg_state = {'mtime': None}


def _users_file():
    cfg = load_config()
    store = cfg.get('store_path') or os.path.join(HERE, 'mem0-store')
    return os.path.join(store, 'users.json')


def list_users():
    try:
        with open(_users_file(), 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return []


def remember_user(u):
    try:
        if not u:
            return
        us = list_users()
        if u not in us:
            us.append(u)
            os.makedirs(os.path.dirname(_users_file()), exist_ok=True)
            with open(_users_file(), 'w', encoding='utf-8') as f:
                json.dump(us, f, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        pass


def _embed_dims_guard(store, dims):
    """向量维度护栏（2026-09-13 加）。

    为什么需要：faiss 的集合是按固定维度建的。换了嵌入模型但维度不一样时，
    mem0 不会说人话，只会抛一堆底层报错，表现出来就是"记忆时好时坏"。
    这里把第一次建库时的维度记在库里，之后每次启动都对比；不一致就直接拒绝启动并说清楚怎么办。
    """
    marker = os.path.join(store, 'embed-dims.json')
    prev = None
    try:
        with open(marker, 'r', encoding='utf-8') as f:
            prev = int((json.load(f) or {}).get('dims') or 0) or None
    except Exception:  # noqa: BLE001
        prev = None
    if prev is None:
        try:
            with open(marker, 'w', encoding='utf-8') as f:
                json.dump({'dims': int(dims), 'at': time.strftime('%Y-%m-%d %H:%M:%S')}, f, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            pass
        return
    if int(prev) != int(dims):
        raise RuntimeError(
            '向量维度变了：记忆库是按 %d 维建的，现在配置的是 %d 维。'
            '①把「大脑 → ⑥ 向量接口」换回原来的嵌入模型（或把维度改回 %d）；'
            '②确实想换：去后台「记忆 → 提炼设置 → 一键重置」勾上"清空她的记忆"重建记忆库。'
            % (int(prev), int(dims), int(prev))
        )


def build_memory(cfg, llm_override=None):
    from mem0 import Memory
    llm = llm_override or (cfg.get('llm') or {})
    emb = cfg.get('embedder') or {}
    store = cfg.get('store_path') or os.path.join(HERE, 'mem0-store')
    os.makedirs(store, exist_ok=True)
    model = llm.get('model') or ''
    if not model:
        raise RuntimeError('未配置提炼模型（后台→设置→记忆 里填写，或先填好主对话模型）')
    # 向量服务：provider 由后台「向量接口」的地址决定（本地=ollama / 云端=openai 兼容）
    emb_provider = str(emb.get('provider') or 'ollama').strip().lower()
    emb_dims = int(emb.get('embedding_dims') or 1024)
    if emb_provider not in ('ollama', 'openai'):
        emb_provider = 'ollama'
    emb_model = emb.get('model') or 'bge-m3'
    _embed_dims_guard(store, emb_dims)
    if emb_provider == 'openai':
        emb_conf = {
            'model': emb_model,
            'openai_base_url': emb.get('openai_base_url') or 'https://api.siliconflow.cn/v1',
            'api_key': emb.get('api_key') or '',
            'embedding_dims': emb_dims,
        }
    else:
        emb_conf = {
            'model': emb_model,
            'ollama_base_url': emb.get('ollama_base_url') or 'http://127.0.0.1:11434',
            'embedding_dims': emb_dims,
        }
    config = {
        'telemetry': False,  # 她的记忆不出门：关掉 mem0 内置遥测
        'llm': {
            'provider': 'openai',
            'config': {
                'model': model,
                'openai_base_url': llm.get('base_url') or 'https://api.siliconflow.cn/v1',
                'api_key': llm.get('api_key') or '',
                'temperature': 0.1,
                'max_tokens': 1000,
            },
        },
        'embedder': {
            'provider': emb_provider,
            'config': emb_conf,
        },
        'vector_store': {
            'provider': 'faiss',
            'config': {'path': store, 'collection_name': 'her_memory', 'embedding_model_dims': emb_dims},
        },
        'history_db_path': os.path.join(store, 'history.db'),
        # 事实抽取提示词（2026-09-12 改成她的第一人称）：
        # 用户反馈"记忆条目不是她的第一视角、非常人机"——原来抽出来的是「主人不吃香菜」这种报告体，
        # 现在要求像她自己随手记的：「他不吃香菜」「我下周想去趟杭州」。
        'custom_fact_extraction_prompt': (
            '你是她（这个女生本人）的记事本。读下面的对话，挑出值得她长期记住的事，'
            '用她自己的第一人称写下来，像她随手在备忘录里记的一条，而不是系统日志。'
            '规则：①关于对方用「他」或他的名字，绝对不要用「主人」「用户」「对方」这类报告词；'
            '②关于她自己用「我」；③口语、短句（8~25 字）；④只写事实，不写「谈话中提及」「用户表示」这类套话。'
            '正例：他不吃香菜 / 他下周三要出差去成都 / 我最喜欢下雨天。'
            '反例：主人不吃香菜 / 用户表示下周出差 / 她喜欢雨天。'
            '不要记日常寒暄；约定、偏好、重要事件、对方提到的日程必须记。一律用中文写（只有原话本身是英文时才保留英文）。'
            '以 JSON 返回：{{"facts": ["一句话记忆（第一人称）", ...]}}'
        ),
    }
    return Memory.from_config(config)


def _llm_candidates(cfg):
    """主力 + 回落链（后台五个接口各留三个回落槽）：返回 [llm配置, ...]，按顺序试"""
    base = dict(cfg.get('llm') or {})
    out = [base]
    for fb in (base.get('fallbacks') or []):
        if isinstance(fb, dict) and fb.get('base_url') and fb.get('model'):
            out.append({'base_url': fb.get('base_url'), 'api_key': fb.get('api_key') or '', 'model': fb.get('model')})
    return out


def memory_with_fallback(cfg, idx):
    """取第 idx 个候选取用的 Memory 实例（0=主力，>0=回落；不改全局状态）"""
    cands = _llm_candidates(cfg)
    if idx == 0 or idx >= len(cands):
        return None
    return build_memory({**cfg, 'llm': cands[idx]})


def get_memory(force_reload=False):
    with _lock:
        if force_reload:
            _state['memory'] = None
            _state['error'] = None
        if _state['memory'] is None and _state['error'] is None:
            try:
                _state['cfg'] = load_config()
                _state['memory'] = build_memory(_state['cfg'])
            except Exception as e:  # noqa: BLE001
                _state['error'] = str(e)
        return _state['memory'], _state['error'], _state['cfg'] or {}


def parse_ts(v):
    if not v:
        return None
    if isinstance(v, (int, float)):
        return int(v if v > 1e11 else v * 1000)
    try:
        return int(datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp() * 1000)
    except Exception:  # noqa: BLE001
        return None


def norm_results(raw):
    # mem0 v1.x 返回 list，v2.x 返回 {'results': [...]}——两种都吃
    if isinstance(raw, dict):
        raw = raw.get('results') or []
    out = []
    for e in raw or []:
        if not isinstance(e, dict):
            continue
        meta = e.get('metadata') or {}
        out.append({
            'id': e.get('id') or e.get('uuid') or '',
            'text': e.get('memory') or e.get('data') or '',
            'score': e.get('score'),
            'who': e.get('user_id') or meta.get('user_id') or 'global',
            'ts': parse_ts(e.get('created_at')) or parse_ts(meta.get('ts')) or int(datetime.now().timestamp() * 1000),
            'metadata': meta,
        })
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003
        sys.stdout.write('[mem] ' + (fmt % args) + '\n')

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(n) if n else b'{}'
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:  # noqa: BLE001
            return {}

    def do_GET(self):  # noqa: N802
        path = self.path.split('?')[0]
        if path == '/health':
            try:
                p = _config_file()
                try:
                    mt = os.path.getmtime(p) if p else None
                except Exception:  # noqa: BLE001
                    mt = None
                if mt != _cfg_state['mtime']:
                    _cfg_state['mtime'] = mt
                    m, err, cfg = get_memory(force_reload=True)
                else:
                    m, err, cfg = get_memory()
                if m is None:
                    # 进程活着但还不能用：明说缺什么，而不是假装没在运行
                    return self._send(200, {'ok': True, 'ready': False, 'reason': err or '未知原因'})
                llm = (cfg.get('llm') or {})
                emb = (cfg.get('embedder') or {})
                # 把"实际在用的向量服务"如实报出去（2026-09-13）：后台据此显示，避免"设置与行为对不上"
                ep = str(emb.get('provider') or 'ollama').lower()
                return self._send(200, {
                    'ok': True, 'ready': True, 'engine': 'mem0', 'vector': 'faiss',
                    'embedder': emb.get('model') or 'bge-m3',
                    'embedder_provider': ep,
                    'embedder_url': (emb.get('openai_base_url') if ep == 'openai' else emb.get('ollama_base_url')) or '',
                    'embedder_dims': int(emb.get('embedding_dims') or 1024),
                    'llm': llm.get('model') or '',
                })
            except Exception as e:  # noqa: BLE001
                return self._send(200, {'ok': True, 'ready': False, 'reason': str(e)})
        if path == '/list':
            try:
                m, err, _ = get_memory()
                if m is None:
                    return self._send(500, {'ok': False, 'error': err})
                who = self.path.split('user_id=')[1] if 'user_id=' in self.path else ''
                who = who.split('&')[0]
                from urllib.parse import unquote
                who = unquote(who) if who else ''
                out = []
                if who:
                    with _lock:
                        raw = m.get_all(filters={'user_id': who})
                    out = norm_results(raw)
                else:
                    # mem0 2.0.20 的 get_all 必须带 filters → 遍历已知用户
                    for u in (['global'] + [x for x in list_users() if x != 'global']):
                        try:
                            with _lock:
                                raw = m.get_all(filters={'user_id': u})
                            out.extend(norm_results(raw))
                        except Exception:  # noqa: BLE001
                            pass
                seen = set()
                uniq = []
                for e in out:
                    if e.get('id') in seen:
                        continue
                    seen.add(e.get('id'))
                    uniq.append(e)
                return self._send(200, {'ok': True, 'entries': uniq})
            except Exception as e:  # noqa: BLE001
                return self._send(500, {'ok': False, 'error': str(e)})
        return self._send(404, {'ok': False, 'error': 'unknown endpoint'})

    def do_POST(self):  # noqa: N802
        path = self.path.split('?')[0]
        b = self._body()
        try:
            # 2026-09-13 修（关键）：这里以前是 `m, err, _ = get_memory()`，把第三个返回值 cfg 丢掉了。
            # 而 /add 的"主力失败→换回落槽"重试要用它（len(_llm_candidates(cfg))），
            # 于是**每一次写记忆都抛 NameError: name 'cfg' is not defined**：
            # 手写的记忆、她的生活流水全进不了引擎，只落在本地 JSON，后台列表永远是 0 条。
            m, err, cfg = get_memory()
            if m is None:
                return self._send(500, {'ok': False, 'error': err})
            if path == '/debug-embed':
                try:
                    import traceback
                    from urllib.parse import unquote
                    custom = unquote(self.path.split('input=')[1]) if 'input=' in self.path else 'debug'
                    m2, err2, _ = get_memory()
                    info = {'err': err2, 'input': custom[:40]}
                    try:
                        e = m2.embedding_model.embed(custom, 'add')
                        info['embed_ok'] = True
                        info['dims'] = len(e)
                    except Exception as ex:  # noqa: BLE001
                        info['embed_ok'] = False
                        info['embed_err'] = str(ex)
                        info['trace'] = traceback.format_exc()[-800:]
                    try:
                        from ollama import Client
                        c = Client(host=(load_config().get('embedder') or {}).get('ollama_base_url') or 'http://127.0.0.1:11434')
                        rr = c.embed(model='bge-m3', input=custom)
                        d = rr if isinstance(rr, dict) else (rr.model_dump() if hasattr(rr, 'model_dump') else {})
                        info['raw_keys'] = list(d.keys())
                        info['raw_has_emb'] = bool(d.get('embeddings'))
                    except Exception as ex2:  # noqa: BLE001
                        info['raw_err'] = str(ex2)
                    return self._send(200, {'ok': True, **info})
                except Exception as e3:  # noqa: BLE001
                    return self._send(500, {'ok': False, 'error': str(e3)})
            if path == '/add':
                remember_user(str(b.get('user_id') or 'global'))
                with _lock:
                    # 猴子补丁：记录 add 过程中的每一次 embed 调用（输入/结果）
                    em = m.embedding_model
                    if not getattr(em, '_logged', False):
                        _orig_embed = em.embed
                        def logged_embed(text, action='add', _o=_orig_embed):
                            try:
                                r = _o(text, action)
                                sys.stdout.write('[mem] embed OK %r dims=%s\n' % (str(text)[:60], len(r)))
                                sys.stdout.flush()
                                return r
                            except Exception as ex:
                                sys.stdout.write('[mem] embed FAIL %r err=%s\n' % (repr(text)[:120], ex))
                                sys.stdout.flush()
                                raise
                        em.embed = logged_embed
                        em._logged = True
                    raw = None
                    last_err = None
                    for _idx in range(max(1, len(_llm_candidates(cfg)))):
                        try:
                            _mm = m if _idx == 0 else memory_with_fallback(cfg, _idx)
                            if _mm is None:
                                break
                            if _idx:
                                sys.stdout.write('[mem] 主力失败，改用回落槽 #%d（%s）\n' % (_idx, (_llm_candidates(cfg)[_idx] or {}).get('model')))
                                sys.stdout.flush()
                            raw = _mm.add(
                                str(b.get('text') or ''),
                                user_id=str(b.get('user_id') or 'global'),
                                metadata=b.get('metadata') or {},
                                infer=bool(b.get('infer')),
                            )
                            last_err = None
                            break
                        except Exception as e:  # noqa: BLE001
                            last_err = e
                            import traceback
                            sys.stdout.write('[mem] /add 第 %d 槽失败: %s\n' % (_idx, str(e)[:200]))
                            sys.stdout.flush()
                    if raw is None and last_err is not None:
                        raise last_err
                rs = raw.get('results') if isinstance(raw, dict) else raw
                ids = [x.get('id') for x in (rs or []) if isinstance(x, dict) and x.get('id')]
                return self._send(200, {'ok': True, 'ids': ids, 'raw_count': len(rs or [])})
            if path == '/extract':
                dlg = str(b.get('dialogue') or '')
                if not dlg.strip():
                    return self._send(200, {'ok': True, 'facts': 0})
                msgs = []
                if '对方：' in dlg:
                    for line in dlg.splitlines():
                        line = line.strip()
                        if line.startswith('对方：'):
                            msgs.append({'role': 'user', 'content': line[3:]})
                        elif line.startswith('她：'):
                            msgs.append({'role': 'assistant', 'content': line[2:]})
                if not msgs:
                    msgs = [{'role': 'user', 'content': dlg[:2000]}]
                remember_user(str(b.get('user_id') or 'global'))
                with _lock:
                    raw = m.add(msgs, user_id=str(b.get('user_id') or 'global'), metadata={'source': 'auto'}, infer=True)
                rs = raw.get('results') if isinstance(raw, dict) else raw
                facts = [x for x in (rs or []) if isinstance(x, dict) and x.get('event') in ('ADD', 'UPDATE', 'NONE', 'NOOP', 'DELETE')]
                return self._send(200, {'ok': True, 'facts': len(facts), 'events': [x.get('event') for x in (rs or [])]})
            if path == '/search':
                with _lock:
                    raw = m.search(
                        str(b.get('query') or ''),
                        filters={'user_id': str(b.get('user_id') or 'global')},
                        limit=int(b.get('limit') or 6),
                    )
                return self._send(200, {'ok': True, 'results': norm_results(raw)})
            if path == '/update':
                data = b.get('data') or {}
                with _lock:
                    m.update(memory_id=str(b.get('id') or ''), data=str(data.get('text') or ''))
                return self._send(200, {'ok': True})
            if path == '/delete':
                with _lock:
                    m.delete(memory_id=str(b.get('id') or ''))
                return self._send(200, {'ok': True})
            if path == '/migrate':
                entries = b.get('entries') or []
                whos = []
                for e in entries:
                    w = str(e.get('who') or 'global')
                    if w not in whos:
                        whos.append(w)
                existing = set()
                for u in whos:
                    try:
                        with _lock:
                            raw = m.get_all(filters={'user_id': u})
                        for e2 in norm_results(raw):
                            existing.add((u, (e2.get('text') or '').strip().lower()))
                    except Exception:  # noqa: BLE001
                        pass
                added = 0
                skipped = 0
                for e in entries:
                    try:
                        text = str(e.get('text') or '').strip()
                        if not text:
                            continue
                        who = str(e.get('who') or 'global')
                        key = (who, text.lower())
                        if key in existing:
                            skipped += 1
                            continue
                        with _lock:
                            m.add(text, user_id=who, metadata=e.get('metadata') or {}, infer=False)
                        existing.add(key)
                        remember_user(who)
                        added += 1
                    except Exception:  # noqa: BLE001
                        pass
                return self._send(200, {'ok': True, 'added': added, 'skipped': skipped, 'total': len(entries)})
            if path == '/reload':
                get_memory(force_reload=True)
                return self._send(200, {'ok': True})
            if path == '/quit':
                # 2026-09-13 加：让插件能"重启记忆引擎"。
                # 为什么需要：插件启动时若发现引擎已在跑就直接复用（不会重启它），
                # 于是**改了 python 代码 / 改了向量配置，引擎却一直跑旧的**——上一批的
                # "向量真打通 + 维度护栏"就这么白写了。现在给一个体面的退出入口。
                self._send(200, {'ok': True, 'bye': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            return self._send(404, {'ok': False, 'error': 'unknown endpoint'})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {'ok': False, 'error': str(e)})


def main():
    print('[mem] 她的记忆引擎（mem0 sidecar）启动中，端口 ' + str(PORT) + ' ...')
    print('[mem] 首次调用会初始化 faiss + bge-m3，可能要几秒；提炼模型走云端。')
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()

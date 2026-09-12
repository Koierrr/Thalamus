# -*- coding: utf-8 -*-
# wxauto_bridge.py — wxauto 通道桥（PC 微信接管，UIA 方式）
# 端口 127.0.0.1:43123
# 原理：不注入、不碰微信内存——用 Windows UIA 接口像"无形的手"一样操作微信窗口。
# 风险定位：比 wcferry（DLL 注入，已出局）安全得多，但不是零风险；
#           防封三件套在插件侧：发送队列+拟人延迟、每日上限、总开关默认关。
#
# 依赖：pip install wxauto   （启动wxauto通道.bat 会自动装）
# 注意：微信 3.9 窗口必须保持登录且【不要最小化】（可以背着其他窗口）。
#
# 接口：
#   GET  /health                → {ok, ready, listening:[...]}
#   POST /send  {to, text}      → 让她通过微信窗口发一条消息
#   POST /listen {peers:[...]}  → 增加监听联系人（昵称/备注名，要用微信里显示的名字）
# 配置：环境变量 WXAUTO_BRIDGE_CONFIG 或脚本同目录 wxauto-bridge.json
#   { "callback": "http://127.0.0.1:43121/wechat-companion/panel/wxauto/in",
#     "peers": ["备注名1", "备注名2"] }

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 43123

_state = {
    'wx': None,            # wxauto.WeChat 实例
    'ready': False,
    'error': '',
    'peers': [],           # 正在监听的联系人名
    'callback': 'http://127.0.0.1:43121/wechat-companion/panel/wxauto/in',
}
_lock = threading.RLock()


def load_config():
    path = os.environ.get('WXAUTO_BRIDGE_CONFIG') or os.path.join(HERE, 'wxauto-bridge.json')
    for p in (path, os.path.join(HERE, 'wxauto-bridge.json')):
        if p and os.path.exists(p):
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:  # noqa: BLE001
                pass
    return {}


def ensure_wx():
    with _lock:
        if _state['wx'] is not None:
            return True
        try:
            from wxauto import WeChat
            _state['wx'] = WeChat()
            _state['ready'] = True
            _state['error'] = ''
            print('[wxauto] 已连接微信窗口 ✅（注意：窗口不要最小化）')
            return True
        except Exception as e:  # noqa: BLE001
            _state['error'] = str(e)
            _state['ready'] = False
            print('[wxauto] 连接微信失败（微信开着且登录了吗？）: ' + str(e))
            return False


def add_listeners(peers):
    with _lock:
        wx = _state['wx']
        if wx is None:
            return False
        for p in peers:
            if p and p not in _state['peers']:
                try:
                    wx.AddListenChat(who=p)
                    _state['peers'].append(p)
                    print('[wxauto] 开始监听: ' + p)
                except Exception as e:  # noqa: BLE001
                    print('[wxauto] 监听失败 ' + p + ': ' + str(e))
        return True


def listen_loop():
    cfg = load_config()
    _state['callback'] = cfg.get('callback') or _state['callback']
    peers = cfg.get('peers') or []
    # 等微信就绪后自动补监听（每30秒重试直到成功）
    while True:
        if _state['ready'] and peers:
            if add_listeners(peers):
                peers = []
        try:
            wx = _state['wx']
            if wx is not None:
                msgs = wx.GetListenMessage()
                if msgs:
                    for chat, items in (msgs.items() if hasattr(msgs, 'items') else []):
                        who = getattr(chat, 'who', '') or (chat.find('msg').get('attr') if hasattr(chat, 'find') else '')
                        for msg in (items or []):
                            try:
                                if getattr(msg, 'type', '') != 'friend':
                                    continue  # 只回对方发的，不回自己发的
                                text = str(getattr(msg, 'content', '') or '')
                                if not text.strip():
                                    continue
                                post_inbound(who, text)
                            except Exception as e:  # noqa: BLE001
                                print('[wxauto] 消息处理失败: ' + str(e))
        except Exception as e:  # noqa: BLE001
            print('[wxauto] 监听轮询异常: ' + str(e))
        time.sleep(1.0)


def post_inbound(who, text):
    data = json.dumps({'peer': who, 'text': text, 'ts': int(time.time() * 1000)}).encode('utf-8')
    req = urllib.request.Request(
        _state['callback'], data=data,
        headers={'content-type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            r.read()
        print('[wxauto] 已上报 ' + who + ': ' + text[:30])
    except Exception as e:  # noqa: BLE001
        print('[wxauto] 上报失败（插件在跑吗？）: ' + str(e))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003
        sys.stdout.write('[wxauto] ' + (fmt % args) + '\n')

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
        if self.path.split('?')[0] == '/health':
            ok = ensure_wx()
            return self._send(200, {
                'ok': True, 'ready': ok, 'error': _state['error'],
                'listening': list(_state['peers']),
                'hint': '微信窗口请保持登录且不要最小化',
            })
        return self._send(404, {'ok': False})

    def do_POST(self):  # noqa: N802
        path = self.path.split('?')[0]
        b = self._body()
        if path == '/send':
            if not ensure_wx():
                return self._send(500, {'ok': False, 'error': '微信未连接: ' + (_state['error'] or '未知')})
            to = str(b.get('to') or '')
            text = str(b.get('text') or '')
            if not to or not text.strip():
                return self._send(400, {'ok': False, 'error': 'to/text 必填'})
            try:
                with _lock:
                    _state['wx'].SendMsg(msg=text, who=to)
                print('[wxauto] 已发送 → ' + to + ': ' + text[:30])
                return self._send(200, {'ok': True})
            except Exception as e:  # noqa: BLE001
                return self._send(500, {'ok': False, 'error': str(e)})
        if path == '/listen':
            if not ensure_wx():
                return self._send(500, {'ok': False, 'error': '微信未连接: ' + (_state['error'] or '未知')})
            add_listeners([str(p) for p in (b.get('peers') or [])])
            return self._send(200, {'ok': True, 'listening': list(_state['peers'])})
        return self._send(404, {'ok': False})


def main():
    print('[wxauto] wxauto 通道桥启动，端口 ' + str(PORT) + ' ...')
    print('[wxauto] 这是"PC 接管"通道：会用 UIA 操作微信 3.9 窗口（不注入不碰内存）。')
    threading.Thread(target=listen_loop, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()

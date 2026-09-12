window.__ModuleLoader__.load({
  id: "dsh-wechat-companion",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const { useState, useEffect, useCallback } = react;
    const h = react.createElement;

    const css = ".wxb_section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px}.wxb_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}.wxb_card h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}.wxb_row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.wxb_grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.wxb_label{color:var(--dsw-alias-label-secondary);font-size:13px}.wxb_value{color:var(--dsw-alias-label-tertiary);font-size:12px}.wxb_status{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px}.wxb_dot{border-radius:999px;width:7px;height:7px;display:inline-block;background:var(--dsw-alias-label-tertiary)}.wxb_dot[data-on=true]{background:var(--dsw-alias-state-success-primary)}.wxb_dot[data-on=paused]{background:var(--dsw-alias-state-warning-primary)}.wxb_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px}.wxb_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.wxb_btn[data-danger=true]{color:var(--dsw-alias-state-error-primary)}.wxb_btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}.wxb_accounts{display:flex;flex-direction:column;gap:8px}.wxb_account{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:4px}.wxb_accountTop{display:flex;align-items:center;justify-content:space-between;gap:8px}.wxb_qr{display:flex;flex-direction:column;align-items:center;gap:10px}.wxb_qr img{width:256px;height:256px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.wxb_err{color:var(--dsw-alias-state-error-primary);font-size:13px}.wxb_ok{color:var(--dsw-alias-state-success-primary);font-size:13px}.wxb_sel{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:6px;padding:4px 8px;font-size:13px;max-width:340px;min-width:180px}.wxb_field{display:flex;flex-direction:column;gap:4px;min-width:180px;flex:1}.wxb_input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:6px;padding:6px 8px;font-size:13px;resize:vertical}.wxb_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}.wxb_chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.wxb_chip{border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;border-radius:999px;padding:2px 10px;cursor:pointer}.wxb_chip:hover{color:var(--dsw-alias-label-primary);border-style:solid}.wxb_chip[data-on=true]{border-style:solid;color:var(--dsw-alias-state-business-primary)}.wxb_muted{color:var(--dsw-alias-label-tertiary);font-size:12px}.wxb_range{width:100%}.wxb_card2{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;margin-bottom:10px;overflow:hidden}.wxb_card2>summary{cursor:pointer;list-style:none;padding:11px 14px;font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);display:flex;justify-content:space-between;align-items:center}.wxb_card2>summary::-webkit-details-marker{display:none}.wxb_card2>summary:after{content:'▾';color:var(--dsw-alias-label-tertiary)}.wxb_card2[open]>summary:after{content:'▴'}.wxb_cardB{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px}";
    const tagId = "dsh-wechat-companion/settings.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-wechat-companion";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    async function api(method, p, body) {
      const res = await fetch("/wechat-companion/" + p, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(j.error || ("HTTP " + res.status));
      return j;
    }

    function Card(title, defOpen) { return function (children) { return h("details", { className: "wxb_card2", open: defOpen !== false }, h("summary", null, title), h("div", { className: "wxb_cardB" }, ...children)); }; }
    function Row() { return h("div", { className: "wxb_row" }, ...arguments); }
    function Val(text) { return h("div", { className: "wxb_value" }, text); }
    function Btn(props, text) { return h("button", Object.assign({ className: "wxb_btn" }, props), text); }
    function Field(label, input) { return h("span", { className: "wxb_field" }, h("span", { className: "wxb_label" }, label), input); }
    function Input(props) { return h("input", Object.assign({ className: "wxb_input" }, props)); }
    function Sel(props, children) { return h("select", Object.assign({ className: "wxb_sel" }, props), ...(children || [])); }
    function Option(v, label) { return h("option", { value: v, key: v || "empty" }, label); }

    function StatusCard() {
      const [st, setSt] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState("");
      const [qr, setQr] = useState(null);
      const [conn, setConn] = useState("");
      const load = useCallback(() => { api("GET", "status").then(setSt).catch((e) => setErr(e.message)); }, []);
      useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
      useEffect(() => {
        if (!qr) return undefined;
        const t = setInterval(() => {
          api("POST", "qrstatus", { sessionId: qr.sessionId })
            .then((r) => { if (r.status === "confirmed") { setQr(null); load(); } })
            .catch(() => {});
        }, 2000);
        return () => clearInterval(t);
      }, [qr, load]);
      const act = (fn) => { setBusy(true); setErr(""); fn().then(load).catch((e) => setErr(e.message)).finally(() => setBusy(false)); };
      const running = st && st.running;
      const accounts = (st && st.accounts) || [];
      return Card("她的微信连接")( [
        Row(
          h("span", { className: "wxb_status" },
            h("span", { className: "wxb_dot", "data-on": running ? "true" : "false" }),
            running ? "在线" : "离线"
          ),
          running
            ? Btn({ disabled: busy, "data-danger": "true", onClick: () => act(() => api("POST", "disable")) }, "停止")
            : Btn({ disabled: busy, "data-primary": "true", onClick: () => act(() => api("POST", "enable")) }, "启动"),
        ),
        Val("启动后开始轮询她的微信消息并按人设回复；绑定/启停状态会持久化。"),
        accounts.length === 0
          ? Val("还没有绑定她的微信号。点下方按钮扫码绑定。")
          : h("div", { className: "wxb_accounts" }, accounts.map((a) =>
            h("div", { className: "wxb_account", key: a.accountId },
              h("div", { className: "wxb_accountTop" },
                h("span", { className: "wxb_label" }, (a.name || a.accountId) + (a.enabled ? "" : "（已停用）")),
                Btn({ "data-danger": "true", disabled: busy, onClick: () => act(() => api("POST", "remove", { accountId: a.accountId })) }, "移除"),
              ),
              Val(a.accountId + " · token=" + (a.hasToken ? "已存" : "缺失") + " · " + (a.lastLoginAt || "从未登录") + (a.health ? " · " + a.health : "")),
            ))),
        Row(
          Btn({ disabled: busy, onClick: () => act(() => api("POST", "panel/conn-test", {}).then((r) => setConn((r.ok ? "✅ " : "⚠️ ") + (r.note || r.error || "")))) }, "连接自检"),
          conn && h("span", { className: conn.startsWith("✅") ? "wxb_ok" : "wxb_err" }, conn),
        ),
        Row(
          Val("绑定需要 bot_type=3 资格的微信账号。"),
          Btn({ disabled: busy, "data-primary": "true", onClick: () => act(() => api("POST", "qrlogin").then((r) => setQr(r))) }, "扫码绑定她的微信号"),
        ),
        qr && h("div", { className: "wxb_qr" },
          h("img", { src: qr.qrImage, alt: "qr" }),
          Val("用她的微信扫码并确认，成功后自动完成绑定。"),
          Btn({ onClick: () => setQr(null) }, "取消"),
        ),
        err && h("div", { className: "wxb_err" }, err),
      ]); }

    function EmergencyCard() {
      const [paused, setPaused] = useState(false);
      const [busy, setBusy] = useState(false);
      useEffect(() => { api("GET", "panel/config").then((r) => setPaused(!!(r.config && r.config.paused))).catch(() => {}); }, []);
      const toggle = () => {
        setBusy(true);
        api("POST", "panel/config", { paused: !paused })
          .then((r) => setPaused(!!(r.config && r.config.paused)))
          .catch(() => {})
          .finally(() => setBusy(false));
      };
      return Card("全局急停")( [
        Row(
          h("span", { className: "wxb_status" },
            h("span", { className: "wxb_dot", "data-on": paused ? "paused" : "true" }),
            paused ? "已急停：她不会回复任何消息" : "正常运行中",
          ),
          Btn({ disabled: busy, "data-danger": !paused, "data-primary": paused, onClick: toggle }, paused ? "解除急停" : "一键急停"),
        ),
        Val("急停后她立刻安静（不回复、不主动）。状态持久化，重启后依然有效。"),
      ]); }

    function ModelCard() {
      const [roles, setRoles] = useState(null);
      const [modelOpts, setModelOpts] = useState({});
      const [temp, setTemp] = useState(0.8);
      const [voiceRate, setVoiceRate] = useState(0);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      useEffect(() => {
        api("GET", "panel/config").then((r) => {
          const c = r.config || {};
          const base = (k, extra) => Object.assign({ baseURL: "", apiKey: "", model: "" }, extra || {}, c[k] || {});
          setRoles({
            chat: base("chat"),
            image: base("image"),
            tts: base("tts", { voice: "" }),
            asr: base("asr"),
            vision: base("vision"),
            embed: Object.assign({ source: "local", url: "http://127.0.0.1:11434", apiKey: "", model: "bge-m3" }, c.embed || {}),
          });
          setTemp((c.params && c.params.temperature) !== undefined ? c.params.temperature : 0.8);
          setVoiceRate((c.behavior && c.behavior.voiceRate) !== undefined ? c.behavior.voiceRate : 0);
        }).catch((e) => setMsg(e.message));
      }, []);
      const upd = (role, patch) => setRoles(Object.assign({}, roles, { [role]: Object.assign({}, roles[role], patch) }));
      const pull = async (role) => {
        setBusy(true); setMsg("");
        const r = roles[role];
        try {
          const res = await api("POST", "panel/models", { baseURL: r.baseURL || roles.chat.baseURL, apiKey: r.apiKey || roles.chat.apiKey });
          const ids = (res.models || []).map((m) => m.id);
          setModelOpts(Object.assign({}, modelOpts, { [role]: ids }));
          setMsg(role + " 拉取到 " + ids.length + " 个模型（点下方模型名即可填入）");
        } catch (e) { setMsg(role + " 拉取失败: " + e.message); }
        setBusy(false);
      };
      const save = async () => {
        setBusy(true); setMsg("");
        try {
          const inh = (r) => Object.assign({}, r, { baseURL: r.baseURL || roles.chat.baseURL, apiKey: r.apiKey || roles.chat.apiKey });
          await api("POST", "panel/config", { chat: roles.chat, image: inh(roles.image), tts: inh(roles.tts), asr: inh(roles.asr), vision: inh(roles.vision), embed: roles.embed, params: { temperature: Number(temp) }, behavior: { voiceRate: Number(voiceRate) } });
          setMsg("已保存 ✅");
        } catch (e) { setMsg("保存失败: " + e.message); }
        setBusy(false);
      };
      const roleBox = (role, title, extra) => {
        const r = roles[role];
        return h("div", { className: "wxb_account" },
          h("div", { className: "wxb_label" }, title),
          Field("BaseURL", Input({ value: r.baseURL || "", placeholder: "https://api.siliconflow.cn", onChange: (e) => upd(role, { baseURL: e.target.value }) })),
          Field("API Key", Input({ type: "password", value: r.apiKey || "", onChange: (e) => upd(role, { apiKey: e.target.value }) })),
          Row(
            Field("模型名（点选或手输）", Input({ value: r.model || "", onChange: (e) => upd(role, { model: e.target.value }) })),
            Btn({ disabled: busy, onClick: () => pull(role) }, "拉取列表"),
          ),
          h("div", { style: { maxHeight: "180px", overflowY: "auto", display: "flex", flexWrap: "wrap", gap: "6px", paddingRight: "4px" } },
            (modelOpts[role] || []).map((m) => h("button", {
              key: m,
              onClick: () => upd(role, { model: m }),
              style: { border: "1px dashed #c8ccd2", borderRadius: "99px", padding: "2px 10px", fontSize: "12px", cursor: "pointer", background: "transparent", color: "#6b6f76", fontFamily: "inherit" },
            }, m))),
          (modelOpts[role] || []).length === 0 ? h("span", { className: "wxb_status" }, "点「拉取列表」后，点模型名即可填入") : null,
          ...extra,
        );
      };
      if (roles === null) return Card("模型服务")( [msg ? h("div", { className: "wxb_err" }, msg) : Val("加载中…")] );
      return Card("模型服务（六个接口互相独立）")( [
        Val("六个接口互相独立；留空 BaseURL/Key 的接口会自动沿用①对话接口的配置（同一家只需填一次）。"),
        roleBox("chat", "① 对话接口（她的大脑）", []),
        roleBox("image", "② 生图接口（朋友圈配图；明日更新后用）", []),
        roleBox("tts", "③ 语音合成 TTS（暂不使用：当前通道发不了语音，可不填；代码已就绪）", [Field("TTS 音色（可选）", Input({ value: roles.tts.voice || "", onChange: (e) => upd("tts", { voice: e.target.value }) }))]),
        roleBox("asr", "④ 语音识别 ASR（暂不使用：通道收语音待验证，可不填）", []),
        roleBox("vision", "⑤ 识图 VLM（她看得见图片，主模型无多模态也能用）", []),
        roleBox("embed", "⑥ 记忆向量（整理她的记忆）", [
          Row(
            h("span", { className: "wxb_status" }, "向量来源："),
            Sel({ value: roles.embed.source || "local", disabled: busy, onChange: (e) => upd("embed", { source: e.target.value }) }, [Option("local", "本地 Ollama（隐私最优）"), Option("api", "云端接口（OpenAI兼容）")]),
          ),
          roles.embed.source === "api"
            ? h("div", { className: "wxb_grid" },
                Field("向量接口 BaseURL", Input({ value: roles.embed.baseURL || "", onChange: (e) => upd("embed", { baseURL: e.target.value }) })),
                Field("API Key", Input({ type: "password", value: roles.embed.apiKey || "", onChange: (e) => upd("embed", { apiKey: e.target.value }) })),
                Field("向量模型", Input({ value: roles.embed.model || "", onChange: (e) => upd("embed", { model: e.target.value }) })))
            : Val("使用本机 Ollama（" + (roles.embed.url || "http://127.0.0.1:11434") + " · " + (roles.embed.model || "bge-m3") + "），向量不出你的电脑"),
        ]),
        Row(
          h("span", { className: "wxb_field", style: { flex: "2" } },
            h("span", { className: "wxb_label" }, "说话随机度 temperature：" + temp),
            h("input", { className: "wxb_range", type: "range", min: 0, max: 2, step: 0.05, value: temp, onChange: (e) => setTemp(e.target.value) })),
          h("span", { className: "wxb_field", style: { flex: "2" } },
            h("span", { className: "wxb_label" }, "语音条比例（对主人）" + Math.round(voiceRate * 100) + "%"),
            h("input", { className: "wxb_range", type: "range", min: 0, max: 100, step: 5, value: Math.round(voiceRate * 100), onChange: (e) => setVoiceRate(Number(e.target.value) / 100) })),
        ),
        Row(
          Btn({ disabled: busy, "data-primary": "true", onClick: save }, "保存全部模型配置"),
          msg && h("span", { className: msg.indexOf("失败") >= 0 ? "wxb_err" : "wxb_ok" }, msg),
        ),
      ]);
    }

    const DIMS = [
      ["extraversion", "外向程度"], ["warmth", "温柔程度"], ["clinginess", "粘人程度"],
      ["sass", "嘴碎程度"], ["initiative", "主动程度"],
    ];
    function PersonaCard() {
      const [p, setP] = useState(null);
      const [versions, setVersions] = useState([]);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      useEffect(() => { api("GET", "panel/persona").then((r) => setP(r.persona)).catch((e) => setMsg(e.message)); }, []);
      const upd = (patch) => setP(Object.assign({}, p, patch));
      const save = () => {
        setBusy(true); setMsg("");
        api("POST", "panel/persona", p).then((r) => { setP(r.persona); setMsg("已保存 ✅（当前 v" + r.persona.version + "）"); })
          .catch((e) => setMsg("保存失败: " + e.message)).finally(() => setBusy(false));
      };
      const loadVersions = () => api("GET", "panel/persona/versions").then((r) => setVersions(r.versions || [])).catch(() => {});
      const rollback = (v) => api("POST", "panel/persona/rollback", { version: v }).then((r) => { setP(r.persona); setVersions([]); setMsg("已回滚 ✅"); }).catch((e) => setMsg(e.message));
      if (!p) return Card("人设")( [msg ? h("div", { className: "wxb_err" }, msg) : Val("加载中…")] );
      const set = (key) => (e) => upd(Object.assign({}, p, { [key]: e.target.value }));
      const listText = (arr) => (arr || []).join("，");
      const parseList = (s) => String(s).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      return Card("人设（她是谁）")( [
        h("div", { className: "wxb_grid" },
          Field("名字", Input({ value: p.name || "", onChange: set("name") })),
          Field("生日/星座", Input({ value: p.birthday || "", onChange: set("birthday") })),
          Field("城市", Input({ value: p.city || "", onChange: set("city") })),
          Field("职业/身份", Input({ value: p.job || "", onChange: set("job") })),
        ),
        Field("背景故事（她的人生、家庭、经历……越具体越像）",
          h("textarea", { className: "wxb_input", rows: 5, value: p.personaText || "", onChange: set("personaText") })),
        h("div", null, DIMS.map((d) => h("div", { key: d[0], style: { marginBottom: "6px" } },
          h("div", { className: "wxb_label" }, d[1] + "：" + ((p.personality || {})[d[0]] || 0) + "%"),
          h("input", { className: "wxb_range", type: "range", min: 0, max: 100, value: (p.personality || {})[d[0]] || 0,
            onChange: (e) => upd(Object.assign({}, p, { personality: Object.assign({}, p.personality, { [d[0]]: Number(e.target.value) }) })) }),
        ))),
        h("div", { className: "wxb_grid" },
          Field("口头禅（逗号分隔）", Input({ value: listText(p.quirks && p.quirks.catchphrases), onChange: (e) => upd(Object.assign({}, p, { quirks: Object.assign({}, p.quirks, { catchphrases: parseList(e.target.value) }) })) })),
          Field("兴趣（逗号分隔）", Input({ value: listText(p.interests), onChange: (e) => upd({ interests: parseList(e.target.value) }) })),
          Field("红线话题（永不聊）", Input({ value: listText(p.redLines), onChange: (e) => upd({ redLines: parseList(e.target.value) }) })),
          Field("你们的关系", Input({ value: (p.relationship || {}).toOwner || "", onChange: (e) => upd(Object.assign({}, p, { relationship: Object.assign({}, p.relationship, { toOwner: e.target.value }) })) })),
          Field("她怎么称呼你", Input({ value: (p.relationship || {}).callOwner || "", onChange: (e) => upd(Object.assign({}, p, { relationship: Object.assign({}, p.relationship, { callOwner: e.target.value }) })) })),
          Field("带表情的回复比例（0-100）", Input({ type: "number", min: 0, max: 100, value: Math.round(((p.quirks || {}).emojiRate || 0) * 100), onChange: (e) => upd(Object.assign({}, p, { quirks: Object.assign({}, p.quirks, { emojiRate: Number(e.target.value) / 100 }) })) })),
        ),
        Row(
          Btn({ disabled: busy, "data-primary": "true", onClick: save }, "保存人设"),
          Btn({ disabled: busy, onClick: loadVersions }, "历史版本"),
          msg && h("span", { className: msg.indexOf("失败") >= 0 ? "wxb_err" : "wxb_ok" }, msg),
        ),
        versions.length > 0 && h("div", { className: "wxb_chips" }, versions.map((v) =>
          h("button", { className: "wxb_chip", key: v.version, onClick: () => rollback(v.version) },
            "v" + v.version + " · " + new Date(v.at).toLocaleString("zh-CN")))),
        Val("每次保存自动快照，可随时回滚。所有改动立刻影响她的说话方式。"),
      ]); }

    function MemoryCard() {
      const [mem, setMem] = useState(null);
      const [text, setText] = useState("");
      const [imp, setImp] = useState(4);
      const [busy, setBusy] = useState(false);
      const load = useCallback(() => { api("GET", "panel/memory").then((r) => setMem(r.memories)).catch(() => {}); }, []);
      useEffect(() => { load(); }, [load]);
      const op = (body) => { setBusy(true); api("POST", "panel/memory", body).then(load).catch(() => {}).finally(() => setBusy(false)); };
      if (!mem) return Card("她的记忆")( [Val("加载中…")] );
      const entries = (mem.entries || []).slice().sort((a, b) => b.ts - a.ts);
      return Card("她的记忆（她记得的事）")( [
        Row(
          h("span", { className: "wxb_field", style: { flex: "3" } },
            h("span", { className: "wxb_label" }, "手动教她记一件事"),
            Input({ value: text, placeholder: "例如：主人不吃香菜", onChange: (e) => setText(e.target.value) })),
          h("span", { className: "wxb_field", style: { flex: "0 0 110px" } },
            h("span", { className: "wxb_label" }, "重要度 " + imp),
            h("input", { className: "wxb_range", type: "range", min: 1, max: 5, value: imp, onChange: (e) => setImp(Number(e.target.value)) })),
          Btn({ disabled: busy || !text, "data-primary": "true", onClick: () => { op({ op: "add", text, importance: imp, who: "" }); setText(""); } }, "记住"),
        ),
        entries.length === 0 ? Val("还没有记忆。聊天时她会自动记，也可以在这里手动教。") :
          h("div", { className: "wxb_accounts" }, entries.map((e) =>
            h("div", { className: "wxb_account", key: e.id },
              h("div", { className: "wxb_accountTop" },
                h("span", { className: "wxb_label" }, (e.pinned ? "📌 " : "") + "★" + (e.importance || 3) + " " + e.text),
                h("span", null,
                  Btn({ disabled: busy, onClick: () => op({ op: "pin", id: e.id }) }, e.pinned ? "取消钉住" : "钉住"),
                  " ",
                  Btn({ disabled: busy, "data-danger": "true", onClick: () => op({ op: "delete", id: e.id }) }, "让她忘掉"),
                ),
              ),
              Val(new Date(e.ts).toLocaleString("zh-CN") + (e.who ? " · 关于 " + e.who : " · 通用") + (e.todo ? " · 待办: " + e.todo.text : "")),
            ))),
        Val("重要度越高越不容易遗忘；钉住 = 永远记得。"),
      ]); }

    function NamesCard() {
      const [st, setSt] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [newBlock, setNewBlock] = useState("");
      const [busy, setBusy] = useState(false);
      const load = useCallback(() => {
        api("GET", "status").then(setSt).catch(() => {});
        api("GET", "panel/config").then((r) => setCfg(r.config || {})).catch(() => {});
      }, []);
      useEffect(() => { load(); }, [load]);
      const save = (patch) => { setBusy(true); api("POST", "panel/config", patch).then((r) => setCfg(r.config || {})).catch(() => {}).finally(() => setBusy(false)); };
      if (!cfg) return Card("名单与身份")( [Val("加载中…")] );
      const known = (st && st.knownPeers) || [];
      const blocklist = cfg.blocklist || [];
      return Card("名单与身份（谁是她特殊的人）")( [
        Row(
          h("span", { className: "wxb_status" }, "回复所有人："),
          h("input", { type: "checkbox", checked: cfg.replyToAll !== false, disabled: busy, onChange: (e) => save({ replyToAll: e.target.checked }) }),
          Val(cfg.replyToAll !== false ? "开：陌生人也回（默认）" : "关：仅白名单模式"),
        ),
        Val("设为主人后，她会用对待你的方式说话（亲密度、称呼、特殊记忆）。下面是给她发过消息的人（内部ID）："),
        h("div", { className: "wxb_chips" },
          known.length === 0 ? Val("还没有人给她发过消息。") :
            known.map((p) => h("button", { className: "wxb_chip", key: p, "data-on": cfg.ownerPeerId === p, disabled: busy,
              onClick: () => save({ ownerPeerId: cfg.ownerPeerId === p ? "" : p }) },
              (cfg.ownerPeerId === p ? "👑 " : "") + p))),
        Val("黑名单（她的消息会被静默忽略）："),
        h("div", { className: "wxb_chips" },
          blocklist.map((p) => h("button", { className: "wxb_chip", key: p, disabled: busy,
            onClick: () => save({ blocklist: blocklist.filter((x) => x !== p) }) }, p + " ✕")),
          Input({ style: { maxWidth: "240px" }, placeholder: "输入ID后回车加入黑名单", value: newBlock,
            onChange: (e) => setNewBlock(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter" && newBlock.trim()) { save({ blocklist: blocklist.concat([newBlock.trim()]) }); setNewBlock(""); } } }),
        ),
      ]); }

    function TestCard() {
      const [text, setText] = useState("在干嘛呢");
      const [out, setOut] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState("");
      const run = () => {
        setBusy(true); setErr("");
        api("POST", "panel/soul-test", { text })
          .then(setOut).catch((e) => setErr(e.message)).finally(() => setBusy(false));
      };
      return Card("回复预览（不会真实发送）")( [
        Row(
          h("span", { className: "wxb_field", style: { flex: "3" } },
            Input({ value: text, onChange: (e) => setText(e.target.value) })),
          Btn({ disabled: busy, "data-primary": "true", onClick: run }, busy ? "她想…" : "让她回"),
        ),
        err && h("div", { className: "wxb_err" }, err),
        out && h("div", { className: "wxb_account" },
          (out.chunks || []).map((c, i) => h("div", { key: i, style: { marginBottom: "4px" } },
            h("span", { className: "wxb_label" }, "她："), c,
            h("span", { className: "wxb_muted" }, "  （延迟 " + ((out.delaysMs || [])[i] || 0) + "ms）"))),
          out.backend ? Val("大脑: " + out.backend + " · 心情: " + Math.round(out.mood || 0)) : null),
        Val("预览使用真实模型（消耗少量 token），但不发微信。用于调人设和模型。"),
      ]); }

    function MomentsCard() {
      const [drafts, setDrafts] = useState(null);
      const [theme, setTheme] = useState("");
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const load = useCallback(() => { api("GET", "panel/moments").then((r) => setDrafts(r.drafts || [])).catch(() => {}); }, []);
      useEffect(() => { load(); }, [load]);
      const gen = () => {
        setBusy(true); setMsg("");
        api("POST", "panel/moments/generate", { theme })
          .then(() => { setMsg("草稿已生成 ✅"); load(); })
          .catch((e) => setMsg("生成失败: " + e.message))
          .finally(() => setBusy(false));
      };
      const op = (body) => { setBusy(true); api("POST", body.op === "delete" ? "panel/moments/delete" : "panel/moments/posted", body).then(load).catch(() => {}).finally(() => setBusy(false)); };
      const copyText = (t) => { navigator.clipboard.writeText(t).then(() => setMsg("文案已复制 ✅")).catch(() => setMsg("复制失败，请手动选择文本")); };
      if (drafts === null) return Card("朋友圈工坊")( [Val("加载中…")] );
      return Card("朋友圈工坊（她生产，你发布）")( [
        Row(
          h("span", { className: "wxb_field", style: { flex: "3" } },
            h("span", { className: "wxb_label" }, "灵感方向（可选，留空她自己想）"),
            Input({ value: theme, placeholder: "例如：今天下雨了 / 新买的奶茶 / 加班好累", onChange: (e) => setTheme(e.target.value) })),
          Btn({ disabled: busy, "data-primary": "true", onClick: gen }, busy ? "她正在酝酿…" : "生成朋友圈草稿"),
        ),
        msg && h("span", { className: msg.indexOf("失败") >= 0 ? "wxb_err" : "wxb_ok" }, msg),
        drafts.length === 0 ? Val("还没有草稿。点上面按钮让她写一条。") :
          h("div", { className: "wxb_accounts" }, drafts.map((d) =>
            h("div", { className: "wxb_account", key: d.id },
              h("div", { className: "wxb_accountTop" },
                h("span", { className: "wxb_label" }, (d.status === "posted" ? "✅已发 " : "📝 ") + (d.text || "").slice(0, 60)),
                h("span", null,
                  Btn({ disabled: busy, onClick: () => copyText(d.text || "") }, "复制文案"),
                  " ",
                  d.status !== "posted" ? Btn({ disabled: busy, onClick: () => op({ op: "posted", id: d.id }) }, "标记已发") : null,
                  " ",
                  Btn({ disabled: busy, "data-danger": "true", onClick: () => op({ op: "delete", id: d.id }) }, "删除"),
                ),
              ),
              Val(new Date(d.createdAt).toLocaleString("zh-CN") + " · 配图 " + ((d.images || []).length) + " 张 · " + ((d.images || [])[0] || "（无图）")),
            ))),
        Val("v1为半自动：复制文案、从她的图片文件夹取图，用她手机的微信亲手发出——真手指最像真人，零封号风险。"),
      ]);
    }

    function WorkshopCard() {
      const [chatText, setChatText] = useState("");
      const [desc, setDesc] = useState("");
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const analyze = () => {
        setBusy(true); setMsg("");
        api("POST", "panel/workshop/analyze", { chatText, description: desc })
          .then((r) => { setDraft(r.draft); setMsg("分析完成，请检查下面的草稿再应用"); })
          .catch((e) => setMsg("分析失败: " + e.message))
          .finally(() => setBusy(false));
      };
      const apply = () => {
        setBusy(true); setMsg("");
        api("POST", "panel/workshop/apply", { draft })
          .then((r) => { setMsg("已应用 ✅（" + r.seeds + " 条记忆种子导入；人设卡刷新可见，可回滚）"); setDraft(null); setChatText(""); })
          .catch((e) => setMsg("应用失败: " + e.message))
          .finally(() => setBusy(false));
      };
      return Card("人设工坊（用真实素材喂出她）")( [
        Val("把她的素材粘进来（微信导出的聊天记录 / 或手打的对话与描述），她据此为自己设定人设与说话风格。素材只在本机解析。"),
        h("textarea", { className: "wxb_input", rows: 6, placeholder: "粘贴聊天记录，或类似：\n她：今天好累啊\n我：抱抱，吃什么了\n她：随便，想吃火锅 哈哈", value: chatText, onChange: (e) => setChatText(e.target.value) }),
        Row(
          h("span", { className: "wxb_field", style: { flex: "3" } },
            h("span", { className: "wxb_label" }, "关系/背景描述（可选）"),
            Input({ value: desc, placeholder: "例如：大学同学，认识两年，她爱撒娇", onChange: (e) => setDesc(e.target.value) })),
          Btn({ disabled: busy, "data-primary": "true", onClick: analyze }, busy ? "分析中…" : "分析并生成人设草稿"),
        ),
        draft && h("div", { className: "wxb_account" },
          h("div", { className: "wxb_label" }, "草稿预览"),
          Val("名字：" + (draft.name || "—") + " · 说话风格：" + (draft.sentenceStyle || "—") + " · emoji率：" + Math.round((draft.emojiRate || 0) * 100) + "%"),
          Val("背景故事：" + (draft.personaText || "—").slice(0, 120)),
          Val("风格样例 " + ((draft.styleExamples || []).length) + " 条 · 记忆种子 " + ((draft.memorySeeds || []).length) + " 条"),
        ),
        Row(
          draft ? Btn({ disabled: busy, "data-primary": "true", onClick: apply }, "应用到她的人设") : null,
          draft ? Btn({ disabled: busy, onClick: () => setDraft(null) }, "丢弃") : null,
          msg && h("span", { className: msg.indexOf("失败") >= 0 ? "wxb_err" : "wxb_ok" }, msg),
        ),
        Val("应用前自动快照当前人设，不满意随时回滚。"),
      ]);
    }

    function ActivityCard() {
      const [act, setAct] = useState(null);
      const load = useCallback(() => { api("GET", "panel/activity").then((r) => setAct(r)).catch(() => {}); }, []);
      useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
      if (!act) return Card("她的实况")( [Val("加载中…")] );
      const list = act.activity || [];
      return Card("她的实况（后台运行直播）")( [
        h("span", { className: "wxb_value" },
          "已收消息 " + (act.inboundCount || 0) + " 条 · 最近收信 " + (act.lastInboundAt ? new Date(act.lastInboundAt).toLocaleString("zh-CN") : "还没有")),
        list.length === 0 ? Val("她还没开始活动。绑定微信后给她发条消息试试。") :
          h("div", { className: "wxb_accounts" }, list.slice(0, 30).map((a, i) =>
            h("div", { className: "wxb_account", key: i },
              Val(new Date(a.at).toLocaleTimeString("zh-CN") + "  " + a.text)))),
        Val("实时滚动：收发消息 / 主动问候 / 朋友圈草稿 / 语音与图片的理解（最近200条）。"),
      ]);
    }

    function CompanionSection() {
      return h("div", { className: "wxb_section" },
        h(StatusCard, null),
        h(ActivityCard, null),
        h(EmergencyCard, null),
        h(ModelCard, null),
        Row(
          h("a", { href: "/wechat-companion/console", target: "_blank", style: { color: "var(--pri)", "font-size": "14px", "font-weight": "600" } }, "→ 打开完整后台控制台（新窗口 · 手机也能用）"),
        ),
        Val("人设 / 记忆 / 名单 / 朋友圈工坊 / 人设工坊 / 回复预览 已移入完整后台控制台（数据与此处完全同步）。"),
      );
    }

    const inject = ["slots"];
    function apply(ctx) {
      // 「她」入口已迁至独立后台控制台 /wechat-companion/console
      // （DSH 设置侧栏空间紧张；桌面快捷方式「她的后台」直达）
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

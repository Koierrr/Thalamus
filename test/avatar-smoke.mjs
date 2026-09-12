// avatar-smoke.mjs — 形象工坊 + 相册的回归（用本地假生图接口，不联网、不花钱）
// 覆盖：定稿图上传/校验/主图/删除、外貌档案→提示词、图生图与文生图两条链路、相册增删/标记已发
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/avatar-smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AvatarWorkshop } from '../src/avatar.js';
import { makeTestPng } from '../src/model-test.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));

const png = await makeTestPng(48);
const srv = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  let body = '';
  for await (const c of req) body += c;
  if (u === '/v1/images/generations' || u === '/v1/images/edits') {
    const isEdit = u.endsWith('/edits');
    const multipart = /multipart/.test(req.headers['content-type'] || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }], _edit: isEdit, _multipart: multipart }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'nope' } }));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port + '/v1';

// 假 soul：人设存内存
function mkSoul(p0 = {}) {
  let persona = { name: '小暖', job: '插画师', profile: { appearance: {}, avatarRefs: [] }, relationship: {}, ...p0 };
  return { getPersona: () => persona, savePersona: (patch) => { persona = { ...persona, ...patch }; return persona; } };
}

// ── ① 定稿图 ──
let dir = mk();
let soul = mkSoul();
let av = new AvatarWorkshop({ dir, routerGet: () => ({ image: async () => [{ b64: png.toString('base64') }] }), soul, cfgGet: () => ({ image: { baseURL: BASE, apiKey: 'k', model: 'm' } }), logger: () => {} });
const rec = av.addRef({ dataBase64: png.toString('base64'), mime: 'image/png', angle: '正面', name: 'v1.png' });
ok(rec.id && fs.existsSync(path.join(dir, 'avatar', rec.file)), '定稿图落盘（' + rec.file + '）');
ok(av.refs().length === 1 && av.main().id === rec.id, '第一张自动成为主图');
const rec2 = av.addRef({ dataBase64: png.toString('base64'), mime: 'image/jpeg', angle: '全身' });
ok(rec2.file.endsWith('.jpg'), 'jpeg 存成 .jpg');
av.setMain(rec.id);
ok(av.main().id === rec.id, '可以切换主图');
av.removeRef(rec2.id);
ok(av.refs().length === 1 && av.refs().every((r) => r.id !== rec2.id), '删除定稿图生效');
ok(!fs.existsSync(path.join(dir, 'avatar', rec2.file)), '删除时文件也清掉了');
let threw = '';
try { av.addRef({ dataBase64: png.toString('base64'), mime: 'application/pdf' }); } catch (e) { threw = e.message; }
ok(/只支持/.test(threw), '不支持的格式明确报错（' + threw + '）');
threw = '';
try { av.addRef({ dataBase64: '', mime: 'image/png' }); } catch (e) { threw = e.message; }
ok(/为空/.test(threw), '空图片明确报错');

// ── ② 外貌档案 → 提示词 ──
soul.savePersona({ profile: { ...soul.getPersona().profile, appearance: { face: '圆脸', hair: '黑色长发', vibe: '安静' } } });
const ap = av.appearancePrompt(soul.getPersona());
ok(/圆脸/.test(ap) && /黑色长发/.test(ap) && /安静/.test(ap), '外貌档案进了提示词');
ok(/同一个/.test(av.appearancePrompt(soul.getPersona())) || /年轻女生/.test(ap), '提示词里写明"照片里是她本人"');

// ── ③ 生图两条链路 ──
let gen = await av.generate({ scene: '在咖啡店窗边', mode: 'i2i' });
ok(gen.mode === 'i2i' && gen.bytes > 0 && fs.existsSync(av.albumFile(gen)), '图生图生成成功并入相册（' + Math.round(gen.bytes / 1024) + 'KB）');
ok(av.album().length === 1, '相册索引 +1');
let gen2 = await av.generate({ scene: '雨天窝沙发', mode: 't2i' });
ok(gen2.mode === 't2i' && av.album().length === 2, '文生图生成成功并入相册');
// 没有定稿图时 i2i 自动降级为 t2i（不然用户会以为坏了）
const avNoRef = new AvatarWorkshop({ dir: mk(), routerGet: () => ({ image: async () => [{ b64: png.toString('base64') }] }), soul: mkSoul(), cfgGet: () => ({ image: { baseURL: BASE, apiKey: 'k', model: 'm' } }), logger: () => {} });
const gen3 = await avNoRef.generate({ scene: 'x', mode: 'i2i' });
ok(gen3.mode === 't2i', '没有定稿图时自动降级为文生图（不会报错）');
// 生图接口没配好 → 明确告诉她去哪配（禁黑盒）
const avNoCfg = new AvatarWorkshop({ dir: mk(), routerGet: () => ({ image: async () => [] }), soul: mkSoul(), cfgGet: () => ({ image: {} }), logger: () => {} });
threw = '';
try { await avNoCfg.generate({ scene: 'x' }); } catch (e) { threw = e.message; }
ok(/生图接口没配好/.test(threw) && /大脑/.test(threw), '生图接口没配好 → 明确指路（' + threw.slice(0, 30) + '…）');

// ── ④ 相册 ──
av.markSent(gen.id);
ok(av.album().find((x) => x.id === gen.id).sentAt > 0, '标记"已发过微信"');
av.removeAlbum(gen2.id);
ok(av.album().length === 1 && !fs.existsSync(av.albumFile(gen2)), '删除照片同时清文件');
ok(av.album().length === 1 && av.album()[0].id === gen.id, '剩余照片索引正确');

srv.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? '\nAVATAR ALL GREEN ✅  ' + pass + ' 项' : '\nAVATAR 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

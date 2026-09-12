// console-live-check.mjs — 用「真前端 + 真后端」跑一遍后台每个页签，抓"加载失败"这类静默出错
// 原理：起一个本地小代理——/wechat-companion/console 用工作区里最新的 src/console.html，
//      其余 /wechat-companion/* 原样转发给正在运行的插件服务(127.0.0.1:43121)。
//      这样不用重启 DSH，就能验证"改了前端之后，跟真数据一起跑会不会出错"。
// 用法：~/.dsh/electron/electron.exe test/console-live-check.mjs [--shots]
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const UPSTREAM = 'http://127.0.0.1:' + (process.env.PANEL_PORT || '43121');
const shots = process.argv.includes('--shots');

const server = http.createServer((req, res) => {
  const u = String(req.url);
  if (u === '/wechat-companion/console' || u === '/wechat-companion/console/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(root, 'src/console.html')));
    return;
  }
  // 其余全部转发给真插件服务
  const up = new URL(UPSTREAM + u);
  const pr = http.request({ hostname: up.hostname, port: up.port, path: up.pathname + up.search, method: req.method, headers: { ...req.headers, host: up.host } }, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  pr.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream: ' + e.message })); });
  req.pipe(pr);
});

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const win = new BrowserWindow({ width: 1560, height: 1180, show: false, useContentSize: true });
  const errs = [];
  win.webContents.on('console-message', function () {
    const msg = Array.prototype.slice.call(arguments).map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/error|Error|not a function|undefined|null/.test(msg)) errs.push(msg.slice(0, 300));
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errs.push('did-fail-load ' + code + ' ' + desc));
  // 先探活：插件服务没跑的时候，页面会到处"加载失败"——那是环境问题，不是代码问题，要分开报
  let upstreamUp = false;
  try {
    const r = await fetch(UPSTREAM + '/wechat-companion/status', { signal: AbortSignal.timeout(3000) });
    upstreamUp = r.ok;
  } catch { upstreamUp = false; }
  if (!upstreamUp) {
    console.log('⚠️  连不上插件服务 ' + UPSTREAM + '（DSH 没在跑？端口不对？）。');
    console.log('   这个检查需要"真后端"，先启动 DSH 再来；或者用 test/_probe.mjs（假后端）看纯前端。');
    app.exit(2);
    return;
  }
  await win.loadURL('http://127.0.0.1:' + port + '/wechat-companion/console');

  const tabs = ['home', 'persona', 'world', 'relation', 'memory', 'brain', 'nwa', 'ops'];
  const scan = `(function(){
    var bad=[];
    document.querySelectorAll('main *').forEach(function(el){
      if(el.children.length) return;
      var t=(el.textContent||'');
      if(/加载失败|读取失败|加载中/.test(t)){
        var sec=el.closest('details.sec'), it=el.closest('details.item');
        bad.push({tab:CUR, where:(sec?sec.id:'-')+' / '+(it?((it.querySelector('summary')||{}).textContent||''):'-'), text:t.slice(0,140)});
      }
    });
    return bad;
  })()`;

  const found = [];
  for (const t of tabs) {
    await win.webContents.executeJavaScript("try{localStorage.setItem('ctab','" + t + "');go('" + t + "');}catch(e){}");
    await new Promise((r) => setTimeout(r, 1100));
    try { (await win.webContents.executeJavaScript(scan)).forEach((b) => found.push(b)); }
    catch (e) { found.push({ tab: t, where: 'SCAN-ERROR', text: e.message }); }
    if (shots) {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(root, 'test', 'preview-' + t + '.png'), img.toPNG());
    }
  }

  // 关键 UI 必须在「真数据」下也出现（假数据下渲染成功、真数据下被空值卡住，是另一种坑）
  const MUST = {
    relation: [/所有联系人/, /认识多久/],  // 备注名按钮只在真有过联系人时才出现，空态时不该要求它
    memory: [/一键重置（危险）/, /记忆提炼接口/],
    brain: [/向量服务地址/, /记忆引擎实际在用/],
    nwa: [/BaseURL/, /API Key/],
    world: [/上一月/, /下一月/, /她眼中的你（画像）/],
    persona: [/她用 emoji 的频率/, /手滑打错字概率/],
  };
  const missing = [];
  for (const t of Object.keys(MUST)) {
    await win.webContents.executeJavaScript("try{localStorage.setItem('ctab','" + t + "');go('" + t + "');}catch(e){}");
    await new Promise((r) => setTimeout(r, 1200));
    // 关键：innerText 拿不到"收起"的 <details> 里的字，先全部展开再读（否则会把"折叠"误判成"缺失"）
    await win.webContents.executeJavaScript("document.querySelectorAll('details').forEach(function(d){d.open=true});");
    await new Promise((r) => setTimeout(r, 300));
    const txt = await win.webContents.executeJavaScript("(function(){var m=document.querySelector('main');return m?m.innerText:'';})()");
    for (const re of MUST[t]) if (!re.test(txt)) missing.push('[' + t + '] 缺 ' + re);
  }
  console.log('=== 真数据下关键界面是否都在 ===');
  console.log(missing.length ? missing.map((x) => '  ' + x).join(String.fromCharCode(10)) : '  （都在 ✅）');

  console.log('=== 真前端 + 真后端：页面上的异常提示 ===');
  console.log(found.length ? found.map((f) => '  [' + f.tab + '] ' + f.where + ' → ' + f.text).join('\n') : '  （无 ✅）');
  console.log('=== 浏览器控制台报错 ===');
  console.log(errs.length ? errs.slice(0, 20).map((e) => '  ' + e).join('\n') : '  （无 ✅）');
  if (shots) console.log('截图已写入 test/preview-*.png');
  app.exit(found.length || errs.length || missing.length ? 1 : 0);
});

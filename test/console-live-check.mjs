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
  await win.loadURL('http://127.0.0.1:' + port + '/wechat-companion/console');

  const tabs = ['home', 'persona', 'relation', 'memory', 'brain', 'nwa', 'ops'];
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

  console.log('=== 真前端 + 真后端：页面上的异常提示 ===');
  console.log(found.length ? found.map((f) => '  [' + f.tab + '] ' + f.where + ' → ' + f.text).join('\n') : '  （无 ✅）');
  console.log('=== 浏览器控制台报错 ===');
  console.log(errs.length ? errs.slice(0, 20).map((e) => '  ' + e).join('\n') : '  （无 ✅）');
  if (shots) console.log('截图已写入 test/preview-*.png');
  app.exit(found.length || errs.length ? 1 : 0);
});

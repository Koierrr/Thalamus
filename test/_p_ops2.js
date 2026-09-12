/* ── 机务 = 载体与通道 + 系统与备份 + 媒体（占位）+ 朋友圈工坊 ── */
function tOps(box){
 box.innerHTML='';
 var SECS=[
  {id:'ops-chan',icon:'📡',title:'载体与通道',desc:'她从这个微信说话 · 防封'},
  {id:'ops-sys',icon:'🛠️',title:'系统与备份',desc:'Python · 自启 · 保留天数 · 导出导入'},
  {id:'ops-media',icon:'🖼️',title:'媒体（占位）',desc:'生图/过目开关，等形象工坊落地'},
  {id:'ops-moments',icon:'📷',title:'朋友圈工坊',desc:'草稿 · 复制 · 标记已发'}
 ];
 var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
 wrap.appendChild(tocFor(SECS));
 var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
 body.appendChild(mut('这一页是"她的机务舱"：她从哪个微信说话、防封参数、系统怎么跑、以及配图相关的开关位。她的言行与人设在她页，你们之间的关系在你们页，模型接口在大脑页。'));
 var S={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S[x.id]=sb.body;body.appendChild(sb.el)});
 tChanItem(S['ops-chan']);
 tSysItems(S['ops-sys']);
 tMediaItem(S['ops-media']);
 tMoments(S['ops-moments']);
}

/** 配置保存按钮（统一：即时写盘，每组各自保存） */
function saveCfgBtn(label,getPatch){return btn(label,'pri',function(b2){b2.disabled=true;api('POST','panel/config',getPatch()).then(function(){b2.textContent='已保存 ✅';setTimeout(function(){b2.textContent=label;b2.disabled=false},1500)}).catch(function(e){b2.textContent='失败:'+e.message;alert(e.message);b2.disabled=false})})}

/* ── 载体与通道 ── */
function tChanItem(box){
 loadCfg().then(function(cfg){
  var C=cfg.channel||{};
  var it=itemBlock('发送通道','她从哪个微信跟你说话');it.el.open=true;box.appendChild(it.el);
  var mode=document.createElement('select');[['clawbot','ClawBot（官方机器人通道，当前载体）'],['wxauto','wxauto（PC微信接管）']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];if((C.mode||'clawbot')===o[0])op.selected=true;mode.appendChild(op)});
  it.body.appendChild(f('发送通道',mode));
  var wxE=document.createElement('input');wxE.type='checkbox';wxE.checked=!!C.wxautoEnabled;
  it.body.appendChild(row(wxE,document.createTextNode('wxauto 启用（默认关！解封后再开，先小流量）')));
  var wu=inp(C.wxautoUrl||'http://127.0.0.1:43123',function(v){});
  it.body.appendChild(f('wxauto 桥地址',wu));
  var cap=inp(C.wxautoDailyCap||120,function(v){},'120','number');
  it.body.appendChild(f('每日发送上限（防封）',cap));
  var wp=inp((C.wxautoPeers||[]).join('，'),function(v){},'逗号分隔');
  it.body.appendChild(f('监听谁的备注名',wp));
  var wxst=mut('');
  api('GET','panel/wxauto/status').then(function(r){wxst.textContent='桥状态: '+(r.bridge&&r.bridge.ready?'✅ 已连接微信':'未连接（运行「启动wxauto通道.bat」）')+' · 监听中: '+(((r.bridge&&r.bridge.listening)||[]).join('、')||'无')}).catch(function(){});
  it.body.appendChild(wxst);
  it.body.appendChild(saveCfgBtn('保存通道设置',function(){return {channel:{mode:mode.value,wxautoEnabled:wxE.checked,wxautoUrl:wu.value,wxautoDailyCap:Number(cap.value)||120,wxautoPeers:wp.value.split(/[,，]/).map(function(x){return x.trim()}).filter(Boolean)}}}));
  it.body.appendChild(mut('⚠️ wxauto 用 UIA 操作微信窗口（不注入、不碰内存，比 wcferry 安全得多），但不是零风险：账号被限制过，要等解封并挂机观察几天，再小流量试跑。现在 ClawBot 是主力通道。'));
 }).catch(function(e){box.appendChild(mut('（加载失败：'+e.message+'）'))});
}

/* ── 系统与备份 ── */
function tSysItems(box){
 loadCfg().then(function(cfg){
  var S=cfg.system||{};
  var i1=itemBlock('系统','Python · 自启 · 备份保留');box.appendChild(i1.el);
  var py=inp(S.pythonPath||'',function(v){},'留空=用 PATH 里的 python');
  i1.body.appendChild(f('Python 路径',py));
  var asE=document.createElement('input');asE.type='checkbox';asE.checked=S.autoStartEngine!==false;
  i1.body.appendChild(row(asE,document.createTextNode('DSH 启动时自动拉起记忆引擎')));
  var bkI=inp(S.backupKeepDays||7,function(v){},'7','number');
  i1.body.appendChild(f('备份保留天数',bkI));
  i1.body.appendChild(saveCfgBtn('保存系统设置',function(){return {system:{pythonPath:py.value,autoStartEngine:asE.checked,backupKeepDays:Number(bkI.value)||7}}}));
  i1.body.appendChild(mut('数据目录：'+((cfg.dataDir&&cfg.dataDir!=='')?cfg.dataDir:'~/.dsh/wechat-companion')+'（整个目录=她的全部记忆，每日自动备份，含向量库）'));
  var i2=itemBlock('配置导出 / 导入','换电脑或改乱了就用它');box.appendChild(i2.el);
  i2.body.appendChild(btn('导出全部配置（下载 JSON）','',function(){var blob=new Blob([JSON.stringify(cfg,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='her-config-'+new Date().toISOString().slice(0,10)+'.json';a.click()}));
  var imp=document.createElement('textarea');imp.rows=3;imp.placeholder='把导出的 JSON 粘进来，点导入即可整体恢复';
  i2.body.appendChild(imp);
  i2.body.appendChild(btn('导入以上 JSON','',function(){try{var o=JSON.parse(imp.value);api('POST','panel/config',o).then(function(){alert('导入成功 ✅');go('ops')}).catch(function(e){alert('导入失败: '+e.message)})}catch(e){alert('JSON格式不对')}}));
  i2.body.appendChild(mut('导出的是"设置"（模型/通道/开关这些）；她的记忆与人设在数据目录里，靠每日备份保。'));
 }).catch(function(e){box.appendChild(mut('（加载失败：'+e.message+'）'))});
}

/* ── 媒体（占位开关，等形象工坊落地后随它搬走） ── */
function tMediaItem(box){
 loadCfg().then(function(cfg){
  var MD=cfg.media||{};
  var it=itemBlock('图片开关（占位）','形象工坊 + AI 生图还没做，先放位子');box.appendChild(it.el);
  var img=document.createElement('input');img.type='checkbox';img.checked=MD.imageEnabled!==false;
  it.body.appendChild(row(img,document.createTextNode('允许她生成/发送图片')));
  var rv=document.createElement('input');rv.type='checkbox';rv.checked=!!MD.reviewBeforeSend;
  it.body.appendChild(row(rv,document.createTextNode('生图后先给你过目再发（推荐先开）')));
  it.body.appendChild(saveCfgBtn('保存媒体设置',function(){return {media:{imageEnabled:img.checked,reviewBeforeSend:rv.checked}}}));
  it.body.appendChild(mut('这两个开关是给「形象工坊 + AI 生图 + 主动分享照片」准备的——那套还没做（要等你定好她的形象风格，且通道要能发图）。现在开不开都不影响其它功能。'));
 }).catch(function(e){box.appendChild(mut('（加载失败：'+e.message+'）'))});
}

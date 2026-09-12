/* ── 机务 = 她的消息 + 通道与安全 + 系统 + 朋友圈工坊 + 功能状态 ── */
function tOps(box){
 box.innerHTML='';
 var SECS=[
  {id:'ops-msg',icon:'📨',title:'她的消息',desc:'主动消息 · 聊天机制 · 媒体'},
  {id:'ops-chan',icon:'🔌',title:'通道与安全',desc:'发送通道 · 防封 · 安静时段'},
  {id:'ops-sys',icon:'🛠️',title:'系统',desc:'Python · 自启 · 备份 · 导出导入'},
  {id:'ops-moments',icon:'📷',title:'朋友圈工坊',desc:'草稿 · 复制 · 标记已发'},
  {id:'ops-feat',icon:'📋',title:'功能状态',desc:'她会什么 / 还不会什么（她本人也看得到）'}
 ];
 var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
 wrap.appendChild(tocFor(SECS));
 var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
 body.appendChild(mut('这一页是"她的机务舱"：她怎么找你、从哪个微信说话、系统怎么跑、朋友圈草稿、以及她现在的完整能力清单。'));
 var S={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S[x.id]=sb.body;body.appendChild(sb.el)});
 tMsgSettings(S['ops-msg']);
 tChanSettings(S['ops-chan']);
 tSysSettings(S['ops-sys']);
 tMoments(S['ops-moments']);
 tFeatures(S['ops-feat']);
}

/** 配置保存按钮（统一：用完即时写盘，每组各自保存） */
function saveCfgBtn(label,getPatch){return btn(label,'pri',function(b2){b2.disabled=true;api('POST','panel/config',getPatch()).then(function(){b2.textContent='已保存 ✅';setTimeout(function(){b2.textContent=label;b2.disabled=false},1500)}).catch(function(e){b2.textContent='失败:'+e.message;alert(e.message);b2.disabled=false})})}

/* ── ① 她的消息 ── */
function tMsgSettings(box){
 loadCfg().then(function(cfg){
  var LF=cfg.life||{};var MD=cfg.media||{};var b1=cfg.behavior||{};
  /* 主动消息 */
  var cLf=card('主动消息（她主动找你）');box.appendChild(cLf);
  cLf.appendChild(mut('早安/晚安/日常分享/催你 的开关与时段。次数类设置（每天主动几次、你多久没回她开始等、每天最多等几次）在「她→生活节奏」——这里只管开关和时段。'));
  var lfOn=document.createElement('input');lfOn.type='checkbox';lfOn.checked=LF.enabled!==false;
  cLf.appendChild(row(lfOn,document.createTextNode('总开关（关掉=她不再主动发消息，但你找她她照常回）')));
  var mgOn=document.createElement('input');mgOn.type='checkbox';mgOn.checked=LF.morningOn!==false;
  var ntOn=document.createElement('input');ntOn.type='checkbox';ntOn.checked=LF.nightOn!==false;
  cLf.appendChild(row(mgOn,document.createTextNode('早安（起床时刻±25分钟）'),ntOn,document.createTextNode('晚安（睡觉时刻±20分钟）')));
  var pwv=(LF.pokeWindow||['10:00','22:00']);
  var pwI=inp(pwv[0]+'-'+pwv[1],function(v){},'10:00-22:00');
  cLf.appendChild(f('日常分享时段',pwI));
  cLf.appendChild(saveCfgBtn('保存主动消息设置',function(){
   var m=String(pwI.value||'').split('-');
   var win=(/^\d{1,2}:\d{2}$/.test((m[0]||'').trim())&&/^\d{1,2}:\d{2}$/.test((m[1]||'').trim()))?[m[0].trim(),m[1].trim()]:['10:00','22:00'];
   return {life:{enabled:lfOn.checked,morningOn:mgOn.checked,nightOn:ntOn.checked,pokeWindow:win}};
  }));
  cLf.appendChild(mut('催人（nudge）：你已读不回超过设定时长，她才会来催一次，每天有次数上限——这是"她在等你"，不是骚扰。'));
  /* 聊天机制 */
  var c1=card('聊天机制');box.appendChild(c1);
  var cm=inp(b1.chunkMax||3,function(v){},'3','number');c1.appendChild(f('最多拆几条',cm));
  var cr=inp(b1.contextRounds||16,function(v){},'16','number');c1.appendChild(f('记得最近几轮',cr));
  c1.appendChild(mut('「最多拆几条」1-8；真人一般 1-3 条，太多像刷屏。「记得最近几轮」2-100；越大越连贯，每次回复也越费 token。'));
  c1.appendChild(saveCfgBtn('保存聊天机制',function(){return {behavior:{chunkMax:Number(cm.value)||3,contextRounds:Number(cr.value)||16}}}));
  c1.appendChild(mut('💡 回复速度/作息/主动频率/意外概率 在「她→生活节奏」（那是人设的一部分）；语音条比例在「大脑→通用参数」。'));
  /* 媒体 */
  var c3=card('媒体（图片/语音）');box.appendChild(c3);
  var img=document.createElement('input');img.type='checkbox';img.checked=MD.imageEnabled!==false;
  c3.appendChild(row(img,document.createTextNode('允许她生成/发送图片')));
  var rv=document.createElement('input');rv.type='checkbox';rv.checked=!!MD.reviewBeforeSend;
  c3.appendChild(row(rv,document.createTextNode('生图后先给你过目再发（推荐先开）')));
  c3.appendChild(saveCfgBtn('保存媒体设置',function(){return {media:{imageEnabled:img.checked,reviewBeforeSend:rv.checked}}}));
  c3.appendChild(mut('这两个开关是给"形象工坊 + AI 生图 + 主动分享照片"准备的位子——那套还没做（要等你定好她的形象风格，且通道要能发图）。现在开不开都不影响别的功能。'));
 }).catch(function(e){box.appendChild(mut('（加载失败：'+e.message+'）'))});
}

/* ── ② 通道与安全 ── */
function tChanSettings(box){
 loadCfg().then(function(cfg){
  var C=cfg.channel||{};
  var c4=card('通道（她从哪个微信跟你说话）');box.appendChild(c4);
  var mode=document.createElement('select');[['clawbot','ClawBot（官方机器人通道，当前载体）'],['wxauto','wxauto（PC微信接管）']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];if((C.mode||'clawbot')===o[0])op.selected=true;mode.appendChild(op)});
  c4.appendChild(f('发送通道',mode));
  var wxE=document.createElement('input');wxE.type='checkbox';wxE.checked=!!C.wxautoEnabled;
  c4.appendChild(row(wxE,document.createTextNode('wxauto 启用（默认关！解封后再开，先小流量）')));
  var wu=inp(C.wxautoUrl||'http://127.0.0.1:43123',function(v){});
  c4.appendChild(f('wxauto 桥地址',wu));
  var cap=inp(C.wxautoDailyCap||120,function(v){},'120','number');
  c4.appendChild(f('wxauto 每日发送上限（防封）',cap));
  var wp=inp((C.wxautoPeers||[]).join('，'),function(v){},'逗号分隔');
  c4.appendChild(f('wxauto 监听谁（微信备注名）',wp));
  var wxst=mut('');
  api('GET','panel/wxauto/status').then(function(r){wxst.textContent='桥状态: '+(r.bridge&&r.bridge.ready?'✅ 已连接微信':'未连接（运行「启动wxauto通道.bat」）')+' · 监听中: '+(((r.bridge&&r.bridge.listening)||[]).join('、')||'无')}).catch(function(){});
  c4.appendChild(wxst);
  c4.appendChild(saveCfgBtn('保存通道设置',function(){return {channel:{mode:mode.value,wxautoEnabled:wxE.checked,wxautoUrl:wu.value,wxautoDailyCap:Number(cap.value)||120,wxautoPeers:wp.value.split(/[,，]/).map(function(x){return x.trim()}).filter(Boolean)}}}));
  c4.appendChild(mut('⚠️ wxauto 用 UIA 操作微信窗口（不注入、不碰内存，比 wcferry 安全得多），但不是零风险：账号被限制过，要等解封并挂机观察几天，再小流量试跑。'));
  /* 安静时段 */
  var c5=card('安静时段');box.appendChild(c5);
  var qh=inp(cfg.quietHours||'',function(v){},'01:00-07:30');c5.appendChild(f('安静时段',qh));
  c5.appendChild(mut('格式 01:00-07:30；留空=不安静。安静时段里她只理主人，别人发消息不回。'));
  c5.appendChild(saveCfgBtn('保存安静时段',function(){return {quietHours:qh.value}}));
 }).catch(function(e){box.appendChild(mut('（加载失败：'+e.message+'）'))});
}

/* ── ③ 系统 ── */
function tSysSettings(box){
 loadCfg().then(function(cfg){
  var S=cfg.system||{};
  var c6=card('系统');box.appendChild(c6);
  var py=inp(S.pythonPath||'',function(v){},'留空=用 PATH 里的 python');
  c6.appendChild(f('Python 路径（记忆引擎用）',py));
  var asE=document.createElement('input');asE.type='checkbox';asE.checked=S.autoStartEngine!==false;
  c6.appendChild(row(asE,document.createTextNode('DSH 启动时自动拉起记忆引擎')));
  var bkI=inp(S.backupKeepDays||7,function(v){},'7','number');
  c6.appendChild(f('备份保留天数（1-365）',bkI));
  c6.appendChild(saveCfgBtn('保存系统设置',function(){return {system:{pythonPath:py.value,autoStartEngine:asE.checked,backupKeepDays:Number(bkI.value)||7}}}));
  c6.appendChild(mut('数据目录：'+((cfg.dataDir&&cfg.dataDir!=='')?cfg.dataDir:'~/.dsh/wechat-companion')+'（整个目录=她的全部记忆，每日自动备份，含向量库）'));
  var c7=card('配置一键导出/导入');box.appendChild(c7);
  c7.appendChild(btn('导出全部配置（下载JSON）','',function(){var blob=new Blob([JSON.stringify(cfg,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='her-config-'+new Date().toISOString().slice(0,10)+'.json';a.click()}));
  var imp=document.createElement('textarea');imp.rows=4;imp.placeholder='把导出的JSON粘进来，点导入即可整体恢复';
  c7.appendChild(imp);
  c7.appendChild(btn('导入以上JSON','',function(){try{var o=JSON.parse(imp.value);api('POST','panel/config',o).then(function(){alert('导入成功 ✅');go('ops')}).catch(function(e){alert('导入失败: '+e.message)})}catch(e){alert('JSON格式不对')}}));
  c7.appendChild(mut('导出给的是"设置"（模型/通道/人设之外的所有开关）；她的记忆与人设在数据目录里，靠每日备份保。'));
 }).catch(function(e){box.appendChild(mut('（加载失败：'+e.message+'）'))});
}

/* ── 首页（状态常显 · 分区可折叠） ── */
function tHome(box){
 box.innerHTML='';
 var SECS=[
  {id:'hm-conn',icon:'🔌',title:'连接与运行',desc:'启停 · 扫码绑定 · 连接自检'},
  {id:'hm-today',icon:'☀️',title:'今天的她',desc:'每日随机 · 人设自动定基调'},
  {id:'hm-live',icon:'📡',title:'实况直播',desc:'4 秒刷新'},
  {id:'hm-test',icon:'💬',title:'试聊',desc:'真实模型，不真的发出去'}
 ];
 var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
 wrap.appendChild(tocFor(SECS));
 var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
 body.appendChild(mut('这一页是"她现在怎么样"：连接通不通、今天是什么状态、正在发生什么。状态类内容默认展开，方便一眼看到。'));
 var OBJ={},S={};
 SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);OBJ[x.id]=sb.el;S[x.id]=sb.body;body.appendChild(sb.el)});
 OBJ['hm-test'].open=false;
 tStatus(S['hm-conn']);
 tToday(S['hm-today']);
 tLiveFeed(S['hm-live']);
 tTest(S['hm-test']);
}

/* ── 连接（写进给定容器） ── */
function tStatus(box){
 var c=card('微信连接与运行');box.appendChild(c);
 c.style.gridTemplateColumns='1fr';
 var body=document.createElement('div');body.style.gridColumn='1/-1';c.appendChild(body);
 var qrBox=document.createElement('div');var conn=document.createElement('span');conn.className='mut';
 function draw(st,err){body.innerHTML='';if(err){body.appendChild(mut('加载失败: '+err));return}
  var r1=row();var dot=document.createElement('span');dot.className='dot'+(st.running?' on':'');r1.appendChild(dot);r1.appendChild(document.createTextNode(st.running?'运行中':'已停止'));body.appendChild(r1);
  body.appendChild(row(btn(st.running?'停止':'启动','pri',function(){api('POST',st.running?'disable':'enable').then(load).catch(function(e){alert(e.message)})})));
  var accs=st.accounts||[];
  if(!accs.length){body.appendChild(mut('还没有绑定她的微信号。点下方按钮扫码绑定。'))}
  accs.forEach(function(a){var b=bx();b.appendChild(row((function(){var s=document.createElement('span');s.className='mut';s.textContent=(a.name||a.accountId)+(a.enabled?'':'（已停用）');return s})(),btn('移除','dg',function(){api('POST','remove',{accountId:a.accountId}).then(load).catch(function(){})})));
   b.appendChild(mut(a.accountId+' · token='+(a.hasToken?'已存':'缺失')+' · '+(a.lastLoginAt||'从未登录')+(a.health?(' · '+a.health):'')));body.appendChild(b)});
  body.appendChild(row(btn('连接自检','',function(b2){b2.disabled=true;api('POST','panel/conn-test',{}).then(function(r){conn.className=r.ok?'ok':'er';conn.textContent=(r.ok?'✅ ':'⚠️ ')+(r.note||r.error||'')}).catch(function(e){conn.className='er';conn.textContent=e.message});setTimeout(function(){b2.disabled=false},100)}),conn));
  body.appendChild(row(btn('扫码绑定她的微信号','pri',function(){api('POST','qrlogin',{}).then(function(r){drawQr(r.sessionId,r.qrImage)}).catch(function(e){alert(e.message)})})));
  body.appendChild(qrBox);
  body.appendChild(mut('绑定需要 bot_type=3 资格的微信账号（微信官方机器人通道）。'));
 }
 function drawQr(sid,img){qrBox.innerHTML='';var im=document.createElement('img');im.className='qr';im.src=img;qrBox.appendChild(im);qrBox.appendChild(mut('用她的微信扫码并确认…'));var t=setInterval(function(){api('POST','qrstatus',{sessionId:sid}).then(function(r){if(r.status==='confirmed'){clearInterval(t);qrBox.innerHTML='';load();}}).catch(function(){})},2000)}
 function load(){api('GET','status').then(function(st){draw(st)}).catch(function(e){draw(null,e.message)})}
 load();
}

/* ── 今天的她（写进给定容器） ── */
function tToday(box){
 var cT=card('今天的她');box.appendChild(cT);
 var td=document.createElement('div');td.style.gridColumn='1/-1';cT.appendChild(td);td.appendChild(mut('加载中…'));
 api('GET','panel/today').then(function(r){var t=r.today||{};var df=r.deform||{};var W2=r.world||{};td.innerHTML='';
  var chips=document.createElement('div');chips.className='chips';
  [['☀ 起床 '+(t.wake||'—')],['🌙 睡觉 '+(t.sleep||'—')],['💭 心情 '+Math.round(t.mood||0)],['🔋 电量 '+Math.round(t.battery||0)],['💬 话痨度 '+Math.round((t.chatter||1)*100)+'%'],['⚡ 今日痴迷 '+(t.focus||'—')],['🎭 压力 '+Math.round(df.stress||0)+(df.state&&df.state!=='normal'?('·变形:'+df.state):'')]].forEach(function(x){var c=document.createElement('button');c.className='chip';c.textContent=x[0];chips.appendChild(c)});
  td.appendChild(chips);
  if(W2.weather){var wch=document.createElement('button');wch.className='chip';wch.textContent='🌤 '+W2.weather+(W2.weatherSource==='story'?'（她编的）':'');chips.appendChild(wch);}
  if(t.traitDrift){var dk=Object.keys(t.traitDrift).filter(function(k){return t.traitDrift[k]});if(dk.length){var LB={socialBattery:'社交电量',warmth:'情感温度',attachment:'依恋强度',sharpness:'批判锐度',initiative:'发起力',orderliness:'秩序感'};var dtx=dk.map(function(k){return LB[k]+(t.traitDrift[k]>0?'+':'')+t.traitDrift[k]}).join(' ');var tc2=document.createElement('button');tc2.className='chip';tc2.textContent='📊 今日六维弹性 '+dtx;tc2.title='性格底色不变，只是今天的状态在基准上摆一摆（明天弹回）';chips.appendChild(tc2)}}
  if(t.worldAuthored){var wc=document.createElement('button');wc.className='chip';wc.textContent='🌍 今天由世界引擎书写';chips.appendChild(wc);}
  if((t.events||[]).length)td.appendChild(mut('今天：'+(t.events||[]).join(' · ')));
  td.appendChild(mut('同一天结果固定（重开页面也一样）；每天都会有点不一样——这就是生活。'));
 }).catch(function(){});
}

/* ── 实况直播（写进给定容器） ── */
function tLiveFeed(box){
 var c=card('她的实况');box.appendChild(c);
 var lv=document.createElement('div');lv.style.gridColumn='1/-1';c.appendChild(lv);
 function load(){api('GET','panel/activity').then(function(r){lv.innerHTML='';lv.appendChild(mut('已收消息 '+(r.inboundCount||0)+' 条 · 最近收信 '+(r.lastInboundAt?new Date(r.lastInboundAt).toLocaleString('zh-CN'):'还没有')));(r.activity||[]).slice(0,50).forEach(function(a){var b=bx();b.innerHTML='<b>'+new Date(a.at).toLocaleTimeString('zh-CN')+'</b> '+esc(a.text);lv.appendChild(b)})}).catch(function(){})}
 load();
 if(TIMER)clearInterval(TIMER);TIMER=setInterval(load,4000);
}

/* ── 试聊（写进给定容器；不真的发到微信） ── */
function tTest(box){
 var c=card('回复预览（真实模型，不发送）');box.appendChild(c);
 var t=document.createElement('input');t.value='在干嘛呢';c.appendChild(f('对她说',t));
 var rec=document.createElement('input');rec.type='checkbox';rec.checked=true;
 var out2=document.createElement('div');out2.style.gridColumn='1/-1';
 var goBtn=btn('让她回','pri',function(b2){b2.disabled=true;b2.textContent='她想…';out2.innerHTML='';
  api('POST','panel/soul-test',{text:t.value,record:rec.checked,peerKey:'room'}).then(function(r){
   (r.chunks||[]).forEach(function(ch){var b=bx();b.innerHTML='<b>她：</b>'+esc(ch);out2.appendChild(b)});
   var bb=bx();bb.className='mut';bb.textContent='大脑: '+(r.backend||'')+' · 心情 '+Math.round(r.mood||0)+' · '+((r.delaysMs||[]).join('/'))+'ms';out2.appendChild(bb);
  }).catch(function(e){out2.appendChild(mut('失败: '+e.message))}).then(function(){b2.disabled=false;b2.textContent='让她回'})});
 c.appendChild(row(rec,document.createTextNode('计入记忆与亲密度'),goBtn));
 c.appendChild(out2);
 c.appendChild(mut('勾选"计入记忆与亲密度"时，这场试聊会进她的记忆（归属 room），跟真聊天一样影响心情与亲密度。'));
}

/* ── 她（人设 v5：分区折叠 + 左侧目录 + 自适应多列 + 状态指标格） ── */
function tPersona(box){
 box.innerHTML='';box.appendChild(mut('加载中…'));
 api('GET','panel/persona').then(function(p0){
  var p=p0.persona;
  box.innerHTML='';
  var SECS=[
   {id:'sec-identity',icon:'🪪',title:'她是谁',desc:'身份 · 背景 · 兴趣 · 说话细节'},
   {id:'sec-traits',icon:'🧠',title:'性格',desc:'MBTI → 八维 → 六维'},
   {id:'sec-rhythm',icon:'⏰',title:'生活节奏',desc:'作息 · 波动 · 概率 · 主动'},
   {id:'sec-status',icon:'🎭',title:'她的状态',desc:'压力 · 变形 · 周结算账本'},
   {id:'sec-world',icon:'🌍',title:'她的世界',desc:'世界引擎 · 天气 · 社交圈'},
   {id:'sec-archive',icon:'💾',title:'存档',desc:'保存与切换'}
  ];
  var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
  wrap.appendChild(tocFor(SECS));
  var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
  var st=mut('改完点「保存人设」立即生效（无版本号）');
  var aname=document.createElement('input');aname.placeholder='给当前人设起个存档名…';aname.style.maxWidth='240px';
  var bar=document.createElement('div');bar.className='card';
  var relLine=mut('关系：读取中…');relLine.style.gridColumn='1/-1';
  var relBtn=btn('去「你们」页看关系','',function(){go('relation')});
  bar.appendChild(row(btn('保存人设','pri',function(b2){doSave(b2)}),aname,btn('存档为…','',function(){doArchive()}),relBtn));
  bar.appendChild(st);bar.appendChild(relLine);
  api('GET','panel/today').then(function(r0){var R=(r0||{}).relation||{};
   relLine.textContent='她与你的关系：'+(R.stage||'刚认识')+'（亲密度 '+(R.affection||0)+'/100'+(R.next?('，再涨 '+R.next.need+' 点到「'+R.next.label+'」'):'')+'）——阶段、称呼、她的日记都在「你们」页。';
  }).catch(function(){relLine.textContent='关系信息读取失败';});
  body.appendChild(bar);
  body.appendChild(mut('💡 大分区默认展开、可整体收起；分区里的每个小项点开才显示内容。左上「本页目录」可一键跳转。'));
  var S={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S[x.id]=sb.body;body.appendChild(sb.el)});
  function doSave(b2){if(b2)b2.disabled=true;api('POST','panel/persona',p).then(function(r2){p=r2.persona;st.className='ok';st.textContent='已保存 ✅ 立即生效'}).catch(function(e){st.className='er';st.textContent='保存失败：'+e.message}).then(function(){if(b2)b2.disabled=false})}
  function doArchive(){if(!aname.value){alert('先起个存档名');return}api('POST','panel/persona',{})&&api('POST','panel/persona/archive',{name:aname.value}).then(function(){st.className='ok';st.textContent='已存档 ✅';aname.value='';loadArch()}).catch(function(e){alert(e.message)})}

  /* ── ① 她是谁 ── */
  var A=S['sec-identity'];
  var it1=itemBlock('基础档案','名字 · 生日 · 城市 · 职业 · 年龄');A.appendChild(it1.el);
  it1.body.appendChild(f('名字',inp(p.name,function(v){p.name=v})));
  it1.body.appendChild(f('生日/星座',inp(p.birthday,function(v){p.birthday=v})));
  it1.body.appendChild(f('城市',inp(p.city,function(v){p.city=v})));
  it1.body.appendChild(f('职业/身份',inp(p.job,function(v){p.job=v})));
  it1.body.appendChild(f('年龄',inp(p.age,function(v){p.age=v})));
  it1.body.appendChild(mut('城市会用在真实天气查询里（她所在城市的阴晴会进她的生活和聊天）。'));
  var it2=itemBlock('背景故事','越具体越像真人');A.appendChild(it2.el);
  var ta=document.createElement('textarea');ta.rows=6;ta.value=p.personaText||'';ta.onchange=function(e){p.personaText=e.target.value};it2.body.appendChild(ta);
  var it3=itemBlock('兴趣与口头禅','逗号分隔');A.appendChild(it3.el);
  it3.body.appendChild(f('兴趣',inp((p.interests||[]).join('，'),function(v){p.interests=v.split(/[,，]/).map(function(x){return x.trim()}).filter(Boolean)})));
  it3.body.appendChild(f('口头禅',inp(((p.quirks||{}).catchphrases||[]).join('，'),function(v){p.quirks=p.quirks||{};p.quirks.catchphrases=v.split(/[,，]/).map(function(x){return x.trim()}).filter(Boolean)})));
  it3.body.appendChild(mut('兴趣会影响她"今天的痴迷话题"；口头禅是她说话时不自觉带的口头语。'));
  var it4=itemBlock('说话细节','表情符号与手滑');A.appendChild(it4.el);
  it4.body.appendChild(f('emoji 比例',inp(Math.round(((p.quirks||{}).emojiRate||0)*100),function(v){p.quirks=p.quirks||{};p.quirks.emojiRate=Math.max(0,Math.min(100,Number(v)||0))/100},'','number')));
  var tq=document.createElement('input');tq.type='range';tq.min=0;tq.max=10;tq.step=1;tq.value=Math.round(((p.quirks||{}).typoRate||0)*100);
  var tql=mut('手滑打错字概率 '+tq.value+'%');
  tq.oninput=function(){tql.textContent='手滑打错字概率 '+tq.value+'%';p.quirks=p.quirks||{};p.quirks.typoRate=Number(tq.value)/100};
  it4.body.appendChild(tql);it4.body.appendChild(tq);
  it4.body.appendChild(mut('emoji 比例只管 😊 这类字符（不是微信表情包）；手滑概率>0 时她会偶尔发错一条、紧接着自己更正"啊打错了"。'));

  /* ── ② 性格 ── */
  var T=S['sec-traits'];
  var TR=[['socialBattery','社交电量','她今天还剩多少跟人说话的力气——低会说去躺会'],['warmth','情感温度','说话的温度：高=暖爱撒娇，低=话少直接'],['attachment','依恋强度','对你的联结需求：高=半小时不回就想你，低=淡定'],['sharpness','批判锐度','吐槽和一针见血的倾向——高=神吐槽，低=哄着你'],['initiative','发起力','主动开话题/分享/拉你干这干那的倾向'],['orderliness','秩序感','生活规律程度——直接控制作息随机的波动幅度']];
  var mt=itemBlock('MBTI 底色','4 字母决定荣格八维功能栈');T.appendChild(mt.el);
  mt.body.appendChild(f('MBTI',inp((p.assessments||{}).mbti||'',function(v){p.assessments=p.assessments||{};p.assessments.mbti=v.toUpperCase()},'如 INFP')));
  mt.body.appendChild(btn('按MBTI重算六维','pri',function(b2){var mi2=mt.body.querySelector('input');if(!mi2.value){alert('先填4字母');return}b2.disabled=true;api('POST','panel/persona',{assessments:{mbti:mi2.value.toUpperCase()}}).then(function(r2){p=r2.persona;go('persona')}).catch(function(e){alert(e.message)}).then(function(){b2.disabled=false})}));
  mt.body.appendChild(mut('底层=荣格八维功能栈（由 4 字母自动推导，永不改变）；六维由功能位置与性质推得，改完还能手动微调。'));
  var t6=itemBlock('六维微调','拖动改变她的性格底色');T.appendChild(t6.el);
  TR.forEach(function(d){var w=document.createElement('div');w.style.gridColumn='1/-1';var lb=document.createElement('label');lb.className='mut';lb.textContent=d[1]+'：'+((p.traits||{})[d[0]]==null?50:p.traits[d[0]])+'% —— '+d[2];w.appendChild(lb);
   var rg=document.createElement('input');rg.type='range';rg.min=5;rg.max=95;rg.value=(p.traits||{})[d[0]]==null?50:p.traits[d[0]];rg.oninput=function(e){lb.textContent=d[1]+'：'+e.target.value+'% —— '+d[2];p.traits=p.traits||{};p.traits[d[0]]=Number(e.target.value)};w.appendChild(rg);t6.body.appendChild(w)});
  t6.body.appendChild(mut('这六个数是"底色"；每天会在这个底色上小幅浮动（首页的 📊 徽章能看到今天飘了多少），长期还会被你们的相处慢慢改写。'));

  /* ── ③ 生活节奏 ── */
  var R=S['sec-rhythm'];var B=p.behavior=p.behavior||{};
  var r1=itemBlock('回复速度与作息','底色与作息基准');R.appendChild(r1.el);
  var spd=document.createElement('select');[['human','拟人（推荐）'],['instant','偏快'],['slow','偏慢热']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];if((B.replySpeed||'human')===o[0])op.selected=true;spd.appendChild(op)});
  spd.onchange=function(e){B.replySpeed=e.target.value};
  r1.body.appendChild(f('回复速度',spd));
  r1.body.appendChild(f('基准起床',inp(B.baseWake||'07:30',function(v){B.baseWake=v.trim()||'07:30'},'07:30')));
  r1.body.appendChild(f('基准睡觉',inp(B.baseSleep||'23:30',function(v){B.baseSleep=v.trim()||'23:30'},'23:30')));
  var r2=itemBlock('每天的人味随机','每天自动掷骰，性格影响概率');R.appendChild(r2.el);
  var jt=document.createElement('input');jt.type='range';jt.min=0;jt.max=600;jt.value=B.jitterMin==null?45:B.jitterMin;var jtl=mut('作息波动 ±'+jt.value+' 分钟（最高±600）');jt.oninput=function(){jtl.textContent='作息波动 ±'+jt.value+' 分钟';B.jitterMin=Number(jt.value)};r2.body.appendChild(jtl);r2.body.appendChild(jt);
  var no=document.createElement('input');no.type='range';no.min=0;no.max=100;no.value=Math.round((B.nightOwlProb==null?0.15:B.nightOwlProb)*100);var nol=mut('夜猫日概率 '+no.value+'%（当天推迟1-3小时睡）');no.oninput=function(){nol.textContent='夜猫日概率 '+no.value+'%';B.nightOwlProb=Number(no.value)/100};r2.body.appendChild(nol);r2.body.appendChild(no);
  var an=document.createElement('input');an.type='range';an.min=0;an.max=100;an.value=Math.round((B.allNighterProb==null?0.03:B.allNighterProb)*100);var anl=mut('熬通宵概率 '+an.value+'%（次日赖床补觉）');an.oninput=function(){anl.textContent='熬通宵概率 '+an.value+'%';B.allNighterProb=Number(an.value)/100};r2.body.appendChild(anl);r2.body.appendChild(an);
  var wk=document.createElement('input');wk.type='range';wk.min=0;wk.max=180;wk.value=B.weekendShiftMin==null?60:B.weekendShiftMin;var wkl=mut('周末起床推迟（上限） '+wk.value+' 分钟');wk.oninput=function(){wkl.textContent='周末起床推迟（上限） '+wk.value+' 分钟';B.weekendShiftMin=Number(wk.value)};r2.body.appendChild(wkl);r2.body.appendChild(wk);
  r2.body.appendChild(mut('周末那个是"上限"，实际每天在 30%~100% 之间随机——所以周末不会每天都一样晚起。'));
  var r3=itemBlock('主动与催促','她多久找你、多久没回她会等');R.appendChild(r3.el);
  r3.body.appendChild(f('每日主动次数',inp(B.activePerDay==null?3:B.activePerDay,function(v){B.activePerDay=Number(v)||3},'3','number')));
  r3.body.appendChild(f('多久没回她会等',inp(B.pokeMinutes==null?30:B.pokeMinutes,function(v){B.pokeMinutes=Number(v)||30},'30','number')));
  r3.body.appendChild(f('每天最多等几次',inp(B.pokeMaxPerDay==null?2:B.pokeMaxPerDay,function(v){B.pokeMaxPerDay=Number(v)||2},'2','number')));
  r3.body.appendChild(mut('「每日主动次数」是基准值，实际每天随机浮动（还受她的发起力影响）；「多久没回她会等」= 你已读不回超过这个分钟数，她才会来催一次。'));
  var foot=document.createElement('div');foot.className='secFoot';
  foot.appendChild(btn('保存生活节奏','pri',function(b2){b2.disabled=true;api('POST','panel/persona',{behavior:B}).then(function(){st.className='ok';st.textContent='生活节奏已保存 ✅ 立即生效'}).catch(function(e){st.className='er';st.textContent='失败：'+e.message}).then(function(){b2.disabled=false})}));
  foot.appendChild(mut('只保存这一块'));
  R.appendChild(foot);

  /* ── ④ 她的状态（指标格） ── */
  var K=S['sec-status'];
  var k1=itemBlock('当前状态','压力 · 状态 · 整合度 · 账本');k1.el.open=true;K.appendChild(k1.el);
  var km=metricsWrap();k1.body.appendChild(km);
  var kExtra=mut('');k1.body.appendChild(kExtra);
  var k2=itemBlock('原理与参数','开关 · 灵敏度 · 三个阈值');K.appendChild(k2.el);
  k2.body.appendChild(mut('底色（认知功能栈）永不变，变的只是压力下的表达。阈值1「劣势爆发」：说话冲、爱较真、说反话，嘴硬不承认；阈值2「反刍循环」：同一件事绕不出来、越说越封闭；阈值3「影子状态」：平时绝不会说的话会冒出来。被哄 −12 / 睡得好 −10 / 每天自然 −15 会减压，平静后逐层退出，那一轮她会自然道歉或自嘲；每缓过来一次整合度 +2（上限 80）——下次更不容易被逼变形。'));
  var DF={enabled:true,sensitivity:1,grip:45,loop:70,shadow:88};
  var dfOn=document.createElement('input');dfOn.type='checkbox';dfOn.checked=true;dfOn.onchange=function(e){DF.enabled=e.target.checked};
  k2.body.appendChild(row(dfOn,document.createTextNode('启用变形状态机（关掉=她永远稳态，压力不再影响回复）')));
  var seR=document.createElement('input');seR.type='range';seR.min=0.2;seR.max=3;seR.step=0.1;seR.value=1;
  var seL=mut('灵敏度 ×1（只放大加压，不影响被哄减压）');
  seR.oninput=function(){DF.sensitivity=Number(seR.value);seL.textContent='灵敏度 ×'+seR.value};
  k2.body.appendChild(seL);k2.body.appendChild(seR);
  [['grip','阈值1·劣势爆发',10,95],['loop','阈值2·反刍循环',20,98],['shadow','阈值3·影子状态',30,100]].forEach(function(t){
   var rg=document.createElement('input');rg.type='range';rg.min=t[2];rg.max=t[3];rg.step=1;
   var lb=mut(t[1]+' '+DF[t[0]]);
   rg.oninput=function(){DF[t[0]]=Number(rg.value);lb.textContent=t[1]+' '+rg.value};
   rg.dataset.k=t[0];
   k2.body.appendChild(lb);k2.body.appendChild(rg);
  });
  k2.body.appendChild(mut('加压事件：被凶/被怼 +18 · 她熬通宵 +25 · 被冷落 +15 · 冲突 +20；加压总量 = 基础值 × 灵敏度。'));
  k2.body.appendChild(btn('保存变形设置','pri',function(b2){b2.disabled=true;api('POST','panel/config',{deform:DF}).then(function(){kExtra.className='ok';kExtra.textContent='变形设置已保存 ✅ 立即生效'}).catch(function(e){alert(e.message)}).then(function(){b2.disabled=false})}));
  api('GET','panel/config').then(function(r2){var d=(r2.config||{}).deform||{};if(d.enabled!==undefined)dfOn.checked=d.enabled!==false;if(d.sensitivity)seR.value=d.sensitivity;if(d.grip)DF.grip=d.grip;if(d.loop)DF.loop=d.loop;if(d.shadow)DF.shadow=d.shadow;
   seL.textContent='灵敏度 ×'+(d.sensitivity||1);
   k2.querySelectorAll('input[type=range][data-k]').forEach(function(rg){var k=rg.dataset.k;if(d[k])rg.value=d[k];var nm={grip:'阈值1·劣势爆发',loop:'阈值2·反刍循环',shadow:'阈值3·影子状态'};rg.previousSibling.textContent=nm[k]+' '+rg.value})}).catch(function(){});
  api('GET','panel/today').then(function(r2){var d=(r2||{}).deform||{},ev=(r2||{}).evolution||{};
   var NM={normal:'正常',grip:'劣势爆发',loop:'反刍循环',shadow:'影子状态'};
   var stt=d.state||'normal';var cls=stt==='normal'?'':(stt==='shadow'?'bad':'warn');
   km.innerHTML='';
   km.appendChild(metric('压力',(d.stress||0)+' <small>/100</small>',bar(d.stress||0,(d.stress>=70?'bad':(d.stress>=45?'warn':'')))));
   km.appendChild(metric('当前状态','<span class="tag '+(cls==='bad'?'bad':(cls==='warn'?'warn':''))+'">'+(NM[stt]||stt)+'</span>'));
   km.appendChild(metric('整合度',(d.integration||0)+' <small>/80</small>',bar(Math.round(((d.integration||0)/80)*100))));
   km.appendChild(metric('生效阈值',((d.thresholds||{}).grip||45)+' / '+((d.thresholds||{}).loop||70)+' / '+((d.thresholds||{}).shadow||88)));
   kExtra.className='mut';
   kExtra.textContent='上次变形：'+(d.lastGripAt?new Date(d.lastGripAt).toLocaleString('zh-CN'):'还没变形过')+'　·　最近事件：'+(d.lastEvent||'—')+String.fromCharCode(10)+'性格周结算账本（每满7天用它微调六维）：本周被哄 '+(ev.warm||0)+' 次 · 被怼 '+(ev.rude||0)+' 次 · 聊了 '+(ev.chats||0)+' 轮';
  }).catch(function(){kExtra.textContent='（加载失败）'});

  /* ── ⑤ 她的世界 ── */
  tWorldItems(S['sec-world']);

  /* ── ⑥ 存档 ── */
  var V=S['sec-archive'];
  var v1=itemBlock('保存与存档','保存立即生效，无版本号堆积');V.appendChild(v1.el);
  v1.body.appendChild(row(btn('保存人设','pri',function(b2){doSave(b2)}),btn('存档为…','',function(){doArchive()}),mut('存档名写在页面顶部输入框')));
  v1.body.appendChild(mut('「保存人设」= 把这一页所有改动写进她（立即生效）；「存档为…」= 把当前整个人设存一份，随时能一键切回去。'));
  var v2=itemBlock('历史存档','点一下切回那个她');V.appendChild(v2.el);
  var alist=document.createElement('div');alist.style.gridColumn='1/-1';v2.body.appendChild(alist);
  function loadArch(){api('GET','panel/persona/archives').then(function(r2){alist.innerHTML='';(r2.archives||[]).forEach(function(a){var b=bx();
    b.innerHTML='<b>'+esc(a.name)+'</b> <span class=mut>'+new Date(a.savedAt).toLocaleString('zh-CN')+' · '+esc(a.personaName||'')+'</span>';
    b.appendChild(row(
     btn('一键切换','pri',function(){api('POST','panel/persona/switch',{id:a.id}).then(function(){go('persona')}).catch(function(e){alert(e.message)})}),
     btn('改名','',function(){var n=window.prompt('新名字：',a.name);if(n)api('POST','panel/persona/rename',{id:a.id,name:n}).then(function(){loadArch()})}),
     btn('删除','dg',function(){if(window.confirm('删除存档「'+a.name+'」？'))api('POST','panel/persona/archive-delete',{id:a.id}).then(loadArch)})
    ));
    alist.appendChild(b);})}).catch(function(){})}
  loadArch();
 }).catch(function(e){box.innerHTML='';box.appendChild(mut('加载失败: '+e.message))});
}

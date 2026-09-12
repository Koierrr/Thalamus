/* ── 记忆（mem0 引擎 · 分区折叠） ── */
function tMemory(box){
 box.innerHTML='';box.appendChild(mut('加载中…'));
 var SECS=[
  {id:'mem-engine',icon:'🔌',title:'引擎',desc:'mem0 / 本地兜底 · 迁移'},
  {id:'mem-bidir',icon:'🔁',title:'双向记忆',desc:'她也记得自己说过什么'},
  {id:'mem-list',icon:'📚',title:'她记得的事',desc:'搜索 · 编辑 · 钉住 · 导出'},
  {id:'mem-extract',icon:'⚙️',title:'提炼设置',desc:'用哪个模型整理记忆'}
 ];
 var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
 wrap.appendChild(tocFor(SECS));
 var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
 var st=mut('');body.appendChild(st);
 var S={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S[x.id]=sb.body;body.appendChild(sb.el)});
 api('GET','panel/mem-engine').then(function(r){
  if(r.running&&r.info&&r.info.ready===false){st.className='er';st.textContent='引擎在跑但还不能用：'+(r.info.reason||'未配置')+' —— 去「大脑」页保存对话模型后 1 分钟内自动恢复'}
  else if(r.running){st.className='ok';st.textContent='mem0 记忆引擎运行中 ✅ '+((r.info&&r.info.llm)?('提炼模型: '+r.info.llm+' · '):'')+'嵌入: '+((r.info&&r.info.embedder)||'bge-m3')}
  else{st.className='er';st.textContent='记忆引擎未运行（本地JSON兜底）— 双击「启动记忆引擎.bat」，或重启DSH时自动拉起'}
 }).catch(function(){});
 Promise.all([api('GET','panel/memory'),loadCfg()]).then(function(rs){
  var view=rs[0]||{};var entries=(view.entries||[]);var cfg=rs[1].config||{};
  if(view.engine==='mem0'){st.className=(st.className==='er'?st.className:'ok');st.textContent=(st.textContent||'')+'　·　记忆 '+entries.length+' 条'}
  box.innerHTML='';box.appendChild(mut('这里是她的记忆库：她记得你说过的事，也记得自己说过的话。'));
  var wrap2=document.createElement('div');wrap2.className='pageWrap';box.appendChild(wrap2);
  wrap2.appendChild(tocFor(SECS));
  var body2=document.createElement('div');body2.className='pageBody';wrap2.appendChild(body2);
  body2.appendChild(st);
  var S2={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S2[x.id]=sb.body;body2.appendChild(sb.el)});

  /* ① 引擎 */
  var e1=itemBlock(view.engine==='mem0'?'mem0 引擎（自动提炼 · 去重合并 · 向量检索）':'本地 JSON（兜底模式）','');S2['mem-engine'].appendChild(e1.el);
  if(view.engine==='mem0'){
   e1.body.appendChild(btn('把旧JSON记忆搬进新引擎','',function(b2){b2.disabled=true;b2.textContent='迁移中…';api('POST','panel/memory/migrate',{}).then(function(r){b2.textContent='✓ 新迁 '+r.added+' 条 · 跳过重复 '+(r.skipped||0)+' 条';setTimeout(function(){b2.textContent='把旧JSON记忆搬进新引擎';b2.disabled=false},2500)}).catch(function(e){b2.textContent='失败';alert(e.message)})}));
   e1.body.appendChild(mut('迁移很安全：幂等去重，重复点只跳过。旧 memory.json 同时作为兜底镜像持续同步（引擎挂了也不丢一条）。'));
   if(view.legacyCount!=null)e1.body.appendChild(mut('本地 JSON 镜像档案：'+view.legacyCount+' 条（每日随数据目录自动备份）'));
  } else {
   e1.body.appendChild(mut('引擎没开时她用旧引擎记事，一切照常，只是没有自动去重和淡忘。'));
  }

  /* ② 双向记忆 */
  var e2=itemBlock('双向记忆','她记得自己说过的话；可关可改');S2['mem-bidir'].appendChild(e2.el);
  e2.body.appendChild(mut('单向记忆只记"你说了什么"，她聊完就断片、前后自相矛盾。双向记忆把她的关键自述（立场/打算/喜好/约定，如"我下周要去趟杭州"）单独归档为「她自己的话」，检索时和"你的事"一起被想起，并在提示词里要求她与自己的话保持一致——这样她才有自己的立场和前后联动。'));
  var selfOn=document.createElement('input');selfOn.type='checkbox';selfOn.checked=(cfg.memory||{}).selfMemory!==false;
  var sNote=mut('');
  selfOn.onchange=function(){api('POST','panel/config',{memory:{selfMemory:selfOn.checked}}).then(function(){sNote.className='ok';sNote.textContent=selfOn.checked?'已开启双向记忆 ✅':'已关闭（她不再记自己的话）'}).catch(function(e){alert(e.message);selfOn.checked=!selfOn.checked})};
  e2.body.appendChild(row(selfOn,document.createTextNode('让她记住自己说过的话（关掉=只记你说的）')));
  e2.body.appendChild(sNote);
  var selfMems=entries.filter(function(e){return e.who==='self'||e.source==='self'});
  if(selfMems.length){
   e2.body.appendChild(mut('她自己的话（共 '+selfMems.length+' 条，最近 8 条）：'));
   selfMems.slice().sort(function(a,b){return b.ts-a.ts}).slice(0,8).forEach(function(e){e2.body.appendChild(mut('· '+e.text+'（'+new Date(e.ts).toLocaleDateString('zh-CN')+'）'))});
   e2.body.appendChild(mut('这些条目在「她记得的事」里也能搜到、能改能删（来源徽章显示 self）。'));
  } else {
   e2.body.appendChild(mut('还没有她自己的话——等她聊到"我要/我打算/我决定/我最近…"这类自己表态的话，就会自动归档一条。'));
  }

  /* ③ 她记得的事 */
  var FILTER='';var ONLYPIN=false;var SORT='time';
  var e3=itemBlock('教她记一件事','你说了她会记住（重要度越高越难忘）');S2['mem-list'].appendChild(e3.el);
  var txt=document.createElement('input');txt.placeholder='例如：主人不吃香菜';
  var imp=document.createElement('input');imp.type='number';imp.min=1;imp.max=5;imp.value=4;imp.style.maxWidth='80px';
  var tags=document.createElement('input');tags.placeholder='标签（逗号分隔，可选）';
  e3.body.appendChild(f('内容',txt));
  e3.body.appendChild(f('重要度',imp));
  e3.body.appendChild(f('标签',tags));
  e3.body.appendChild(btn('记住','pri',function(){if(!txt.value)return;api('POST','panel/memory',{op:'add',text:txt.value,importance:Number(imp.value),tags:tags.value.split(/[,，]/).map(function(x){return x.trim()}).filter(Boolean),who:(FILTER&&FILTER!=='通用')?FILTER:''}).then(function(){go('memory')}).catch(function(e){alert(e.message)})}));
  var e4=itemBlock('记忆列表','搜索 · 过滤 · 排序 · 导出');e4.el.open=true;S2['mem-list'].appendChild(e4.el);
  var q=document.createElement('input');q.placeholder='🔍 搜索（正文和标签都会搜）…';
  e4.body.appendChild(f('搜索',q));
  var pinB=btn('只看📌','',function(){ONLYPIN=!ONLYPIN;pinB.className=ONLYPIN?'pri':'';render()});
  var so=document.createElement('select');[['time','按时间排序'],['imp','按重要度排序']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];so.appendChild(op)});so.onchange=function(){SORT=so.value;render()};
  e4.body.appendChild(f('排序',so));
  var whoChips=document.createElement('div');whoChips.className='chips';whoChips.style.gridColumn='1/-1';
  var whos={};entries.forEach(function(e){var w=(e.who==='self')?'她自己的话':(e.who||'通用');whos[w]=(whos[w]||0)+1});
  Object.keys(whos).forEach(function(w){var b=document.createElement('button');b.className='chip';b.textContent=w+'('+whos[w]+')';b.onclick=function(){FILTER=(FILTER===w)?'':w;render()};whoChips.appendChild(b)});
  e4.body.appendChild(whoChips);
  var ctl=row();
  ctl.appendChild(pinB);
  ctl.appendChild(btn('导出记忆(Markdown)','',function(){var lines=entries.slice().sort(function(a,b){return b.ts-a.ts}).map(function(e){return '- ['+new Date(e.ts).toLocaleDateString('zh-CN')+'] ★'+(e.importance||3)+(e.pinned?' 📌':'')+' '+(e.text||'')+'（'+(e.who||'通用')+'）'});var blob=new Blob(['# 她的记忆\n\n'+lines.join('\n')],{type:'text/markdown'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='her-memories-'+new Date().toISOString().slice(0,10)+'.md';a.click()}));
  e4.body.appendChild(ctl);
  var today=new Date();today.setHours(0,0,0,0);
  e4.body.appendChild(mut('共 '+entries.length+' 条 · 置顶 '+entries.filter(function(e){return e.pinned}).length+' 条 · 今天新增 '+entries.filter(function(e){return e.ts>=today.getTime()}).length+' 条'));
  var list=document.createElement('div');list.style.gridColumn='1/-1';e4.body.appendChild(list);
  function render(){
   list.innerHTML='';
   var kw=q.value.trim();
   var es=entries.filter(function(e){if(FILTER&&(((e.who==='self')?'她自己的话':(e.who||'通用'))!==FILTER))return false;if(ONLYPIN&&!e.pinned)return false;if(kw&&((String(e.text||'').indexOf(kw)<0)&&(((e.tags||[]).join('')).indexOf(kw)<0)))return false;return true});
   es.sort(function(a,b){if(SORT==='imp')return (b.importance||3)-(a.importance||3)||(b.ts-a.ts);return (b.pinned?1:0)-(a.pinned?1:0)||b.ts-a.ts});
   if(!es.length){list.appendChild(mut('没有匹配的记忆。'));return}
   es.forEach(function(e2){
    var b=bx();
    var t2=document.createElement('div');t2.style.display='flex';t2.style.alignItems='center';t2.style.gap='6px';
    var selI=document.createElement('select');selI.style.width='70px';[1,2,3,4,5].forEach(function(n){var op=document.createElement('option');op.value=n;op.textContent='★'+n;if((e2.importance||3)===n)op.selected=true;selI.appendChild(op)});selI.onchange=function(e3){api('POST','panel/memory',{op:'edit',id:e2.id,patch:{importance:Number(e3.target.value)}}).then(function(){go('memory')}).catch(function(x){alert(x.message)})};
    t2.appendChild(selI);
    t2.appendChild(document.createTextNode((e2.pinned?'📌 ':'')+(e2.text||'')));
    if(e2.source){var sb=document.createElement('span');sb.className='mut';sb.textContent='['+e2.source+']';t2.appendChild(sb)}
    b.appendChild(t2);
    b.appendChild(mut(new Date(e2.ts).toLocaleString('zh-CN')+' · '+((e2.who==='self')?'她自己的话':(e2.who||'通用'))+' · '+(((e2.tags||[]).join('/'))||'无标签')));
    var ei=document.createElement('input');ei.style.display='none';ei.value=e2.text;
    b.appendChild(ei);
    b.appendChild(row(
     btn('编辑','',function(b3){if(ei.style.display==='none'){ei.style.display='flex';ei.focus();b3.textContent='保存'}else{api('POST','panel/memory',{op:'edit',id:e2.id,patch:{text:ei.value}}).then(function(){go('memory')}).catch(function(x){alert(x.message)})}}),
     btn(e2.pinned?'取消钉住':'📌 钉住','',function(){api('POST','panel/memory',{op:'pin',id:e2.id}).then(function(){go('memory')})}),
     btn('让她忘掉','dg',function(){api('POST','panel/memory',{op:'delete',id:e2.id}).then(function(){go('memory')})})
    ));
    list.appendChild(b);
   });
  }
  q.oninput=render;
  render();

  /* ④ 提炼设置 */
  var m=cfg.memory||{};
  var e5=itemBlock('用哪个模型整理记忆','可独立于对话接口，省钱用');S2['mem-extract'].appendChild(e5.el);
  var sel=document.createElement('select');[['cloud','云端便宜模型自动提炼（推荐）'],['manual','纯手动（不自动记，最省）']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];if((m.extraction||'cloud')===o[0])op.selected=true;sel.appendChild(op)});
  e5.body.appendChild(f('提炼模式',sel));
  var eb=inp(m.extractionBaseUrl||'',function(v){},'留空=跟对话接口同一家');
  e5.body.appendChild(f('提炼专用 BaseURL',eb));
  var ek=inp(m.extractionApiKey||'',function(v){},'留空=用对话接口的 Key','password');
  e5.body.appendChild(f('提炼专用 Key',ek));
  var em=inp(m.extractionModel||'',function(v){},'留空=用主对话模型');
  e5.body.appendChild(f('提炼模型',em));
  var tk=inp(m.topK||6,function(v){},'6','number');
  e5.body.appendChild(f('每次想起几条',tk));
  var en=inp(m.extractEveryN||1,function(v){},'1','number');
  e5.body.appendChild(f('每几轮整理一次',en));
  var echips=document.createElement('div');echips.className='chips';echips.style.gridColumn='1/-1';
  e5.body.appendChild(echips);
  e5.body.appendChild(btn('拉取模型列表','',function(b2){b2.disabled=true;api('POST','panel/models',{baseURL:eb.value||((cfg.chat||{}).baseURL),apiKey:ek.value||((cfg.chat||{}).apiKey)}).then(function(r){echips.innerHTML='';(r.models||[]).forEach(function(mm){var cc=document.createElement('button');cc.className='chip';cc.textContent=mm.id;cc.onclick=function(){em.value=mm.id};echips.appendChild(cc)});b2.textContent='✓';setTimeout(function(){b2.textContent='拉取模型列表'},2000)}).catch(function(e){alert(e.message)}).then(function(){b2.disabled=false})}));
  e5.body.appendChild(btn('保存记忆设置','pri',function(){api('POST','panel/config',{memory:{extraction:sel.value,extractionBaseUrl:eb.value,extractionApiKey:ek.value,extractionModel:em.value,topK:Number(tk.value)||6,extractEveryN:Number(en.value)||1}}).then(function(r2){cfg=r2.config||cfg;st.className='ok';st.textContent='记忆设置已保存 ✅（引擎自动热重载）'}).catch(function(e){alert(e.message)})}));
  e5.body.appendChild(mut('全部留空=完全跟随对话接口。想省钱就单独填一家便宜 API + 一个便宜模型（如 Qwen2.5-7B）。「每次想起几条」越多越连贯也越费 token；「每几轮整理一次」设 2-3 能明显省 token。'));
 }).catch(function(e){box.innerHTML='';box.appendChild(mut('加载失败: '+e.message))});
}

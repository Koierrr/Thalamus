/* ── 女娲（对话式捏人 · 分区折叠） ── */
function tWorkshop(box){
 box.innerHTML='';
 var SECS=[
  {id:'nw-how',icon:'🧭',title:'怎么用',desc:'三步捏出一个她'},
  {id:'nw-api',icon:'🎭',title:'女娲的 API',desc:'选填，留空跟对话接口'},
  {id:'nw-chat',icon:'💬',title:'和女娲聊',desc:'她主动挖你的需求'},
  {id:'nw-draft',icon:'📝',title:'实时草稿',desc:'聊到哪捏到哪，随时可应用'}
 ];
 var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
 wrap.appendChild(tocFor(SECS));
 var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
 var st=mut('女娲负责把你的想法捏成"她"：人设、外貌、内心、生活节奏、社交圈、秘密、长线目标，捏完一键应用。');body.appendChild(st);
 var S={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S[x.id]=sb.body;body.appendChild(sb.el)});

 /* ① 怎么用 */
 var g1=itemBlock('三步走','');g1.el.open=true;S['nw-how'].appendChild(g1.el);
 g1.body.appendChild(mut('① 在「和女娲聊」里，把你知道的关于"她"的一切说给女娲听——背景/性格/MBTI 测试结果/聊天记录，想到什么说什么，乱都没关系。'));
 g1.body.appendChild(mut('② 女娲会不停追问细节，你答她就捏——「实时草稿」会跟着长（右下方能看到她当前捏成什么样）。'));
 g1.body.appendChild(mut('③ 捏到满意，点草稿底部的应用按钮：人设、外貌、内心、测评、兴趣、口头禅一次性填进去；记忆种子会进 mem0。应用前会自动快照，随时能切回。'));

 /* ② 女娲的 API */
 var g2=itemBlock('女娲的 API','选填：想让她用更会写人设的模型就单独配');S['nw-api'].appendChild(g2.el);
 var cfgW=null;var W0={};
 var wb=inp('',function(v){},'留空=用对话接口');var wk=inp('',function(v){},'','password');var wm=inp('',function(v){},'留空=用对话模型');
 var wchips=document.createElement('div');wchips.className='chips';wchips.style.gridColumn='1/-1';
 api('GET','panel/config').then(function(r2){cfgW=r2.config||{};W0=cfgW.workshop||{};wb.value=W0.baseURL||'';wk.value=W0.apiKey||'';wm.value=W0.model||''}).catch(function(){});
 g2.body.appendChild(f('BaseURL',wb));
 g2.body.appendChild(f('API Key',wk));
 g2.body.appendChild(f('模型',wm));
 g2.body.appendChild(btn('拉取列表','',function(b2){b2.disabled=true;api('POST','panel/models',{baseURL:wb.value||((cfgW||{}).chat||{}).baseURL,apiKey:wk.value||((cfgW||{}).chat||{}).apiKey}).then(function(rr){wchips.innerHTML='';(rr.models||[]).forEach(function(mm){var cc=document.createElement('button');cc.className='chip';cc.textContent=mm.id;cc.onclick=function(){wm.value=mm.id};wchips.appendChild(cc)});b2.textContent='✓';setTimeout(function(){b2.textContent='拉取列表'},2000)}).catch(function(e){alert(e.message)}).then(function(){b2.disabled=false})}));
 g2.body.appendChild(wchips);
 g2.body.appendChild(btn('保存女娲API','pri',function(){api('POST','panel/config',{workshop:{baseURL:wb.value,apiKey:wk.value,model:wm.value}}).then(function(){st.className='ok';st.textContent='女娲 API 已保存 ✅（这条专线失败会自动回落对话接口）'}).catch(function(e){alert(e.message)})}));
 g2.body.appendChild(mut('想给女娲配个更会写人设的模型（如 DeepSeek-V4 全血版）就单独填；不填就跟着对话接口走。'));

 /* ③ 和女娲聊 */
 var g3=itemBlock('对话区','');g3.el.open=true;S['nw-chat'].appendChild(g3.el);
 var SID=localStorage.getItem('ws-sid')||'';var DRAFT=null;
 var bar=row();var sess=document.createElement('select');sess.style.maxWidth='340px';bar.appendChild(f('会话',sess));
 bar.appendChild(btn('＋新对话','pri',function(){api('POST','panel/workshop/sessions/new',{}).then(function(r2){SID=r2.session.id;localStorage.setItem('ws-sid',SID);loadSession(SID);loadSessions(false)}).catch(function(e){alert(e.message)})}));
 bar.appendChild(btn('删除当前','dg',function(){if(!SID)return;if(!window.confirm('确定删除这个会话？聊天记录和草稿都会消失。'))return;api('POST','panel/workshop/sessions/delete',{id:SID}).then(function(){SID='';localStorage.removeItem('ws-sid');MSG.innerHTML='';DRAFT=null;drawDraft();loadSessions(true)}).catch(function(e){alert(e.message)})}));
 g3.body.appendChild(bar);
 var MSG=document.createElement('div');
 MSG.style.cssText='grid-column:1/-1;border:1px solid #e6e9ec;border-radius:10px;background:#fafbfc;min-height:240px;max-height:460px;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px';
 g3.body.appendChild(MSG);
 var inrow=row();var tin=document.createElement('input');tin.placeholder='对女娲说点什么…（回车发送）';tin.style.flex='1';
 tin.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();send()}};inrow.appendChild(tin);
 var sendB=btn('发送','pri',function(){send()});inrow.appendChild(sendB);g3.body.appendChild(inrow);

 /* ④ 实时草稿 */
 var g4=itemBlock('女娲当前捏的草稿','');g4.el.open=true;S['nw-draft'].appendChild(g4.el);
 var dc=document.createElement('div');dc.style.gridColumn='1/-1';g4.body.appendChild(dc);

 function bubble(who,t){var b=bx();b.innerHTML='<b>'+esc(who)+'</b>　'+esc(t);MSG.appendChild(b);MSG.scrollTop=MSG.scrollHeight}
 function drawDraft(){dc.innerHTML='';
  if(!DRAFT||!Object.keys(DRAFT).length){dc.appendChild(mut('女娲还没开始捏——先在上方跟她聊几句，这里会实时长出人设草稿。'));return}
  dc.appendChild(mut('名字: '+(DRAFT.name||'—')+' · 生日: '+(DRAFT.birthday||'—')+' · 城市: '+(DRAFT.city||'—')+' · 职业: '+(DRAFT.job||'—')+' · 年龄: '+(DRAFT.age||'—')));
  if(DRAFT.personaText)dc.appendChild(mut('背景: '+String(DRAFT.personaText).slice(0,200)));
  var A=DRAFT.assessments||{};
  var al='测评: '+(A.mbti||'')+(A.functions?('（'+A.functions+'）'):'');
  if(al!=='测评: ')dc.appendChild(mut(al));
  var AP=DRAFT.appearance||{};
  if(Object.keys(AP).length)dc.appendChild(mut('外貌: '+[['face',AP.face],['hair',AP.hair],['style',AP.style],['body',AP.body],['vibe',AP.vibe]].filter(function(x){return x[1]}).map(function(x){return x[0]+':'+x[1]}).join(' · ')));
  dc.appendChild(mut('兴趣: '+((DRAFT.interests||[]).join('、')||'—')+' · 口头禅: '+(((DRAFT.quirks||{}).catchphrases||[]).join('、')||'—')+' · 红线: '+((DRAFT.redLines||[]).join('、')||'—')));
  var IN=DRAFT.inner||{};
  if(Object.keys(IN).length)dc.appendChild(mut('内心: '+[['desire',IN.desire],['fear',IN.fear],['values',IN.values],['quirk',IN.quirk]].filter(function(x){return x[1]}).map(function(x){return x[0]+':'+x[1]}).join(' · ')));
  dc.appendChild(mut('记忆种子 '+(DRAFT.memorySeeds||[]).length+' 条 · 风格样例 '+(DRAFT.styleExamples||[]).length+' 条'));
  var B=DRAFT.behavior||{};var BB=B.behavior||{};var BL=B.life||{};
  if(BB.replySpeed||BL.pokesPerDay!=null)dc.appendChild(mut('行为建议: 回复速度 '+(BB.replySpeed||'—')+' · 拆条 '+(BB.chunkMax||'—')+' · 每日主动 '+(BL.pokesPerDay==null?'—':BL.pokesPerDay)+' 次'+(BL.wake?(' · 作息 '+BL.wake+'~'+(BL.sleep||'')):'')));
  var acts=row(btn('① 应用到人设（含测评/外貌/内心）+ 导入记忆','pri',function(){api('POST','panel/workshop/apply',{draft:DRAFT}).then(function(r2){st.className='ok';st.textContent='已应用 ✅（'+r2.seeds+' 条记忆种子进 mem0；应用前已自动快照，可回滚）'}).catch(function(e){st.className='er';st.textContent='失败: '+e.message})}));
  if(BB.replySpeed||BL.pokesPerDay!=null)acts.appendChild(btn('② 行为建议写进人设','',function(){api('POST','panel/persona',{behavior:{replySpeed:BB.replySpeed,baseWake:BL.wake,baseSleep:BL.sleep,activePerDay:BL.pokesPerDay}}).then(function(){st.className='ok';st.textContent='行为建议已写进人设 ✅'}).catch(function(e){st.className='er';st.textContent='失败: '+e.message})}));
  dc.appendChild(acts);
  dc.appendChild(mut('随时继续和女娲聊着改；应用后可以在「她→存档」里切回旧版本。'));
 }
 function send(){var t=tin.value.trim();if(!t)return;tin.value='';bubble('你',t);st.className='mut';st.textContent='女娲捏人中…（约10-30秒）';sendB.disabled=true;
  api('POST','panel/workshop/chat',{sessionId:SID,message:t}).then(function(r){SID=r.sessionId;localStorage.setItem('ws-sid',SID);DRAFT=r.draft||DRAFT;bubble('女娲',r.reply||'…');drawDraft();st.textContent='';loadSessions()}).catch(function(e){st.className='er';st.textContent=e.message}).then(function(){sendB.disabled=false})}
 function loadSessions(auto){api('GET','panel/workshop/sessions').then(function(r){
  var list=r.sessions||[];sess.innerHTML='';
  list.forEach(function(s2){var op=document.createElement('option');op.value=s2.id;op.textContent=(s2.title||'新造人')+' · '+new Date(s2.updatedAt).toLocaleString('zh-CN');if(s2.id===SID)op.selected=true;sess.appendChild(op)});
  sess.onchange=function(){loadSession(sess.value)};
  if(!auto)return;
  if(SID&&list.some(function(s2){return s2.id===SID})){loadSession(SID)}
  else if(list.length){loadSession(list[0].id)}
  else{api('POST','panel/workshop/sessions/new',{}).then(function(r2){SID=r2.session.id;localStorage.setItem('ws-sid',SID);loadSession(SID);loadSessions(false)}).catch(function(e){st.textContent=e.message})}
 }).catch(function(e){st.textContent=e.message})}
 function loadSession(id){SID=id;localStorage.setItem('ws-sid',id);api('GET','panel/workshop/session?id='+encodeURIComponent(id)).then(function(r){MSG.innerHTML='';var ss=r.session||{};(ss.messages||[]).forEach(function(m2){bubble(m2.role==='user'?'你':'女娲',m2.text)});DRAFT=ss.draft||null;drawDraft()}).catch(function(e){st.textContent=e.message})}
 loadSessions(true);
}
function h3t(t){var d=document.createElement('div');d.style.fontWeight='600';d.textContent=t;return d}

/* ── 你们 = 关系阶段 + 称呼 + 她的日记 + 画像 + 名单（分区折叠） ── */
function tRelation(box){
 box.innerHTML='';box.appendChild(mut('加载中…'));
 var SECS=[
  {id:'rel-stage',icon:'💞',title:'关系阶段',desc:'亲密度推着阶段自动走'},
  {id:'rel-call',icon:'🏷️',title:'称呼与关系',desc:'她怎么叫你 · 你叫她什么'},
  {id:'rel-diary',icon:'📔',title:'她的日记',desc:'偷看她的真心话'},
  {id:'rel-portrait',icon:'🪞',title:'她眼中的你',desc:'她会按这个对待你'},
  {id:'rel-list',icon:'👥',title:'名单与范围',desc:'主人 · 黑名单 · 回复范围'}
 ];
 var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
 wrap.appendChild(tocFor(SECS));
 var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
 var st=mut('这里是她和你之间的关系：阶段、称呼、她的日记、她对你的印象、以及谁能跟她说话。');body.appendChild(st);
 var S={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S[x.id]=sb.body;body.appendChild(sb.el)});

 /* ① 关系阶段 */
 var r1=itemBlock('当前阶段','她与你的关系走到哪一步');r1.el.open=true;S['rel-stage'].appendChild(r1.el);
 var mw=metricsWrap();r1.body.appendChild(mw);
 var rnote=mut('读取中…');r1.body.appendChild(rnote);
 var rtbl=document.createElement('div');rtbl.style.gridColumn='1/-1';r1.body.appendChild(rtbl);
 r1.body.appendChild(mut('阶段只由亲密度决定，不用手动设置；她对你的称呼会跟着阶段自然变（刚认识叫名字 → 暧昧开始试探昵称 → 恋人用专属昵称）。'));
 api('GET','panel/today').then(function(r0){
  var R=(r0||{}).relation||{};var aff=R.affection||0;
  mw.innerHTML='';
  mw.appendChild(metric('当前阶段','<span class="tag">'+esc(R.stage||'刚认识')+'</span>'));
  mw.appendChild(metric('亲密度',aff+' <small>/100</small>',bar(aff)));
  mw.appendChild(metric('她的心情',(R.mood||0)+' <small>/100</small>',bar(R.mood||0)));
  mw.appendChild(metric('已聊',(R.chats||0)+' <small>次</small>'));
  var days=R.firstSeen?Math.max(1,Math.round((Date.now()-R.firstSeen)/86400000)):0;
  mw.appendChild(metric('认识',(days?days+' <small>天</small>':'<small>还没开始</small>')));
  mw.appendChild(metric('称呼方式',esc(R.callHint||'—')));
  if(!R.hasOwner){rnote.className='er';rnote.textContent='⚠️ 还没指定主人：去下面「名单与范围」里点一下你的 ID 戴上👑，这里才会开始算关系。'}
  else if(R.next){rnote.className='mut';rnote.textContent='现在处在「'+(R.stage||'')+'」；再涨 '+R.next.need+' 点亲密度就进入「'+R.next.label+'」，称呼也会跟着变。'}
  else {rnote.className='ok';rnote.textContent='已经走到最后一段「恋人」了。'}
  var rows=(R.stages||[]).map(function(s2){return {cells:[s2.min, s2.label, s2.callHint], cur:(s2.label===R.stage)}});
  if(rows.length)rtbl.appendChild(tbl(['亲密度门槛','阶段','称呼方式'],rows));
 }).catch(function(){rnote.textContent='（加载失败）'});

 /* ①b 所有联系人 */
 var rc2=itemBlock('所有联系人','她也跟别人来往——这里是每个人的数据');S['rel-stage'].appendChild(rc2.el);
 var rclist=mut('加载中…');rc2.body.appendChild(rclist);
 Promise.all([api('GET','panel/memory'),api('GET','panel/config')]).then(function(rs){
  var REL=(rs[0]||{}).relations||{};var o=((rs[1]||{}).config||{}).ownerPeerId||'';
  var keys=Object.keys(REL);
  if(!keys.length){rclist.textContent='还没有联系人数据——等她收到消息后这里会有记录。';return}
  rclist.innerHTML='';
  keys.forEach(function(k){var R=REL[k]||{};var isOwn=!!(o&&(k===o||k.endsWith(':'+o)));
   rclist.appendChild(mut((isOwn?'👑 ':'')+k+'　亲密度 '+Math.round(R.affection||0)+'/100　心情 '+Math.round(R.mood||0)+'/100　已聊 '+(R.chats||0)+' 次'))});
  rc2.body.appendChild(mut('只有主人会计算关系阶段；其他人她按普通朋友对待。'));
 }).catch(function(){rclist.textContent='（加载失败）'});

 /* ② 称呼与关系 */
 var r2=itemBlock('称呼','她怎么叫你、你叫她什么');S['rel-call'].appendChild(r2.el);
 api('GET','panel/persona').then(function(p0){
  var PER=(p0&&p0.persona)?p0.persona:{};var rc=PER.relationship=PER.relationship||{};
  r2.body.appendChild(f('专属昵称',inp(rc.callOwner||'',function(v){rc.callOwner=v})));
  var lk=document.createElement('input');lk.type='checkbox';lk.checked=!!rc.callLock;lk.onchange=function(e){rc.callLock=e.target.checked};
  r2.body.appendChild(row(lk,document.createTextNode('锁定称呼：不管关系到哪一步，都用上面的昵称')));
  r2.body.appendChild(f('她希望你叫她',inp(rc.ownerCallsMe||'',function(v){rc.ownerCallsMe=v})));
  r2.body.appendChild(mut('专属昵称到「恋人」阶段才会叫出口，这里填的是替她想好的那个；「她希望你叫她」是她的偏好，不随阶段变。'));
  r2.body.appendChild(btn('保存称呼设置','pri',function(b2){b2.disabled=true;api('POST','panel/persona',{relationship:rc}).then(function(){st.className='ok';st.textContent='称呼设置已保存 ✅ 立即生效'}).catch(function(e){st.className='er';st.textContent='失败：'+e.message}).then(function(){b2.disabled=false})}));
 }).catch(function(){});

 /* ③ 她的日记 */
 var r3=itemBlock('她的日记','世界引擎每晚替她写（第一人称真心话）');S['rel-diary'].appendChild(r3.el);
 var diaryBox=document.createElement('div');diaryBox.style.gridColumn='1/-1';r3.body.appendChild(diaryBox);
 api('GET','panel/today').then(function(r0){
  var W=(r0||{}).world||{};diaryBox.innerHTML='';
  if(W.diary){
   var d=bx();d.innerHTML='<b>📅 '+esc(W.date||'')+'</b>';diaryBox.appendChild(d);
   var t=document.createElement('div');t.textContent=W.diary;t.style.lineHeight='1.8';diaryBox.appendChild(t);
   diaryBox.appendChild(mut('这是她写给自己看的，不是给你看的——你可以偷看，但别在聊天里直接背出来。'));
  } else {
   diaryBox.appendChild(mut('还没有日记。'));
   diaryBox.appendChild(mut('原因通常是：①世界引擎还没配置自己的 API（「她」页底部配）；②她还没进过睡眠窗口（睡着后才会写）。'));
   diaryBox.appendChild(mut('配好 API 后，点「她」页世界引擎里的「立即生成一次世界」可以马上试跑一篇。'));
  }
 }).catch(function(){diaryBox.appendChild(mut('（加载失败）'))});

 /* ④ 她眼中的你 */
 var r4=itemBlock('她眼中的你（画像）','世界引擎每晚结合聊天重写');S['rel-portrait'].appendChild(r4.el);
 var pi=document.createElement('textarea');pi.rows=3;pi.placeholder='她眼里的你是什么样的人（世界引擎每晚重写；你也可以手动改）';
 api('GET','panel/portrait').then(function(r0){pi.value=(r0||{}).portrait||''}).catch(function(){});
 r4.body.appendChild(pi);
 r4.body.appendChild(btn('保存画像','pri',function(b2){b2.disabled=true;api('POST','panel/portrait',{portrait:pi.value}).then(function(){st.className='ok';st.textContent='画像已保存 ✅（明晚会被世界引擎重写）'}).catch(function(e){alert(e.message)}).then(function(){b2.disabled=false})}));
 r4.body.appendChild(mut('这段文字会直接注入她的对话提示——她怎么待你，很大一部分取决于它。'));

 /* ⑤ 名单与范围 */
 var r5=itemBlock('回复范围','陌生人要不要理');S['rel-list'].appendChild(r5.el);
 var r6=itemBlock('谁是主人（👑）','她最在意的那个人');S['rel-list'].appendChild(r6.el);
 var r7=itemBlock('黑名单','这些人的消息她静默忽略');S['rel-list'].appendChild(r7.el);
 Promise.all([api('GET','status'),api('GET','panel/config')]).then(function(rs){
  var s2=rs[0]||{};var cfg=(rs[1]||{}).config||{};
  var cb=document.createElement('input');cb.type='checkbox';cb.checked=cfg.replyToAll!==false;
  cb.onchange=function(){api('POST','panel/config',{replyToAll:cb.checked}).then(function(){drawStop()}).catch(function(){})};
  r5.body.appendChild(row(cb,document.createTextNode('回复所有人（陌生人的消息她也会回）')));
  r5.body.appendChild(mut('关掉的话，她只回主人和白名单里的人。'));
  var chips=document.createElement('div');chips.className='chips';chips.style.gridColumn='1/-1';r6.body.appendChild(chips);
  var known=s2.knownPeers||[];
  if(!known.length)r6.body.appendChild(mut('还没有人给她发过消息。等她收到第一条消息后，这里会出现 ID，点一下就能指定主人。'));
  known.forEach(function(p){var b=document.createElement('button');b.className='chip'+(cfg.ownerPeerId===p?' on':'');b.textContent=(cfg.ownerPeerId===p?'👑 ':'')+p;
   b.onclick=function(){api('POST','panel/config',{ownerPeerId:cfg.ownerPeerId===p?'':p}).then(function(){go('relation')}).catch(function(){})};chips.appendChild(b)});
  r6.body.appendChild(mut('主人享受：永远特殊对待、关系阶段只对主人计算、安静时段也回他。'));
  var chips2=document.createElement('div');chips2.className='chips';chips2.style.gridColumn='1/-1';r7.body.appendChild(chips2);
  (cfg.blocklist||[]).forEach(function(p){var b=document.createElement('button');b.className='chip';b.textContent=p+' ✕';b.onclick=function(){api('POST','panel/config',{blocklist:(cfg.blocklist||[]).filter(function(x){return x!==p})}).then(function(){go('relation')})};chips2.appendChild(b)});
  var bi=document.createElement('input');bi.placeholder='输入 ID 后回车加入';bi.style.maxWidth='240px';
  bi.onkeydown=function(e){if(e.key==='Enter'&&bi.value.trim()){api('POST','panel/config',{blocklist:(cfg.blocklist||[]).concat([bi.value.trim()])}).then(function(){go('relation')})}};
  chips2.appendChild(bi);
  r7.body.appendChild(mut('黑名单里的人给她发消息，她一个字都不会回（也不会记进记忆）。'));
 }).catch(function(e){r5.body.appendChild(mut('（加载失败：'+e.message+'）'))});
}

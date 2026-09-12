/* ── 大脑 = 模型（分区折叠） ── */
function tModels(box){
 box.innerHTML='';box.appendChild(mut('加载中…'));
 loadCfg().then(function(c){
  var SECS=[
   {id:'ai-chat',icon:'🧠',title:'对话接口',desc:'她的大脑（必填）'},
   {id:'ai-other',icon:'🧩',title:'其他接口',desc:'生图 · 语音 · 识图 · 向量（可选）'},
   {id:'ai-params',icon:'🎛️',title:'通用参数',desc:'温度 · 语音条比例'}
  ];
  var ROLES=[['image','② 生图接口','朋友圈配图、她拍生活照用；暂未上线，可先留空',[]],['tts','③ 语音合成 TTS','暂不使用：当前通道发不了语音（代码已就绪）',[['voice','音色（可选）']]],['asr','④ 语音识别 ASR','暂不使用：通道收语音待验证',[]],['vision','⑤ 识图 VLM','她看得见你发的图片',[]],['embed','⑥ 记忆向量','整理她的记忆用；本地 Ollama 或云端接口',[['source','向量来源：local=本地Ollama / api=云端','sourceSelect']]]];
  var cur0=(CFG.chat)||{};
  box.innerHTML='';
  var wrap=document.createElement('div');wrap.className='pageWrap';box.appendChild(wrap);
  wrap.appendChild(tocFor(SECS));
  var body=document.createElement('div');body.className='pageBody';wrap.appendChild(body);
  var st=mut('六个接口互相独立；留空 BaseURL/Key 的接口自动沿用①对话接口（同一家只填一次）。可混搭多家。');body.appendChild(st);
  var S={};SECS.forEach(function(x){var sb=secBlock(x.id,x.icon,x.title,x.desc);S[x.id]=sb.body;body.appendChild(sb.el)});

  function pullBtn(getBase,getKey,onIds){return btn('拉取列表','',function(b2){b2.disabled=true;api('POST','panel/models',{baseURL:getBase(),apiKey:getKey()}).then(function(r){var ids=(r.models||[]).map(function(m){return m.id});onIds(ids);b2.textContent='✓ '+ids.length+'个';setTimeout(function(){b2.textContent='拉取列表'},2000)}).catch(function(e){alert(e.message)}).then(function(){b2.disabled=false})})}
  function chipsBox(){var d=document.createElement('div');d.className='chips';d.style.gridColumn='1/-1';return d}

  /* ① 对话接口 */
  var i1=itemBlock('对话接口 · 她的大脑','必填：填一次就能用');i1.el.open=true;S['ai-chat'].appendChild(i1.el);
  var chat=CFG.chat=Object.assign({},cur0);
  i1.body.appendChild(f('BaseURL',inp(chat.baseURL,function(v){chat.baseURL=v},'https://api.siliconflow.cn')));
  i1.body.appendChild(f('API Key',inp(chat.apiKey,function(v){chat.apiKey=v},'','password')));
  var cInp=inp(chat.model,function(v){chat.model=v});
  i1.body.appendChild(f('模型名',cInp));
  i1.body.appendChild(pullBtn(function(){return chat.baseURL},function(){return chat.apiKey},function(ids){cChips.innerHTML='';ids.forEach(function(m){var c2=document.createElement('button');c2.className='chip';c2.textContent=m;c2.onclick=function(){cInp.value=m;chat.model=m};cChips.appendChild(c2)})}));
  var cChips=chipsBox();i1.body.appendChild(cChips);
  i1.body.appendChild(mut('这是她聊天用的大脑。填好 BaseURL+Key → 点「拉取列表」→ 点模型芯片填入 → 拉到最下面保存。'));

  /* ② 其他接口 */
  ROLES.forEach(function(rd){
   var role=rd[0],title=rd[1],note=rd[2],extra=rd[3];
   var ii=itemBlock(title,note);S['ai-other'].appendChild(ii.el);
   var cur=CFG[role]||{};
   if(role==='embed'){cur=Object.assign({source:'local',url:'http://127.0.0.1:11434',model:'bge-m3'},cur)}
   ii.body.appendChild(f('BaseURL',inp(cur.baseURL,function(v){cur.baseURL=v},'留空=沿用对话接口')));
   ii.body.appendChild(f('API Key',inp(cur.apiKey,function(v){cur.apiKey=v},'留空=沿用对话接口','password')));
   var mInp=inp(cur.model,function(v){cur.model=v});
   ii.body.appendChild(f('模型名',mInp));
   ii.body.appendChild(pullBtn(function(){return cur.baseURL||((CFG.chat||{}).baseURL)},function(){return cur.apiKey||((CFG.chat||{}).apiKey)},function(ids){chips.innerHTML='';ids.forEach(function(m){var c2=document.createElement('button');c2.className='chip';c2.textContent=m;c2.onclick=function(){mInp.value=m;cur.model=m};chips.appendChild(c2)})}));
   var chips=chipsBox();ii.body.appendChild(chips);
   extra.forEach(function(ex){
    if(ex[2]==='sourceSelect'){
     var s2=document.createElement('select');[['local','本地 Ollama（隐私最优）'],['api','云端接口（OpenAI兼容）']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];if(cur.source===o[0])op.selected=true;s2.appendChild(op)});
     s2.onchange=function(e){cur.source=e.target.value};
     ii.body.appendChild(f('向量来源',s2));
     ii.body.appendChild(f('Ollama 地址',inp(cur.url,function(v){cur.url=v},'http://127.0.0.1:11434')));
     ii.body.appendChild(f('嵌入模型',inp(cur.model,function(v){cur.model=v},'bge-m3')));
    } else { ii.body.appendChild(f(ex[1],inp(cur[ex[0]],function(v){cur[ex[0]]=v}))) }
   });
   CFG[role]=cur;
  });

  /* ③ 通用参数 */
  var i3=itemBlock('通用参数','影响她说话的发挥与语音条');S['ai-params'].appendChild(i3.el);
  var t1=document.createElement('input');t1.type='range';t1.min=0;t1.max=2;t1.step=0.05;t1.value=(CFG.params&&CFG.params.temperature)||0.8;var t1v=Number(t1.value);
  var l1=mut('temperature '+t1v);
  t1.oninput=function(){t1v=Number(t1.value);l1.textContent='temperature '+t1v};
  i3.body.appendChild(l1);i3.body.appendChild(t1);
  i3.body.appendChild(mut('温度越高她越天马行空、越低越稳；0.8 左右最像人。'));
  var t2=document.createElement('input');t2.type='range';t2.min=0;t2.max=100;t2.step=5;t2.value=Math.round(((CFG.behavior||{}).voiceRate||0)*100);var t2v=Number(t2.value);
  var l2=mut('语音条比例 '+t2v+'%');
  t2.oninput=function(){t2v=Number(t2.value);l2.textContent='语音条比例 '+t2v+'%'};
  i3.body.appendChild(l2);i3.body.appendChild(t2);
  i3.body.appendChild(mut('暂不使用：当前通道发不出语音，代码已就绪，通道支持后打开即可。'));
  var sv=btn('保存全部模型配置','pri',function(){sv.disabled=true;api('POST','panel/config',{chat:CFG.chat,image:CFG.image,tts:CFG.tts,asr:CFG.asr,vision:CFG.vision,embed:CFG.embed,params:{temperature:t1v},behavior:{voiceRate:t2v/100}}).then(function(){st.className='ok';st.textContent='模型配置已保存 ✅ 立即生效';sv.textContent='已保存 ✅';setTimeout(function(){sv.textContent='保存全部模型配置';sv.disabled=false},1500)}).catch(function(e){alert(e.message);sv.disabled=false})});
  S['ai-params'].appendChild(sv);
  var foot=document.createElement('div');foot.className='secFoot';foot.appendChild(mut('提示：世界引擎的 API 不在这一页——它是「她」页底部单独的一套（必须独立）。'));S['ai-params'].appendChild(foot);
 }).catch(function(e){box.innerHTML='';box.appendChild(mut('加载失败: '+e.message))});
}

/* ── 世界引擎（「她」页内的小项化；必须独立配置，不跟对话接口共用） ── */
function tWorldItems(host){
 /* ① API */
 var itA=itemBlock('世界引擎 API','必填：她世界的独立大脑');host.appendChild(itA.el);
 var a=itA.body;
 a.appendChild(mut('世界引擎是替她"造世界"的另一个大脑：每晚她睡着后写日记、排第二天的作息/心情/痴迷/天气/生活流水、更新"她眼中的你"、每满 7 天做一次性格结算。建议用和对话接口不同家/不同型号的模型——它绝不蹭对话接口、也绝不回落过去。'));
 var wst=mut('检查中…');a.appendChild(wst);
 var W0={};
 var web=inp('',function(v){W0.baseURL=v.trim()},'必填：如 https://api.siliconflow.cn');
 var wek=inp('',function(v){W0.apiKey=v},'','password');
 var wem=inp('',function(v){W0.model=v},'必填：给她世界选个模型');
 api('GET','panel/config').then(function(r2){var W2=(r2.config||{}).world||{};W0=Object.assign({baseURL:'',apiKey:'',model:''},W2);web.value=W0.baseURL;wek.value=W0.apiKey;wem.value=W0.model;
  if(W0.baseURL&&W0.model){wst.className='ok';wst.textContent='✅ 已配置独立 API · 模型 '+W0.model}else{wst.className='er';wst.textContent='⚠️ 还没配置——不配置她今晚就没有剧本（作息心情走随机兜底）'}}).catch(function(){});
 a.appendChild(f('BaseURL',web));
 a.appendChild(f('API Key',wek));
 a.appendChild(f('模型',wem));
 var wchips=document.createElement('div');wchips.className='chips';a.appendChild(wchips);
 a.appendChild(btn('拉取模型列表','',function(b2){b2.disabled=true;api('POST','panel/models',{baseURL:web.value,apiKey:wek.value}).then(function(r2){wchips.innerHTML='';(r2.models||[]).forEach(function(mm){var cc=document.createElement('button');cc.className='chip';cc.textContent=mm.id;cc.onclick=function(){wem.value=mm.id;W0.model=mm.id};wchips.appendChild(cc)});b2.textContent='✓ '+(r2.models||[]).length+'个';setTimeout(function(){b2.textContent='拉取模型列表'},2000)}).catch(function(e){alert(e.message)}).then(function(){b2.disabled=false})}));
 var saveW=btn('保存世界引擎API','pri',function(){if(!web.value.trim()||!wem.value.trim()){alert('世界引擎必须填自己的 BaseURL 和模型（不跟对话接口共用）');return}api('POST','panel/config',{world:{baseURL:web.value,apiKey:wek.value,model:wem.value}}).then(function(){wst.className='ok';wst.textContent='✅ 已保存 · 模型 '+wem.value;saveW.textContent='已保存 ✅';setTimeout(function(){saveW.textContent='保存世界引擎API'},2000)}).catch(function(e){alert(e.message)})});
 var genW=btn('立即生成一次世界','',function(){if(!web.value.trim()||!wem.value.trim()){alert('先填好并保存世界引擎的 BaseURL 和模型');return}genW.disabled=true;genW.textContent='生成中…（约10-30秒）';api('POST','panel/world/generate',{}).then(function(){genW.textContent='✅ 已生成';setTimeout(function(){genW.textContent='立即生成一次世界';genW.disabled=false},3000)}).catch(function(e){genW.textContent='失败';genW.disabled=false;alert(e.message)})});
 a.appendChild(row(saveW,genW));

 /* ② 说明（纯文字，不放任何动态数据） */
 var itD=itemBlock('世界引擎是干什么的','纯说明：12 项产出 / 联动 / 成本');host.appendChild(itD.el);
 var d=itD.body;
 d.appendChild(mut('【一句话】世界引擎 = 替她"过日子"的另一个大脑。她睡着后它醒着，把她的世界往前推一格；第二天她几点起、心情如何、聊什么、身边发生什么，都是它昨晚定好的剧本。'));
 d.appendChild(mut('【为什么要独立一个模型】它干的是"编剧"的活：要记住她的人设、这周的相处、昨天的日记，还要写得像真的生活。这和"即时聊天"是两种任务——所以给它单独一套 API，互不干扰、各花各的钱；坏掉那晚就当她"没做上梦"（作息心情回到随机兜底）。'));
 d.appendChild(mut('【每晚产出 12 样】① 私人日记 ② 明天起床/睡觉时间（与剧情自洽：熬夜赶稿→次日赖床）③ 心情基线 ④ 痴迷话题 ⑤ 生活流水 2-4 件 ⑥ 心里冒的念头 ⑦ 藏着的小秘密 ⑧ 虚构社交圈 NPC ⑨ 长线小心思 ⑩ 明天天气 ⑪ 重写"她眼中的你" ⑫ 每满 7 天的性格周结算。'));
 d.appendChild(mut('【性格周结算】满 7 天触发：读这一周"被哄/被怼/聊了多少轮"（账本在「她」页的「她的状态」里），微调六维（合计 ≤±5），并写一句第一人称成长理由进记忆。铁律：只动表达层，绝不违背她的 MBTI 认知类型——她是"被养成"，不是"换个人"。'));
 d.appendChild(mut('【和别的系统怎么联动】作息/心情/痴迷 → 被「每日随机系统」采用（首页 🌍 = 今天是她写出来的）；流水与成长理由 → 进她的记忆；社交圈/念头/秘密/长线 → 注入聊天提示词；画像 → 注入"她对你的印象"；天气 → 影响心情与穿搭话题。'));
 d.appendChild(mut('【运转规则与成本】每晚只跑一次（进入她的睡眠窗口后触发）；未配置 = 今晚没剧本；专线失败后 30 分钟内不重试；「立即生成一次世界」可随时强制跑一次。成本：一晚约 1-2 千 token。'));

 /* ③ 运行状态（动态数据集中在这里） */
 var itS=itemBlock('运行状态 · 上帝视角','上次生成 / 排的作息 / 念头 / 秘密 / 长线 / 流水');host.appendChild(itS.el);
 var sm=metricsWrap();itS.body.appendChild(sm);
 var sList=mut('加载中…');itS.body.appendChild(sList);
 api('GET','panel/today').then(function(r2){
  var W=(r2||{}).world||{};
  sm.innerHTML='';
  sm.appendChild(metric('上次生成',W.generatedAt?new Date(W.generatedAt).toLocaleString('zh-CN'):'<small>还没有生成过</small>'));
  sm.appendChild(metric('剧本生效日',W.forDate?esc(W.forDate):'<small>—</small>'));
  sm.appendChild(metric('排的作息',(W.wake||'?')+' <small>起</small> / '+(W.sleep||'?')+' <small>睡</small>'));
  sm.appendChild(metric('明天心情',typeof W.mood==='number'?(W.mood+' <small>/100</small>'):'<small>—</small>'));
  sm.appendChild(metric('痴迷话题',W.focus?esc(W.focus):'<small>—</small>'));
  sm.appendChild(metric('天气',W.weather?(esc(W.weather)+' <small>'+(W.weatherSource==='real'?'真实':'她编的')+'</small>'):'<small>—</small>'));
  var L=[];
  if((W.longterm||[]).length)L.push('长线小心思（最新）：'+W.longterm[W.longterm.length-1].text);
  if((W.thoughts||[]).length)L.push('心里冒的念头：'+W.thoughts.join('；'));
  if((W.secrets||[]).length)L.push('她藏着的秘密：'+W.secrets.join('；')+'（只会在气氛合适时漏一点）');
  if((W.flow||[]).length)L.push('明天的生活流水：'+(W.flow||[]).map(function(f){return (f.time||'')+' '+(f.text||'')}).join(' · '));
  sList.textContent=L.length?L.join(String.fromCharCode(10)):'（跑过一次之后，这里会显示她的念头、秘密、长线和明天的流水）';
 }).catch(function(){sList.textContent='（加载失败）'});

 /* ④ 天气 */
 var itW=itemBlock('她的天气','真实 API 优先，失败她自己编');host.appendChild(itW.el);
 var winfo=mut('加载中…');itW.body.appendChild(winfo);
 var wr=document.createElement('input');wr.type='checkbox';wr.checked=true;
 wr.onchange=function(){api('POST','panel/config',{world:{weatherReal:wr.checked}}).then(function(){winfo.className='ok';winfo.textContent=wr.checked?'已开启真实天气（API失败时她自己编）':'已关闭真实天气（全部由她自己编）'}).catch(function(e){alert(e.message);wr.checked=!wr.checked})};
 itW.body.appendChild(row(wr,document.createTextNode('接入真实天气 API（城市=她的身份卡里填的城市）')));
 itW.body.appendChild(mut('天气会影响她的心情、穿搭话题，以及"提醒你添衣"这类关心。'));

 /* ⑤ 社交圈 */
 var itC=itemBlock('她的社交圈','世界引擎维护的稳定编制，聊天里会自然提到');host.appendChild(itC.el);
 var clist=mut('加载中…');itC.body.appendChild(clist);
 api('GET','panel/today').then(function(r2){var W3=(r2||{}).world||{};
  if(W3.weather){winfo.textContent='今天：'+W3.weather+'（'+(W3.weatherSource==='real'?'真实天气API':'她自己编的')+'）'}else{winfo.textContent='还没有天气记录——世界引擎跑过一次就会有。'}
  wr.checked=W3.weatherReal!==false;
  var npcs=W3.npcs||[];
  if(npcs.length){clist.innerHTML='';npcs.forEach(function(n){var nm=(n&&typeof n==='object')?n:null;var line=nm?(nm.name+(nm.rel?'（'+nm.rel+'）':'')+(nm.note?'：'+nm.note:'')):String(n);clist.appendChild(mut('· '+line))});
   clist.appendChild(mut('编制上限 6 人：世界引擎每晚维护，新朋友会进圈、老人不会凭空消失。'));}
  else{clist.textContent='还没有社交圈——世界引擎跑几晚后，会自然为她聚起一圈朋友/同事。'}
 }).catch(function(){winfo.textContent='（加载失败）';clist.textContent='（加载失败）'});
}

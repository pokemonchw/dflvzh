/* Plain-browser rendering of the source layouts in LegendsViewer-Next.
 * UI definitions: upstream-ui.js. Data parsing and DFCN translation stay local. */
(function () {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = value => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  const UI = window.LegendsUI;
  const categories = UI.categories;
  const artKinds=new Set(['danceforms','musicalforms','poeticforms']);
  const list = value => value === undefined || value === null || value === '' ? [] : Array.isArray(value) ? value : [value];
  const scalar = value => Array.isArray(value) ? scalar(value[0]) : value;
  const numeric = value => value === undefined || value === null || value === '' || typeof value === 'object' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const storage = {get(key) {try{return localStorage.getItem('atlas.'+key);}catch{return null;}},set(key,value) {try{localStorage.setItem('atlas.'+key,value);return true;}catch{return false;}}};
  const singular = {figures:'figure',sites:'site',entities:'entity',artifacts:'artifact',regions:'region',eras:'era',collections:'event',events:'event',landmasses:'region',undergroundregions:'region',mountainpeaks:'region',rivers:'region'};
  const state = {world:null,route:'explore',recordId:null,lang:'zh',indexes:{},names:new Map(),graphs:[],rules:[],excludedEventTypes:new Set(),eventIndex:new Map(),collectionIndex:new Map(),favorites:new Set(),files:[],importing:false,bookmarks:[],tables:new Map(),tableSources:new Map(),map:null,charts:[],recordsView:null,query:'',filter:'',minYear:'',maxYear:'',expandedGroups:new Set()};
  let databasePromise,toastTimer,renderGeneration=0,searchGeneration=0,filterTimer,filterController,expandedGraph,importController,detailController,worldGeneration=0;
  const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
  function checkAbort(signal){if(signal?.aborted)throw new DOMException('导入已取消','AbortError');}
  const referenceKinds=new Map();
  const text = key => UI.labels[key] || key;
  const termOverrides = {unknown:'未知',civilization:'文明',sitegovernment:'地方政府',female:'女性',male:'男性',default:'默认',religion:'宗教组织',guild:'行会',hills:'丘陵',grassland:'草原',wetland:'湿地',musical:'音乐',poetic:'诗歌',dance:'舞蹈'};
  function term(value, scope) {
    if(value===undefined||value===null||value==='')return '-';
    const s=String(value).replace(/_/g,' '),domain=typeof scope==='string'||scope&&typeof scope==='object'?scope:undefined;
    if(domain)return window.DFTranslate?.term(s,domain)||s;
    return termOverrides[s.toLowerCase()]||window.DFTranslate?.term(s)||s;
  }
  function icon(value) {let cls=value||'mdi-circle-small';if(!cls.startsWith('mdi-'))cls=categories[cls]?.icon||({overview:'mdi-earth-box',explore:'mdi-file-tree-outline',map:'mdi-map-search-outline',events:'mdi-calendar-clock',collections:'mdi-calendar-clock',records:'mdi-trophy-outline'}[cls])||'mdi-circle-small';return `<i class="mdi ${escape(cls)}" aria-hidden="true"></i>`;}
  function toast(message) {const el=$('#toast');el.textContent=message;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,4000);}
  function pathFor(kind,id) {const path=categories[kind]?.route||({overview:'/world',explore:'/',map:'/map',records:'/records',events:'/event',collections:'/chronicle'}[kind])||'/'+kind;return '#'+path+(id===undefined||id===null?'':'/'+encodeURIComponent(id));}
  function link(kind,id,label) {if(kind==='structures'&&/^\d+:\d+$/.test(String(id)))id=(state.world?.disk?.aggregates||state.world?.aggregates)?.structureLookup?.[id];const record=state.indexes[kind]?.get(Number(id));if(!record&&!(state.world?.disk&&numeric(id)!==null&&Number(id)>=0))return escape(label||'-');const symbol=record&&window.LegendsMap?.objectIconHTML?.(record,kind,state.world);return `<span class="object-link" data-object-kind="${escape(kind)}" data-object-id="${Number(id)}">${symbol||icon(categories[kind]?.icon||kind)} <a href="${pathFor(kind,id)}">${escape(label||(record?name(record,kind):'#'+id))}</a></span>`;}
  function rawName(record) { return String(record?.name || record?.translated_name || record?.name2 || `#${record?.id ?? '—'}`); }
  function artifactItemSource(record) {
    const source=record?.raw||record||{};
    // Artifact.cs uses the item caption only when no artifact name is present.
    // Keep that distinction after normalizeRecord supplies its display name.
    if(scalar(source.name)||scalar(source.translated_name)||scalar(record?.translated_name))return null;
    const item=source.item??record?.item;
    const value=typeof item==='object'&&item?scalar(item.name_string):typeof item==='string'?item:scalar(source.name_string??record?.name_string);
    return typeof value==='string'&&value?value:null;
  }
  function name(record, kind, useChinese=state.lang==='zh') {
    if (!record) return '未记录';
    const original=rawName(record);
    if(!useChinese)return original;
    if(kind==='artifacts'){
      const itemSource=artifactItemSource(record);
      if(itemSource!==null)return window.LegendsItemTranslate?.translate(itemSource)??itemSource;
    }
    if(artKinds.has(kind)&&original==='Untitled')return '无题';
    if((kind==='collections'||categories[kind]?.collectionTypes)&&/^(?:Collection\s*#|[\w ]+\s+\d+$)/i.test(original)&&!(record.raw?.name||record.translated_name))return window.DFTranslate?.collectionName?.(record,{name})||term(record.type)+' #'+record.id;
    if(/^Historical figure #\d+$/i.test(original))return '无名人物 #'+record.id;
    if(/^Entity #\d+$/i.test(original))return '无名组织 #'+record.id;
    if(/^Artifact #\d+$/i.test(original))return '无名神器 #'+record.id;
    const unnamed=original.match(/^(Site|Region|Era|Event) #(\d+)$/i);
    if(unnamed&&!(record.raw?.name||record.translated_name))return ({site:'无名地点',region:'无名区域',era:'未命名时代',event:'未命名事件'})[unnamed[1].toLowerCase()]+' #'+record.id;
    const source=record.translated_name || record.name || original;
    const context={kind:singular[kind]||kind,type:record.type,entityType:record.type,siteType:kind==='sites'?record.type:undefined,rawName:original};let cacheable=true;
    if(kind==='figures')context.givenName=original.split(/\s+/)[0];
    if(kind==='entities'&&/^(?:sitegovernment|site government|government)$/i.test(String(record.type||''))) {
      const links=record.entity_link||[];
      const parents=[...new Set((Array.isArray(links)?links:[links]).filter(link=>link&&/^parent$/i.test(String(link.type||link.link_type||''))).map(link=>Number(link.target??link.entity_id)).filter(id=>Number.isFinite(id)&&id>=0))];
      // Only an explicit, unambiguous parent link supplies a civilization HEAD.
      if(parents.length===1) {
        const parent=state.indexes.entities?.get(parents[0]);
        if(!parent)cacheable=false;
        const head=parent&&window.DFTranslate?.polityHead?.(parent.translated_name||parent.name);
        if(head){context.parentHead=head.head;context.parentPlural=head.plural;}
      }
    }
    const key=kind+':'+record.id+':'+original+':'+(context.parentHead||'')+':'+(context.parentPlural||'');
    if(cacheable&&state.names.has(key))return state.names.get(key);
    const translated=window.DFTranslate?.name(String(source),context) || String(source);
    if(cacheable)state.names.set(key,translated);if(state.names.size>10000)state.names.delete(state.names.keys().next().value);return translated;
  }

  function refKind(key) {
    if(!referenceKinds.has(key))referenceKinds.set(key,classifyReference(key));
    return referenceKinds.get(key);
  }
  function classifyReference(key) {
    key=key.toLowerCase();
    if(/^(?:author|author_id|author_hfid|worship_hfid|holder_hfid|seeker_hfid|giver_hfid|receiver_hfid|attacking_hfid|defending_hfid|noncom_hfid|a_support_merc_hfid|d_support_merc_hfid|group_hfid|corruptor_hfid|snatcher_hfid|abductor_hfid)$/.test(key))return 'figures';
    if(/^(?:resident_civ_id|new_site_civ_id|old_site_civ_id|new_civ_id|old_civ_id|aggressor_ent_id|attacking_merc_enid|defending_merc_enid)$/.test(key))return 'entities';
    if(/^(?:source_site_id|target_site_id|dest_site_id|destination_site_id|site_id1|site_id2)$/.test(key))return 'sites';
    if(key==='feature_layer_id')return 'undergroundregions';
    if(key==='subregion_id')return 'regions';
    if(/^(?:written_content_id|written_content|wc_id|writing|page_written_content_id|writing_written_content_id)$/.test(key))return 'writtencontents';
    if(/^(?:dance_form_id|dance_form)$/.test(key))return 'danceforms';
    if(/^(?:musical_form_id|musical_form)$/.test(key))return 'musicalforms';
    if(/^(?:poetic_form_id|poetic_form)$/.test(key))return 'poeticforms';
    if(/^(?:wcid|master_wcid|world_construction_id|construction_id)$/.test(key))return 'constructions';
    if(/^(hfid|hf_id|hf|hf1|hf2|histfig|histfig_id|historical_figure_id|historical_figure|hist_figure_id|figure_id|slayer_hf|slayer_hfid|victim_hf|victim_hfid|doer|doer_hf|doer_hfid|target_hf|target_hfid|builder_hf|builder_hfid|creator_hf|creator_hfid|seeker_hf|holder_hf|giver_hf|receiver_hf|attacker_hf|defender_hf|hfid1|hfid2|source_hf|target_hf|abducted_hf|body_hf|speaker_hf|student|teacher|maker|maker_hfid)$/.test(key)||/^(hf|histfig|hist_figure|historical_figure)_id_?\d?$/.test(key))return 'figures';
    if(/^(site|site_id|siteid|source_site|target_site|dest_site|destination_site|old_site|new_site)$/.test(key))return 'sites';
    if(/^(entity|entity_id|entityid|civ|civ_id|civid|site_civ|site_civ_id|cur_owner_id|attacker_civ|defender_civ|attacker_civ_id|defender_civ_id|attacker_enid|defender_enid|attacking_enid|defending_enid|attacker_ent_id|defender_ent_id|group|group_id|enid|entity_1|entity_2)$/.test(key))return 'entities';
    if(/^(artifact|artifact_id|artifactid)$/.test(key))return 'artifacts';
    if(/^(region|region_id|regionid)$/.test(key))return 'regions';
    return null;
  }
  function references(record,indexes=state.indexes) {
    const found=new Map();
    function walk(obj,depth,parentKey) {
      if(!obj||typeof obj!=='object'||depth>5)return;
      for(const [key,val] of Object.entries(obj)) {
        if(key==='raw')continue;
        const kind=refKind(key)||(key==='target'?({entity_link:'entities',hf_link:'figures',hfhf_link:'figures',site_link:'sites'}[parentKey]||null):null);
        if(kind)for(const v of Array.isArray(val)?val:[val])if((typeof v==='number'||typeof v==='string')&&/^\d+$/.test(String(v))&&(state.world?.disk||indexes[kind]?.has(Number(v))))found.set(kind+':'+v,{kind,id:Number(v),key});
        if(val&&typeof val==='object')walk(val,depth+1,Array.isArray(obj)?parentKey:key);
      }
    }
    walk(record,0);
    for(const ref of window.DFTranslate?.eventReferences?.(record)||[])if(state.world?.disk||indexes[ref.kind]?.has(Number(ref.id)))found.set(ref.kind+':'+ref.id,ref);
    const source=record?.raw||record||{},aggregates=state.world?.disk?.aggregates||state.world?.aggregates;
    for(const [siteKey,structureKey]of [['site_id','structure_id'],['site_id','structure_local_id'],['source_site_id','source_structure_id'],['dest_site_id','dest_structure_id']]){const id=aggregates?.structureLookup?.[(record?.[siteKey]??source[siteKey])+':'+(record?.[structureKey]??source[structureKey])];if(id!==undefined)found.set('structures:'+id,{kind:'structures',id:Number(id),key:structureKey});}
    return [...found.values()];
  }
  function eventRefs(event, kind) {return references(event).filter(r=>!kind||r.kind===kind);}
  function eventCount(kind,id) {return state.world?.disk?state.diskRelated?.get(kind+':'+id)?.eventCount||0:state.eventIndex.get(kind+':'+id)?.length||0;}
  function recordEvents(kind,id) {return state.world?.disk?state.diskRelated?.get(kind+':'+id)?.events||[]:(state.eventIndex.get(kind+':'+id)||[]).map(i=>state.world.events[i]);}
  function eventType(event) {return String(event.type||event.event_type||'未知事件').replace(/_/g,' ').toLowerCase();}
  const eventWords={'hf died':'人物逝世','hf born':'人物诞生','birth':'人物诞生','created site':'建立聚落','site founded':'建立聚落','artifact created':'神器诞生','artifact lost':'神器遗失','artifact found':'发现神器','artifact destroyed':'神器损毁','add hf entity link':'加入组织','remove hf entity link':'离开组织','change hf state':'生活变迁','add hfhf link':'人物关系','hf gains secret goal':'秘密目标','hf learned secret':'习得秘密','hf does interaction':'施展力量','hf wounded':'人物受伤','hf abducted':'人物被掳','battle':'战役','war':'战争','peace accepted':'达成和平','site taken over':'占领聚落','site conquered':'攻陷聚落','hf simple battle event':'人物交战','attacked site':'袭击聚落','plundered site':'劫掠聚落','destroyed site':'摧毁聚落','historical event collection':'历史篇章','entity created':'组织成立','add hf site link':'人物与地点','hf new pet':'驯养动物','hf travel':'人物旅行'};
  Object.assign(eventWords,{'change hf job':'职业变迁','hf learns secret':'习得秘密','masterpiece created':'杰作诞生','performance':'文艺演出','trade':'商旅贸易','agreement formed':'缔结协定','new site leader':'统治更替'});
  function eventLabel(event) { const t=eventType(event);return window.DFTranslate?.eventLabel?.(t)||eventWords[t]||term(t); }
  function isWar(event) {return /war|battle|attack|conquer|plunder|destroyed site|siege|conflict/.test(eventType(event));}
  function eventText(event, html=true) {
    if(window.DFTranslate?.event)return DFTranslate.event(event,{term,link:html?link:(kind,id)=>escape(name(state.indexes[kind]?.get(Number(id)),kind)),record:(kind,id)=>state.indexes[kind]?.get(Number(id)),name,escape,references});
    if((event.description||event.summary)&&!state.world.demo)return escape(event.description||event.summary);
    const refs=eventRefs(event), by=kind=>refs.filter(r=>r.kind===kind).map(r=>html?link(r.kind,r.id):name(state.indexes[r.kind].get(r.id),r.kind));
    const figures=by('figures'),sites=by('sites'),entities=by('entities'),artifacts=by('artifacts');
    const t=eventType(event);let text='';
    if(/hf died/.test(t)&&figures.length)text=`${figures[0]}${figures[1]?` 被 ${figures[1]} 杀死`:' 结束了生命'}${sites[0]?`，地点在 ${sites[0]}`:''}。`;
    else if(/artifact created/.test(t))text=`${figures[0]||'一位工匠'}创造了${artifacts[0]?'神器 '+artifacts[0]:'一件神器'}${sites[0]?'，于 '+sites[0]:''}。`;
    else if(/created site|site founded/.test(t))text=`${entities[0]||figures[0]||'定居者'}建立了 ${sites[0]||'一座新聚落'}。`;
    else if(/add hf entity link/.test(t)&&figures[0]&&entities[0])text=`${figures[0]} 与 ${entities[0]} 建立了联系。`;
    else if(/hf born|birth/.test(t)&&figures[0])text=`${figures[0]} 来到了这个世界${sites[0]?'，于 '+sites[0]:''}。`;
    else if(/site taken over|site conquered/.test(t)&&sites[0])text=`${sites[0]} 的统治发生了更替${entities.length?'，涉及 '+entities.join('、'):''}。`;
    else if(t==='hf travel'&&figures[0]&&sites[0])text=`${figures[0]} 前往了 ${sites[0]}。`;
    else if(t==='change hf job'&&figures[0])text=`${figures[0]} 的职业发生了变化${sites[0]?'，见于 '+sites[0]:''}。`;
    else if(t==='masterpiece created'&&figures[0])text=`${figures[0]} 完成了一件杰作${sites[0]?'，于 '+sites[0]:''}。`;
    else if(t==='performance'&&figures[0])text=`${figures[0]} 参加了一场演出${sites[0]?'，于 '+sites[0]:''}。`;
    else if(t==='trade'&&sites[0])text=`${sites[0]} 记载了一次商旅贸易${figures[0]?'，涉及 '+figures[0]:''}。`;
    else if(t==='agreement formed')text=`${entities[0]||figures[0]||'有关各方'}缔结了新的协定${sites[0]?'，于 '+sites[0]:''}。`;
    else {const all=[...figures,...sites,...entities,...artifacts];text=all.length?`${all.slice(0,4).join(' · ')}${all.length>4?' …':''}`:'此事件未记录可识别的关联对象。';}
    return text;
  }

  function database() {
    if(window.LegendsLocalStore)return LegendsLocalStore.database();
    if(databasePromise)return databasePromise;
    databasePromise=new Promise((resolve,reject)=>{if(!window.indexedDB){reject(new Error('当前浏览器不支持本地数据库'));return;}const request=indexedDB.open('legends-atlas',1);request.onupgradeneeded=()=>request.result.createObjectStore('worlds',{keyPath:'id'});request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('本地数据库正被占用'));request.onsuccess=()=>resolve(request.result);});
    return databasePromise;
  }
  async function dbOp(mode, fn) {const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('worlds',mode);let result;try{const req=fn(tx.objectStore('worlds'));req.onsuccess=()=>result=req.result;req.onerror=()=>reject(req.error);}catch(err){reject(err);return;}tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('保存被中止'));});}
  function worldName(world=state.world) {return world?name({id:'world',name:world.name},'world'):'';}
  function alternativeName(world=state.world) {return world?.altname?name({id:'alt:'+world.id,name:world.altname},'world'):'';}
  function recordRows(kind) {if(!state.world)return [];return state.world[kind]||[];}
  function recordCollections(kind,id) {
    if(state.world?.disk)return state.diskRelated?.get(kind+':'+id)?.collections||[];
    if(kind==='collections'||categories[kind]?.collectionTypes)return list(state.indexes.collections?.get(Number(id))?.eventcol||state.indexes.collections?.get(Number(id))?.collection).map(value=>state.indexes.collections.get(Number(value))).filter(Boolean);
    const key=kind+':'+id;
    if(!state.collectionIndex.has(key)){
      const found=new Set(state.collectionDirectIndex.get(key)||[]),seen=new Set(),pending=[];
      for(const position of state.eventIndex.get(key)||[])for(const index of state.eventCollections.get(Number(state.world.events[position].id))||[])pending.push(index);
      while(pending.length){const index=pending.pop();if(seen.has(index))continue;seen.add(index);found.add(index);for(const parent of state.collectionParents.get(Number(state.world.collections[index].id))||[])pending.push(parent);}
      state.collectionIndex.set(key,[...found].sort((a,b)=>a-b));
    }
    return state.collectionIndex.get(key).map(i=>state.world.collections[i]);
  }
  function collectionKind(record) {const type=String(record.type||'').toLowerCase().replace(/_/g,' ');return Object.keys(categories).find(kind=>categories[kind].collectionTypes?.includes(type))||'collections';}
  function collectionEvents(record) {
    const result=new Map(),seen=new Set(),pending=record?[record]:[];
    while(pending.length){const current=pending.pop();if(seen.has(current.id))continue;seen.add(current.id);for(const id of list(current.event||current.event_id)){const event=state.indexes.events.get(Number(id));if(event)result.set(Number(event.id),event);}const children=list(current.eventcol||current.collection);for(let i=children.length-1;i>=0;i--){const child=state.indexes.collections.get(Number(children[i]));if(child)pending.push(child);}}
    return [...result.values()];
  }
  function eventsFor(kind,id) {if(kind==='events')return [state.indexes.events.get(Number(id))].filter(Boolean);if(kind==='eras'){const era=state.indexes.eras.get(Number(id));return state.world.events.filter(event=>event.year>=era.start_year&&(era.end_year<0||event.year<=era.end_year));}if(kind==='collections'||categories[kind]?.collectionTypes)return collectionEvents(state.indexes.collections.get(Number(id)));return recordEvents(kind,id);}
  function normalizeExtra(record,index,kind) {const r=LegendsData.normalizeArtForm({...record},kind);r.id=numeric(r.id??r.local_id)??index;r.name=typeof r.name==='string'&&r.name?r.name:typeof r.title==='string'&&r.title?r.title:typeof r.name_string==='string'&&r.name_string?r.name_string:(r.type||'#')+' '+r.id;for(const key of ['year','start_year','end_year','site_id','region_id','depth','height'])if(numeric(r[key])!==null)r[key]=numeric(r[key]);return r;}
  async function setWorld(world,{navigate=false,renderView=true,onProgress,signal}={}) {
    const generation=++worldGeneration,indexes={},eventIndex=new Map(),collectionDirectIndex=new Map(),eventCollections=new Map(),collectionParents=new Map(),entityMemberCounts=new Map(),sitesByCivilization=new Map(),civilizationsWithSites=new Set(),eventYearsByType=new Map(),heroic=new Map();
    if(window.LegendsFastStore){const progress=progress=>onProgress?.({...progress,percent:90+(Number(progress.percent)||0)*.01});await LegendsFastStore.analytics(world,{signal,progress});if(world.disk?.format==='file-index')await LegendsFastStore.prepareSourceRoles(world,{signal,progress});checkAbort(signal);if(generation!==worldGeneration)throw new DOMException('载入已取消','AbortError');window.LegendsMap?.invalidate?.(world);}
    let yielded=performance.now();
    async function checkpoint(percent,message,force=false){checkAbort(signal);if(generation!==worldGeneration)throw new DOMException('载入已取消','AbortError');if(force||performance.now()-yielded>=12){onProgress?.({percent,message});await pause();checkAbort(signal);yielded=performance.now();}}
    const append=(map,key,value)=>{let values=map.get(key);if(!values)map.set(key,values=[]);values.push(value);};
    const extras=world.extra||{},collectionKinds=new Map();
    for(const [kind,definition] of Object.entries(categories)){
      if(definition.collectionTypes){world[kind]=[];for(const type of definition.collectionTypes)append(collectionKinds,type,kind);continue;}
      if(Array.isArray(world[kind])){if(artKinds.has(kind))for(const record of world[kind])LegendsData.normalizeArtForm(record,kind);continue;}
      let rows=extras[definition.extraSection]||[];
      if(kind==='structures'&&!rows.length){rows=[];for(const site of world.sites||[])for(const structure of list(site.structure||site.structures))if(structure&&typeof structure==='object')rows.push({...structure,site_id:site.id,id:rows.length});}
      world[kind]=[];
      for(let i=0;i<rows.length;i++){world[kind].push(normalizeExtra(rows[i],i,kind));if(i%512===0)await checkpoint(91,'整理分类数据…');}
    }
    for(let i=0;i<world.collections.length;i++){const record=world.collections[i];for(const kind of collectionKinds.get(String(record.type||'').replace(/_/g,' ').toLowerCase())||[])world[kind].push(record);if(i%512===0)await checkpoint(91,'整理纪事分类…');}
    await checkpoint(92,'建立记录索引…',true);
    const groups=[...new Set(['figures','sites','entities','artifacts','events','eras','regions','collections',...Object.keys(categories)])];
    for(const kind of groups){const rows=world[kind]||[],index=new Map();indexes[kind]=index;for(let i=0;i<rows.length;i++){if(window.LegendsFastStore)Object.assign(rows[i],LegendsFastStore.metrics(world,kind,rows[i]));index.set(Number(rows[i].id),rows[i]);if(i%1024===0)await checkpoint(92,'建立记录索引…');}}
    for(let i=0;i<world.events.length;i++){
      const event=world.events[i];for(const ref of window.LegendsFastStore?.relationshipReferences?.(event,world)||references(event,indexes))append(eventIndex,ref.kind+':'+ref.id,i);
      if(['site abandoned','site retired','site died'].includes(eventType(event)))for(const [kind,id] of [['sites',event.site_id],['entities',event.site_civ_id]])if(numeric(id)!==null&&Number(id)>=0)heroic.set(kind+':'+id,{kind,id:Number(id)});
      if(numeric(event.year)!==null){const type=eventType(event);let years=eventYearsByType.get(type);if(!years)eventYearsByType.set(type,years=new Map());const year=Number(event.year);years.set(year,(years.get(year)||0)+1);}
      if(i%256===0)await checkpoint(93+Math.floor(i/Math.max(1,world.events.length)*3),'建立事件关联…');
    }
    for(let i=0;i<world.collections.length;i++){
      const collection=world.collections[i];for(const ref of references(collection,indexes))append(collectionDirectIndex,ref.kind+':'+ref.id,i);
      for(const id of list(collection.event||collection.event_id))append(eventCollections,Number(id),i);
      for(const id of list(collection.eventcol||collection.collection))append(collectionParents,Number(id),i);
      if(i%256===0)await checkpoint(96,'建立纪事关联…');
    }
    for(let i=0;i<world.figures.length;i++){const figure=world.figures[i];for(const ref of references(figure,indexes))if(ref.kind==='entities')entityMemberCounts.set(ref.id,(entityMemberCounts.get(ref.id)||0)+1);if(Object.hasOwn(figure,'adventurer'))heroic.set('figures:'+figure.id,{kind:'figures',id:Number(figure.id)});if(i%256===0)await checkpoint(97,'整理文明数据…');}
    for(let i=0;i<world.sites.length;i++){const site=world.sites[i],owner=ownerCivilization(site,indexes);if(owner!==null)append(sitesByCivilization,owner,site);if(numeric(site.civ_id)!==null)civilizationsWithSites.add(Number(site.civ_id));if(i%512===0)await checkpoint(97,'整理文明数据…');}
    let generatedMapImage=world.generatedMapImage;
    if(!world.mapImage&&!generatedMapImage){await checkpoint(98,'准备世界地图…',true);generatedMapImage=window.LegendsMap?.imageForWorld(world)||'';}
    await checkpoint(99,'准备显示世界…',true);
    if(generatedMapImage)world.generatedMapImage=generatedMapImage;
    if(world.disk){for(const [type,counts] of Object.entries(world.disk.eventYears||{}))eventYearsByType.set(type,new Map(Object.entries(counts).map(([year,count])=>[Number(year),count])));for(const [id,count] of Object.entries(world.disk.entityMembers||{}))entityMemberCounts.set(Number(id),count);}
    for(const ref of world.disk?.aggregates?.playerRelatedObjects||world.playerRelatedObjects||[])if(ref.kind&&numeric(ref.id)!==null)heroic.set(ref.kind+':'+ref.id,ref);
    resetView();Object.assign(state,{world,indexes,eventIndex,collectionDirectIndex,eventCollections,collectionParents,entityMemberCounts,sitesByCivilization,civilizationsWithSites,eventYearsByType,heroic:[...heroic.values()],collectionIndex:new Map(),diskRelated:new Map(),diskPages:new Map(),familyWorld:null});state.names.clear();
    try{state.favorites=new Set(JSON.parse(storage.get('favorites.'+world.id)||'[]'));}catch{state.favorites=new Set();}
    if(world.disk)for(const key of state.favorites){const [kind,id]=key.split(':');if(!state.indexes[kind]?.has(Number(id))){let record;if(world.disk.format==='file-index'&&!artKinds.has(kind)){const headers=await LegendsFastStore.getHeaders(world,kind,id,{signal});record=headers.length?LegendsFastStore.headerSummary(headers[headers.length-1],kind,world):null;}else record=await LegendsLocalStore.getRecord(world,kind,id,{signal});checkAbort(signal);if(generation!==worldGeneration)return;if(record)cacheDiskRecords({[kind]:[record]},world);}await checkpoint(99,'准备显示收藏…');}
    state.neighborIds=new Map();
    state.tables.clear();document.title='Legends Viewer';
    if(navigate){state.route='overview';state.recordId=null;history.replaceState(null,'',pathFor('overview'));}
    if(renderView)render();
    return world;
  }
  function navMarkup() {
    const selected=state.route,disabled=!state.world;
    const item=(entry,child=false)=>`<a class="nav-link ${child?'nav-child ':''}${selected===entry.id?'active':''}${disabled&&entry.id!=='explore'?' disabled':''}" href="${entry.route?'#'+entry.route:pathFor(entry.id)}" ${disabled&&entry.id!=='explore'?'aria-disabled="true" tabindex="-1"':''} ${selected===entry.id?'aria-current="page"':''}>${child?'':icon(entry.icon)}<span>${escape(entry.title)}</span></a>`;
    return UI.navItems.map(entry=>{
      if(entry.id==='favorites') {
        if(!state.favorites.size)return '';
        const favorites=[...state.favorites].map(key=>{const [kind,id]=key.split(':');const record=state.indexes[kind]?.get(Number(id))||(state.world?.disk?{id:Number(id),name:'#'+id}:null);return record?`<a class="nav-link nav-child" href="${pathFor(kind,id)}">${icon(categories[kind]?.icon)}<span>${escape(name(record,kind))}</span></a>`:'';}).join('');
        return `<details class="nav-group" ${state.expandedGroups.has('favorites')?'open':''} data-nav-group="favorites"><summary>${icon(entry.icon)}<span>${escape(entry.title)}</span>${icon('mdi-chevron-down')}</summary>${favorites}</details>`;
      }
      if(entry.children){const open=state.expandedGroups.has(entry.id)||entry.children.some(child=>child.id===selected);return `<details class="nav-group ${disabled?'disabled':''}" data-nav-group="${entry.id}" ${open?'open':''}><summary ${disabled?'aria-disabled="true"':''}>${icon(entry.icon)}<span>${escape(entry.title)}</span>${icon('mdi-chevron-down')}</summary>${entry.children.map(child=>item(child,true)).join('')}</details>`;}
      return item(entry);
    }).join('');
  }
  function renderNav() {$('#main-nav').innerHTML=navMarkup();$$('[data-nav-group]').forEach(el=>el.addEventListener('toggle',()=>{if(el.open)state.expandedGroups.add(el.dataset.navGroup);else state.expandedGroups.delete(el.dataset.navGroup);}));}

  function isDiskWorld(world=state.world) {return Boolean(world?.disk&&window.LegendsLocalStore);}
  function diskCount(kind) {return isDiskWorld()?LegendsLocalStore.totalFor(state.world,kind):recordRows(kind).length;}
  function cacheDiskRecords(groups,world=state.world) {
    if(world!==state.world||!groups)return;
    if(state.diskCacheWorld!==world){state.diskCacheWorld=world;state.diskCached=new Map();state.diskBaseIndexes=new Map();}
    for(const [kind,rows] of groups instanceof Map?groups:Object.entries(groups)) {
      if(!Array.isArray(rows))continue;
      const canonical=categories[kind]?.collectionTypes?'collections':kind;
      const index=state.indexes[canonical]||(state.indexes[canonical]=new Map());
      if(!state.diskBaseIndexes.has(canonical))state.diskBaseIndexes.set(canonical,new Map((world[canonical]||[]).map(record=>[Number(record.id),record])));
      const base=state.diskBaseIndexes.get(canonical);
      let keys=state.diskCached.get(canonical);if(!keys)state.diskCached.set(canonical,keys=new Set());
      for(const record of rows){if(!record||numeric(record.id)===null)continue;const id=Number(record.id);index.set(id,record);keys.delete(id);keys.add(id);if(canonical==='collections'){const alias=collectionKind(record);(state.indexes[alias]||(state.indexes[alias]=new Map())).set(id,record);}}
      while(keys.size>1000){
        const id=keys.values().next().value;keys.delete(id);
        if(state.recordId!==null&&Number(state.recordId)===id){keys.add(id);continue;}
        if(canonical==='collections'){const alias=collectionKind(index.get(id)||{});if(alias!=='collections')state.indexes[alias]?.delete(id);}
        if(base.has(id))index.set(id,base.get(id));else index.delete(id);
      }
    }
  }
  function tableReferences(kind,rows) {
    const requested=new Map(),headers=kind==='events'?UI.eventTableHeaders:kind==='collections'?UI.chronicleTableHeaders:categories[kind]?.tableHeaders||[],keys=new Set(headers.map(header=>header.key));
    const add=(target,id)=>{id=numeric(id);if(id!==null&&id>=0)requested.set(target+':'+id,{kind:target,id});};
    for(const row of rows){
      if(kind==='figures')continue;
      if(kind==='events'){for(const ref of window.DFTranslate?.eventReferences?.(row)||references(row))add(ref.kind,ref.id);for(const ref of references(row))if(ref.kind==='structures')add(ref.kind,ref.id);continue;}
      if(kind==='entities'&&/^(?:sitegovernment|site government|government)$/i.test(String(row.type||'')))for(const parent of list(row.entity_link))if(/^parent$/i.test(String(parent.type||parent.link_type||'')))add('entities',parent.target??parent.entity_id);
      if(kind==='writtencontents'&&(keys.has('subtype')||keys.has('author')))add('figures',row.author_hfid??row.author);
      if(keys.has('regionLink')||kind==='sites'&&keys.has('subtype'))add('regions',row.region_id??row.subregion_id);
      if(kind==='collections'||categories[kind]?.collectionTypes){
        if(keys.has('html')&&window.DFTranslate?.collection){const tokens=[];const html=DFTranslate.collection(row,{name:record=>rawName(record),record:(target,id)=>state.indexes[target]?.get(Number(id)),link:(target,id)=>{const token='\uE120'+tokens.length+'\uE121';tokens.push({token,target,id});return token;}});for(const ref of tokens)if(html.includes(ref.token)&&!(Number(ref.id)===Number(row.id)&&(ref.target==='collections'||categories[ref.target]?.collectionTypes)))add(ref.target,ref.id);}
        if(keys.has('subtype'))for(const id of [row.aggressor_ent_id??row.attacker_ent_id??row.attacker_civ_id??row.attacking_enid,row.defender_ent_id??row.defender_civ_id??row.defending_enid,row.civ_id])add('entities',id);
      }
    }
    return [...requested.values()];
  }
  async function prefetchDiskRecords(world,kind,rows,signal) {
    const requested=tableReferences(kind,rows),groups=requested.length?await LegendsLocalStore.prefetchRefs(world,rows,{signal,namesOnly:true,references:requested}):{};checkAbort(signal);
    if(world!==state.world)return;
    // Government names need their explicit civilization HEAD before the first
    // translation is cached, including governments linked from event text.
    const parents=new Map();for(const entity of [...(groups.entities||[]),...(kind==='entities'?rows:[])])if(/^(?:sitegovernment|site government|government)$/i.test(String(entity.type||'')))for(const relation of list(entity.entity_link))if(/^parent$/i.test(String(relation.type||relation.link_type||''))){const id=numeric(relation.target??relation.entity_id);if(id!==null&&id>=0&&!state.indexes.entities?.has(id)&&!(groups.entities||[]).some(value=>Number(value.id)===id))parents.set(id,{kind:'entities',id});}
    if(parents.size){const extra=await LegendsLocalStore.prefetchRefs(world,[],{signal,namesOnly:true,references:[...parents.values()]});checkAbort(signal);for(const [target,records]of Object.entries(extra))(groups[target]||(groups[target]=[])).push(...records);}
    cacheDiskRecords(groups,world);cacheDiskRecords({[kind]:rows},world);
  }
  function syncPreparedGeography(world) {
    if(world!==state.world||world.disk?.format!=='file-index')return;
    if(state.preparedRowsWorld!==world){state.preparedRowsWorld=world;state.preparedRows=new Map();}
    if(state.diskCacheWorld!==world){state.diskCacheWorld=world;state.diskCached=new Map();state.diskBaseIndexes=new Map();}
    const extras={undergroundregions:'underground_regions',landmasses:'landmasses',rivers:'rivers',mountainpeaks:'mountain_peaks',constructions:'world_constructions',entity_populations:'entity_populations'};let changed=false,civilizationsChanged=false;
    for(const kind of ['regions','undergroundregions','landmasses','rivers','mountainpeaks','constructions','sites','entities','entity_populations']){
      const rows=world[kind]||world.extra?.[extras[kind]||kind]||state.emptyPreparedRows||(state.emptyPreparedRows=[]);
      if(state.preparedRows.get(kind)===rows)continue;state.preparedRows.set(kind,rows);changed=true;if(['sites','entities'].includes(kind))civilizationsChanged=true;
      const base=new Map(rows.map(record=>[Number(record.id),record]));state.diskBaseIndexes.set(kind,base);
      const index=state.indexes[kind]||(state.indexes[kind]=new Map());for(const [id,record]of base)if(!index.has(id))index.set(id,record);
    }
    if(civilizationsChanged){
      const sitesByCivilization=new Map(),civilizationsWithSites=new Set(),ownership=world.disk.aggregates?.siteOwnership||{};
      for(const site of world.sites||[]){const current=ownership[site.id]?.owner??site.cur_owner_id,civ=ownerCivilization({...site,cur_owner_id:current});if(civ!==null){if(!sitesByCivilization.has(civ))sitesByCivilization.set(civ,[]);sitesByCivilization.get(civ).push(site);}if(numeric(site.civ_id)!==null)civilizationsWithSites.add(Number(site.civ_id));}
      state.sitesByCivilization=sitesByCivilization;state.civilizationsWithSites=civilizationsWithSites;
    }
    if(changed){LegendsMap.invalidate?.(world);if(!world.mapImage)world.generatedMapImage=LegendsMap.imageForWorld(world)||world.generatedMapImage;}
  }
  function queryOptions(settings,extra={}) {return {signal:settings.signal,page:settings.page,pageSize:settings.pageSize,query:state.query,sortKey:settings.sortKey,descending:settings.descending,rules:state.rules,name:(record,kind)=>name(record,kind,true),sortValue:(record,key,kind)=>columnValue(record,key,kind),context:filterContext(),...extra};}
  // These original table columns are fully represented by the version 3
  // headers. Event prose, extra collection fields and art-form name prefixes
  // need their original XML; eras also derive their final end-year on read.
  const fullListKinds=new Set(['events','eras','duels','persecutions','purges',...artKinds]);
  async function prepareListContext(world,kind,signal){
    if(kind!=='mountainpeaks'||world.disk?.format!=='file-index')return;
    const total=Number(world.disk.counts.mountain_peaks||0);
    if((world.mountainpeaks||world.extra?.mountain_peaks||[]).length<total){
      const records=[];await LegendsFastStore.scanHeaders(world,kind,header=>records.push(LegendsFastStore.headerSummary(header,kind,world)),{signal});checkAbort(signal);
      world.mountainpeaks=records;(world.extra||(world.extra={})).mountain_peaks=records;syncPreparedGeography(world);
    }
  }
  function diskTableSource(kind,{recordKind,recordId,part,initial}={}) {
    return {remote:async settings=>{
      const world=state.world;
      let result;
      if(recordKind!==undefined){const related=await LegendsLocalStore.related(world,recordKind,recordId,queryOptions(settings,{query:'',rules:[],sortKey:settings.sortKey||(part==='events'?'date':''),excludeEventTypes:part==='events'?[...state.excludedEventTypes]:[],part}));result={rows:related[part]||[],total:Number(related[part==='events'?'eventCount':'collectionCount']??0),typeCounts:related.typeCounts||related.eventTypeCounts,eventYears:related.eventYears};}
      else{await prepareListContext(world,kind,settings.signal);result=await LegendsLocalStore.query(world,kind,queryOptions(settings,{query:kind===state.route?state.query:'',rules:kind===state.route?state.rules:[],excludeEventTypes:kind==='events'?[...state.excludedEventTypes]:[],headersOnly:!fullListKinds.has(kind)}));}
      checkAbort(settings.signal);await prefetchDiskRecords(world,kind,result.rows||[],settings.signal);checkAbort(settings.signal);
      if(world===state.world){state.diskPages||(state.diskPages=new Map());state.diskPages.set(kind,{rows:result.rows||[],page:settings.page});}
      return result;
    },total:initial?.total??diskCount(kind),alreadyPaged:true,typeCounts:initial?.typeCounts||(kind==='events'&&!recordKind?Object.fromEntries(Object.entries(state.world.disk.eventYears||{}).map(([type,years])=>[type,Object.values(years).reduce((sum,n)=>sum+Number(n),0)])):undefined),eventYears:initial?.eventYears};
  }
  function readFailureMarkup(error){return `<div class="no-data" role="alert">${escape(error?.message||'无法载入记录。')} <button class="button" data-action="retry-view">重试</button></div>`;}
  function offerSourceRecovery(error,world=state.world){
    if(error?.name!=='SourceFileError'||!world?.disk)return false;
    state.sourceRecovery={world,error};state.files=[];$('#file-input').value='';$('#selected-files').innerHTML='';
    $('#import-title').innerHTML=icon('mdi-file-restore-outline')+'重新关联世界原文件';
    const expected=(world.disk.fileInfo||[]).filter(file=>/\.xml$/i.test(file.name||'')).map(file=>file.name);
    $('#import-dialog .import-tips p').textContent='选择此世界原来的 XML，保留已有索引和统计，无需重新导入。'+(expected.length?' 原文件：'+expected.join('、'):'');
    $('#import-error').textContent=error.message;$('#import-error').hidden=false;$('#import-progress').hidden=true;
    $('#start-import').textContent='重新关联原文件';$('#start-import').disabled=true;$('#file-input').disabled=false;$('#close-import').disabled=false;$('#close-import').textContent='关闭';
    if(!$('#import-dialog').open)$('#import-dialog').showModal();return true;
  }
  function viewFailure(error,generation=renderGeneration) {if(generation!==renderGeneration)return;$('#main').innerHTML=readFailureMarkup(error);offerSourceRecovery(error);}
  async function diskFamilyWorld(record,world,signal) {
    const figures=new Map([[Number(record.id),record]]),queue=[{record,mothers:0,fathers:0,path:new Set()}];let yielded=performance.now();
    const relations=current=>{
      const result=[];
      const add=(type,id)=>{if(id!==null&&id>=0&&!result.some(value=>value.type===type&&value.id===id))result.push({type,id});};
      for(const relation of [...list(current.hf_link),...list(current.hfhf_link),...list(current.related_historical_figures),...list(current.relatedHistoricalFigures)])add(String(relation?.link_type??relation?.type??'').trim().toLowerCase().replace(/_/g,' '),numeric(relation?.hfid??relation?.hf_id??relation?.histfig_id??relation?.historical_figure_id??relation?.target));
      for(const [key,type]of [['mother_id','mother'],['father_id','father']])add(type,numeric(current[key]));return result;
    };
    async function fetch(ids){
      const pending=[...new Set(ids)].filter(id=>!figures.has(id));let next=0;
      await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{while(next<pending.length){checkAbort(signal);const id=pending[next++],figure=await LegendsLocalStore.getRecord(world,'figures',id,{signal});checkAbort(signal);if(figure)figures.set(Number(figure.id),figure);if(performance.now()-yielded>12){yielded=performance.now();await pause();checkAbort(signal);}}}));
    }
    // Ancestors use the same separate mother/father depth limits as Family's
    // renderer. Direct children are leaves; their other ancestry is not drawn.
    while(queue.length){
      checkAbort(signal);const current=queue.shift(),id=Number(current.record.id);if(current.path.has(id))continue;
      const path=new Set(current.path);path.add(id);const parents=relations(current.record).filter(value=>['mother','father'].includes(value.type));await fetch(parents.map(value=>value.id));
      for(const parent of parents){const figure=figures.get(parent.id);if(!figure)continue;const mothers=current.mothers+(parent.type==='mother'?1:0),fathers=current.fathers+(parent.type==='father'?1:0);if(parent.type==='mother'?mothers<3:fathers<3)queue.push({record:figure,mothers,fathers,path});}
    }
    await fetch(relations(record).filter(value=>value.type==='child').map(value=>value.id));checkAbort(signal);
    if(world!==state.world)return null;cacheDiskRecords({figures:[...figures.values()]},world);
    return {...world,figures:[...figures.values()],events:[{year:world.year,type:''}]};
  }
  function pageTitle(title,subtitle,mdi,append='') {return `<div class="page-title">${icon(mdi)}<div><h2>${escape(title)}</h2>${subtitle?`<p>${escape(subtitle)}</p>`:''}</div>${append}</div>`;}
  function sectionHeader(title,subtitle,mdi,append='') {return `<div class="section-heading">${icon(mdi)}<div><h3>${escape(title)}</h3>${subtitle?`<p>${escape(subtitle)}</p>`:''}</div>${append}</div>`;}
  function section(title,subtitle,mdi,body,attrs='') {return `<section class="section-card" ${attrs}>${sectionHeader(title,subtitle,mdi)}<div class="section-body">${body}</div></section>`;}
  function resetView() {detailController?.abort();detailController=null;state.detailModel=null;for(const source of state.tableSources.values())source.controller?.abort();renderGeneration++;if($('#expanded-dialog').open)$('#expanded-dialog').close();expandedGraph?.destroy();expandedGraph=null;state.map?.destroy?.();state.map=null;if(typeof state.recordsView==='function')state.recordsView();else state.recordsView?.destroy?.();state.recordsView=null;for(const chart of state.charts)chart.destroy();state.charts=[];for(const graph of state.graphs)graph?.destroy?.();state.graphs=[];state.tableSources.clear();}
  function render() {
    resetView();renderNav();
    if(state.route==='explore'){renderWorlds();return;}
    if(!state.world){state.route='explore';renderNav();renderWorlds();return;}
    if(state.recordId!==null){const generation=renderGeneration;renderRecord(state.route,state.recordId).catch(error=>viewFailure(error,generation));return;}
    if(state.route==='overview'){const generation=renderGeneration;renderOverview().catch(error=>viewFailure(error,generation));}
    else if(state.route==='map'){const generation=renderGeneration;renderMap().catch(error=>viewFailure(error,generation));}
    else if(state.route==='records'){state.recordsView=window.LegendsRecords?.render($('#main'),state.world,{name:(record,kind)=>record.id==='world'?worldName():name(record,kind),link,term,icon,records:recordRows,record:(kind,id)=>state.indexes[kind]?.get(Number(id)),eventsFor});}
    else renderCollection();
  }
  function parseRoute() {
    let path=decodeURIComponent(location.hash.slice(1).split('?')[0]).replace(/^\/+|\/+$/g,'');const [part,id]=path.split('/');
    const aliases={world:'overview',worlds:'explore',overview:'overview',figures:'figures',entities:'entities',sites:'sites',artifacts:'artifacts',events:'events',collections:'collections',wars:'wars'};
    const route=part?(UI.routeToKind['/'+part]||aliases[part]||(['map','records'].includes(part)?part:'explore')):'explore';
    if(route!==state.route||String(state.recordId??'')!==String(id??'')){state.route=route;state.recordId=id===undefined?null:Number(id);state.query='';state.filter='';state.minYear='';state.maxYear='';state.tables.clear();state.rules=[];}
    render();$('#sidebar').classList.remove('open');$('#drawer-backdrop').hidden=true;window.scrollTo(0,0);
  }
  async function bookmarks() {return LegendsLocalStore.bookmarks();}
  function thumbnail(world) {const image=world.mapImage||world.generatedMapImage;return image?`<img class="world-thumbnail pixelated-image" src="${escape(image)}" alt="${escape(world.name)}">`:'<div class="world-thumbnail"></div>';}
  async function renderWorlds() {
    const generation=renderGeneration;
    const first=`<article class="world-card"><div class="world-image">${icon('mdi-earth-box-plus')}</div><h2>探索新世界</h2><p>选择导出的传说 XML 文件</p><div class="world-card-actions"><button class="button button-orange" data-action="import">${icon('mdi-earth')}选择</button></div></article>`;
    $('#main').innerHTML=`<div class="world-cards">${first}</div><section class="section-card"><div class="section-body"><h3>本地缓存管理</h3><p>可删除世界缓存或地图底图；原始 XML 和图片文件不会被删除。清理前请关闭其他旧版本页面。</p><button class="button" data-cache-action="orphans">清理失败导入残留</button> <button class="button" data-cache-action="all">清空全部本地世界缓存</button><p id="cache-status" role="status"></p></div></section>`;
    try{state.bookmarks=await bookmarks();}catch{state.bookmarks=[];}
    if(generation!==renderGeneration)return;
    $('.world-cards').insertAdjacentHTML('beforeend',state.bookmarks.map(w=>`<article class="world-card">${thumbnail(w)}<h2>${escape(worldName(w))}${w.width&&w.height?`<span class="chip world-size">${w.width} × ${w.height}</span>`:''}</h2><p>${escape(alternativeName(w)||'-')}</p><div class="world-card-actions"><button class="button ${state.world?.id===w.id?'button-green':'button-blue'}" data-load-world="${escape(w.id)}">${state.world?.id===w.id?'探索':'载入'}</button><details class="bookmark-menu"><summary class="icon-button" aria-label="更多">${icon('mdi-dots-horizontal')}</summary>${w.mapImage&&w.hasImportedMap!==false?`<button class="button" data-remove-map="${escape(w.id)}">${icon('mdi-map-remove')}删除导入地图</button>`:''}<button class="button" data-delete-world="${escape(w.id)}">${icon('mdi-delete-outline')}删除世界缓存</button></details><span class="world-date">${escape(w.savedAt?new Date(w.savedAt).toLocaleDateString('zh-CN'):'')}</span></div></article>`).join(''));
  }
  function cacheLock(mode,task){return navigator.locks?.request?navigator.locks.request('legends-cache-lifecycle',{mode},task):task();}
  function releaseCurrentWorld(){
    worldGeneration++;resetView();
    for(const key of ['world','detailModel','familyWorld','diskCacheWorld','preparedRowsWorld','emptyPreparedRows','sourceRecovery'])state[key]=null;
    for(const key of ['eventIndex','collectionDirectIndex','eventCollections','collectionParents','entityMemberCounts','sitesByCivilization','eventYearsByType','collectionIndex','diskRelated','diskPages','diskCached','diskBaseIndexes','preparedRows'])state[key]=new Map();
    state.indexes={};state.names.clear();state.files=[];$('#file-input').value='';$('#selected-files').innerHTML='';state.heroic=[];state.bookmarks=[];state.favorites=new Set();state.route='explore';state.recordId=null;
    storage.set('lastWorld','');history.replaceState(null,'',pathFor('explore'));
  }
  let cacheChannel;try{cacheChannel=new BroadcastChannel('legends-cache-changes');cacheChannel.onmessage=event=>{if(event.data?.all||state.world?.id===event.data?.id){releaseCurrentWorld();render();toast('另一个页面已修改缓存，请重新载入世界。');}};}catch(_){}
  async function changeCache(action,id){
    if(state.importing||state.cacheBusy)return toast('请等待导入完成或先取消导入。');
    const messages={all:'清空本页面保存的全部世界、地图、索引和原文件缓存？之后需要重新导入 XML。原始文件不会被删除。',orphans:'清理失败或取消导入留下的缓存？已保存的世界将保留。',map:'删除此世界导入的地图底图？世界数据保留，之后可以重新导入图片。',world:'删除此世界及其地图、索引和原文件缓存？原始文件不会被删除。'};
    if(!confirm(messages[action]))return;
    state.cacheBusy=true;const status=$('#cache-status');if(status)status.textContent='正在等待后台任务完成并清理缓存…';
    try{await cacheLock('exclusive',async()=>{
      await Promise.allSettled([...(state.pendingSaves?.values()||[]),...[...(state.sourceRepairs?.values()||[])].map(entry=>entry.promise)]);
      if(action==='map'){
        const world=state.world?.id===id?state.world:await LegendsLocalStore.getWorld(id);
        if(!world)throw new Error('找不到世界缓存。');
        if(!world.mapImage)throw new Error('此世界没有导入地图，当前显示的是自动生成的底图。');
        const fileName=world.mapFileName,previous={sourceFiles:world.sourceFiles};
        for(const key of ['mapImage','mapImageWidth','mapImageHeight','mapFileName','generatedMapImage']){previous[key]=world[key];delete world[key];}
        if(fileName)world.sourceFiles=(world.sourceFiles||[]).filter(name=>name!==fileName);
        try{LegendsMap.invalidate?.(world);await queueWorldSave(world);}catch(error){Object.assign(world,previous);LegendsMap.invalidate?.(world);throw error;}
        await LegendsFastStore.removeMapSources(world);
      }else if(action==='world'){
        await LegendsLocalStore.deleteWorld(id);try{localStorage.removeItem('atlas.favorites.'+id);}catch(_){}
        if(state.world?.id===id)releaseCurrentWorld();if(storage.get('lastWorld')===id)storage.set('lastWorld','');
      }else{
        const worlds=[];
        if(action!=='all'){
          for(const row of await bookmarks()){const world=await LegendsLocalStore.getWorld(row.id);if(!world)throw new Error('世界目录不完整，未清理缓存。');worlds.push({id:world.id,disk:world.disk});}
          if(state.world)worlds.push({id:state.world.id,disk:state.world.disk});
        }
        await LegendsFastStore.clearOrphans(worlds,action==='all');await LegendsLocalStore.clearCache(worlds,action==='all');
        if(action==='all'){releaseCurrentWorld();try{for(const key of Object.keys(localStorage))if(key.startsWith('atlas.favorites.'))localStorage.removeItem(key);}catch(_){}}
      }
      if(action!=='orphans')cacheChannel?.postMessage({id,all:action==='all'});
    });render();toast(action==='map'?'导入地图已删除。':action==='world'?'世界缓存已删除。':'缓存清理完成。');}
    catch(error){toast('清理失败：'+error.message);if(status?.isConnected)status.textContent='清理失败：'+error.message;}
    finally{state.cacheBusy=false;}
  }
  function tableState(id) {if(!state.tables.has(id))state.tables.set(id,{page:1,pageSize:UI.pageSize||10,sortKey:'',descending:false});return state.tables.get(id);}
  function regionFor(record) {const id=record.region_id??record.subregion_id;return id===undefined?null:state.indexes.regions?.get(Number(id));}
  function columnValue(record,key,kind) {
    const collection=kind==='collections'||categories[kind]?.collectionTypes;
    if(key==='id')return record.id;
    if(key==='html')return kind==='events'?eventText(record):name(record,collection?collectionKind(record):kind);
    if(key==='date')return record.year>=0?Number(record.year)*403200+Number(record.seconds72||0):'';
    if(key==='startDate')return (record.start_year??record.year)>=0?Number(record.start_year??record.year)*403200+Math.max(0,Number(record.start_seconds72||0)):'';
    if(key==='endDate')return numeric(record.end_year)!==null&&record.end_year>=0?Number(record.end_year)*403200+Math.max(0,Number(record.end_seconds72||0)):'';
    if(key==='eventCount')return isDiskWorld()?Number(record.eventCount??record.event_count??state.diskRelated?.get(kind+':'+record.id)?.eventCount??NaN):collection?collectionEvents(record).length:eventsFor(kind,record.id).length;
    if(key==='eventCollectionCount')return isDiskWorld()?Number(record.eventCollectionCount??record.event_collection_count??record.collection_count??state.diskRelated?.get(kind+':'+record.id)?.collectionCount??NaN):recordCollections(kind,record.id).length;
    if(key==='type')return kind==='figures'?record.race||record.type:kind==='artifacts'?record.item_type||record.type:record.type;
    if(key==='subtype')return kind==='figures'?record.caste:kind==='entities'?record.race:kind==='sites'?regionFor(record)?.type:kind==='regions'?record.evilness:kind==='undergroundregions'?record.depth:kind==='writtencontents'?state.indexes.figures?.get(Number(record.author_hfid??record.author))?.name:record.subtype||record.item_subtype||record.mat||record.material||'';
    if(key==='size'||key==='squareTiles')return record.squareTiles??String(record.coords||record.path||'').split('|').filter(Boolean).length;
    if(key==='heightMeter')return numeric(record.height)!==null?Number(record.height)*3:'';
    if(key==='worldRank'){if(record.worldRank!==undefined)return record.worldRank;const peaks=recordRows('mountainpeaks').slice().sort((a,b)=>Number(b.height)-Number(a.height)||Number(a.id)-Number(b.id));return peaks.findIndex(peak=>Number(peak.id)===Number(record.id))+1||'';}
    if(key==='regionLink')return regionFor(record)?.name||'';
    if(key==='duration')return numeric(record.end_year)!==null&&record.end_year>=0?record.end_year-(record.start_year||0):'';
    if(key==='height')return numeric(record.height)!==null?Number(record.height)*3:'';
    const snake=key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());return scalar(record[key]??record[snake]??'');
  }
  function tableCell(record,header,kind) {
    const value=columnValue(record,header.key,kind);
    if(header.key==='html'){if(kind==='events')return eventText(record);const k=kind==='collections'?collectionKind(record):kind;return (kind==='collections'||categories[kind]?.collectionTypes)&&window.DFTranslate?.collection?DFTranslate.collection(record,{link,name,record:(kind,id)=>state.indexes[kind]?.get(Number(id))}):link(k,record.id);}
    if(header.key==='subtype'&&kind==='writtencontents'){const author=numeric(record.author_hfid??record.author);return author!==null?link('figures',author):'-';}
    if(header.key==='subtype'&&(kind==='collections'||categories[kind]?.collectionTypes)){const attacker=numeric(record.aggressor_ent_id??record.attacker_ent_id??record.attacker_civ_id??record.attacking_enid),defender=numeric(record.defender_ent_id??record.defender_civ_id??record.defending_enid);if(attacker!==null||defender!==null)return (attacker!==null?link('entities',attacker):'-')+' ⇒ '+(defender!==null?link('entities',defender):'-');if(numeric(record.civ_id)!==null)return link('entities',record.civ_id);}
    if(header.key==='regionLink'){const region=regionFor(record);return region?link('regions',region.id):'-';}
    if(header.key==='heightMeter')return value===''?'-':escape(fmt(value))+' 米';
    if(['type','subtype','race','biome','evilness'].includes(header.key)) {
      const domain=header.key==='race'||kind==='figures'&&header.key==='type'||kind==='entities'&&header.key==='subtype'?'creature':kind==='entities'&&header.key==='type'?'entityType':header.key==='biome'||['regions','undergroundregions'].includes(kind)&&header.key==='type'||kind==='sites'&&header.key==='subtype'?'terrain':undefined;
      return value===undefined||value===''?'-':escape(term(value,domain));
    }
    if(['date','startDate','endDate'].includes(header.key)){if(value==='')return '-';const prefix=header.key==='date'?'':header.key==='startDate'?'start_':'end_',year=Number(record[prefix+'year']??record.year),seconds=numeric(record[prefix+'seconds72']);return String(year).padStart(4,'0')+(seconds!==null&&seconds>=0?'-'+String(1+Math.floor(seconds/33600)).padStart(2,'0')+'-'+String(1+Math.floor(seconds%33600/1200)).padStart(2,'0'):'');}
    if(header.key==='author'){const id=numeric(record.author_hfid??record.author);return id!==null?link('figures',id):'-';}
    if(typeof value==='object'||(typeof value==='number'&&!Number.isFinite(value)))return '-';
    return value===undefined||value===''?'-':escape(typeof value==='number'?fmt(value):value);
  }
  function tableMarkup(id,rows,headers,kind,options={}) {
    const previous=state.tableSources.get(id)||{},source={...previous,...options,rows,headers,kind};state.tableSources.set(id,source);
    const settings=tableState(id),remote=Boolean(source.remote||source.alreadyPaged);
    let sorted=rows;
    if(settings.sortKey&&!remote){sorted=[...rows].sort((a,b)=>{const first=columnValue(a,settings.sortKey,kind),second=columnValue(b,settings.sortKey,kind);const cmp=typeof first==='number'&&typeof second==='number'?first-second:String(first??'').localeCompare(String(second??''),'zh-CN');return settings.descending?-cmp:cmp;});}
    const total=remote?Number(source.total??rows.length):sorted.length,pages=Math.max(1,Math.ceil(total/settings.pageSize));settings.page=Math.min(settings.page,pages);const start=(settings.page-1)*settings.pageSize,visible=remote?sorted:sorted.slice(start,start+settings.pageSize);
    const table=`<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(h=>`<th class="align-${h.align||'start'}" scope="col">${h.sortable===false?escape(h.title):`<button data-sort-table="${id}" data-sort-key="${h.key}">${escape(h.title)}${settings.sortKey===h.key?icon(settings.descending?'mdi-arrow-down':'mdi-arrow-up'):''}</button>`}</th>`).join('')}</tr></thead><tbody>${visible.length?visible.map(record=>`<tr>${headers.map(h=>`<td class="align-${h.align||'start'}">${tableCell(record,h,kind)}</td>`).join('')}</tr>`).join(''):`<tr><td class="no-data" colspan="${headers.length}">无数据</td></tr>`}</tbody></table></div>`;
    return table+`<div class="pagination"><label>每页条数：<select data-page-size="${id}" aria-label="每页条数">${(UI.pageSizeOptions||[10,25,50,100]).map(n=>`<option ${settings.pageSize===n?'selected':''}>${n}</option>`).join('')}</select></label><span>${total&&visible.length?start+1:0}–${Math.min(start+visible.length,total)} / ${fmt(total)}</span><div class="pagination-buttons"><button class="icon-button" data-page-table="${id}" data-page="1" ${settings.page===1?'disabled':''} aria-label="首页">${icon('mdi-page-first')}</button><button class="icon-button" data-page-table="${id}" data-page="${settings.page-1}" ${settings.page===1?'disabled':''} aria-label="上一页">${icon('mdi-chevron-left')}</button><button class="icon-button" data-page-table="${id}" data-page="${settings.page+1}" ${settings.page>=pages?'disabled':''} aria-label="下一页">${icon('mdi-chevron-right')}</button><button class="icon-button" data-page-table="${id}" data-page="${pages}" ${settings.page>=pages?'disabled':''} aria-label="末页">${icon('mdi-page-last')}</button></div></div>`;
  }
  function tableHost(id,rows,headers,kind,options={}) {return `<div class="table-host" data-table="${id}">${tableMarkup(id,rows,headers,kind,options)}</div>`;}
  async function updateTable(id) {
    let source=state.tableSources.get(id);const host=$(`[data-table="${id}"]`);if(!source||!host)return;
    if(!source.remote){host.innerHTML=tableMarkup(id,source.rows,source.headers,source.kind);return;}
    source.controller?.abort();const controller=new AbortController();source.controller=controller;
    const generation=renderGeneration,world=state.world,request=(source.request||0)+1;source.request=request;host.setAttribute('aria-busy','true');
    try{
      let result;const active=()=>generation===renderGeneration&&world===state.world&&state.tableSources.get(id)===source&&source.request===request;
      while(true){const settings=tableState(id),queriedPage=settings.page;result=await source.remote({...settings,signal:controller.signal});if(!active())return;const lastPage=Math.max(1,Math.ceil(Number(result.total??0)/settings.pageSize)),page=Math.max(1,Math.min(queriedPage,lastPage));if(page===queriedPage)break;settings.page=page;checkAbort(controller.signal);}
      host.innerHTML=tableMarkup(id,result.rows||[],source.headers,source.kind,{total:result.total??0,typeCounts:result.typeCounts??source.typeCounts,eventYears:result.eventYears??source.eventYears,alreadyPaged:true});const missing=result.missingFilterFields||Object.keys(result.unknownFilterCounts||{});if(missing.length)toast('部分记录缺少筛选所需数据：'+missing.map(property=>window.LegendsFilters?.label(property)||term(property)).join('、'));
    }
    catch(error){if(error.name!=='AbortError'&&generation===renderGeneration&&state.tableSources.get(id)===source&&source.request===request){host.innerHTML=readFailureMarkup(error);offerSourceRecovery(error,world);}}
    finally{if(generation===renderGeneration&&source.request===request)host.removeAttribute('aria-busy');}
  }
  function matches(record,kind,query) {const q=query.trim().toLowerCase();if(!q)return true;return String(record.id)===q||rawName(record).toLowerCase().includes(q)||String(record.translated_name||'').toLowerCase().includes(q)||(/[\u3400-\u9fff]/.test(q)&&name(record,kind,true).toLowerCase().includes(q));}
  async function filterRows() {
    if(isDiskWorld()){await updateTable('list');return;}
    const kind=state.route,query=state.query,filter=state.filter,generation=++searchGeneration,world=state.world;
    const rows=[],source=recordRows(kind);let yielded=performance.now();
    for(const record of source){if(matches(record,kind,query)&&(!filter||String(kind==='figures'?record.race:record.type)===filter)&&(!window.LegendsFilters||LegendsFilters.matches(record,kind,state.rules,filterContext()))&&(state.minYear===''||Number(record.year??record.start_year??record.birth_year)>=Number(state.minYear))&&(state.maxYear===''||Number(record.year??record.start_year??record.birth_year)<=Number(state.maxYear)))rows.push(record);if(performance.now()-yielded>16){await new Promise(resolve=>setTimeout(resolve,0));if(generation!==searchGeneration||world!==state.world||kind!==state.route||query!==state.query)return;yielded=performance.now();}}
    if(generation!==searchGeneration||world!==state.world||kind!==state.route||query!==state.query)return;
    const host=$('[data-table="list"]');if(host)host.innerHTML=tableMarkup('list',rows,categories[kind].tableHeaders,kind);
  }
  function renderCollection() {
    const definition=categories[state.route];if(!definition){$('#main').innerHTML='';return;}
    const wiki=definition.wikiKeyWord?`<a class="button wiki-button" href="https://dwarffortresswiki.org/index.php/${encodeURIComponent(definition.wikiKeyWord)}" target="_blank" rel="noopener">搜索矮人要塞维基 ${icon('mdi-search-web')}</a>`:'';
    const rows=isDiskWorld()?[]:recordRows(state.route),total=isDiskWorld()?diskCount(state.route):rows.length;
    $('#main').innerHTML=pageTitle(definition.title,definition.subtitle,definition.icon,wiki)+`<section class="section-card">${sectionHeader(definition.overviewTitle,definition.overviewSubtitle,'mdi-card-search-outline',`<span class="chip chip-cyan">${icon(definition.icon)}${escape(definition.title)}：${fmt(total)}</span>`)}<div class="section-body"><div class="collection-toolbar"><label class="outlined-field search-field">${icon('mdi-magnify')}<input id="collection-query" placeholder="搜索" aria-label="搜索" value="${escape(state.query)}"></label>${definition.showFilters?`<div class="filter-chip-container"><button class="icon-button filter-button" id="filter-button" aria-label="筛选设置">${icon('mdi-filter-menu-outline')}</button><span id="active-filters">${state.rules.map(rule=>`<span class="chip">${escape(window.LegendsFilters?.chip(rule)||rule.propertyName)}</span>`).join('')}</span></div>`:''}</div>${tableHost('list',rows,definition.tableHeaders,state.route,isDiskWorld()?diskTableSource(state.route):{})}</div></section>`;
    $('#collection-query').addEventListener('input',event=>{state.query=event.target.value;tableState('list').page=1;clearTimeout(filterTimer);filterTimer=setTimeout(filterRows,120);});
    $('#filter-button')?.addEventListener('click',showFilters);
    if(isDiskWorld()||state.query||state.filter||state.rules.length||state.minYear!==''||state.maxYear!=='')filterRows();
  }
  function filterContext() {return {world:state.world,records:recordRows,eventsFor,term,icon};}
  function showFilters() {
    const definition=categories[state.route];
    $('#filter-subtitle').textContent=definition.title;
    filterController?.destroy?.();
    filterController=window.LegendsFilters.mount($('#filter-fields'),state.route,state.rules,filterContext());
    const modal=$('#filter-dialog');modal.showModal();
    if(window.innerWidth>=760){const rect=$('#filter-button').getBoundingClientRect();modal.style.margin='0';modal.style.left=Math.max(16,rect.left-modal.offsetWidth)+'px';modal.style.top=Math.max(16,Math.min(rect.top,window.innerHeight-modal.offsetHeight-16))+'px';}else{modal.style.margin='auto';modal.style.left='';modal.style.top='';}
  }
  function chart(id,type,labels,values,palette=[]) {
    const el=$('#'+id);if(!el||!window.Chart)return;
    const borderColors=values.map((_,i)=>Array.isArray(palette[i])?'rgb('+palette[i].join(',')+')':palette[i]||'rgb(112,128,144)');
    const fillColors=borderColors.map(color=>color.startsWith('rgb(')?color.replace('rgb(','rgba(').replace(')',',0.2)'):color==='DarkSeaGreen'?'rgba(143,188,143,0.2)':color);
    const data=type==='doughnut'?{labels,datasets:[{data:values,backgroundColor:fillColors,borderColor:borderColors,borderWidth:2,borderRadius:4,spacing:4}]}:{labels,datasets:[{label:'事件',data:values,fill:true,borderColor:'rgb(75,192,192)',backgroundColor:type==='bar'?'rgba(75,192,192,0.6)':'rgba(75,192,192,0.2)',tension:.2,pointRadius:values.length>100?0:2}]};
    Chart.defaults.font.size=16;Chart.defaults.font.family='Roboto, "Microsoft YaHei", sans-serif';
    const instance=new Chart(el,{type,data,options:{responsive:true,maintainAspectRatio:false,indexAxis:type==='bar'?'y':'x',elements:{bar:{borderWidth:1}},color:'#fff',plugins:{legend:{display:type==='doughnut',position:'right',labels:{color:'#fff',font:{size:16}}}},scales:type==='doughnut'?{}:{x:{beginAtZero:type==='bar',ticks:{color:'#b0bec5',font:{size:14},maxTicksLimit:12},grid:{color:'#37474f'}},y:{beginAtZero:type!=='bar',ticks:{color:'#b0bec5',font:{size:14}},grid:{color:'#37474f'}}}}});state.charts.push(instance);return instance;
  }
  function eventChart(id,events) {
    const years=new Map();
    const diskYears=isDiskWorld()?state.tableSources.get(id.replace(/^chart-/,''))?.eventYears:null;
    if(diskYears){for(const [type,counts] of Object.entries(diskYears)){if(state.excludedEventTypes.has(type))continue;for(const [year,count] of Object.entries(counts))years.set(Number(year),(years.get(Number(year))||0)+Number(count));}}
    else if((events===state.world.events||id==='chart-events')&&state.eventYearsByType){for(const [type,counts] of state.eventYearsByType){if(state.excludedEventTypes.has(type))continue;for(const [year,count] of counts)years.set(year,(years.get(year)||0)+count);}}
    else for(const event of events){if(state.excludedEventTypes.has(eventType(event)))continue;if(numeric(event.year)!==null)years.set(Number(event.year),(years.get(Number(event.year))||0)+1);}
    const labels=[...years.keys()].sort((a,b)=>a-b);chart(id,'line',labels,labels.map(year=>years.get(year)));
  }
  function eventFilterChip(id) {return state.excludedEventTypes.size?`<button class="chip event-filter-chip" data-clear-event-filters="${id}">${icon('mdi-filter-variant')}已筛选：隐藏 ${state.excludedEventTypes.size} 种事件${icon('mdi-close')}</button>`:'';}
  function eventSection(events,id='events',options={}) {
    const rows=options.remote?events:state.excludedEventTypes.size?events.filter(event=>!state.excludedEventTypes.has(eventType(event))):events;
    const markup=`<section class="section-card" data-event-section="${id}">${sectionHeader('事件','事件概览','mdi-calendar-clock',`<button class="icon-button" data-expand-events="${id}" aria-label="展开">${icon('mdi-resize')}</button>`)}<div class="section-body indented"><div data-event-filter-state="${id}">${eventFilterChip(id)}</div><div class="event-chart"><canvas id="chart-${id}" aria-label="事件分布"></canvas></div>${tableHost(id,rows,UI.eventTableHeaders,'events',options)}</div></section>`;
    if(!options.remote)state.tableSources.get(id).allRows=events;return markup;
  }
  function chroniclesSection(rows,id='chronicles',options={}) {return `<section class="section-card">${sectionHeader('纪事','纪事列表','mdi-calendar-clock')}<div class="section-body indented">${tableHost(id,rows,UI.chronicleTableHeaders,'collections',options)}</div></section>`;}
  function overviewPopulation(pop) {
    const source=pop.raw||pop,race=scalar(pop.race??source.race),match=String(race??'').match(/^(.*):(-?\d+)$/),count=match?Math.abs(Number(match[2])):numeric(pop.count??source.count);
    return {id:Number(pop.id),civId:numeric(pop.civ_id??source.civ_id),race:match?match[1]:typeof race==='string'?race:'',count};
  }
  function overviewCivName(civ) {const value=civ?.raw?.name??civ?.name;return typeof value==='string'&&value.trim()&&!/^Entity\s+#\d+$/i.test(value);}
  function overviewIsCivilization(civ,world) {if(!civ)return false;const a=world.disk?.aggregates||world.aggregates;if(Array.isArray(a?.civilizations))return a.civilizations.includes(Number(civ.id));if(civ.IsCiv!==undefined)return civ.IsCiv===true;if(civ.is_civ!==undefined)return civ.is_civ===true;return /^civilization$/i.test(civ.type||'')&&overviewCivName(civ);}
  function populationsByRace(world=state.world) {
    const output=new Map();
    for(const source of world.extra?.entity_populations||[]){const pop=overviewPopulation(source),civ=state.indexes.entities.get(pop.civId);if(pop.civId===null||!overviewIsCivilization(civ,world)||!pop.race||pop.count===null)continue;output.set(pop.race,(output.get(pop.race)||0)+pop.count);}
    return [...output].map(([race,count])=>[term(race,'creature'),count,race]);
  }
  function areasByRegion(world=state.world) {
    const output=new Map();for(const region of world.regions){const coords=region.coords??region.raw?.coords,size=coords?String(coords).split('|').filter(Boolean).length:numeric(region.square_tiles??region.squareTiles);if(size>0)output.set(region.type,(output.get(region.type)||0)+size);}return [...output].map(([type,count])=>[term(type,'terrain'),count,type]);
  }
  function ownerCivilization(site,indexes=state.indexes) {const owner=numeric(site.cur_owner_id);if(owner===null||owner<0)return numeric(site.civ_id);const entity=indexes.entities.get(owner);if(entity?.type==='civilization')return owner;const parent=list(entity?.entity_link).find(r=>/^parent$/i.test(String(r.type||'')));return parent?numeric(parent.target):numeric(site.civ_id);}
  function civSites(entity) {return state.sitesByCivilization.get(Number(entity.id))||[];}
  async function overviewCivilizations(world,signal) {
    const a=world.disk?.aggregates||world.aggregates||{},populations=world.extra?.entity_populations||[],known=new Set(list(a.civilizations).map(Number)),byId=state.indexes.entities;
    const populationByCiv=new Map(),populationMembers=new Map(Object.entries(a.populationMembers||{}).map(([id,count])=>[Number(id),count]));
    for(const source of populations){const pop=overviewPopulation(source),civ=byId.get(pop.civId);if(pop.civId===null||!civ)continue;populationByCiv.set(pop.civId,pop);civ.type='civilization';if(pop.race)civ.race=pop.race;}
    if(!world.disk&&!a.populationMembers)for(const figure of world.figures){const id=numeric(figure.ent_pop_id??figure.raw?.ent_pop_id);if(id!==null)populationMembers.set(id,(populationMembers.get(id)||0)+1);}
    const main=world.entities.filter(civ=>overviewIsCivilization(civ,world));
    for(const civ of main)known.add(Number(civ.id));
    function parent(id){const entity=byId.get(id),facts=a.entityFacts?.[id],explicit=numeric(facts?.parentEntityId??facts?.parentEntity??entity?.parentEntityId??entity?.parentEntity);if(explicit!==null)return explicit;return numeric(list(entity?.entity_link).find(item=>/^parent$/i.test(item.type||item.link_type||''))?.target);}
    const resolved=new Map();function civilization(id){id=numeric(id);if(id===null||id<0)return null;if(resolved.has(id))return resolved.get(id);const original=id,seen=new Set();while(id!==null&&!seen.has(id)){if(known.has(id)){resolved.set(original,id);return id;}seen.add(id);id=parent(id);}resolved.set(original,null);return null;}
    const current=new Map(),past=new Map();
    for(const site of world.sites){const info=a.siteOwnership?.[site.id],owner=info?info.owner:site.cur_owner_id??site.civ_id,id=info?.civ??civilization(owner);if(id!==null&&id!==undefined){if(!current.has(Number(id)))current.set(Number(id),[]);current.get(Number(id)).push(site);}for(const period of info?.history||[]){if(Number(period.end)<0)continue;const previous=civilization(period.owner);if(previous!==null)past.set(previous,(past.get(previous)||0)+1);}}
    const rows=main.map(civ=>{const id=Number(civ.id),sites=current.get(id)||[],count=numeric(civ.CurrentSitesCount??civ.currentSitesCount??civ.current_sites_count)??sites.length,history=numeric(civ.SiteHistoryCount??civ.siteHistoryCount??civ.site_history_count),pop=populationByCiv.get(id);return {civ,sites,currentCount:count,lostCount:history===null?(past.get(id)||0):Math.max(0,history-count),population:pop?.count??null,members:pop?(populationMembers.get(pop.id)??null):null,leader:null};});
    // MainCivilizationDto.CurrentLeader takes the lowest nonnegative assignment,
    // and requires both the position definition and its historical figure.
    const pending=[];
    for(const row of rows){const civ=row.civ,assignment=list(civ.entity_position_assignment??civ.raw?.entity_position_assignment).filter(item=>numeric(item.position_id)!==null&&Number(item.position_id)>=0).sort((x,y)=>Number(x.position_id)-Number(y.position_id))[0];if(!assignment)continue;const position=list(civ.entity_position??civ.raw?.entity_position).find(item=>Number(item.id)===Number(assignment.position_id)),id=numeric(assignment.histfig??assignment.hfid);if(position&&id!==null&&id>=0)pending.push({row,position,id});}
    let next=0;await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{while(next<pending.length){checkAbort(signal);const item=pending[next++];let figure=state.indexes.figures.get(item.id);if(!figure&&world.disk)figure=await LegendsLocalStore.getRecord(world,'figures',item.id,{signal});checkAbort(signal);if(!figure)continue;cacheDiskRecords({figures:[figure]},world);const p=item.position,title=/^female$/i.test(figure.caste)?p.name_female||p.name:/^male$/i.test(figure.caste)?p.name_male||p.name:p.name;if(title)item.row.leader={figure,title};await pause();}}));
    rows.sort((x,y)=>String(x.civ.race||'Unknown').localeCompare(String(y.civ.race||'Unknown'),'en')||Number(x.civ.id)-Number(y.civ.id));return {active:rows.filter(row=>row.currentCount>0),lost:rows.filter(row=>row.currentCount===0)};
  }
  function overviewRaceChip(civ,world) {const color=LegendsMap.entityColor(civ,world,1),rgb=(color.match(/[\d.]+/g)||[102,102,102]).slice(0,3).map(Number),foreground=(.299*rgb[0]+.587*rgb[1]+.114*rgb[2])/255>.5?'#000':'#fff';return `<span class="v-chip v-chip--label v-theme--dark v-chip--density-compact v-chip--size-default v-chip--variant-tonal soc civilization-race-chip" style="background-color:${escape(color)};color:${foreground}"><span class="v-chip__underlay"></span><span class="v-chip__content">${escape(term(civ.race||'Unknown','creature'))}</span></span>`;}
  function civList(rows,title,subtitle,mdi,world,image,lost=false) {
    if(!rows.length)return '';const chip=(count,cls,glyph,label)=>count>0?`<span class="chip ${cls}" title="${label}">${icon(glyph)}${fmt(count)}</span>`:'';
    return section(title,subtitle,mdi,`<div class="civilization-list">${rows.map(row=>{const civ=row.civ;return `<div class="civilization-row" data-civilization="${civ.id}">${image?`<span class="civilization-thumbnail${lost?' civilization-thumbnail-lost':''}" data-civ-thumbnail="${civ.id}" tabindex="0"><img width="92" height="92" loading="lazy" src="${escape(image)}" alt=""></span>`:''}<div class="civilization-details"><div class="civilization-title">${link('entities',civ.id)}</div>${row.leader?`<div class="civilization-current-leader"><b>${escape(term(row.leader.title,'profession'))}：</b>${link('figures',row.leader.figure.id)}</div>`:''}<div class="civilization-chips">${chip(row.currentCount,'chip-blue','mdi-home','当前据点')}${chip(row.lostCount,'chip-pink','mdi-home-minus-outline','失去的据点')}${chip(row.population,'chip-blue','mdi-account-circle-outline','当前人口')}${chip(row.members,'chip-cyan','mdi-account-supervisor-circle-outline','历史人物（在世与已故）')}</div></div><span class="civilization-race">${overviewRaceChip(civ,world)}</span></div>`;}).join('')}</div>`,'data-civilization-card');
  }
  function overviewThumbnails(world,rows,image,generation,signal) {
    if(!image)return;const byId=new Map(rows.map(row=>[Number(row.civ.id),row])),pending=new Set(),tips=[];let stopped=false;
    const active=()=>!stopped&&!signal.aborted&&world===state.world&&generation===renderGeneration;
    async function load(host){const id=Number(host.dataset.civThumbnail);if(pending.has(id)||!active())return;pending.add(id);const row=byId.get(id);if(!row)return;const points=row.sites.flatMap(site=>window.LegendsDetails?.coordinates(site)||[]),formed=LegendsMap.getCoordinates(row.civ.formedAt||row.civ.formed_at);if(formed)points.push([formed.x,formed.y]);let src=image;if(points.length)src=await LegendsMap.locationImage(world,'sites',{coords:points.map(p=>p.join(',')).join('|')},{tileSize:2})||image;if(!active())return;host.querySelector('img').src=src;host.dataset.thumbnailReady='true';if(window.tippy){const preview=document.createElement('div'),large=document.createElement('img');large.src=src;large.width=400;preview.append(large);preview.className='civilization-thumbnail-preview'+(host.classList.contains('civilization-thumbnail-lost')?' civilization-thumbnail-preview-lost':'');const tip=tippy(host,{content:preview,placement:'right',maxWidth:432,trigger:'mouseenter focus',arrow:false,delay:[150,0]});tips.push(tip);}}
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);load(entry.target).catch(error=>{if(error.name!=='AbortError'&&active())entry.target.dataset.thumbnailReady='false';});}},{rootMargin:'96px'}):null;
    for(const host of $$('[data-civ-thumbnail]'))if(observer)observer.observe(host);else load(host).catch(()=>{});
    state.graphs.push({destroy(){stopped=true;observer?.disconnect();for(const tip of tips)tip.destroy();}});
  }
  async function renderOverview() {
    detailController=new AbortController();const signal=detailController.signal,world=state.world,generation=renderGeneration;
    $('#main').innerHTML='<div class="loading"><progress aria-label="载入中"></progress></div>';
    await LegendsDetails.prepareGeography(world,{signal,indexes:state.indexes});checkAbort(signal);syncPreparedGeography(world);
    const civilizations=await overviewCivilizations(world,signal);checkAbort(signal);if(world!==state.world||generation!==renderGeneration)return;
    const population=populationsByRace(world),areas=areasByRegion(world),image=world.mapImage||world.generatedMapImage;
    let cards='';
    if(image)cards+=section('世界概览地图','点击探索交互地图，查看世界中的地点','mdi-map-search-outline',`<a href="#/map"><img class="overview-map pixelated-image" src="${escape(image)}" alt=""></a>`);
    if(population.length)cards+=section('各族人口','主要文明的人口构成','mdi-chart-donut','<div class="doughnut"><canvas id="population-chart"></canvas></div>');
    if(areas.length)cards+=section('地表区域面积','世界各地陆地分布的比较','mdi-earth','<div class="doughnut"><canvas id="area-chart"></canvas></div>');
    const heroic=(state.heroic||[]).map(ref=>({title:escape(ref.kind==='figures'?'冒险者':term(state.indexes[ref.kind]?.get(ref.id)?.type)),subtitle:link(ref.kind,ref.id)}));
    $('#main').innerHTML=pageTitle(worldName(),alternativeName(),'mdi-earth-box')+(cards?`<div class="overview-charts">${cards}</div>`:'')+`<div class="civilization-grid">${civList(civilizations.active,'现存文明','持续塑造世界的繁荣社会','mdi-account-multiple',world,image)}${civList(civilizations.lost,'失落文明','已经成为历史的文明遗迹','mdi-account-multiple-remove-outline',world,image,true)}</div>`+eventSection(world.events,'events',isDiskWorld()?diskTableSource('events'): {})+chroniclesSection(world.collections,'chronicles',isDiskWorld()?diskTableSource('collections'):{})+(heroic.length?`<div class="detail-grid">${listCard('冒险关联','与你的旅途有关的冒险者、派系与地点','mdi-compass-outline',heroic)}</div>`:'');
    if(population.length){const raceColors=LegendsMap.raceColors(world);chart('population-chart','doughnut',population.map(r=>r[0]),population.map(r=>r[1]),population.map(r=>raceColors.get(r[2])));}if(areas.length)chart('area-chart','doughnut',areas.map(r=>r[0]),areas.map(r=>r[1]),areas.map(r=>LegendsMap.regionBaseColor(r[2])));eventChart('chart-events',world.events);if(isDiskWorld()){updateTable('events');updateTable('chronicles');}
    overviewThumbnails(world,[...civilizations.active,...civilizations.lost],image,generation,signal);
  }
  async function renderMap() {
    detailController=new AbortController();const signal=detailController.signal;
    const world=state.world,generation=renderGeneration,query=new URLSearchParams(location.hash.split('?')[1]||''),type=query.get('type'),id=numeric(query.get('id')),kind=UI.routeToKind['/'+type]||type;
    $('#main').innerHTML='<div id="full-map" class="map-container large" aria-label="地图"></div>';
    await LegendsDetails.prepareGeography(world,{signal,indexes:state.indexes});if(generation!==renderGeneration||world!==state.world)return;syncPreparedGeography(world);
    state.map=window.LegendsMap?.mount($('#full-map'),world,{large:true,onSelect:openRecord,translate:(source,kind,record)=>name(record||{id:source,name:source},kind||'sites')});
    const map=state.map,warfare=[],activeWars=new Set(),activeChildren=new Set();
    if(world.disk?.format==='file-index')await LegendsFastStore.scanHeaders(world,'collections',header=>{if(['war','battle'].includes(String(header.type).toLowerCase())&&Number(header.end_year)<0){warfare.push(LegendsFastStore.headerSummary(header,'collections',world));if(String(header.type).toLowerCase()==='war'){activeWars.add(Number(header.id));for(const child of list(header.children))activeChildren.add(Number(child));}}},{signal});
    else for(const record of world.collections)if(['war','battle'].includes(String(record.type).toLowerCase())&&Number(record.end_year)<0){warfare.push(record);if(String(record.type).toLowerCase()==='war'){activeWars.add(Number(record.id));for(const child of list(record.eventcol))activeChildren.add(Number(child));}}
    if(world.disk?.format==='file-index')await LegendsFastStore.scanHeaders(world,'collections',header=>{if(String(header.type).toLowerCase()==='battle'&&Number(header.end_year)>=0&&(activeWars.has(Number(header.war_eventcol??header.parent_eventcol))||activeChildren.has(Number(header.id))))warfare.push(LegendsFastStore.headerSummary(header,'collections',world));},{signal});
    else warfare.push(...world.collections.filter(record=>String(record.type).toLowerCase()==='battle'&&Number(record.end_year)>=0&&(activeWars.has(Number(record.war_eventcol??record.parent_eventcol))||activeChildren.has(Number(record.id)))));
    if(generation!==renderGeneration||world!==state.world)return;map?.setWarfare?.(warfare);
    if(type&&id!==null){const record=isDiskWorld(world)?await LegendsLocalStore.getRecord(world,kind,id):state.indexes[kind]?.get(id);if(generation!==renderGeneration||world!==state.world)return;if(record){let collections=[];if(kind==='wars'&&world.disk?.format==='file-index'){const children=new Set(list(record.eventcol).map(Number));await LegendsFastStore.scanHeaders(world,'collections',header=>{if(children.has(Number(header.id)))collections.push(LegendsFastStore.headerSummary(header,'collections',world));});}else if(kind==='wars')collections=recordCollections(kind,id);if(kind==='battles'){const parentId=numeric(record.war_eventcol??record.parent_eventcol);if(parentId!==null){const parent=isDiskWorld(world)?await LegendsLocalStore.getRecord(world,'wars',parentId):state.indexes.wars?.get(parentId);if(parent)collections.push(parent);}}if(generation!==renderGeneration||world!==state.world)return;map?.focus?.({kind,id,record,collections});}}
  }
  function listCard(title,subtitle,mdi,items) {if(!items.length)return '';return section(title,subtitle,mdi,`<div class="related-list">${items.map(item=>`<div class="related-list-item">${typeof item==='string'?item:`${item.title||''}${item.subtitle?`<small>${item.subtitle}</small>`:''}`}</div>`).join('')}</div>`);}
  function familyMarkup(record) {
    if(!window.LegendsFamily?.hasFamily(record,state.familyWorld||state.world))return '';
    return `<section class="section-card family-card">${sectionHeader('家族树','祖先与后裔','mdi-family-tree',`<button class="icon-button" data-expand-family="${record.id}" aria-label="展开">${icon('mdi-resize')}</button>`)}<div class="family-graph" data-family="${record.id}"></div></section>`;
  }
  async function recordNeighbors(world,kind,id,signal) {
    let ids=state.neighborIds?.get(kind);
    if(!ids){
      ids=[];const existence=kind==='figures'&&world.disk?.aggregates?.figureExistence;
      if(existence&&typeof existence==='object'){
        // Exact analytics bits include holes in the exported IDs. Reading this
        // compact set avoids scanning every figure block for two arrow links.
        for(const chunk of Object.keys(existence).sort((a,b)=>Number(a)-Number(b))){checkAbort(signal);const words=existence[chunk];for(let word=0;word<words.length;word++){let bits=Number(words[word])>>>0;while(bits){const bit=31-Math.clz32(bits&-bits);ids.push(Number(chunk)*4096+word*32+bit);bits=(bits&(bits-1))>>>0;}}}
      }else if(world.disk?.format==='file-index')await LegendsFastStore.scanHeaders(world,kind,header=>{ids.push(Number(header.id));},{signal});
      else for(const record of recordRows(kind))ids.push(Number(record.id));
      checkAbort(signal);ids.sort((a,b)=>a-b);state.neighborIds?.set(kind,ids);
    }
    const index=ids.indexOf(Number(id));return index<0||!ids.length?{}:{previous:{id:ids[(index-1+ids.length)%ids.length]},next:{id:ids[(index+1)%ids.length]}};
  }
  function detailCard(card) {
    if(card.summary)return `<section class="section-card"><div class="section-body">${card.items.map(row=>`<div class="info-list-item"><strong>${row.title||''}</strong><span>${row.subtitle||''}</span></div>`).join('')}</div></section>`;
    if(card.description)return section('描述','深入了解起源、技法及文化意义','mdi-book-open-page-variant',`<div class="description-content">${escape(card.description).replace(/ {2}/g,'<br>').replace(/\[B\]/g,'<li>')}</div>`);
    if(card.skills){const icons={dabbl:'mdi-square-medium-outline',novic:'mdi-square-medium',adequ:'mdi-square-outline',compe:'mdi-square-outline',skill:'mdi-square',profi:'mdi-square',talen:'mdi-star-outline',adept:'mdi-star-outline',exper:'mdi-star',profe:'mdi-star',accom:'mdi-diamond-outline',great:'mdi-diamond-outline',maste:'mdi-diamond-outline',highm:'mdi-crown-outline',grand:'mdi-crown',legen:'mdi-trophy'};return section(card.title,card.subtitle,card.icon,`<div class="related-list">${card.skills.map(skill=>`<div class="related-list-item skill-row"><span class="chip ${escape(skill.category)}">${icon(icons[skill.subrank]||'mdi-help-circle-outline')}</span><div>${escape(skill.rank)} ${escape(skill.name)}<small>${escape(skill.name)} | ${escape(skill.rank)}</small></div><span class="chip ${escape(skill.category)}">${escape(skill.points)}</span></div>`).join('')}</div>`);}
    return section(card.title,card.subtitle,card.icon,`<div class="related-list">${card.items.map(value=>typeof value==='string'?`<div class="related-list-item">${value}</div>`:`<div class="related-list-item"><div>${value.title||''}${value.subtitle?`<small>${value.subtitle}</small>`:''}</div>${value.append!==undefined&&value.append!==null?`<span class="chip">${escape(value.append)}</span>`:''}</div>`).join('')}</div>`);
  }
  function recordInfo(record,kind,model) {
    let before='',after='';
    if(model.location)before+=section('位置',name(record,kind)+'在世界地图中的位置','mdi-map-search-outline',`<a href="${pathFor('map')}?type=${encodeURIComponent(categories[kind]?.route?.slice(1)||kind)}&id=${record.id}"><img class="overview-map pixelated-image" src="${escape(model.location)}" alt=""></a>`);
    const parts=(model.before||[]).map(card=>({title:card.title,html:detailCard(card)}));
    if(kind==='figures'){const profile=parts.findIndex(card=>card.title==='人物概览');parts.splice(profile+1,0,{html:familyMarkup(record)});}
    if(kind==='entities'&&window.LegendsTimeline){
      const timelines=LegendsTimeline.dataFor(record,state.world,{figures:model.records.figures||[],events:model.events||[]});model.timelines=timelines;
      const insert=parts.findIndex(card=>!['战争','贵族职位'].includes(card.title)),timelineParts=[];
      for(const mode of ['primaryOnly','otherPositions'])if(LegendsTimeline.available(timelines,{isCiv:String(record.type).toLowerCase()==='civilization',mode}).length)timelineParts.push({html:`<section class="section-card">${sectionHeader(mode==='primaryOnly'?'君主时间线':'其他职位时间线','职位持有者与任期','mdi-timeline-clock-outline',`<button class="icon-button" data-expand-timeline="${mode}" aria-label="展开">${icon('mdi-resize')}</button>`)}<div class="monarch-timeline" id="timeline-${mode}"></div></section>`});
      parts.splice(insert<0?parts.length:insert,0,...timelineParts);
    }
    if(['entities','wars'].includes(kind)&&window.LegendsWarfare){
      const collections=(model.collections||[]).filter(value=>String(value.type).toLowerCase()===(kind==='entities'?'war':'battle'));
      const data=LegendsWarfare.dataFor(collections,state.world,{current:kind==='entities'?record:null,name,term,events:model.events||[],collections:[record,...model.collections]});
      if(data.edges.length){model.warfare=data;parts.unshift({html:`<section class="section-card">${sectionHeader(kind==='entities'?'战争图':'战役图','按冲突规模呈现参战派系',kind==='entities'?'mdi-sword-cross':'mdi-chess-bishop',`<button class="icon-button" data-expand-warfare aria-label="展开">${icon('mdi-resize')}</button>`)}<div class="warfare-graph" id="object-warfare"></div></section>`});}
    }
    before+=parts.map(part=>part.html).join('');
    for(const definition of model.charts)before+=section(definition.title,definition.subtitle,definition.icon,`<div class="doughnut"><canvas id="${definition.id}"></canvas></div>`);
    for(const card of model.after||[])after+=detailCard(card);
    return {before,after};
  }
  function recordActions(kind,{previous,next}={}) {return `<div class="object-actions">${previous?`<a class="icon-button object-nav" href="${pathFor(kind,previous.id)}" aria-label="上一项">${icon('mdi-chevron-left')}</a>`:`<button class="icon-button object-nav" disabled aria-label="上一项">${icon('mdi-chevron-left')}</button>`}${next?`<a class="icon-button object-nav" href="${pathFor(kind,next.id)}" aria-label="下一项">${icon('mdi-chevron-right')}</a>`:`<button class="icon-button object-nav" disabled aria-label="下一项">${icon('mdi-chevron-right')}</button>`}</div>`;}
  function recordHeading(record,kind,world,neighbors={}) {
    const favorite=state.favorites.has(kind+':'+record.id),id=record.id,actions=recordActions(kind,neighbors);
    return `<div class="page-title">${LegendsMap.objectIconHTML?.(record,kind,world)||icon(categories[kind]?.icon||kind)}<div><h2>${escape(name(record,kind))}<button class="icon-button favorite-button ${favorite?'active':''}" data-favorite="${kind}:${id}" aria-label="${favorite?'取消收藏':'收藏'}" aria-pressed="${favorite}">${icon(favorite?'mdi-star':'mdi-star-outline')}</button></h2><p>${escape(term(kind==='figures'?record.race:record.type||record.item_type,kind==='figures'?'creature':kind==='entities'?'entityType':['regions','undergroundregions'].includes(kind)?'terrain':undefined))}</p></div>${actions}</div>`;
  }
  function recordPreview(record,kind,world) {
    if(kind!=='figures')return '';
    const items=[],add=(title,value)=>items.push({title:escape(title),subtitle:String(value)}),born=numeric(record.birth_year),died=numeric(record.death_year),year=Number(world.year||world.end_year||0);
    if(record.goal)add('目标',escape(term(record.goal)));
    if(born!==null&&born!==-1){add('年龄',escape((died!==null&&died>=0?died:year)-born)+(died!==null&&died>=0?' ✝':''));add('出生',escape(born)+' 年');}
    if(died!==null&&died>=0)add('死亡',escape(died)+' 年');
    if(record.sphere)add('领域',escape(window.DFTranslate?.sphere?.(record.sphere)||list(record.sphere).map(value=>term(value,'sphere')).join('、')));
    return items.length?'<div class="detail-grid">'+detailCard({title:'人物概览',subtitle:'重要细节与个人特征的摘要',icon:'mdi-account-details-outline',items})+'</div>':'';
  }
  async function detailRelatedPage(world,kind,id,settings,{signal,part,detail=false}) {
    while(true){
      const page=settings.page,result=await LegendsLocalStore.related(world,kind,id,{signal,detail,part,page,pageSize:settings.pageSize,sortKey:settings.sortKey||(part==='events'?'date':''),descending:settings.descending,name:(record,target)=>name(record,target,true),sortValue:(record,key,target)=>columnValue(record,key,target),excludeEventTypes:part==='events'?[...state.excludedEventTypes]:[]});checkAbort(signal);
      const total=Number(result[part==='events'?'eventCount':'collectionCount']||0),normalized=Math.max(1,Math.min(page,Math.max(1,Math.ceil(total/settings.pageSize))));
      if(normalized===page)return result;settings.page=normalized;
    }
  }
  async function renderRecord(kind,id) {
    const generation=renderGeneration,world=state.world,disk=isDiskWorld(world);
    detailController=new AbortController();const signal=detailController.signal;
    let record=state.indexes[kind]?.get(Number(id)),events,collections,relatedResult,neighbors={};
    const active=()=>!signal.aborted&&generation===renderGeneration&&world===state.world;
    const prepareNeighbors=()=>{recordNeighbors(world,kind,id,signal).then(value=>{if(!active())return;neighbors=value;const actions=$('#main .object-actions');if(actions)actions.outerHTML=recordActions(kind,value);},error=>{if(active()&&error.name!=='AbortError'){toast(error.message||'无法载入相邻记录。');offerSourceRecovery(error,world);}});};
    state.familyWorld=null;
    if(disk){
      $('#main').innerHTML='<div class="loading"><progress aria-label="载入中"></progress></div>';
      record=await LegendsLocalStore.getRecord(world,kind,id,{signal});if(generation!==renderGeneration||world!==state.world)return;
      if(record){cacheDiskRecords({[kind]:[record]},world);$('#main').innerHTML=recordHeading(record,kind,world)+recordPreview(record,kind,world)+'<div class="loading" data-detail-loading><progress aria-label="载入中"></progress></div>';prepareNeighbors();await pause();checkAbort(signal);
        const eventSettings=tableState('object-events'),collectionSettings=tableState('object-chronicles');
        relatedResult=await detailRelatedPage(world,kind,id,eventSettings,{signal,part:'events',detail:true});if(!active())return;
        const collectionResult=await detailRelatedPage(world,kind,id,collectionSettings,{signal,part:'collections'});if(!active())return;
        collections=collectionResult.collections||[];
        events=relatedResult.events||[];relatedResult={...relatedResult,collections,collectionCount:collectionResult.collectionCount};state.diskRelated||(state.diskRelated=new Map());state.diskRelated.delete(kind+':'+id);state.diskRelated.set(kind+':'+id,relatedResult);while(state.diskRelated.size>100)state.diskRelated.delete(state.diskRelated.keys().next().value);
        const prefetched=await LegendsLocalStore.prefetchRefs(world,[record,...events,...collections],{signal,namesOnly:true});if(generation!==renderGeneration||world!==state.world)return;
        cacheDiskRecords(prefetched,world);cacheDiskRecords({[kind]:[record],events,collections},world);
        if(kind==='figures'){const familyWorld=await diskFamilyWorld(record,world,signal);if(generation!==renderGeneration||world!==state.world)return;state.familyWorld=familyWorld;}
        if(generation!==renderGeneration||world!==state.world)return;
      }
    }
    if(!record){$('#main').innerHTML='<div class="no-data">无数据</div>';return;}
    events=events||(eventsFor(kind,id).sort((a,b)=>a.year-b.year||a.id-b.id));collections=collections||recordCollections(kind,id);
    const getRecord=async(target,targetId)=>{checkAbort(signal);return disk?LegendsLocalStore.getRecord(world,target,targetId,{signal}):state.indexes[target]?.get(Number(targetId));};
    const getNameRecord=async(target,targetId)=>{checkAbort(signal);const cached=state.indexes[target]?.get(Number(targetId));if(cached&&(!artKinds.has(target)||cached.description!==undefined))return cached;if(artKinds.has(target))return getRecord(target,targetId);if(world.disk?.format==='file-index'){const headers=await LegendsFastStore.getHeaders(world,target,targetId,{signal});checkAbort(signal);return headers.length?LegendsFastStore.headerSummary(headers[headers.length-1],target,world):null;}return getRecord(target,targetId);};
    const model=await LegendsDetails.load(world,kind,record,{signal,escape,term,link,name,references,indexes:state.indexes,getRecord,getNameRecord,cacheRecords:cacheDiskRecords,pathFor,eventText,relatedResult});checkAbort(signal);syncPreparedGeography(world);
    model.location=await window.LegendsMap?.locationImage?.(world,kind,record);
    if(generation!==renderGeneration||world!==state.world)return;state.detailModel=model;
    if(!disk)prepareNeighbors();const heading=recordHeading(record,kind,world,neighbors);
    const info=recordInfo(record,kind,model),eventTotal=disk?Number(relatedResult.eventCount||0):events.length,eventAvailable=disk?Math.max(eventTotal,Object.values(relatedResult.typeCounts||relatedResult.eventTypeCounts||{}).reduce((sum,count)=>sum+Number(count),0)):events.length,collectionTotal=disk?Number(relatedResult.collectionCount||0):collections.length;
    const eventOptions=disk?diskTableSource('events',{recordKind:kind,recordId:id,part:'events',initial:{total:eventTotal,typeCounts:relatedResult.typeCounts||relatedResult.eventTypeCounts,eventYears:relatedResult.eventYears}}):{},collectionOptions=disk?diskTableSource('collections',{recordKind:kind,recordId:id,part:'collections',initial:{total:collectionTotal}}):{};
    $('#main').innerHTML=heading+(info.before?`<div class="detail-grid">${info.before}</div>`:'')+(eventAvailable?eventSection(events,'object-events',eventOptions):'')+(collectionTotal?chroniclesSection(collections,'object-chronicles',collectionOptions):'')+(info.after?`<div class="detail-grid">${info.after}</div>`:'');
    if(eventAvailable)eventChart('chart-object-events',events);
    for(const definition of model.charts){const palette=LegendsMap.raceColors(world);chart(definition.id,definition.type,definition.labels,definition.values,definition.races.map(race=>palette.get(race)||'rgb(112,128,144)'));}
    if(model.warfare)state.graphs.push(LegendsWarfare.mount($('#object-warfare'),model.warfare,{onSelect:openRecord}));
    if(model.timelines)for(const mode of ['primaryOnly','otherPositions']){const host=$('#timeline-'+mode);if(host)state.graphs.push(LegendsTimeline.mount(host,model.timelines,{isCiv:String(record.type).toLowerCase()==='civilization',mode,name,term,onSelect:openRecord}));}
    const family=$('[data-family]');if(family)state.graphs.push(LegendsFamily.mount(family,record,state.familyWorld||state.world,{name,onSelect:openRecord}));
  }
  function openRecord(kind,id) {if(kind==='collections')kind=collectionKind(state.indexes.collections.get(Number(id))||{});location.hash=pathFor(kind,id).slice(1);}
  function toggleFavorite(key) {if(state.favorites.has(key))state.favorites.delete(key);else state.favorites.add(key);storage.set('favorites.'+state.world.id,JSON.stringify([...state.favorites]));renderNav();const button=$(`[data-favorite="${key}"]`);if(button){const active=state.favorites.has(key);button.classList.toggle('active',active);button.setAttribute('aria-pressed',active);button.setAttribute('aria-label',active?'取消收藏':'收藏');button.innerHTML=icon(active?'mdi-star':'mdi-star-outline');}}
  function showImport() {if(state.importing)return;state.sourceRecovery=null;$('#import-title').innerHTML=icon('mdi-earth')+'选择世界导出文件';$('#import-dialog .import-tips p').textContent='选择主导出文件（legends.xml），并同时选择同次导出的 legends_plus.xml 和地图图片。';$('#start-import').textContent='载入世界';$('#import-error').hidden=true;$('#import-progress').hidden=true;$('#import-dialog').showModal();}
  function selectFiles(files) {if(state.importing)return;state.files=[...files];$('#selected-files').innerHTML=state.files.map(file=>`<div class="file-item">${icon('mdi-file-xml-box')}<span>${escape(file.name)}</span></div>`).join('');$('#start-import').disabled=!state.files.length;$('#import-error').hidden=true;}
  function importProgress(progress) {
    const percent=Math.max(0,Math.min(100,Number(progress.percent)||0));
    $('#progress-bar').value=percent;$('#progress-value').textContent=Math.round(percent)+'%';$('#progress-text').textContent=progress.message||'正在载入世界…';
    const diagnostic=state.importDiagnostic;
    if(diagnostic?.status==='running'&&(Date.now()-(diagnostic.updatedAt||0)>1000||diagnostic.phase!==progress.phase)){
      Object.assign(diagnostic,{updatedAt:Date.now(),percent:Math.round(percent*10)/10,phase:progress.phase||'',message:progress.message||'',workers:window.LegendsImport?.getStatus?.().activeWorkers||0});
      saveImportDiagnostic(diagnostic);
    }
  }
  function saveImportDiagnostic(diagnostic){if(state.importDiagnostic!==diagnostic)return;try{localStorage.setItem('atlas.importDiagnostic',JSON.stringify(diagnostic));}catch(_){}}
  function exportImportDiagnostic(){
    const text=localStorage.getItem('atlas.importDiagnostic')||JSON.stringify({message:'暂无导入诊断，请先导入一次世界。'}),url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');
    link.href=url;link.download='Legends-导入诊断.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function releaseImportControls(controller) {
    if(importController!==controller)return false;
    importController=null;state.importing=false;$('#start-import').disabled=!state.files.length;$('#close-import').disabled=false;$('#close-import').textContent='关闭';$('#file-input').disabled=false;return true;
  }
  function cancelImport() {
    if(!state.importing){state.sourceRecovery=null;$('#import-dialog').close();return;}
    const controller=importController;releaseImportControls(controller);$('#import-dialog').close();$('#import-progress').hidden=true;controller?.abort();
  }
  function queueWorldSave(world,files) {
    state.pendingSaves||(state.pendingSaves=new Map());
    const previous=state.pendingSaves.get(world.id);
    const saving=(async()=>{try{await pause();if(previous)await previous.catch(()=>{});if(files&&world.disk?.format==='file-index'&&!world.disk.sourcesPersisted)await LegendsFastStore.persistSourceFiles(world,files,{timeout:120000});await LegendsLocalStore.saveWorld(world);if(state.world===world)storage.set('lastWorld',world.id);}catch(error){if(state.world===world)toast('世界已载入，但本地保存失败：'+(error.message||'请稍后重试'));throw error;}})();
    state.pendingSaves.set(world.id,saving);saving.catch(()=>{}).finally(()=>{if(state.pendingSaves.get(world.id)===saving)state.pendingSaves.delete(world.id);});return saving;
  }
  function queueSourceRepair(world,files){
    state.sourceRepairs||(state.sourceRepairs=new Map());state.sourceRepairs.get(world.id)?.controller.abort();
    const controller=new AbortController(),entry={controller,promise:null};
    const repair=(async()=>{
      await pause();checkAbort(controller.signal);
      await LegendsFastStore.persistReboundSources(world,files,{signal:controller.signal,timeout:120000});
      if(state.world===world)toast('原文件缓存已修复，可直接刷新恢复。');
    })().catch(error=>{
      if(error.name!=='AbortError'&&state.world===world)toast('本次已恢复浏览，但原文件缓存修复失败，刷新后需再次选择原文件。');
    }).finally(()=>{if(state.sourceRepairs.get(world.id)===entry)state.sourceRepairs.delete(world.id);});
    entry.promise=repair;state.sourceRepairs.set(world.id,entry);toast('原文件已关联，正在后台修复本地缓存…');return repair;
  }
  async function restoreWorld(world,options) {
    const previousId=world.disk?.id,previousVersion=world.disk?.aggregates?.version,previousRaceVersion=world.disk?.aggregates?.civilizationRacesVersion,previousCopiedWorksVersion=world.disk?.aggregates?.copiedWorksVersion;
    await setWorld(world,options);
    if(world.disk&&(world.disk.id!==previousId||world.disk.aggregates?.version!==previousVersion||world.disk.aggregates?.civilizationRacesVersion!==previousRaceVersion||world.disk.aggregates?.copiedWorksVersion!==previousCopiedWorksVersion))await queueWorldSave(world);
  }
  function startImport(){if(state.importing||state.cacheBusy)return;return cacheLock('shared',runStartImport);}
  async function runStartImport() {
    if(state.importing||!state.files.length)return;
    const controller=new AbortController(),importFiles=state.files.slice();importController=controller;state.importing=true;$('#start-import').disabled=true;$('#close-import').disabled=false;$('#close-import').textContent='取消';$('#file-input').disabled=true;$('#import-error').hidden=true;$('#import-progress').hidden=false;
    const diagnostic={version:'local-pipeline-1',status:'running',startedAt:new Date().toISOString(),browser:navigator.userAgent,threads:Number($('#import-threads').value)||2,files:importFiles.map(file=>({name:file.name,size:file.size})),percent:0};state.importDiagnostic=diagnostic;saveImportDiagnostic(diagnostic);
    importProgress({percent:0,message:'准备读取世界…'});
    let importedWorld;
    try{
      if(state.sourceRecovery){
        const recovery=state.sourceRecovery;
        importProgress({percent:10,message:'正在重新关联原文件…'});
        await LegendsFastStore.rebindSourceFiles(recovery.world,importFiles);checkAbort(controller.signal);
        state.sourceRecovery=null;
        if(state.world!==recovery.world)await restoreWorld(recovery.world,{navigate:false,renderView:false,signal:controller.signal});
        importProgress({percent:100,message:'原文件已重新关联'});render();$('#import-dialog').close();releaseImportControls(controller);await queueSourceRepair(recovery.world,importFiles);return;
      }
      const images=importFiles.filter(file=>/^image\/(?:png|jpeg|gif|webp|bmp)$/i.test(file.type)||/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file.name));
      if(images.length===importFiles.length){
        if(!state.world)throw new Error('请先载入对应的世界，再选择地图图片。');
        if(images.length!==1)throw new Error('一次只能导入一张地图底图，请选择需要显示的那张地图。');
        const world=state.world,update={sourceFiles:[...(world.sourceFiles||[])]};
        importProgress({percent:10,message:'读取地图图片…'});
        await LegendsData.readMapImage(update,images[0],controller.signal);checkAbort(controller.signal);
        if(state.world!==world)throw new Error('当前世界已切换，请重新选择地图图片。');
        Object.assign(world,update);delete world.generatedMapImage;LegendsMap.invalidate?.(world);
        state.route='map';state.recordId=null;history.replaceState(null,'',pathFor('map'));
        importProgress({percent:100,message:'载入完成'});render();$('#import-dialog').close();releaseImportControls(controller);
        await queueWorldSave(world);return;
      }
      const world=await LegendsData.parseFiles(importFiles,progress=>{if(importController===controller&&!controller.signal.aborted)importProgress({...progress,percent:(Number(progress.percent)||0)*.9});},{signal:controller.signal,threads:Number($('#import-threads').value)||2});
      importedWorld=world;checkAbort(controller.signal);
      await setWorld(world,{navigate:true,renderView:false,onProgress:progress=>{if(importController===controller&&!controller.signal.aborted)importProgress(progress);},signal:controller.signal});
      importProgress({percent:100,message:'载入完成'});render();$('#import-dialog').close();releaseImportControls(controller);
      await queueWorldSave(world,importFiles);
    }catch(error){
      diagnostic.status=error.name==='AbortError'?'cancelled':'failed';diagnostic.error=String(error.message||error);saveImportDiagnostic(diagnostic);
      if(importedWorld?.disk&&state.world!==importedWorld)Promise.resolve().then(()=>LegendsLocalStore.abortImport(importedWorld.disk.id)).catch(()=>{});
      if(importController!==controller)return;
      if(error.name==='AbortError'){$('#import-dialog').close();$('#import-progress').hidden=true;}else{$('#import-error').textContent=error.message||'无法载入世界。';$('#import-error').hidden=false;}
    }
    finally{if(diagnostic.status==='running'){diagnostic.status=controller.signal.aborted?'cancelled':'complete';diagnostic.updatedAt=Date.now();saveImportDiagnostic(diagnostic);}releaseImportControls(controller);}
  }
  function loadWorld(id,options){if(state.cacheBusy)return;return cacheLock('shared',()=>runLoadWorld(id,options));}
  async function runLoadWorld(id,{navigate=true,renderView=true}={}) {
    if(state.importing)return;
    if(state.world?.id===id){if(navigate){state.route='overview';state.recordId=null;history.replaceState(null,'',pathFor('overview'));}if(renderView)render();return;}
    const controller=new AbortController();importController=controller;state.importing=true;$('#import-dialog').showModal();$('#import-progress').hidden=false;$('#import-error').hidden=true;$('#start-import').disabled=true;$('#file-input').disabled=true;$('#close-import').disabled=false;$('#close-import').textContent='取消';importProgress({percent:0,message:'读取已保存的世界…'});
    let world;
    try{world=await LegendsLocalStore.getWorld(id,{signal:controller.signal});checkAbort(controller.signal);if(!world)throw new Error('找不到已保存的世界。');if(world.demo){$('#import-dialog').close();return;}await restoreWorld(world,{navigate,renderView:false,onProgress:progress=>{if(importController===controller&&!controller.signal.aborted)importProgress(progress);},signal:controller.signal});checkAbort(controller.signal);storage.set('lastWorld',world.id);if(renderView)render();$('#import-dialog').close();}
    catch(error){if(importController!==controller)return;if(error.name==='AbortError')$('#import-dialog').close();else if(!offerSourceRecovery(error,world)){$('#import-error').textContent=error.message||'无法载入世界。';$('#import-error').hidden=false;}}
    finally{releaseImportControls(controller);}
  }
  function expandEvents(id) {
    const source=state.tableSources.get(id);if(!source)return;const counts=new Map(Object.entries(source.typeCounts||{}));if(!counts.size)for(const event of source.allRows||source.rows)counts.set(eventType(event),(counts.get(eventType(event))||0)+1);const types=[...counts.keys()].sort((a,b)=>counts.get(b)-counts.get(a));
    $('#expanded-content').innerHTML=sectionHeader('事件','事件概览','mdi-calendar-clock')+`<div class="expanded-event-grid"><div class="event-type-list">${types.map(type=>`<label><input type="checkbox" ${state.excludedEventTypes.has(type)?'':'checked'} data-event-type="${escape(type)}"><span>${escape(eventLabel({type}))}</span><span class="chip">${fmt(counts.get(type))}</span></label>`).join('')}</div><div class="event-type-chart"><canvas id="expanded-event-chart"></canvas></div></div><div class="modal-footer"><button class="button" data-action="close-expanded">关闭对话框</button></div>`;
    $('#expanded-dialog').showModal();const bar=chart('expanded-event-chart','bar',types.map(t=>eventLabel({type:t})),types.map(t=>counts.get(t)));
    function barColors(){bar.data.datasets[0].backgroundColor=types.map(type=>state.excludedEventTypes.has(type)?'rgba(120,120,120,0.2)':'rgba(75,192,192,0.6)');bar.data.datasets[0].borderColor=types.map(type=>state.excludedEventTypes.has(type)?'rgba(120,120,120,0.3)':'rgb(75,192,192)');bar.update();}
    barColors();
    $$('[data-event-type]').forEach(input=>input.addEventListener('change',()=>{
      if(input.checked)state.excludedEventTypes.delete(input.dataset.eventType);else state.excludedEventTypes.add(input.dataset.eventType);
      if(source.remote){updateTable(id);const chip=$(`[data-event-filter-state="${id}"]`);if(chip)chip.innerHTML=eventFilterChip(id);const previous=state.charts.find(instance=>instance.canvas?.id==='chart-'+id);if(previous){previous.destroy();state.charts=state.charts.filter(instance=>instance!==previous);eventChart('chart-'+id,source.allRows||source.rows);}barColors();return;}
      const rows=(source.allRows||source.rows).filter(event=>!state.excludedEventTypes.has(eventType(event))),host=$(`[data-table="${id}"]`);
      if(host)host.innerHTML=tableMarkup(id,rows,source.headers,source.kind);
      const chip=$(`[data-event-filter-state="${id}"]`);if(chip)chip.innerHTML=eventFilterChip(id);
      const chartId='chart-'+id,previous=state.charts.find(instance=>instance.canvas?.id===chartId);
      if(previous){previous.destroy();state.charts=state.charts.filter(instance=>instance!==previous);eventChart(chartId,rows);}
      barColors();
    }));
  }
  function bind() {
    $('#menu-toggle').onclick=()=>{const open=$('#sidebar').classList.toggle('open');$('#drawer-backdrop').hidden=!open;};$('#drawer-backdrop').onclick=()=>{$('#sidebar').classList.remove('open');$('#drawer-backdrop').hidden=true;};
    $('#file-input').onchange=event=>selectFiles(event.target.files);$('#start-import').onclick=startImport;$('#close-import').onclick=cancelImport;
    $('#import-dialog').addEventListener('cancel',event=>{if(state.importing){event.preventDefault();cancelImport();}});
    const drop=$('#drop-zone');drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('dragover');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('dragover');selectFiles(event.dataTransfer.files);});
    $('#cancel-filter').onclick=()=>$('#filter-dialog').close();
    $('#apply-filter').onclick=()=>{state.rules=filterController?.getRules()||[];state.filter='';tableState('list').page=1;$('#filter-dialog').close();renderCollection();};
    $('#clear-filters').onclick=()=>{filterController?.clear();state.rules=[];state.filter='';state.minYear='';state.maxYear='';tableState('list').page=1;const chips=$('#active-filters');if(chips)chips.innerHTML='';filterRows();};
    $('#filter-dialog').addEventListener('click',event=>{if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.currentTarget.close();});
    document.addEventListener('click',async event=>{
      const disabled=event.target.closest('[aria-disabled="true"]');if(disabled){event.preventDefault();return;}
      const action=event.target.closest('[data-action]');if(action?.dataset.action==='import')showImport();if(action?.dataset.action==='retry-view')render();if(action?.dataset.action==='close-expanded')$('#expanded-dialog').close();
      const load=event.target.closest('[data-load-world]');if(load)loadWorld(load.dataset.loadWorld);
      const remove=event.target.closest('[data-delete-world]');if(remove)await changeCache('world',remove.dataset.deleteWorld);
      const removeMap=event.target.closest('[data-remove-map]');if(removeMap)await changeCache('map',removeMap.dataset.removeMap);
      const cache=event.target.closest('[data-cache-action]');if(cache)await changeCache(cache.dataset.cacheAction);
      if(event.target.closest('[data-export-import-diagnostic]'))exportImportDiagnostic();
      const favorite=event.target.closest('[data-favorite]');if(favorite)toggleFavorite(favorite.dataset.favorite);
      const page=event.target.closest('[data-page-table]');if(page&&!page.disabled){tableState(page.dataset.pageTable).page=Number(page.dataset.page);updateTable(page.dataset.pageTable);}
      const sort=event.target.closest('[data-sort-table]');if(sort){const settings=tableState(sort.dataset.sortTable);if(settings.sortKey===sort.dataset.sortKey)settings.descending=!settings.descending;else{settings.sortKey=sort.dataset.sortKey;settings.descending=false;}settings.page=1;updateTable(sort.dataset.sortTable);}
      const clearEventFilters=event.target.closest('[data-clear-event-filters]');if(clearEventFilters){state.excludedEventTypes.clear();render();}
      if(event.target.closest('[data-expand-family],[data-expand-warfare],[data-expand-timeline],[data-expand-events]')){expandedGraph?.destroy();expandedGraph=null;for(const chart of [...state.charts])if(chart.canvas&&$('#expanded-dialog').contains(chart.canvas)){chart.destroy();state.charts=state.charts.filter(instance=>instance!==chart);}}
      const expanded=event.target.closest('[data-expand-events]');if(expanded)expandEvents(expanded.dataset.expandEvents);
      const family=event.target.closest('[data-expand-family]');if(family){
        const figure=state.indexes.figures.get(Number(family.dataset.expandFamily));
        $('#expanded-content').innerHTML=sectionHeader('家族树','祖先与后裔','mdi-family-tree')+'<div class="family-graph" id="expanded-family"></div><div class="modal-footer"><button class="button" data-action="close-expanded">关闭对话框</button></div>';
        $('#expanded-dialog').showModal();
        expandedGraph=LegendsFamily.mount($('#expanded-family'),figure,state.familyWorld||state.world,{name,fullscreen:true,onSelect:(kind,id)=>{$('#expanded-dialog').close();openRecord(kind,id);}});
      }
      const warfare=event.target.closest('[data-expand-warfare]');if(warfare&&state.detailModel?.warfare){$('#expanded-content').innerHTML=sectionHeader(state.route==='entities'?'战争图':'战役图','按冲突规模呈现参战派系','mdi-graph-outline')+'<div class="warfare-graph" id="expanded-warfare"></div><div class="modal-footer"><button class="button" data-action="close-expanded">关闭对话框</button></div>';$('#expanded-dialog').showModal();expandedGraph=LegendsWarfare.mount($('#expanded-warfare'),state.detailModel.warfare,{fullscreen:true,onSelect:(kind,id)=>{$('#expanded-dialog').close();openRecord(kind,id);}});}
      const timeline=event.target.closest('[data-expand-timeline]');if(timeline&&state.detailModel?.timelines){const record=state.detailModel.record;$('#expanded-content').innerHTML=sectionHeader(timeline.dataset.expandTimeline==='primaryOnly'?'君主时间线':'其他职位时间线','职位持有者与任期','mdi-timeline-clock-outline')+'<div class="monarch-timeline" id="expanded-timeline"></div><div class="modal-footer"><button class="button" data-action="close-expanded">关闭对话框</button></div>';$('#expanded-dialog').showModal();expandedGraph=LegendsTimeline.mount($('#expanded-timeline'),state.detailModel.timelines,{fullscreen:true,isCiv:String(record.type).toLowerCase()==='civilization',mode:timeline.dataset.expandTimeline,name,term,onSelect:(kind,id)=>{$('#expanded-dialog').close();openRecord(kind,id);}});}
    });
    document.addEventListener('change',event=>{if(event.target.matches('[data-page-size]')){const id=event.target.dataset.pageSize,settings=tableState(id);settings.pageSize=Number(event.target.value);settings.page=1;updateTable(id);}});
    $('#expanded-dialog').addEventListener('close',()=>{if($('#expanded-dialog').open)return;expandedGraph?.destroy();expandedGraph=null;for(const chart of [...state.charts])if(chart.canvas&&$('#expanded-dialog').contains(chart.canvas)){chart.destroy();state.charts=state.charts.filter(instance=>instance!==chart);}});
    window.addEventListener('hashchange',parseRoute);
  }
  async function init() {
    $('#main').innerHTML='<div class="loading"><progress aria-label="载入中"></progress></div>';
    try{await DFTranslate.ready;}catch(error){$('#main').textContent=error.message;return;}
    bind();
    const last=storage.get('lastWorld');if(last)await loadWorld(last,{navigate:false,renderView:false});
    parseRoute();
  }
  window.LegendsApp={state,setWorld,openRecord,showImport,records:recordRows};
  init();
})();

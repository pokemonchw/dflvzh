/* Disk-backed Legends records. This factory also runs inside the import worker. */
(function installLegendsLocalStore(global) {
  'use strict';
  const VERSION=3, DB_NAME='legends-atlas';
  const array=value=>value===undefined||value===null||value===''?[]:Array.isArray(value)?value:[value];
  const scalar=value=>Array.isArray(value)?scalar(value[0]):value;
  const number=value=>{value=scalar(value);return value!==''&&value!==undefined&&value!==null&&typeof value!=='object'&&Number.isFinite(Number(value))?Number(value):null;};
  const fold=value=>String(scalar(value)??'').trim().toLowerCase().replace(/_/g,' ');
  const dictionary=()=>Object.create(null);
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const extraGroups={undergroundregions:'underground_regions',landmasses:'landmasses',rivers:'rivers',mountainpeaks:'mountain_peaks',structures:'structures',constructions:'world_constructions',danceforms:'dance_forms',musicalforms:'musical_forms',poeticforms:'poetic_forms',writtencontents:'written_contents'};
  const baseGroups=['figures','sites','entities','artifacts','events','eras','regions','collections'];
  const typeGroups={wars:['war'],battles:['battle'],duels:['duel'],raids:['raid'],siteconquerings:['site conquering'],insurrections:['insurrection'],persecutions:['persecution'],purges:['purge'],coups:['coup'],rampages:['beast attack'],abductions:['abduction'],thefts:['theft'],processions:['procession'],performances:['performance'],journeys:['journey'],competitions:['competition'],ceremonies:['ceremony'],occasions:['occasion']};
  let databasePromise;
  function database(){
    if(databasePromise)return databasePromise;
    databasePromise=new Promise((resolve,reject)=>{
      const request=global.indexedDB.open(DB_NAME,VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('worlds'))db.createObjectStore('worlds',{keyPath:'id'});
        if(!db.objectStoreNames.contains('catalog'))db.createObjectStore('catalog',{keyPath:'id'});
        const hasPayloads=db.objectStoreNames.contains('payloads');
        if(!hasPayloads)db.createObjectStore('payloads',{keyPath:['worldId','group','key']}).createIndex('world','worldId');
        if(!db.objectStoreNames.contains('records')){
          const records=db.createObjectStore('records',{keyPath:['worldId','group','key']});
          records.createIndex('world','worldId');
          records.createIndex('order',['worldId','group','order']);
          records.createIndex('id',['worldId','group','id']);
          records.createIndex('name',['worldId','group','name']);
          records.createIndex('type',['worldId','group','type','order']);
          records.createIndex('year',['worldId','group','year','order']);
          records.createIndex('refs','refs',{multiEntry:true});
          records.createIndex('members','members',{multiEntry:true});
        }else if(!hasPayloads){const tx=request.transaction,cursor=tx.objectStore('records').openCursor();cursor.onsuccess=()=>{const value=cursor.result;if(value){const row=value.value;if(row.record){tx.objectStore('payloads').put({worldId:row.worldId,group:row.group,key:row.key,record:row.record});delete row.record;value.update(row);}value.continue();}};}
      };
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();databasePromise=null;};resolve(db);};
      request.onerror=()=>{databasePromise=null;reject(request.error);};
      request.onblocked=()=>reject(new Error('请关闭旧版 Legends Viewer 页面后重试。'));
    });
    return databasePromise;
  }
  function checkAbort(signal){if(signal?.aborted)throw new DOMException('查询已取消。','AbortError');}
  function cancelTransaction(tx,signal,reject){
    if(!signal)return;
    const cancel=()=>{try{tx.abort();}catch(_){}reject(new DOMException('查询已取消。','AbortError'));};
    const release=()=>signal.removeEventListener('abort',cancel);
    signal.addEventListener('abort',cancel,{once:true});tx.addEventListener('complete',release,{once:true});tx.addEventListener('abort',release,{once:true});
    if(signal.aborted)cancel();
  }
  const requestResult=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const transactionDone=tx=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('本地记录写入已中止。'));tx.onerror=()=>reject(tx.error);});
  const range=(id,group)=>IDBKeyRange.bound([id,group,-Infinity],[id,group,Infinity]);
  const prefixRange=(id,group)=>IDBKeyRange.bound([id,group],[id,group,[]]);
  function descriptor(world,kind){const definition=global.LegendsUI?.categories?.[kind],types=definition?.collectionTypes||(own(typeGroups,kind)?typeGroups[kind]:null);return {id:world.disk.id,group:types?'collections':own(extraGroups,kind)?extraGroups[kind]:kind,types};}
  function refKind(key,parent){
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
    if(key==='target')return {entity_link:'entities',hf_link:'figures',hfhf_link:'figures',site_link:'sites'}[parent]||null;
    if(/^(?:hfid|hf_id|hf|hf1|hf2|histfig|histfig_id|historical_figure_id|historical_figure|hist_figure_id|figure_id|slayer_hf|slayer_hfid|victim_hf|victim_hfid|doer|doer_hf|doer_hfid|target_hf|target_hfid|builder_hf|builder_hfid|creator_hf|creator_hfid|seeker_hf|holder_hf|giver_hf|receiver_hf|attacker_hf|defender_hf|hfid1|hfid2|source_hf|abducted_hf|body_hf|speaker_hf|student|teacher|maker|maker_hfid)$/.test(key)||/^(?:hf|histfig|hist_figure|historical_figure)_id_?\d?$/.test(key))return 'figures';
    if(/^(?:site|site_id|siteid|source_site|target_site|dest_site|destination_site|old_site|new_site)$/.test(key))return 'sites';
    if(/^(?:entity|entity_id|entityid|civ|civ_id|civid|site_civ|site_civ_id|cur_owner_id|attacker_civ|defender_civ|attacker_civ_id|defender_civ_id|attacker_enid|defender_enid|attacking_enid|defending_enid|attacker_ent_id|defender_ent_id|group|group_id|enid|entity_1|entity_2)$/.test(key))return 'entities';
    if(/^(?:artifact|artifact_id|artifactid)$/.test(key))return 'artifacts';
    if(/^(?:region|region_id|regionid)$/.test(key))return 'regions';
    return null;
  }
  const keyKinds=new Map();
  function references(record,world){
    const found=new Map();
    function walk(object,depth,parent){if(!object||typeof object!=='object'||depth>5)return;for(const key in object){if(key==='raw')continue;const value=object[key],cacheKey=parent+':'+key;if(!keyKinds.has(cacheKey))keyKinds.set(cacheKey,refKind(key.toLowerCase(),parent));const kind=keyKinds.get(cacheKey);if(kind)for(const raw of array(value)){const id=number(raw);if(id!==null&&id>=0)found.set(kind+':'+id,{kind,id,key});}if(value&&typeof value==='object')walk(value,depth+1,Array.isArray(object)?parent:key);}}
    walk(record,0,'');
    for(const ref of global.DFTranslate?.eventReferences?.(record)||[])found.set(ref.kind+':'+ref.id,ref);
    const source=record?.raw||record||{},aggregates=world?.disk?.aggregates||world?.aggregates;
    for(const [siteKey,structureKey]of [['site_id','structure_id'],['site_id','structure_local_id'],['source_site_id','source_structure_id'],['dest_site_id','dest_structure_id']]){const id=aggregates?.structureLookup?.[(record?.[siteKey]??source[siteKey])+':'+(record?.[structureKey]??source[structureKey])];if(id!==undefined)found.set('structures:'+id,{kind:'structures',id:Number(id),key:structureKey});}
    return [...found.values()];
  }
  const refKey=(id,kind,key,group)=>id+'\0'+kind+'\0'+key+'\0'+group;
  const memberKey=(id,group,key)=>id+'\0'+group+'\0'+key;
  function normalized(record,group,index){
    const base=baseGroups.includes(group),sourceName=record.name||record.title||record.name_string;
    const result=global.LegendsData.normalizeRecord(record,base?group:'collections',index);
    if(!base)result.name=typeof sourceName==='string'&&sourceName?sourceName:String(result.type||'#')+' '+result.id;
    return global.LegendsData.normalizeGeography(global.LegendsData.normalizeArtForm(result,group),group);
  }
  function totalFor(world,kind){const d=descriptor(world,kind);return d.types?d.types.reduce((sum,type)=>sum+(world.disk.typeCounts?.[type]||0),0):world.disk.counts?.[d.group]||0;}
  function compact(record,group,id){
    if(group==='regions'||group==='eras')return normalized({...record},group,id);
    if(!baseGroups.includes(group))return {...record,id};
    const result={id};
    for(const key of ['name','translated_name','name_string','type','race','caste','coords','civ_id','cur_owner_id','region_id','subregion_id','depth','x','y'])if(record[key]!==undefined)result[key]=record[key];
    if(group==='entities')result.entity_link=array(record.entity_link).filter(link=>fold(link.type||link.link_type)==='parent').map(link=>({type:link.type,target:link.target,entity_id:link.entity_id}));
    return normalized(result,group,id);
  }
  async function createImport(options={}){
    const db=await database(),id=options.id||'import-'+Date.now()+'-'+Math.random().toString(36).slice(2),counts=dictionary(),typeCounts=dictionary(),eventYears=dictionary(),entityMembers=dictionary(),sectionCounts=dictionary(),metadata=dictionary(),summaries=new Map(),orders=dictionary();
    const retained=new Set(['sites','entities','regions','eras','underground_regions','landmasses','rivers','mountain_peaks','world_constructions','dance_forms','musical_forms','poetic_forms','entity_populations']);
    let latest=0,closed=false,seenBytes=0,summaryBytes=0;
    const seenBlocks=new Map(),summarySizes=new Map(),SUMMARY_BUDGET=24*1024*1024;
    function firstNumericKey(group,key){if(!Number.isSafeInteger(key)||key<0)return false;const blockKey=group+':'+Math.floor(key/4096);let block=seenBlocks.get(blockKey);if(!block){if(seenBytes>=8*1024*1024)return false;seenBlocks.set(blockKey,block=new Uint32Array(128));seenBytes+=512;}const offset=key%4096,word=offset>>>5,mask=1<<(offset&31),seen=block[word]&mask;block[word]|=mask;return !seen;}
    function adjust(row,delta){
      if(row.group==='events'){
        if(!eventYears[row.type])eventYears[row.type]=dictionary();const years=eventYears[row.type];years[row.year]=(years[row.year]||0)+delta;if(!years[row.year])delete years[row.year];
      }
      if(row.group==='figures')for(const ref of row.refs||[]){const parts=ref.split('\0');if(parts[1]==='entities')entityMembers[parts[2]]=(entityMembers[parts[2]]||0)+delta;}
    }
    async function writeBatch(entries){
      if(closed)throw new Error('导入已结束。');
      const pending=new Map();
      for(const entry of entries){const group=entry.group||entry.section;if(!baseGroups.includes(group)&&entry.tag)entry.record['@tag']=entry.tag;const rawId=number(entry.record.id??entry.record.local_id),key=rawId!==null?rawId:entry.record.name?'name:'+scalar(entry.record.name):'row:'+(orders[group]||0)+':'+pending.size,pendingKey=group+'\0'+key;const existing=pending.get(pendingKey);if(existing)global.LegendsData.mergeRecord(existing.record,entry.record,group==='events');else pending.set(pendingKey,{...entry,group,key,rawId});
        if(group==='sites')for(const structure of array(entry.record.structure||entry.record.structures)){if(!structure||typeof structure!=='object')continue;const local=number(structure.id??structure.local_id);if(rawId===null||local===null)continue;const id=rawId*1000000+local;const key='structures\0'+id,record={...structure,id,site_id:rawId},previous=pending.get(key);if(previous)global.LegendsData.mergeRecord(previous.record,record,false);else pending.set(key,{section:'structures',group:'structures',key:id,rawId:id,record});}
      }
      const tx=db.transaction(['records','payloads'],'readwrite',{durability:'relaxed'}),done=transactionDone(tx),store=tx.objectStore('records'),payloads=tx.objectStore('payloads');
      for(const entry of pending.values()){
        const {group,key,rawId}=entry;
        function process(previous){
          function put(record){
            const order=previous?previous.order:(orders[group]||0),recordId=rawId??order;
            if(!previous){orders[group]=order+1;counts[group]=(counts[group]||0)+1;sectionCounts[entry.section]=(sectionCounts[entry.section]||0)+1;}
            const type=fold(record.type),year=number(record.year??record.start_year)??-1,refs=references(record);
            const row={worldId:id,group,key,id:recordId,order,type,year,name:fold(record.translated_name||record.name||record.name_string||record.title),refs:refs.map(ref=>refKey(id,ref.kind,ref.id,group)),members:[]};
            if(group==='collections'){
              for(const field of ['event','event_id'])for(const value of array(record[field]))if(number(value)!==null)row.members.push(memberKey(id,'events',number(value)));
              for(const field of ['eventcol','collection'])for(const value of array(record[field]))if(number(value)!==null)row.members.push(memberKey(id,'collections',number(value)));
              if(previous)typeCounts[previous.type]=(typeCounts[previous.type]||0)-1;typeCounts[type]=(typeCounts[type]||0)+1;
            }
            if(previous)adjust(previous,-1);adjust(row,1);
            for(const field of ['year','start_year','end_year'])latest=Math.max(latest,number(record[field])||0);
            if(retained.has(group)){if(!summaries.has(group))summaries.set(group,new Map());const rows=summaries.get(group);if(rows.has(recordId)||rows.size<50000){const summary=compact(record,group,recordId),summaryKey=group+':'+recordId,size=JSON.stringify(summary).length*2,previousSize=summarySizes.get(summaryKey)||0;if(summaryBytes-previousSize+size<=SUMMARY_BUDGET){summaryBytes+=size-previousSize;summarySizes.set(summaryKey,size);rows.set(recordId,summary);}}}
            payloads.put({worldId:id,group,key,record});store.put(row);
          }
          if(previous){const original=payloads.get([id,group,key]);original.onsuccess=()=>put(global.LegendsData.mergeRecord(original.result.record,entry.record,group==='events'));}
          else put(entry.record);
        }
        if(firstNumericKey(group,key))process(undefined);else{const lookup=store.get([id,group,key]);lookup.onsuccess=()=>process(lookup.result);}
      }
      try{await done;}catch(error){if(error?.name==='QuotaExceededError')throw new Error('浏览器本地存储空间不足，无法保存这份世界文件。');throw error;}
    }
    async function finish(worldMetadata={}){
      closed=true;
      const world={...metadata,...worldMetadata,year:Math.max(latest,Number(worldMetadata.year)||0),sourceFiles:worldMetadata.sourceFiles||array(options.files).map(file=>file.name),extra:{}};
      for(const group of baseGroups)world[group]=[...(summaries.get(group)?.values()||[])];
      for(const [group,records] of summaries)if(!baseGroups.includes(group))world.extra[group]=[...records.values()];
      global.LegendsData.normalizeWorld(world);
      world.disk={id,counts,sectionCounts,typeCounts,eventYears,entityMembers};
      return world;
    }
    return {id,writeBatch,metadata(key,value){metadata[key]=value;},finish,async abort(){closed=true;await abortImport(id);}};
  }
  async function abortImport(id){
    const db=await database(),tx=db.transaction(['records','payloads'],'readwrite'),done=transactionDone(tx);
    const keys=IDBKeyRange.bound([id],[id,[]]);for(const name of ['records','payloads'])tx.objectStore(name).delete(keys);
    await done;
  }
  async function loadRows(headers){
    if(!headers.length)return [];
    const db=await database(),tx=db.transaction('payloads'),store=tx.objectStore('payloads');
    return Promise.all(headers.map(row=>requestResult(store.get([row.worldId,row.group,row.key])).then(payload=>payload?normalized(payload.record,row.group,row.id):null))).then(rows=>rows.filter(Boolean));
  }
  async function completeEra(world,record,header){
    if(!record||number(record.end_year)!==null)return record;
    const summary=world.eras?.find(row=>Number(row.id)===Number(record.id));
    if(number(summary?.end_year)!==null){record.end_year=Number(summary.end_year);return record;}
    const db=await database(),first=number(record.start_year)??header?.year??-Infinity;
    const next=await new Promise((resolve,reject)=>{const request=db.transaction('records').objectStore('records').index('year').openCursor(IDBKeyRange.lowerBound([world.disk.id,'eras',first,header?.order??0],true));request.onsuccess=()=>{const row=request.result?.value;resolve(row?.worldId===world.disk.id&&row.group==='eras'?row:null);};request.onerror=()=>reject(request.error);});
    record.end_year=next?next.year-1:-1;return record;
  }
  async function getRecord(world,kind,id){
    const d=descriptor(world,kind),db=await database(),row=await requestResult(db.transaction('records').objectStore('records').index('id').get([d.id,d.group,Number(id)]));
    const record=row?(await loadRows([row]))[0]||null:null;
    return d.group==='eras'?completeEra(world,record,row):record;
  }
  function sortField(key){return {html:'name',date:'year',startDate:'year',start_year:'year',name:'name',type:'type',id:'id'}[key]||'order';}
  async function query(world,kind,options={}){
    checkAbort(options.signal);
    const d=descriptor(world,kind),db=await database(),page=Math.max(1,Number(options.page)||1),pageSize=Math.min(100,Math.max(1,Number(options.pageSize)||10)),offset=(page-1)*pageSize,q=String(options.query||'').trim().toLowerCase(),excluded=new Set(options.excludeEventTypes||[]);
    const field=sortField(options.sortKey),indexName=field==='type'?'type':field,indexRange=prefixRange(d.id,d.group),direction=options.descending?'prev':'next';
    const simple=!q&&!d.types&&!options.rules?.length&&!excluded.size;
    const result=await new Promise((resolve,reject)=>{
      const headers=[],tx=db.transaction(['records','payloads']),request=tx.objectStore('records').index(indexName).openCursor(indexRange,direction),payloads=tx.objectStore('payloads');let total=0,advanced=false;
      request.onerror=()=>reject(request.error);tx.onabort=()=>reject(tx.error||new DOMException('查询已取消。','AbortError'));cancelTransaction(tx,options.signal,reject);
      request.onsuccess=()=>{
        const cursor=request.result;
        if(!cursor){resolve({headers,total:simple?totalFor(world,kind):total});return;}
        if(simple&&!advanced&&offset){advanced=true;cursor.advance(offset);return;}
        const row=cursor.value;
        if(d.types&&!d.types.includes(row.type)||excluded.has(row.type)){cursor.continue();return;}
        if(simple){headers.push(row);if(headers.length>=pageSize){resolve({headers,total:totalFor(world,kind)});return;}cursor.continue();return;}
        const chinese=/[^\x00-\x7f]/.test(q),headerMatch=!q||String(row.id)===q||row.name.includes(q);
        if(!headerMatch&&!chinese){cursor.continue();return;}
        function accept(record){
          if(!headerMatch&&!String(options.name?.(record,kind)||'').toLowerCase().includes(q)){cursor.continue();return;}
          if(options.rules?.length&&global.LegendsFilters&&!global.LegendsFilters.matches(record,kind,options.rules,options.context||{world})){cursor.continue();return;}
          if(total>=offset&&headers.length<pageSize)headers.push(row);total++;cursor.continue();
        }
        if(options.rules?.length||!headerMatch){const payload=payloads.get(cursor.primaryKey);payload.onsuccess=()=>accept(normalized(payload.result.record,row.group,row.id));payload.onerror=()=>reject(payload.error);}
        else accept(null);
      };
    });
    checkAbort(options.signal);let rows=await loadRows(result.headers);checkAbort(options.signal);
    if(d.group==='eras'){const headers=new Map(result.headers.map(row=>[row.id,row]));rows=await Promise.all(rows.map(record=>completeEra(world,record,headers.get(record.id))));}
    return {rows:await enrichCounts(world,kind,rows),total:result.total};
  }
  async function enrichCounts(world,kind,rows){
    if(!rows.length||['events','eras'].includes(kind))return rows;
    const d=descriptor(world,kind);
    // Collection membership and inherited chronicles cannot be counted through
    // direct record references. Leave those metrics unset instead of reporting 0.
    if(d.group==='collections')return rows;
    const db=await database(),tx=db.transaction('records'),index=tx.objectStore('records').index('refs');
    await Promise.all(rows.map(async row=>{row.event_count=await requestResult(index.count(IDBKeyRange.only(refKey(d.id,d.group,row.id,'events'))));}));return rows;
  }
  async function fromIndex(world,indexName,key,options={}){
    checkAbort(options.signal);
    const db=await database(),page=Math.max(1,Number(options.page)||1),pageSize=Math.min(100,Math.max(1,Number(options.pageSize)||10)),offset=(page-1)*pageSize,excluded=new Set(options.excludeEventTypes||[]);
    const result=await new Promise((resolve,reject)=>{
      const tx=db.transaction('records'),index=tx.objectStore('records').index(indexName),request=index.openCursor(IDBKeyRange.only(key),options.descending?'prev':'next'),headers=[],typeCounts=dictionary(),eventYears=dictionary();let total=0;
      cancelTransaction(tx,options.signal,reject);request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const cursor=request.result;if(!cursor){resolve({headers,total,typeCounts,eventYears});return;}const row=cursor.value;typeCounts[row.type]=(typeCounts[row.type]||0)+1;if(row.group==='events'){if(!eventYears[row.type])eventYears[row.type]=dictionary();eventYears[row.type][row.year]=(eventYears[row.type][row.year]||0)+1;}if(!excluded.has(row.type)){if(total>=offset&&headers.length<pageSize)headers.push(row);total++;}cursor.continue();};
    });
    return {...result,rows:await loadRows(result.headers)};
  }
  async function headerParents(db,key){return requestResult(db.transaction('records').objectStore('records').index('members').getAll(IDBKeyRange.only(key)));}
  async function related(world,kind,id,options={}){
    checkAbort(options.signal);
    const d=descriptor(world,kind),key=refKey(d.id,d.group,Number(id),'events'),db=await database(),page=Math.max(1,Number(options.page)||1),pageSize=Math.min(100,Math.max(1,Number(options.pageSize)||10)),start=(page-1)*pageSize;
    if(d.group==='events'){const record=await getRecord(world,kind,id);return{events:record?[record]:[],collections:[],eventCount:record?1:0,collectionCount:0};}
    if(d.group==='eras'){
      const era=await getRecord(world,kind,id),first=number(era?.start_year)??-Infinity,last=number(era?.end_year),yearRange=IDBKeyRange.bound([d.id,'events',first],[d.id,'events',last===null||last<0?Infinity:last,[]]);
      const result=await new Promise((resolve,reject)=>{const headers=[],typeCounts=dictionary(),eventYears=dictionary(),excluded=new Set(options.excludeEventTypes||[]);let total=0;const tx=db.transaction('records'),request=tx.objectStore('records').index('year').openCursor(yearRange,options.descending?'prev':'next');cancelTransaction(tx,options.signal,reject);request.onsuccess=()=>{const cursor=request.result;if(!cursor){resolve({headers,total,typeCounts,eventYears});return;}const row=cursor.value;typeCounts[row.type]=(typeCounts[row.type]||0)+1;if(!eventYears[row.type])eventYears[row.type]=dictionary();eventYears[row.type][row.year]=(eventYears[row.type][row.year]||0)+1;if(!excluded.has(row.type)){if(total>=start&&headers.length<pageSize)headers.push(row);total++;}cursor.continue();};request.onerror=()=>reject(request.error);});
      return{events:await loadRows(result.headers),collections:[],eventCount:result.total,collectionCount:0,typeCounts:result.typeCounts,eventYears:result.eventYears};
    }
    if(d.group==='collections'){
      const record=await getRecord(world,kind,id),seen=new Set(),pending=record?[record]:[],eventIds=new Set(),collections=[];
      while(pending.length){checkAbort(options.signal);const current=pending.pop();if(seen.has(current.id))continue;seen.add(current.id);for(const value of array(current.event||current.event_id))eventIds.add(Number(value));for(const child of array(current.eventcol||current.collection)){const row=await getRecord(world,'collections',child);if(row){if(current===record)collections.push(row);pending.push(row);}}}
      const ids=eventIds.values(),headers=[],typeCounts=dictionary(),eventYears=dictionary(),excluded=new Set(options.excludeEventTypes||[]);let total=0,ended=false;
      while(!ended){checkAbort(options.signal);const next=[];while(next.length<256){const value=ids.next();if(value.done){ended=true;break;}next.push(value.value);}if(!next.length)break;const tx=db.transaction('records'),index=tx.objectStore('records').index('id');const batch=await Promise.all(next.map(id=>requestResult(index.get([d.id,'events',id]))));for(const row of batch){if(!row)continue;typeCounts[row.type]=(typeCounts[row.type]||0)+1;if(!eventYears[row.type])eventYears[row.type]=dictionary();eventYears[row.type][row.year]=(eventYears[row.type][row.year]||0)+1;if(!excluded.has(row.type)){if(total>=start&&headers.length<pageSize)headers.push(row);total++;}}}
      return {events:await loadRows(headers),collections:collections.slice(start,start+pageSize),eventCount:total,collectionCount:collections.length,typeCounts,eventYears};
    }
    const [events,direct]=await Promise.all([fromIndex(world,'refs',key,options),fromIndex(world,'refs',refKey(d.id,d.group,Number(id),'collections'),{pageSize:100,signal:options.signal})]);
    const found=new Map(direct.headers.map(row=>[Number(row.id),row]));
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('records'),store=tx.objectStore('records'),request=store.index('refs').openKeyCursor(IDBKeyRange.only(key));let cursorDone=false,pending=0;
      cancelTransaction(tx,options.signal,reject);const finish=()=>{if(cursorDone&&!pending)resolve();};request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const cursor=request.result;if(!cursor){cursorDone=true;finish();return;}const eventId=Number(String(cursor.primaryKey[2]).replace(/^id:/,''));if(Number.isFinite(eventId)){pending++;const parents=store.index('members').getAll(IDBKeyRange.only(memberKey(d.id,'events',eventId)));parents.onsuccess=()=>{for(const row of parents.result)found.set(row.id,row);pending--;finish();};parents.onerror=()=>reject(parents.error);}cursor.continue();};
    });
    const pending=[...found.keys()],seen=new Set();while(pending.length){checkAbort(options.signal);const child=pending.pop();if(seen.has(child))continue;seen.add(child);for(const parent of await headerParents(db,memberKey(d.id,'collections',child)))if(!found.has(parent.id)){found.set(parent.id,parent);pending.push(parent.id);}}
    return {events:events.rows,collections:await loadRows([...found.values()].sort((a,b)=>a.order-b.order).slice(start,start+pageSize)),eventCount:events.total,collectionCount:found.size,typeCounts:events.typeCounts,eventYears:events.eventYears};
  }
  async function prefetchRefs(world,records){
    const refs=new Map();for(const record of records)for(const ref of references(record,world))refs.set(ref.kind+':'+ref.id,ref);
    const output={};await Promise.all([...refs.values()].map(async ref=>{const record=await getRecord(world,ref.kind,ref.id);if(record)(output[ref.kind]||(output[ref.kind]=[])).push(record);}));return output;
  }
  async function readStored(db,store,key,options={}){return global.LegendsStorageValues?global.LegendsStorageValues.read(db,store,key,options):requestResult(db.transaction(store).objectStore(store).get(key));}
  async function getWorld(id,options={}){return readStored(await database(),'worlds',id,options);}
  async function packed(value){return global.LegendsStorageValues?global.LegendsStorageValues.pack(value):value;}
  async function saveWorld(world){
    const db=await database();let previous;
    try{previous=await readStored(db,'worlds',world.id);}catch(error){if(!error.storageStore)throw error;}
    world.savedAt=new Date().toISOString();
    const catalog={id:world.id,name:world.name,altname:world.altname,year:world.year,width:world.width,height:world.height,mapImage:world.mapImage||world.generatedMapImage||'',hasImportedMap:Boolean(world.mapImage),savedAt:world.savedAt,sourceFiles:world.sourceFiles,disk:world.disk?{id:world.disk.id}:undefined};
    const values=await Promise.all([packed(world),packed(catalog)]),tx=db.transaction(['worlds','catalog'],'readwrite'),done=transactionDone(tx);
    tx.objectStore('worlds').put(values[0]);tx.objectStore('catalog').put(values[1]);await done;
    if(previous?.disk?.id&&previous.disk.id!==world.disk?.id)await abortImport(previous.disk.id);
  }
  async function bookmarks(){
    const db=await database(),catalog=[],catalogKeys=await requestResult(db.transaction('catalog').objectStore('catalog').getAllKeys());
    for(const key of catalogKeys){const row=await readStored(db,'catalog',key);if(row)catalog.push(row);}
    const known=new Set(catalog.map(row=>row.id)),keys=await requestResult(db.transaction('worlds').objectStore('worlds').getAllKeys());
    for(const key of keys){if(known.has(key))continue;const world=await readStored(db,'worlds',key);if(world&&!world.demo){await saveWorld(world);catalog.push({id:world.id,name:world.name,altname:world.altname,year:world.year,width:world.width,height:world.height,mapImage:world.mapImage||world.generatedMapImage||'',hasImportedMap:Boolean(world.mapImage),savedAt:world.savedAt,sourceFiles:world.sourceFiles});}}
    return catalog.sort((a,b)=>String(b.savedAt||'').localeCompare(String(a.savedAt||'')));
  }
  async function deleteWorld(id){const db=await database(),world=await readStored(db,'worlds',id);const tx=db.transaction(['worlds','catalog'],'readwrite'),done=transactionDone(tx);tx.objectStore('worlds').delete(id);tx.objectStore('catalog').delete(id);await done;if(world?.disk?.id)await abortImport(world.disk.id);}
  async function clearCache(worlds,all=false){
    const db=await database(),stores=all?['worlds','catalog','records','payloads']:['records','payloads'],live=new Set(worlds.filter(world=>world.disk?.format!=='file-index').map(world=>world.disk?.id).filter(Boolean));let removed=0;
    const tx=db.transaction(stores,'readwrite'),done=transactionDone(tx);
    for(const name of stores){const store=tx.objectStore(name);if(all){store.clear();continue;}const request=store.openKeyCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(!live.has(cursor.primaryKey[0])){store.delete(cursor.primaryKey);removed++;}cursor.continue();};}
    await done;return removed;
  }
  const api={database,getWorld,createImport,abortImport,getRecord,query,related,prefetchRefs,totalFor,saveWorld,bookmarks,deleteWorld,clearCache,references};
  Object.defineProperty(api,'workerSource',{value:(global.LegendsStorageValues?.workerSource||'')+'('+installLegendsLocalStore.toString()+')(self);'});
  global.LegendsLocalStore=Object.freeze(api);
})(typeof window==='undefined'?self:window);

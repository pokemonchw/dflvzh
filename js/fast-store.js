/* Store bounded source chunks and sequential blocks of record locations.
 * This factory runs both in a Blob Worker and on an ordinary file:// page. */
(function installLegendsFastStore(global) {
  'use strict';
  const list=value=>value===undefined||value===null||value===''?[]:Array.isArray(value)||ArrayBuffer.isView(value)?value:[value];
  const fold=value=>String(value??'').trim().toLowerCase().replace(/_/g,' ');
  const number=value=>value!==''&&value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
  const dictionary=()=>Object.create(null);
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const groups=['figures','sites','entities','artifacts','events','eras','regions','collections'];
  const sections={figures:'historical_figures',sites:'sites',entities:'entities',artifacts:'artifacts',events:'historical_events',eras:'historical_eras',regions:'regions',collections:'historical_event_collections'};
  const extras={undergroundregions:'underground_regions',mountainpeaks:'mountain_peaks',constructions:'world_constructions',danceforms:'dance_forms',musicalforms:'musical_forms',poeticforms:'poetic_forms',writtencontents:'written_contents'};
  const aliases={wars:['war'],battles:['battle'],duels:['duel'],raids:['raid'],siteconquerings:['site conquered'],insurrections:['insurrection'],persecutions:['persecution'],purges:['purge'],coups:['entity overthrown'],rampages:['beast attack'],abductions:['abduction'],thefts:['theft'],processions:['procession'],performances:['performance'],journeys:['journey'],competitions:['competition'],ceremonies:['ceremony'],occasions:['occasion']};
  const CURRENT_DATABASE='legends-file-index-v3',LEGACY_DATABASE='legends-file-index',databasePromises=new Map();
  const SOURCE_CHUNK_BYTES=8*1024*1024,SOURCE_CHUNK_CACHE_BYTES=64*1024*1024;
  const filesCache=new Map(),fileReads=new Map(),sourceChunks=new Map(),sourceChunkReads=new Map(),sourceRangeReads=new Map(),sourceReadQueue=[],blockCache=new Map(),blockReads=new Map(),parentCache=new WeakMap();let sourceChunkCacheBytes=0,activeSourceReads=0;
  const abortError=()=>new DOMException('已取消。','AbortError');
  function check(signal){if(signal?.aborted)throw abortError();}
  function sourceReadSlot(signal){
    check(signal);return new Promise((resolve,reject)=>{
      const start=()=>{signal?.removeEventListener('abort',abort);activeSourceReads++;let released=false;resolve(()=>{if(released)return;released=true;activeSourceReads--;while(sourceReadQueue.length&&activeSourceReads<4)sourceReadQueue.shift().start();});};
      const entry={start},abort=()=>{const at=sourceReadQueue.indexOf(entry);if(at>=0)sourceReadQueue.splice(at,1);signal?.removeEventListener('abort',abort);reject(abortError());};
      if(activeSourceReads<4)start();else{sourceReadQueue.push(entry);signal?.addEventListener('abort',abort,{once:true});}
    });
  }
  function waitRead(task,signal){
    check(signal);if(!signal)return task;
    return new Promise((resolve,reject)=>{let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);error?reject(error):resolve(value);},abort=()=>finish(abortError());signal.addEventListener('abort',abort,{once:true});task.then(value=>finish(null,value),error=>finish(error));if(signal.aborted)abort();});
  }
  async function sharedRead(reads,key,signal,retry){const task=reads.get(key);try{return await waitRead(task,signal);}catch(error){if(error.name==='AbortError'&&!signal?.aborted){if(reads.get(key)===task)reads.delete(key);return retry();}throw error;}}
  async function mapBounded(values,limit,visit,signal){let next=0;const result=new Array(values.length);await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{while(next<values.length){check(signal);const at=next++;result[at]=await visit(values[at],at);}}));check(signal);return result;}
  function requestValue(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  const packValue=value=>global.LegendsStorageValues?.pack?global.LegendsStorageValues.pack(value):Promise.resolve(value);
  const readValue=(db,store,key,options={})=>global.LegendsStorageValues?.read?global.LegendsStorageValues.read(db,store,key,options):requestValue(db.transaction(store).objectStore(store).get(key));
  function sourceError(world,fileNo,cause){const disk=world.disk,info=disk.fileInfo?.[fileNo]||{},error=new Error('无法读取世界原文件'+(info.name?'「'+info.name+'」':'')+'，请重新选择同一次导出的 XML。');error.name='SourceFileError';Object.assign(error,{sourceDbName:disk.sourceDbName||disk.dbName||LEGACY_DATABASE,sourceId:disk.sourceId||disk.id,fileNo,expectedName:info.name||'',expectedSize:info.size,storageStore:'sources',cause});return error;}
  function blockError(world,group,blockNo,cause){const label={figures:'历史人物',sites:'地点',entities:'派系与团体',artifacts:'神器',events:'事件',eras:'时代',regions:'区域',collections:'纪事'}[group]||'记录';const error=new Error('无法读取本地'+label+'索引（第 '+(Number(blockNo)+1)+' 块）。');error.name='IndexBlockError';Object.assign(error,{worldId:world.id,importId:world.disk.id,dbName:world.disk.dbName||LEGACY_DATABASE,group,blockNo,storageStore:'blocks',cause});return error;}
  function done(tx){const saved=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||abortError());});saved.catch(()=>{});return saved;}
  function database(name=CURRENT_DATABASE){
    if(databasePromises.has(name))return databasePromises.get(name);
    const promise=new Promise((resolve,reject)=>{
      let settled=false;const request=name===CURRENT_DATABASE?global.indexedDB.open(name,1):global.indexedDB.open(name),timer=setTimeout(()=>fail(new Error('本地索引数据库没有响应，请关闭其他 Legends Viewer 页面后重试。')),10000);
      function fail(error){if(settled)return;settled=true;clearTimeout(timer);databasePromises.delete(name);reject(error);}
      request.onblocked=()=>fail(new Error('本地索引数据库被其他页面占用，请关闭其他 Legends Viewer 页面后重试。'));
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('sources'))db.createObjectStore('sources',{keyPath:['importId','fileNo']});if(!db.objectStoreNames.contains('blocks'))db.createObjectStore('blocks',{keyPath:['importId','group','blockNo']});if(!db.objectStoreNames.contains('derived'))db.createObjectStore('derived',{keyPath:'importId'});};
      request.onsuccess=()=>{const db=request.result;if(settled){db.close();return;}settled=true;clearTimeout(timer);db.onversionchange=()=>{db.close();databasePromises.delete(name);};resolve(db);};request.onerror=()=>fail(request.error);
    });databasePromises.set(name,promise);return promise;
  }
  function cacheSourceFiles(name,id,files){Array.from(files||[]).forEach((file,fileNo)=>filesCache.set(name+':'+id+':'+fileNo,file));}
  function registerSourceFiles(worldOrId,files){const disk=typeof worldOrId==='string'?{id:worldOrId,dbName:CURRENT_DATABASE}:worldOrId.disk;cacheSourceFiles(disk.sourceDbName||disk.dbName||LEGACY_DATABASE,disk.sourceId||disk.id,files);}
  function matchingSourceFiles(world,input){
    const disk=world?.disk;if(!disk||disk.format!=='file-index')throw new Error('当前世界没有可恢复的文件索引。');
    const selected=Array.from(input||[]),expected=(disk.fileInfo||[]).map((info,fileNo)=>({info,fileNo})).filter(row=>/\.xml$/i.test(row.info.name||''));
    if(!expected.length)throw new Error('当前索引没有原文件信息，无法安全重新关联。');
    const matched=[];for(const {info,fileNo}of expected){const file=selected.find(candidate=>candidate.name===info.name&&Number(candidate.size)===Number(info.size));if(!file)throw new Error('请选择原导出文件「'+info.name+'」（'+info.size+' 字节）。');matched.push({fileNo,file});}return matched;
  }
  async function rebindSourceFiles(world,input){
    const disk=world.disk,matched=matchingSourceFiles(world,input);
    // Validate every XML first, then change all slots together. Original slot
    // numbers include any image selected before the XML during initial import.
    const name=disk.sourceDbName||disk.dbName||LEGACY_DATABASE,id=disk.sourceId||disk.id;
    for(const {fileNo,file}of matched){const key=name+':'+id+':'+fileNo;filesCache.set(key,file);fileReads.delete(key);}
    return {count:matched.length,fileNos:matched.map(row=>row.fileNo)};
  }
  async function removeSourceToken(db,id,fileNo,token){const tx=db.transaction('sources','readwrite'),saved=done(tx);tx.objectStore('sources').delete(IDBKeyRange.bound([id,[fileNo,token]],[id,[fileNo,token,[]]]));await saved;}
  async function persistSourceSlots(worldOrId,slots,options={}){
    const disk=typeof worldOrId==='string'?{id:worldOrId,dbName:CURRENT_DATABASE}:worldOrId.disk,id=disk.sourceId||disk.id,name=disk.sourceDbName||disk.dbName||LEGACY_DATABASE;
    check(options.signal);const controller=new AbortController(),signal=controller.signal,abort=()=>controller.abort(),staged=[],previous=[],totalBytes=slots.reduce((sum,row)=>sum+row.file.size,0);let activeTx,timedOut=false,committed=false,bytesWritten=0;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();try{activeTx?.abort();}catch(_){}},options.timeout??120000);
    options.signal?.addEventListener('abort',abort,{once:true});signal.addEventListener('abort',()=>{try{activeTx?.abort();}catch(_){}},{once:true});
    const progress=phase=>options.progress?.({phase,bytesWritten,totalBytes,percent:totalBytes?Math.min(100,bytesWritten/totalBytes*100):100,message:phase==='persisted'?'世界原文件已保存。':'正在后台保存世界原文件…'});
    let db;
    try{
      db=await database(name);
      progress('persist');for(const {fileNo,file}of slots){
        check(signal);let old;try{old=await readValue(db,'sources',[id,fileNo],{signal,retries:1});}catch(error){if(error.name==='AbortError')throw error;}previous.push(old);
        const token=crypto.randomUUID(),manifest={importId:id,fileNo,format:'source-chunks-v1',name:file.name,size:file.size,type:file.type||'',lastModified:Number(file.lastModified)||0,chunkSize:SOURCE_CHUNK_BYTES,chunkCount:Math.ceil(file.size/SOURCE_CHUNK_BYTES),token};staged.push(manifest);
        for(let chunkNo=0;chunkNo<manifest.chunkCount;chunkNo++){
          check(signal);const start=chunkNo*SOURCE_CHUNK_BYTES,end=Math.min(file.size,start+SOURCE_CHUNK_BYTES),part=file.slice(start,end),blob=new Blob([await part.arrayBuffer({signal})]);check(signal);
          activeTx=db.transaction('sources','readwrite',{durability:'relaxed'});const saved=done(activeTx);activeTx.objectStore('sources').put({importId:id,fileNo:[fileNo,token,chunkNo],blob});await saved;activeTx=null;bytesWritten+=end-start;progress('persist');
        }
      }
      check(signal);activeTx=db.transaction('sources','readwrite');const saved=done(activeTx);for(const manifest of staged)activeTx.objectStore('sources').put(manifest);await saved;activeTx=null;committed=true;
      if(typeof worldOrId==='object'){disk.sourcesPersisted=true;disk.sourceId=id;disk.sourceDbName=name;}
      clearTimeout(timer);progress('persisted');for(const old of previous)if(old?.format==='source-chunks-v1')await removeSourceToken(db,id,old.fileNo,old.token).catch(()=>{});
      return true;
    }catch(error){try{activeTx?.abort();}catch(_){}if(db&&!committed)for(const manifest of staged)await removeSourceToken(db,id,manifest.fileNo,manifest.token).catch(()=>{});if(timedOut)throw new Error('保存原文件超时；本次世界仍可浏览，刷新后需重新选择原文件。');throw error;
    }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  async function persistSourceFiles(worldOrId,input,options={}){
    const files=Array.from(input||[]),disk=typeof worldOrId==='string'?{id:worldOrId,dbName:CURRENT_DATABASE}:worldOrId.disk;cacheSourceFiles(disk.sourceDbName||disk.dbName||LEGACY_DATABASE,disk.sourceId||disk.id,files);
    return persistSourceSlots(worldOrId,files.map((file,fileNo)=>({fileNo,file})),options);
  }
  async function persistReboundSources(world,files,options={}){
    const slots=matchingSourceFiles(world,files);return persistSourceSlots(world,slots,options);
  }
  function descriptor(world,kind){const definition=global.LegendsUI?.categories?.[kind],types=definition?.collectionTypes||(own(aliases,kind)?aliases[kind]:null);return {id:world.disk?.id,group:types?'collections':own(extras,kind)?extras[kind]:kind,types};}
  function totalFor(world,kind){const d=descriptor(world,kind);return d.types?d.types.reduce((sum,type)=>sum+(world.disk.typeCounts?.[type]||0),0):world.disk.counts[d.group]||0;}
  function summarySource(header){
    const result={};
    const omitted=new Set(['offset','length','fileNo','group','section','tag','primary','order','factsVersion','events','eventsParts','children','childrenParts','refs','nested','compound']);
    for(const key of Object.keys(header))if(!omitted.has(key))result[key]=header[key];
    if(header.parentEntity!==undefined)result.entity_link=[{type:'PARENT',target:header.parentEntity}];
    if(header.entity_link)result.entity_link=header.entity_link;
    return result;
  }
  function summary(header,group){
    const result=summarySource(header),sourceName=result.name||result.title||result.name_string;
    global.LegendsData.normalizeRecord(result,groups.includes(group)?group:'collections',header.id);
    if(!groups.includes(group))result.name=sourceName||String(result.type||'#')+' '+result.id;
    global.LegendsData.normalizeGeography(result,group);
    Object.defineProperty(result,'__headerOnly',{value:true,configurable:true});return result;
  }
  function hasShadow(world,group,id){
    const shadow=world.disk.shadows?.[group];if(!shadow)return false;if(shadow.all)return true;
    const bits=shadow.bits?.[Math.floor(Number(id)/4096)],offset=Number(id)%4096;
    return Boolean(bits&&(bits[offset>>>5]&(1<<(offset&31))));
  }
  function* members(header,key,alternate){
    if(header[key+'Parts']){const seen=new Set();for(const part of header[key+'Parts'])for(const id of list(part))if(!seen.has(Number(id))){seen.add(Number(id));yield id;}}
    else yield* list(header[key]??header[alternate]);
  }
  function mergeHeaders(headers,group){
    if(headers.length<2)return headers[0];const result={...headers[0]},fields=summarySource(headers[0]),refs=new Map(),events=[],children=[];
    for(let index=0;index<headers.length;index++){
      const header=headers[index];if(index)global.LegendsData.mergeRecord(fields,summarySource(header),group==='events');
      for(const ref of list(header.refs)){const token=ref.kind+':'+ref.id,old=refs.get(token);if(!old)refs.set(token,{...ref});else{const keys=new Set([old.key,...list(old.keys),ref.key,...list(ref.keys)].filter(Boolean));old.keys=[...keys];if(old.sourceCondition&&!ref.sourceCondition){delete old.sourceCondition;delete old.requiresFigure;}}}
      if(header.events||header.event||header.eventsParts)events.push(...(header.eventsParts||[header.events||header.event]));
      if(header.children||header.eventcol||header.childrenParts)children.push(...(header.childrenParts||[header.children||header.eventcol]));
    }
    Object.assign(result,fields);result.refs=[...refs.values()];if(events.length)result.eventsParts=events;if(children.length)result.childrenParts=children;
    return result;
  }
  async function effectiveHeader(world,group,header,options={}){return hasShadow(world,group,header.id)?mergeHeaders(await headersFor(world,group,header.id,options),group):header;}
  async function createImport(options={}){
    const id=options.id||crypto.randomUUID(),files=Array.from(options.files||[]);registerSourceFiles(id,files);
    if(options.persistSources===true)await persistSourceFiles(id,files,options);
    const counts=dictionary(),typeCounts=dictionary(),eventYears=dictionary(),entityMembers=dictionary(),manifest=dictionary(),metadata=dictionary(),retained=dictionary(),orders=dictionary(),seen=new Map(),shadows=dictionary(),retainedPositions=new Map();
    const keep=new Set(['sites','entities','eras','regions','landmasses','underground_regions','rivers','mountain_peaks','entity_populations']);
    let seenBytes=0,retainedBytes=0,shadowBytes=0;
    function markShadow(group,key){
      const shadow=shadows[group]||(shadows[group]={bits:dictionary()});if(shadow.all)return;
      if(!Number.isSafeInteger(key)||key<0){shadow.all=true;return;}
      const block=Math.floor(key/4096);let bits=shadow.bits[block];if(!bits){if(shadowBytes+512>8*1024*1024){shadow.all=true;return;}shadow.bits[block]=bits=new Uint32Array(128);shadowBytes+=512;}
      const offset=key%4096;bits[offset>>>5]|=1<<(offset&31);
    }
    function retain(header,group){
      if(!keep.has(group))return;const key=group+':'+header.id,previous=retainedPositions.get(key),record=summary(previous?global.LegendsData.mergeRecord({...previous.record.raw},summarySource(header),false):header,group),size=JSON.stringify(record).length*2;
      if(retainedBytes-(previous?.size||0)+size>20*1024*1024){if(previous){retained[group][previous.index]=null;retainedBytes-=previous.size;retainedPositions.delete(key);}return;}
      const rows=retained[group]||(retained[group]=[]),index=previous?previous.index:rows.length;rows[index]=record;retainedBytes+=size-(previous?.size||0);retainedPositions.set(key,{index,size,record});
    }
    function unique(group,key){if(!Number.isSafeInteger(key)||key<0)return true;const name=group+':'+Math.floor(key/4096);let bits=seen.get(name);if(!bits){bits=new Uint32Array(128);seen.set(name,bits);seenBytes+=512;}const offset=key%4096,word=offset>>>5,mask=1<<(offset&31),exists=bits[word]&mask;bits[word]|=mask;return !exists;}
    async function writeBlock(input){
      const byGroup=new Map();for(const original of input){const group=original.group||original.section;let rows=byGroup.get(group);if(!rows)byGroup.set(group,rows=[]);const header={...original};header.id=number(header.id)??(orders[group]||0);header.primary=unique(group,header.id);if(!header.primary)markShadow(group,header.id);if(header.type!==undefined)header.type=String(header.type).replace(/_/g,' ');rows.push(header);orders[group]=(orders[group]||0)+1;
        if(header.primary){counts[group]=(counts[group]||0)+1;if(group==='collections')typeCounts[fold(header.type)]=(typeCounts[fold(header.type)]||0)+1;if(group==='events'){const type=fold(header.type),year=Number(header.year);if(!eventYears[type])eventYears[type]=dictionary();if(Number.isFinite(year))eventYears[type][year]=(eventYears[type][year]||0)+1;}if(group==='figures')for(const ref of header.refs||[])if(ref.kind==='entities')entityMembers[ref.id]=(entityMembers[ref.id]||0)+1;
        }
        retain(header,group);
      }
      const values=[];for(const [group,headers] of byGroup){const blocks=manifest[group]||(manifest[group]=[]),blockNo=blocks.length,ids=headers.map(row=>row.id);blocks.push({blockNo,minId:Math.min(...ids),maxId:Math.max(...ids),count:headers.filter(row=>row.primary).length,rows:headers.length,firstOrder:headers[0].order,lastOrder:headers.at(-1).order});values.push(await packValue({importId:id,group,blockNo,headers}));}
      const db=await database(),tx=db.transaction('blocks','readwrite',{durability:'relaxed'}),saved=done(tx);
      for(const value of values)tx.objectStore('blocks').put(value);
      await saved;
    }
    async function finish(meta={}){
      const world={...metadata,...meta,extra:{}};for(const group of groups)world[group]=(retained[group]||[]).filter(Boolean);for(const group of Object.keys(retained))if(!groups.includes(group))world.extra[group]=retained[group].filter(Boolean);
      global.LegendsData.normalizeWorld(world);world.disk={format:'file-index',id,dbName:CURRENT_DATABASE,counts,typeCounts,eventYears,entityMembers,manifest,shadows,factsVersion:meta.factsVersion||1,sourcesPersisted:options.persistSources===true,fileInfo:meta.fileInfo||files.map(file=>({name:file.name,size:file.size,encoding:'CP437'}))};
      if(shadows.collections){for(const key of Object.keys(typeCounts))delete typeCounts[key];await scan(world,'collections',header=>{const type=fold(header.type);typeCounts[type]=(typeCounts[type]||0)+1;});}
      if(shadows.events){for(const key of Object.keys(eventYears))delete eventYears[key];await scan(world,'events',header=>{const type=fold(header.type),year=Number(header.year);if(!eventYears[type])eventYears[type]=dictionary();if(Number.isFinite(year))eventYears[type][year]=(eventYears[type][year]||0)+1;});}
      if(shadows.figures){for(const key of Object.keys(entityMembers))delete entityMembers[key];await scan(world,'figures',header=>{for(const ref of list(header.refs))if(ref.kind==='entities')entityMembers[ref.id]=(entityMembers[ref.id]||0)+1;});}
      return world;
    }
    return {id,writeBlock,metadata(key,value){metadata[key]=value;},finish,persistSources:options=>persistSourceFiles(id,files,options),abort:()=>abortImport(id)};
  }
  async function abortImport(id,options={}){const name=options.dbName||CURRENT_DATABASE,db=await database(name),tx=db.transaction(['sources','blocks',...(db.objectStoreNames.contains('derived')?['derived']:[])],'readwrite'),saved=done(tx),range=IDBKeyRange.bound([id],[id,[]]);if(!options.keepSources){const cursor=tx.objectStore('sources').openKeyCursor(IDBKeyRange.lowerBound([id]));cursor.onsuccess=()=>{const entry=cursor.result;if(entry&&entry.key[0]===id){tx.objectStore('sources').delete(entry.primaryKey);entry.continue();}};}tx.objectStore('blocks').delete(range);if(db.objectStoreNames.contains('derived')){tx.objectStore('derived').delete(id);tx.objectStore('derived').delete(id+':relations-v1');tx.objectStore('derived').delete(id+':sourceRoles-v1');for(const stage of ['writer','import','analytics'])tx.objectStore('derived').delete(id+':handoff:'+stage);}await saved;for(const key of [...filesCache.keys()])if(key.startsWith(name+':'+id+':'))filesCache.delete(key);for(const key of [...blockCache.keys()])if(key.startsWith(name+':'+id+':'))blockCache.delete(key);for(const [key,buffer]of sourceChunks)if(key.startsWith(name+':'+id+':')){sourceChunks.delete(key);sourceChunkCacheBytes-=buffer.size??buffer.byteLength;}}
  async function getBlock(world,group,blockNo,options={}){
    check(options.signal);
    const name=world.disk.dbName||LEGACY_DATABASE,key=name+':'+world.disk.id+':'+group+':'+blockNo;
    if(blockCache.has(key)){const block=blockCache.get(key);blockCache.delete(key);blockCache.set(key,block);return block;}
    if(blockReads.has(key))return sharedRead(blockReads,key,options.signal,()=>getBlock(world,group,blockNo,options));
    const task=(async()=>{let block;try{const db=await database(name);block=await readValue(db,'blocks',[world.disk.id,group,blockNo],options);if(!block?.headers)throw new Error('索引块不存在或不完整。');}catch(error){if(error.name==='AbortError')throw error;try{block=await repairBlock(world,group,blockNo,options);}catch(repairError){if(['AbortError','SourceFileError'].includes(repairError.name))throw repairError;const contextual=blockError(world,group,blockNo,error);contextual.repairError=repairError;throw contextual;}}blockCache.set(key,block);while(blockCache.size>16)blockCache.delete(blockCache.keys().next().value);return block;})();
    blockReads.set(key,task);try{return await task;}finally{if(blockReads.get(key)===task)blockReads.delete(key);}
  }
  async function getSource(world,fileNo,options={}){
    check(options.signal);
    const sourceId=world.disk.sourceId||world.disk.id,name=world.disk.sourceDbName||world.disk.dbName||LEGACY_DATABASE,key=name+':'+sourceId+':'+fileNo;
    if(filesCache.has(key))return filesCache.get(key);if(fileReads.has(key))return sharedRead(fileReads,key,options.signal,()=>getSource(world,fileNo,options));
    const task=(async()=>{try{const db=await database(name),source=await readValue(db,'sources',[sourceId,fileNo],options);if(filesCache.has(key))return filesCache.get(key);const file=source?.format==='source-chunks-v1'?chunkedSourceFile(world,fileNo,source):source?.file;if(!file)throw new Error('缓存中没有原文件。');filesCache.set(key,file);return file;}catch(error){if(filesCache.has(key))return filesCache.get(key);if(error.name==='AbortError')throw error;throw sourceError(world,fileNo,error);}})();
    fileReads.set(key,task);try{return await task;}finally{if(fileReads.get(key)===task)fileReads.delete(key);}
  }
  async function readSourceChunk(world,fileNo,manifest,chunkNo,options={}){
    check(options.signal);const disk=world.disk,name=disk.sourceDbName||disk.dbName||LEGACY_DATABASE,id=disk.sourceId||disk.id,key=name+':'+id+':'+fileNo+':'+manifest.token+':'+chunkNo;
    if(sourceChunks.has(key)){const buffer=sourceChunks.get(key);sourceChunks.delete(key);sourceChunks.set(key,buffer);return buffer;}
    if(sourceChunkReads.has(key))return sharedRead(sourceChunkReads,key,options.signal,()=>readSourceChunk(world,fileNo,manifest,chunkNo,options));
    const task=(async()=>{let release;try{const db=await database(name),part=await readValue(db,'sources',[id,[fileNo,manifest.token,chunkNo]],options),expected=Math.min(manifest.chunkSize,manifest.size-chunkNo*manifest.chunkSize);check(options.signal);if(!(part?.blob instanceof Blob)||part.blob.size!==expected)throw new Error('原文件分块不存在或长度不符。');release=await sourceReadSlot(options.signal);const buffer=await part.blob.arrayBuffer();check(options.signal);if(buffer.byteLength!==expected)throw new Error('原文件分块长度不符。');sourceChunks.set(key,buffer);sourceChunkCacheBytes+=buffer.byteLength;while(sourceChunkCacheBytes>SOURCE_CHUNK_CACHE_BYTES&&sourceChunks.size>1){const oldest=sourceChunks.keys().next().value,payload=sourceChunks.get(oldest);sourceChunkCacheBytes-=payload.size??payload.byteLength;sourceChunks.delete(oldest);}return buffer;}catch(error){if(error.name==='AbortError')throw error;throw sourceError(world,fileNo,error);}finally{release?.();}})();
    sourceChunkReads.set(key,task);try{return await task;}finally{if(sourceChunkReads.get(key)===task)sourceChunkReads.delete(key);}
  }
  async function readSourceRange(world,fileNo,manifest,chunkNo,from,to,options={}){
    check(options.signal);const disk=world.disk,key=(disk.sourceDbName||disk.dbName||LEGACY_DATABASE)+':'+(disk.sourceId||disk.id)+':'+fileNo+':'+manifest.token+':'+chunkNo+':'+from+':'+to;
    if(sourceRangeReads.has(key))return sharedRead(sourceRangeReads,key,options.signal,()=>readSourceRange(world,fileNo,manifest,chunkNo,from,to,options));
    const task=(async()=>{let release;try{const payload=await readSourceChunk(world,fileNo,manifest,chunkNo,options);check(options.signal);if(payload instanceof ArrayBuffer)return payload.slice(from,to);release=await sourceReadSlot(options.signal);check(options.signal);const buffer=await payload.slice(from,to).arrayBuffer();check(options.signal);if(buffer.byteLength!==to-from)throw new Error('原文件片段长度不符。');return buffer;}catch(error){if(error.name==='AbortError'||error.name==='SourceFileError')throw error;throw sourceError(world,fileNo,error);}finally{release?.();}})();sourceRangeReads.set(key,task);try{return await task;}finally{if(sourceRangeReads.get(key)===task)sourceRangeReads.delete(key);}
  }
  function chunkedSourceFile(world,fileNo,manifest){
    if(!Number.isSafeInteger(manifest.size)||manifest.size<0||!Number.isSafeInteger(manifest.chunkSize)||manifest.chunkSize<=0||manifest.chunkSize>SOURCE_CHUNK_BYTES||manifest.chunkCount!==Math.ceil(manifest.size/manifest.chunkSize)||typeof manifest.token!=='string')throw new Error('原文件分块目录无效。');
    const bound=(value,size,fallback)=>{if(value===undefined)return fallback;const raw=Number(value),integer=Number.isNaN(raw)?0:Math.trunc(raw);return integer<0?Math.max(size+integer,0):Math.min(integer,size);};
    const slice=(start=0,end=manifest.size,type='',base=0,size=manifest.size)=>{
      const from=bound(start,size,0),to=Math.max(from,bound(end,size,size)),length=to-from,offset=base+from;
      const result={size:length,type:String(type||'').toLowerCase(),async arrayBuffer(options={}){check(options.signal);const bytes=new Uint8Array(length);let cursor=offset;while(cursor<offset+length){const chunkNo=Math.floor(cursor/manifest.chunkSize),within=cursor-chunkNo*manifest.chunkSize,count=Math.min(manifest.chunkSize-within,offset+length-cursor),buffer=await readSourceRange(world,fileNo,manifest,chunkNo,within,within+count,options);bytes.set(new Uint8Array(buffer),cursor-offset);cursor+=count;}check(options.signal);return bytes.buffer;},async text(options={}){return new TextDecoder().decode(await result.arrayBuffer(options));},slice(nextStart=0,nextEnd=length,nextType=''){return slice(nextStart,nextEnd,nextType,offset,length);}};return result;
    };
    const whole=slice();return {name:manifest.name,size:manifest.size,type:manifest.type||'',lastModified:manifest.lastModified||0,slice:(start,end,type)=>slice(start,end,type),arrayBuffer:options=>whole.arrayBuffer(options),text:options=>whole.text(options)};
  }
  async function repairBlock(world,group,blockNo,options={}){
    check(options.signal);const expected=world.disk.manifest?.[group]?.find(item=>Number(item.blockNo)===Number(blockNo));
    if(!expected||!global.LegendsFileIndexer?.indexFiles)throw blockError(world,group,blockNo,new Error('没有可验证的索引块信息。'));
    const files=[];for(const [fileNo,info]of (world.disk.fileInfo||[]).entries())files.push(/\.xml$/i.test(info.name||'')?await getSource(world,fileNo,options):new File([],info.name||'image'));
    if(!files.some(file=>/\.xml$/i.test(file.name)))throw blockError(world,group,blockNo,new Error('没有可验证的 XML 原文件。'));
    const seen=new Map(),orders=dictionary(),blocks=dictionary(),stop=new Error('已找到待修复索引块。');stop.name='AbortError';let recovered;
    try{await global.LegendsFileIndexer.indexFiles(files,{signal:options.signal,progress:progress=>options.progress?.({...progress,phase:'index-repair',message:'正在修复本地索引…'}),onBlock:input=>{
      const byGroup=new Map();for(const original of input){const kind=original.group||original.section,header={...original};header.id=number(header.id)??(orders[kind]||0);let ids=seen.get(kind);if(!ids)seen.set(kind,ids=new Set());header.primary=!Number.isSafeInteger(header.id)||header.id<0||!ids.has(header.id);if(Number.isSafeInteger(header.id)&&header.id>=0)ids.add(header.id);if(header.type!==undefined)header.type=String(header.type).replace(/_/g,' ');orders[kind]=(orders[kind]||0)+1;let rows=byGroup.get(kind);if(!rows)byGroup.set(kind,rows=[]);rows.push(header);}
      for(const [kind,headers]of byGroup){const at=blocks[kind]||0;blocks[kind]=at+1;if(kind===group&&at===Number(blockNo)){recovered={importId:world.disk.id,group,blockNo:Number(blockNo),headers};throw stop;}}
    }});}catch(error){if(error!==stop)throw error;}
    const rows=recovered?.headers||[],ids=rows.map(row=>row.id),valid=rows.length===(expected.rows??expected.count)&&rows.filter(row=>row.primary).length===expected.count&&Math.min(...ids)===expected.minId&&Math.max(...ids)===expected.maxId&&(expected.firstOrder===undefined||rows[0]?.order===expected.firstOrder)&&(expected.lastOrder===undefined||rows.at(-1)?.order===expected.lastOrder);
    if(!valid)throw blockError(world,group,blockNo,new Error('原文件与索引块的记录边界不一致，未改写缓存。'));
    check(options.signal);const packed=await packValue(recovered),db=await database(world.disk.dbName||LEGACY_DATABASE),tx=db.transaction('blocks','readwrite'),saved=done(tx);tx.objectStore('blocks').put(packed);await saved;
    const key=(world.disk.dbName||LEGACY_DATABASE)+':'+world.disk.id+':'+group+':'+blockNo;blockCache.set(key,recovered);while(blockCache.size>16)blockCache.delete(blockCache.keys().next().value);return recovered;
  }
  const CP437=Array.from('ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ');
  function decode(bytes,encoding){if(/^(?:cp|ibm|windows-?)?437$/i.test(encoding||'')){const text=new TextDecoder('windows-1252').decode(bytes),high=/[\u0080-\uffff]/g;let at=0;return text.replace(high,()=>{while(at<bytes.length&&bytes[at]<128)at++;return CP437[bytes[at++]-128];});}return new TextDecoder(encoding||'utf-8',{fatal:true}).decode(bytes);}
  async function headersFor(world,kind,id,options={}){const d=descriptor(world,kind),matches=[];for(const item of world.disk.manifest[d.group]||[]){if(Number(id)<item.minId||Number(id)>item.maxId)continue;const block=await getBlock(world,d.group,item.blockNo,options);for(const row of block?.headers||[])if(Number(row.id)===Number(id))matches.push(row);}return matches;}
  function normalized(record,group,id){const sourceName=record.name||record.title||record.name_string;global.LegendsData.normalizeRecord(record,groups.includes(group)?group:'collections',id);if(!groups.includes(group))record.name=sourceName||String(record.type||'#')+' '+id;global.LegendsData.normalizeArtForm?.(record,group);global.LegendsData.normalizeGeography(record,group);return record;}
  async function parseHeaderBytes(world,header,group,bytes){const fileNo=header.fileNo||0,encoding=header.encoding||world.disk.fileInfo?.[fileNo]?.encoding||'utf-8',text=global.LegendsFileIndexer?.decodeBytes?global.LegendsFileIndexer.decodeBytes(bytes,encoding):decode(bytes,encoding);const record=await global.LegendsData.parseRecord(text,header.section||sections[group]||group);if(record&&!groups.includes(group)&&header.tag)record['@tag']=header.tag;if(record&&group==='structures'){record.local_id=record.local_id??record.id;record.id=header.id;record.site_id=header.site_id;record.coords=record.coords??header.coords;}if(record)Object.defineProperty(record,'__headerOnly',{value:false,configurable:true});return record;}
  async function readHeader(world,header,group,options={}){if(options.preloadedHeaders?.has(header))return options.preloadedHeaders.get(header);const fileNo=header.fileNo||0,file=await getSource(world,fileNo,options);let bytes;try{bytes=new Uint8Array(await file.slice(header.offset,header.offset+header.length).arrayBuffer(options));}catch(error){if(error.name==='AbortError')throw error;throw sourceError(world,fileNo,error);}return parseHeaderBytes(world,header,group,bytes);}
  const artRecordCache=new WeakMap(),isArtGroup=group=>['dance_forms','musical_forms','poetic_forms'].includes(group);
  async function artRecord(world,kind,id,options={},headers){
    check(options.signal);let cached=artRecordCache.get(world);if(!cached||cached.indexId!==world.disk.id){cached={indexId:world.disk.id,records:new Map(),reads:new Map()};artRecordCache.set(world,cached);}const group=descriptor(world,kind).group,key=group+':'+id;if(cached.records.has(key))return enrich(world,kind,cached.records.get(key));if(cached.reads.has(key))return sharedRead(cached.reads,key,options.signal,()=>artRecord(world,kind,id,options,headers));
    const task=(async()=>{const record=await recordFromHeaders(world,kind,id,headers||await headersFor(world,kind,id,options),options);check(options.signal);if(record)cached.records.set(key,record);return record;})();cached.reads.set(key,task);try{return await task;}finally{if(cached.reads.get(key)===task)cached.reads.delete(key);}
  }
  async function getRecord(world,kind,id,options={}){check(options.signal);const d=descriptor(world,kind);if(isArtGroup(d.group))return artRecord(world,kind,id,options);if(d.group==='events'){const events=(world.disk?.aggregates||world.aggregates)?.virtualEvents,index=Number(id)-(events?.startId??Infinity);if(events&&index>=0&&index<events.count)return normalized(virtualHeader(world,index),'events',Number(id));}const headers=await headersFor(world,kind,id,options);return recordFromHeaders(world,kind,id,headers,options);}
  async function recordFromHeaders(world,kind,id,headers,options={}){const d=descriptor(world,kind);let record=null;for(const header of headers){const next=await readHeader(world,header,d.group,options);if(next)record=record?global.LegendsData.mergeRecord(record,next,d.group==='events'):next;}if(!record)return null;const facts=mergeHeaders(headers,d.group);for(const [key,value]of Object.entries(summarySource(facts)))if(record[key]===undefined)record[key]=value;normalized(record,d.group,Number(id));if(d.group==='eras'&&!Number.isFinite(record.end_year)){const era=world.eras.find(row=>row.id===record.id);record.end_year=era?.end_year??-1;}return enrich(world,kind,record);}
  function virtualHeader(world,index){
    const a=world.disk?.aggregates||world.aggregates,events=a?.virtualEvents;if(!events||index<0||index>=events.count)return null;
    let segment=index,columns=events;if(events.segments){columns=events.segments;let low=0,high=columns.starts.length-1;while(low<high){const middle=Math.ceil((low+high)/2);if(columns.starts[middle]<=index)low=middle;else high=middle-1;}segment=low;}
    const hfid=Number(events.figures[index]),header={id:events.startId+index,group:'events',section:'historical_events',tag:'historical_event',type:'battle fought',year:Number(columns.years[segment]),seconds72:Number(columns.seconds[segment]),hfid,battle_id:Number(columns.battles[segment]),as_attacker:Boolean(columns.flags[segment]&1),was_hired:Boolean(columns.flags[segment]&2),as_scout:Boolean(columns.flags[segment]&4),synthetic:true,origin:'derived',primary:true,refs:[{kind:'figures',id:hfid,key:'hfid'}]};
    for(const [column,key]of [['sites','site_id'],['regions','subregion_id'],['layers','feature_layer_id']])if(columns[column][segment]>=0)header[key]=Number(columns[column][segment]);return header;
  }
  async function scanVirtual(world,visit,options){
    const events=(world.disk?.aggregates||world.aggregates)?.virtualEvents,count=events?.count||0;let last=performance.now();
    const virtualIndex=relationCache.get(world)?.virtual,indexed=options.virtualFigure===undefined||!virtualIndex?null:lookupList(virtualIndex,options.virtualFigure),length=indexed?indexed.length:count;
    for(let at=0;at<length;at++){
      const index=indexed?indexed[options.descending?length-at-1:at]:options.descending?count-at-1:at;
      if(options.virtualFigure===undefined||Number(events.figures[index])===options.virtualFigure){const result=visit(virtualHeader(world,index));if(result===false||result&&typeof result.then==='function'&&await result===false)return false;}
      if((at&16383)===16383){check(options.signal);if(performance.now()-last>12){await new Promise(resolve=>setTimeout(resolve,0));last=performance.now();}}
    }
    check(options.signal);return true;
  }

  const memoryCache=new WeakMap();
  function memoryRows(world,group){
    let cache=memoryCache.get(world);if(!cache)memoryCache.set(world,cache=new Map());if(cache.has(group))return cache.get(group);
    let records=world[group]||world.extra?.[group]||[];
    if(group==='structures'&&!records.length){records=[];for(const site of world.sites||[])for(const structure of list(site.structure??site.structures?.structure??site.structures)){if(structure&&typeof structure==='object')records.push({...structure,local_id:structure.local_id??structure.id,id:records.length,site_id:site.id,coords:site.coords});}}
    const rows=records.map((record,index)=>{
      const header={...record,raw:undefined,group,id:Number(record.id??index),primary:true,refs:(group==='events'?relationshipReferences(record,world):global.LegendsLocalStore?.references(record)||[]).map(ref=>({...ref,kind:analyticGroup(ref.kind)}))};
      // Normalization gives unnamed entities a display fallback. Only an actual
      // exported Name qualifies an ordinary civilization as a main civ.
      if(group==='entities')Object.defineProperty(header,'__sourceNamed',{value:typeof(record.raw||record).name==='string'&&Boolean((record.raw||record).name.trim())});
      if(group==='collections'){
        header.events=Uint32Array.from(list(record.event??record.event_id).map(Number).filter(id=>id>=0));header.children=Uint32Array.from(list(record.eventcol??record.collection).map(Number).filter(id=>id>=0));header.squad_races={};
        for(const side of ['attacking','defending']){const races=list(record[side+'_squad_race']),numbers=list(record[side+'_squad_number']).map(value=>Number(value)<0||Number(value)>100?100:Number(value)),deaths=list(record[side+'_squad_deaths']).map(value=>Number(value)<0||Number(value)>100?100:Number(value));header[side+'_squad_number_sum']=numbers.reduce((n,v)=>n+v,0);header[side+'_squad_deaths_sum']=deaths.reduce((n,v)=>n+v,0);races.forEach((race,index)=>{const entry=header.squad_races[race]||(header.squad_races[race]={attacking:0,defending:0,attacking_deaths:0,defending_deaths:0});entry[side]+=numbers[index]||0;entry[side+'_deaths']+=deaths[index]||0;});}
      }
      if(group==='events'&&fold(header.type)==='item stolen'&&finiteId(header.item)!==null)header.refs.push({kind:'artifacts',id:Number(header.item),key:'item'});
      return header;
    });cache.set(group,rows);return rows;
  }
  const figureIdCache=new WeakMap();
  function figureExists(world,id){
    const chunks=(world?.disk?.aggregates||world?.aggregates)?.figureExistence;
    if(chunks){const bits=chunks[Math.floor(Number(id)/4096)],offset=Number(id)%4096;return Boolean(bits&&(bits[offset>>>5]&(1<<(offset&31))));}
    if(!world)return false;const records=world.figures||[];let cached=figureIdCache.get(world);if(!cached||cached.records!==records||cached.length!==records.length){cached={records,length:records.length,ids:new Set(records.map(record=>Number(record.id)))};figureIdCache.set(world,cached);}return cached.ids.has(Number(id));
  }
  function mergeSourceReferences(record,original,exists){
    const refs=new Map();for(const ref of original)if(!ref.sourceCondition)refs.set(analyticGroup(ref.kind)+':'+ref.id,{...ref,kind:analyticGroup(ref.kind)});
    for(const ref of global.LegendsFileIndexer?.sourceEventReferences(record)||[]){if(ref.requiresFigure!==undefined&&!exists(ref.requiresFigure))continue;const token=ref.kind+':'+ref.id,old=refs.get(token);if(!old)refs.set(token,{kind:ref.kind,id:ref.id,key:ref.key});else if(ref.key!==old.key){const keys=new Set([old.key,...list(old.keys),ref.key]);refs.set(token,{...old,keys:[...keys]});}}
    return [...refs.values()];
  }
  function relationshipReferences(record,world){
    if(fold(record.type)==='battle fought'){const id=finiteId(record.hfid??record.hist_figure_id);return id===null?[]:[{kind:'figures',id,key:'hfid'}];}
    const clean={...record,raw:undefined,reason:undefined,reason_id:undefined,circumstance:undefined,circumstance_id:undefined,method:undefined,relevant_id_for_method:undefined,relevant_entity_id:undefined,sanctify_hf:undefined,anon_4:undefined};
    return mergeSourceReferences(record,global.LegendsLocalStore?.references(clean,world)||[],id=>figureExists(world,id));
  }
  function sourceHeader(world,header,hasFigure){
    if(!global.LegendsFileIndexer?.sourceEventReferences)return header;
    const extra=global.LegendsFileIndexer.sourceEventReferences(header),original=list(header.refs),roles=sourceRoleCache.get(world),added=roles?.eventAdditions?.[header.id],patch=roles?.eventPatches?.[header.id];if(!extra.length&&!original.some(ref=>ref.sourceCondition)&&!added&&!patch)return header;
    const refs=mergeSourceReferences(header,original,hasFigure||((id)=>figureExists(world,id)));for(const ref of added||[])if(!refs.some(old=>old.kind===ref.kind&&Number(old.id)===Number(ref.id)))refs.push(ref);return {...header,...patch,refs};
  }
  async function* orderedBlocks(world,group,items,options={}){
    let next=0;const pending=new Map(),fill=()=>{while(next<items.length&&pending.size<4){check(options.signal);const at=next++,item=items[at],task=getBlock(world,group,item.blockNo,options);task.catch(()=>{});pending.set(at,{item,task});}};
    fill();for(let at=0;at<items.length;at++){check(options.signal);const entry=pending.get(at),block=await entry.task;check(options.signal);pending.delete(at);fill();yield {item:entry.item,block};}
  }
  async function scan(world,group,visit,options={}){
    if(!world.disk){const rows=memoryRows(world,group).filter(header=>!header.synthetic),ordered=options.descending?[...rows].reverse():rows;if(group==='events'&&!options.rawOnly&&options.descending&&await scanVirtual(world,visit,options)===false)return;let last=performance.now();for(const raw of ordered){check(options.signal);const header=group==='events'?sourceHeader(world,raw,options.figureExists):raw,result=visit(header);if(result===false||result&&typeof result.then==='function'&&await result===false)return;if(performance.now()-last>12){await new Promise(resolve=>setTimeout(resolve,0));last=performance.now();}}if(group==='events'&&!options.rawOnly&&!options.descending)await scanVirtual(world,visit,options);return;}
    if(group==='events'&&!options.rawOnly&&options.descending&&await scanVirtual(world,visit,options)===false)return;
    const blocks=(world.disk.manifest[group]||[]).filter(item=>!options.blocks||options.blocks.has(item.blockNo)),ordered=options.descending?[...blocks].reverse():blocks;
    for await(const {block}of orderedBlocks(world,group,ordered,options)){const rows=options.descending?[...(block?.headers||[])].reverse():block?.headers||[];
      for(const raw of rows){if(!raw.primary)continue;let header=hasShadow(world,group,raw.id)?await effectiveHeader(world,group,raw,options):raw;if(group==='events')header=sourceHeader(world,header,options.figureExists);const result=visit(header);if(result===false)return;if(result&&typeof result.then==='function'&&await result===false)return;}
    }
    if(group==='events'&&!options.rawOnly&&!options.descending)await scanVirtual(world,visit,options);
  }
  function sortValue(world,kind,header,key,options){
    const group=descriptor(world,kind).group,record=enrich(world,kind,summary(header,group));
    if(options.sortValue)return options.sortValue(record,key,kind);
    if(key==='id')return Number(record.id);
    if(key==='date')return Number(record.year)>=0?Number(record.year)*403200+Math.max(0,Number(record.seconds72)||0):-1;
    if(key==='startDate')return Number(record.start_year??record.year)>=0?Number(record.start_year??record.year)*403200+Math.max(0,Number(record.start_seconds72)||0):-1;
    if(key==='endDate')return Number(record.end_year)>=0?Number(record.end_year)*403200+Math.max(0,Number(record.end_seconds72)||0):-1;
    if(key==='html'||key==='name')return String(options.name?.(record,kind)||record.name||record.title||'');
    if(key==='type')return fold(kind==='figures'?record.race||record.type:kind==='artifacts'?record.item_type||record.type:record.type);
    if(key==='subtype')return kind==='figures'?record.caste:kind==='entities'?record.race:kind==='sites'?record.regionType:kind==='regions'?record.evilness:kind==='undergroundregions'?Number(record.depth):kind==='writtencontents'?world.disk.aggregates?.authorNames?.[record.author_hfid??record.author]||'':record.subtype||record.item_subtype||record.mat||record.material||'';
    if(key==='heightMeter'||key==='height')return Number(record.height)*3;
    if(key==='worldRank')return record.worldRank;
    if(key==='squareTiles'||key==='size')return record.squareTiles??coords(record.coords||record.path).length;
    if(key==='regionLink')return (world.regions||[]).find(region=>Number(region.id)===Number(record.region_id))?.name||'';
    return record[key]??record[key?.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())]??'';
  }
  async function query(world,kind,options={}){
    await analytics(world,{signal:options.signal,progress:options.progress});await prepareSourceRoles(world,options);
    const d=descriptor(world,kind),page=Math.max(1,Number(options.page)||1),size=Math.min(100,Math.max(1,Number(options.pageSize)||10)),start=(page-1)*size,text=String(options.query||'').trim().toLowerCase(),excluded=new Set(options.excludeEventTypes||[]),selected=[],sortKey=options.sortKey||'id',descending=Boolean(options.descending),simple=!text&&!options.rules?.length&&sortKey==='id',unknownFilterCounts=dictionary();
    let total=0;
    if(simple&&!d.types&&!excluded.size){
      total=totalFor(world,kind);const virtual=d.group==='events'?world.disk.aggregates?.virtualEvents:null,virtualCount=virtual?.count||0,rawTotal=total-virtualCount;
      if(descending&&virtualCount){for(let at=start;at<Math.min(start+size,virtualCount);at++)selected.push(virtualHeader(world,virtualCount-at-1));}
      const rawStart=descending?Math.max(0,start-virtualCount):start,rawSize=descending?size-selected.length:Math.min(size,Math.max(0,rawTotal-start));let skipped=0;
      if(rawSize>0){const blocks=descending?[...(world.disk.manifest[d.group]||[])].reverse():world.disk.manifest[d.group]||[];const desired=selected.length+rawSize;for(const item of blocks){check(options.signal);if(skipped+item.count<=rawStart){skipped+=item.count;continue;}const block=await getBlock(world,d.group,item.blockNo,options),headers=descending?[...(block?.headers||[])].reverse():block?.headers||[];for(const header of headers){if(!header.primary)continue;if(skipped++>=rawStart&&selected.length<desired)selected.push(header);if(selected.length===desired)break;}if(selected.length===desired)break;}}
      if(!descending&&virtualCount&&selected.length<size){const virtualStart=Math.max(0,start-rawTotal);for(let at=virtualStart;at<virtualCount&&selected.length<size;at++)selected.push(virtualHeader(world,at));}
    }
    else if(simple&&d.types){
      const catalog=await collectionTypeCatalog(world,options),types=[...new Set(d.types)].filter(type=>!excluded.has(type));let ids=types.length===1?catalog.types[types[0]]||[]:catalog.combinations.get(types.slice().sort().join('\0'));
      if(!ids){const values=new Set();for(const type of types)for(const id of catalog.types[type]||[])values.add(Number(id));ids=Float64Array.from([...values].sort((a,b)=>a-b));catalog.combinations.set(types.slice().sort().join('\0'),ids);}
      total=ids.length;for(let at=start;at<Math.min(total,start+size);at++)selected.push({id:ids[descending?total-at-1:at]});
    }
    else{
      const heap=[],limit=start+size,collator=new Intl.Collator('zh-CN',{numeric:true}),compare=(a,b)=>{const x=a.value,y=b.value;let result=typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x??''),String(y??''));if(!Number.isFinite(result))result=0;if(descending)result=-result;return result||Number(a.header.id)-Number(b.header.id);};
      const offer=entry=>{if(heap.length===limit){if(compare(entry,heap[0])>=0)return;heap[0]=entry;let i=0;while(true){const left=i*2+1,right=left+1;if(left>=heap.length)break;const child=right<heap.length&&compare(heap[right],heap[left])>0?right:left;if(compare(heap[i],heap[child])>=0)break;[heap[i],heap[child]]=[heap[child],heap[i]];i=child;}}else{heap.push(entry);let i=heap.length-1;while(i>0){const parent=(i-1)>>1;if(compare(heap[parent],heap[i])>=0)break;[heap[parent],heap[i]]=[heap[i],heap[parent]];i=parent;}}};
      await scan(world,d.group,async header=>{
        const type=fold(header.type);if(d.types&&!d.types.includes(type)||excluded.has(type))return;
        let row=isArtGroup(d.group)?await artRecord(world,kind,header.id,options):enrich(world,kind,summary(header,d.group)),name=String((isArtGroup(d.group)||d.group==='artifacts'?row.name||row.title:header.name||header.title)||'').toLowerCase();
        if(text&&String(header.id)!==text&&!name.includes(text)){const numericFigure=kind==='figures'&&/^\d+$/.test(text),display=numericFigure?[row.name,row.translated_name,row.name_string].filter(Boolean).join(' ').toLowerCase():String(options.name?.(row,kind)||'').toLowerCase();if(!display.includes(text))return;}
        if(options.rules?.length&&global.LegendsFilters){const context={...(options.context||{}),world,completeGroups:world.disk.aggregates?.completeGroups||[]};let result=global.LegendsFilters.assess(row,kind,options.rules,context);if(!result.possible)return;if(result.unknown.length){row=await getRecord(world,kind,header.id,options);check(options.signal);result=global.LegendsFilters.assess(row,kind,options.rules,context);}if(!result.matches){for(const property of result.unknown)unknownFilterCounts[property]=(unknownFilterCounts[property]||0)+1;return;}}
        total++;offer({header,value:sortValue(world,kind,isArtGroup(d.group)?row:header,sortKey,options)});
      },{signal:options.signal});
      heap.sort(compare);selected.push(...heap.slice(start,start+size).map(entry=>entry.header));
    }
    check(options.signal);const requests=selected.filter(header=>!header.synthetic).map(header=>({kind,id:header.id})),headers=await batchHeaders(world,requests,options),rows=await mapBounded(selected,8,async header=>{
      if(header.synthetic)return options.headersOnly?enrich(world,kind,summary(header,d.group)):normalized(virtualHeader(world,Number(header.id)-world.disk.aggregates.virtualEvents.startId),'events',Number(header.id));
      const parts=headers.get(kind+':'+header.id)||[];if(isArtGroup(d.group))return artRecord(world,kind,header.id,options,parts);return !parts.length?null:options.headersOnly?enrich(world,kind,summary(mergeHeaders(parts,d.group),d.group)):recordFromHeaders(world,kind,header.id,parts,options);
    },options.signal);return {rows:rows.filter(Boolean),total,unknownFilterCounts,missingFilterFields:Object.keys(unknownFilterCounts)};
  }
  const RELATION_VERSION=3,relationCache=new WeakMap(),relationTasks=new WeakMap(),collectionTypeCache=new WeakMap(),collectionTypeTasks=new WeakMap();
  function relationFingerprint(world){let hash=2166136261;const source=JSON.stringify([world.disk.id,world.disk.factsVersion,world.disk.aggregates?.version,world.disk.aggregates?.virtualEvents?.count,world.disk.aggregates?.virtualEvents?.startId,world.disk.rawEventCount??world.disk.counts.events,world.disk.fileInfo,(world.disk.manifest.events||[]).map(row=>[row.blockNo,row.minId,row.maxId,row.rows??row.count]),(world.disk.manifest.collections||[]).map(row=>[row.blockNo,row.minId,row.maxId,row.rows??row.count])]);for(let at=0;at<source.length;at++)hash=Math.imul(hash^source.charCodeAt(at),16777619);return String(hash>>>0);}
  function compactLists(lists){const ids=Object.keys(lists).map(Number).sort((a,b)=>a-b),starts=new Uint32Array(ids.length+1);let total=0;for(let at=0;at<ids.length;at++){starts[at]=total;total+=lists[ids[at]].length;}starts[ids.length]=total;const values=new Uint32Array(total);for(let at=0;at<ids.length;at++)values.set(lists[ids[at]],starts[at]);return {ids:Float64Array.from(ids),starts,values};}
  function lookupList(index,id){if(!index)return [];let low=0,high=index.ids.length;while(low<high){const mid=(low+high)>>>1;if(index.ids[mid]<Number(id))low=mid+1;else high=mid;}return low<index.ids.length&&index.ids[low]===Number(id)?index.values.subarray(index.starts[low],index.starts[low+1]):[];}
  function appendPosting(groups,group,id,value){if(!Number.isSafeInteger(Number(id))||Number(id)<0||!Number.isSafeInteger(Number(value))||Number(value)<0)return;const targets=groups[group]||(groups[group]=dictionary()),values=targets[id]||(targets[id]=[]);if(values[values.length-1]!==value)values.push(value);}
  function collectionTypeIds(types){const result=dictionary();for(const [type,ids]of Object.entries(types))result[type]=Float64Array.from(ids.sort((a,b)=>a-b));return result;}
  async function collectionTypeCatalog(world,options={}){
    check(options.signal);const fingerprint=relationFingerprint(world),cached=collectionTypeCache.get(world);if(cached?.fingerprint===fingerprint)return cached;
    const lookup=relationCache.get(world);if(lookup?.fingerprint===fingerprint&&lookup.types){const catalog={fingerprint,types:lookup.types,combinations:new Map()};collectionTypeCache.set(world,catalog);return catalog;}
    if(collectionTypeTasks.has(world))return sharedRead(collectionTypeTasks,world,options.signal,()=>collectionTypeCatalog(world,options));
    const task=(async()=>{const types=dictionary();await scan(world,'collections',header=>{const type=fold(header.type),ids=types[type]||(types[type]=[]);ids.push(Number(header.id));},{signal:options.signal});check(options.signal);const catalog={fingerprint,types:collectionTypeIds(types),combinations:new Map()};collectionTypeCache.set(world,catalog);return catalog;})();
    collectionTypeTasks.set(world,task);try{return await task;}finally{if(collectionTypeTasks.get(world)===task)collectionTypeTasks.delete(world);}
  }
  const SOURCE_ROLES_VERSION=2,sourceRoleCache=new WeakMap(),sourceRoleTasks=new WeakMap();
  const ROLE_COLLECTION_FIELDS=['id','type','start_year','end_year','site_id','subregion_id','feature_layer_id','war_eventcol','parent_eventcol','aggressor_ent_id','defender_ent_id','attacking_enid','defending_enid','target_enid','target_entity_id','civ_id','attacking_hfid','defending_hfid','a_support_merc_hfid','d_support_merc_hfid'];
  const ROLE_EVENT_FIELDS=['id','type','attacker_hfid','group_1_hfid','group_2_hfid','hfid','histfig','link','link_type','slayer_hfid','slayer_hf','attacker_civ_id','defender_civ_id','site_id','site','histfig','eater','victim','snatcher_hfid','target_hfid'];
  const ROLE_EVENT_TYPES=new Set(['hf attacked site','hf destroyed site','hf simple battle event','add hf entity link','hf died','item stolen','creature devoured','hf abducted','attacked site','field battle']);
  function roleSnapshot(header,fields){const result={};for(const key of fields)if(header[key]!==undefined)result[key]=header[key];return result;}
  function rawMembers(header,key,alias){return header[key+'Parts']?header[key+'Parts'].flatMap(value=>Array.from(list(value))):Array.from(list(header[key]??header[alias]));}
  function roleCollectionHeader(header){const result=roleSnapshot(header,ROLE_COLLECTION_FIELDS);result.events=rawMembers(header,'events','event');result.children=rawMembers(header,'children','eventcol');return result;}
  function roleEventHeader(header){const result=roleSnapshot(header,ROLE_EVENT_FIELDS);result.refs=list(header.refs);return result;}
  function roleEventIds(collections){const needed=new Set(),active=new Set();const visit=header=>{if(!header||active.has(header.id))return;active.add(header.id);for(const id of header.events)needed.add(Number(id));for(const id of header.children)visit(collections.get(Number(id)));active.delete(header.id);};for(const header of collections.values()){const type=fold(header.type);if(type==='beast attack')visit(header);else if(type==='battle')for(const id of header.events)needed.add(Number(id));}return needed;}
  function eraEnd(era,world){return Number(era.end_year)>=0?Number(era.end_year):Number(sourceRoleCache.get(world)?.lastEventYear??world.disk?.aggregates?.currentYear??world.aggregates?.currentYear??world.year);}
  function eraContainsCollection(era,collection,currentYear){const start=Number(era.start_year),end=Number(era.end_year)>=0?Number(era.end_year):Number(currentYear),a=Number(collection.start_year??-1),b=Number(collection.end_year??-1);return a>=start&&b<=end&&b!==-1||a>=start&&a<=end||b>=start&&b<=end&&b!==-1||a<=start&&b>=end||a<=start&&b===-1;}
  async function saveSourceRoles(world,roles){sourceRoleCache.set(world,roles);try{const packed=await packValue({importId:world.disk.id+':sourceRoles-v1',roles}),db=await database(world.disk.dbName||LEGACY_DATABASE),tx=db.transaction('derived','readwrite'),saved=done(tx);tx.objectStore('derived').put(packed);await saved;}catch(error){/* This acceleration cache is optional; the exact in-memory result remains usable. */}return roles;}
  async function buildSourceRolesFromHeaders(world,collections,events,options={}){
    const a=world.disk.aggregates,roleLists=dictionary(),extraLists=dictionary(),eventAdditions=dictionary(),eventPatches=dictionary(),beastActors=dictionary(),beastSites=dictionary(),beastLists=dictionary(),siteIds=new Set(Object.keys(a.siteOwnership||{}).map(Number)),entityIds=new Set(Object.keys(a.entityFacts||{}).map(Number)),regionIds=new Set((world.regions||[]).map(row=>Number(row.id))),layerIds=new Set((world.extra?.underground_regions||[]).map(row=>Number(row.id))),eraIds=new Set((world.eras||[]).map(row=>Number(row.id)));
    // Small retained groups normally cover all records. Header IDs also cover
    // worlds whose twenty-megabyte retention budget was exhausted.
    for(const [group,target]of [['sites',siteIds],['regions',regionIds],['underground_regions',layerIds]])if(target.size<(world.disk.counts[group]||0))await scan(world,group,header=>target.add(Number(header.id)),options);
    const valid=(group,id)=>id!==null&&id!==undefined&&id!==''&&Number.isSafeInteger(Number(id))&&Number(id)>=0&&(group==='figures'?figureExists(world,Number(id)):group==='entities'?entityIds.has(Number(id)):group==='sites'?siteIds.has(Number(id)):group==='regions'?regionIds.has(Number(id)):group==='underground_regions'?layerIds.has(Number(id)):group==='collections'?collections.has(Number(id)):group==='eras'?eraIds.has(Number(id)):false);
    const resolve=(group,value)=>valid(group,value)?Number(value):null,field=(group,row,...keys)=>{for(const key of keys){const id=resolve(group,row?.[key]);if(id!==null)return id;}return null;};
    const add=(group,id,collection)=>{if(!valid(group,id)||!valid('collections',collection))return;const targets=roleLists[group]||(roleLists[group]=dictionary()),ids=targets[id]||(targets[id]=new Set());ids.add(Number(collection));};
    const patch=(event,key,value)=>{if(value===null||value===undefined)return;(eventPatches[event.id]||(eventPatches[event.id]={}))[key]=value;};
    const addEvent=(group,id,event,key='collection actor')=>{if(!valid(group,id))return;const refs=eventAdditions[event.id]||(eventAdditions[event.id]=[]);if(!refs.some(ref=>ref.kind===group&&ref.id===Number(id)))refs.push({kind:group,id:Number(id),key});if(list(event.refs).some(ref=>ref.kind===group&&Number(ref.id)===Number(id)))return;const targets=extraLists[group]||(extraLists[group]=dictionary()),ids=targets[id]||(targets[id]=new Set());ids.add(Number(event.id));};
    const allEvents=(header,active=new Set())=>{if(!header||active.has(header.id))return [];active.add(header.id);let result=[];for(const child of header.children)result.push(...allEvents(collections.get(Number(child)),active));for(const id of header.events){const event=events.get(Number(id));if(event)result.push(event);}active.delete(header.id);return result.sort((x,y)=>x.id-y.id);};
    const originalRecords=new Map(),original=(kind,id)=>{const key=kind+':'+id;if(!originalRecords.has(key))originalRecords.set(key,getRecord(world,kind,id,options));return originalRecords.get(key);};
    const preloadOriginal=async(kind,ids)=>{
      const requests=[...new Set(ids)].filter(id=>!originalRecords.has(kind+':'+id)).map(id=>({kind,id}));if(!requests.length)return;
      const headers=await batchHeaders(world,requests,options),ordered=requests.map(request=>({...request,headers:headers.get(kind+':'+request.id)||[]})).filter(row=>row.headers.length),position=(a,b)=>(a.fileNo||0)-(b.fileNo||0)||a.offset-b.offset;
      ordered.sort((a,b)=>position(a.headers[0],b.headers[0]));const windows=[];
      for(const header of [...new Set(ordered.flatMap(row=>row.headers))].sort(position)){
        const fileNo=header.fileNo||0,end=header.offset+header.length,last=windows.at(-1);
        if(last&&last.fileNo===fileNo&&header.offset-last.end<=65536&&end-last.start<=1024*1024){last.end=Math.max(last.end,end);last.headers.push(header);}
        else windows.push({fileNo,start:header.offset,end,headers:[header]});
      }
      const preloadedHeaders=new Map(),group=descriptor(world,kind).group;
      await mapBounded(windows,4,async window=>{
        const file=await getSource(world,window.fileNo,options);let bytes;
        try{bytes=new Uint8Array(await file.slice(window.start,window.end).arrayBuffer(options));}catch(error){if(error.name==='AbortError')throw error;throw sourceError(world,window.fileNo,error);}
        let yielded=performance.now();for(const header of window.headers){check(options.signal);const start=header.offset-window.start;preloadedHeaders.set(header,await parseHeaderBytes(world,header,group,bytes.subarray(start,start+header.length)));if(performance.now()-yielded>12){await new Promise(resolve=>setTimeout(resolve,0));yielded=performance.now();}}
      },options.signal);
      const prepared={...options,preloadedHeaders};await mapBounded(ordered,4,row=>{const task=recordFromHeaders(world,kind,row.id,row.headers,prepared);originalRecords.set(kind+':'+row.id,task);return task;},options.signal);
    };
    const ambiguous=[...collections.values()].filter(header=>['persecution','entity overthrown'].includes(fold(header.type))&&header.target_entity_id===undefined);await preloadOriginal('collections',ambiguous.map(header=>header.id));for(const header of ambiguous)header.target_entity_id=(await original('collections',header.id))?.target_entity_id;
    const devoured=[...events.values()].filter(event=>fold(event.type)==='creature devoured');await preloadOriginal('events',devoured.map(event=>event.id));for(const event of devoured){const record=await original('events',event.id);for(const key of ['eater','victim']){event[key]=record?.[key];const figure=field('figures',event,key);patch(event,key,figure);addEvent('figures',figure,event,key);}}
    const initialActor=header=>{const nested=allEvents(header),first=type=>nested.find(event=>fold(event.type)===type);let actor=null;for(const [type,keys]of [['hf attacked site',['attacker_hfid']],['hf destroyed site',['attacker_hfid']],['hf simple battle event',['group_1_hfid']]])if(actor===null)actor=field('figures',first(type),...keys);if(actor===null)actor=field('figures',nested.find(event=>fold(event.type)==='add hf entity link'&&fold(event.link_type??event.link)==='enemy'),'hfid','histfig');return {actor,nested};};
    // Resolve all potential first-death lair records together, in source order.
    // Collection-order reads otherwise repeatedly evict the same 8 MiB chunks.
    const beastState=new Map(),lairCandidates=new Set();for(const header of collections.values())if(fold(header.type)==='beast attack'){const state=initialActor(header);beastState.set(header.id,state);if(state.actor===null){const death=state.nested.find(event=>fold(event.type)==='hf died');if(death)for(const figure of [field('figures',death,'hfid'),field('figures',death,'slayer_hfid','slayer_hf')])if(figure!==null)lairCandidates.add(figure);}}await preloadOriginal('figures',[...lairCandidates]);
    let visited=0;for(const header of collections.values()){
      check(options.signal);const id=Number(header.id),type=fold(header.type),site=field('sites',header,'site_id'),explicitRegion=field('regions',header,'subregion_id'),region=explicitRegion??resolve('regions',a.geographyRegions?.sites?.[site]);add('sites',site,id);add('regions',region,id);add('underground_regions',field('underground_regions',header,'feature_layer_id'),id);for(const child of header.children)add('collections',id,resolve('collections',child));for(const era of world.eras||[])if(eraContainsCollection(era,header,options.lastEventYear??a.currentYear))add('eras',era.id,id);
      if(type==='war'){add('entities',field('entities',header,'aggressor_ent_id'),id);add('entities',field('entities',header,'defender_ent_id'),id);}
      else if(['raid','theft','abduction','site conquered'].includes(type)){add('entities',field('entities',header,'attacking_enid'),id);add('entities',field('entities',header,'defending_enid'),id);}
      else if(type==='duel'){for(const key of ['attacking_hfid','defending_hfid'])for(const figure of list(header[key]))add('figures',figure,id);}
      else if(type==='insurrection')add('entities',field('entities',header,'target_enid'),id);
      else if(type==='persecution'||type==='entity overthrown')add('entities',field('entities',header,'target_entity_id'),id);
      else if(type==='occasion')add('entities',field('entities',header,'civ_id'),id);
      else if(type==='battle'){
        for(const key of ['attacking_hfid','defending_hfid','a_support_merc_hfid','d_support_merc_hfid'])for(const figure of list(header[key]))add('figures',figure,id);
        const direct=header.events.map(event=>events.get(Number(event))).filter(Boolean),sides=direct.find(event=>fold(event.type)==='attacked site')||direct.find(event=>fold(event.type)==='field battle'),war=collections.get(Number(header.war_eventcol));
        add('entities',field('entities',sides,'attacker_civ_id')??(fold(war?.type)==='war'?field('entities',war,'aggressor_ent_id'):null),id);add('entities',field('entities',sides,'defender_civ_id')??(fold(war?.type)==='war'?field('entities',war,'defender_ent_id'):null),id);
      }else if(type==='beast attack'){
        add('entities',field('entities',header,'defending_enid'),id);const state=beastState.get(header.id),nested=state.nested;let actor=state.actor;
        if(actor===null){const deaths=nested.filter(event=>fold(event.type)==='hf died'),firstDeath=deaths[0];if(firstDeath){const victim=field('figures',firstDeath,'hfid'),killer=field('figures',firstDeath,'slayer_hfid','slayer_hf'),hasLair=async figure=>figure!==null&&list((await original('figures',figure))?.site_link).some(link=>fold(link.link_type)==='lair');if(await hasLair(victim))actor=victim;else if(await hasLair(killer))actor=killer;else{const killers=new Map();for(const event of deaths){const figure=field('figures',event,'slayer_hfid','slayer_hf');killers.set(figure,(killers.get(figure)||0)+1);}const repeated=[...killers].filter(([,count])=>count>1);if(repeated.length===1)actor=repeated[0][0];}}}
        const direct=header.events.map(event=>events.get(Number(event))).filter(Boolean);let beastSite=site;
        for(const event of direct.filter(event=>fold(event.type)==='item stolen')){const eventSite=field('sites',event,'site_id','site');if(eventSite===null)patch(event,'site_id',beastSite);else beastSite=eventSite;const thief=field('figures',event,'histfig');if(thief===null)patch(event,'histfig',actor);else if(actor===null)actor=thief;addEvent('sites',beastSite,event);addEvent('figures',actor,event);}
        for(const event of direct.filter(event=>fold(event.type)==='creature devoured')){let eater=field('figures',event,'eater');if(actor===null&&event.eater===undefined){const record=await original('events',event.id);eater=field('figures',record,'eater');}if(eater===null)patch(event,'eater',actor);else if(actor===null)actor=eater;addEvent('figures',actor,event);}
        for(const event of direct.filter(event=>fold(event.type)==='hf abducted')){const snatcher=field('figures',event,'snatcher_hfid');if(snatcher===null)patch(event,'snatcher_hfid',actor);else if(actor===null)actor=snatcher;addEvent('figures',actor,event);}
        if(actor!==null){beastActors[id]=actor;add('figures',actor,id);(beastLists[actor]||(beastLists[actor]=[])).push(id);}if(beastSite!==null)beastSites[id]=beastSite;
      }
      if((++visited&1023)===0){options.progress?.({phase:'source-roles',message:'正在补齐纪事角色…'});await new Promise(resolve=>setTimeout(resolve,0));}
    }
    const compact=groups=>{const result=dictionary();for(const [group,targets]of Object.entries(groups)){const values=dictionary();for(const [id,ids]of Object.entries(targets))values[id]=[...ids].sort((a,b)=>a-b);result[group]=compactLists(values);}return result;};
    return {version:SOURCE_ROLES_VERSION,lastEventYear:options.lastEventYear??a.currentYear,fingerprint:relationFingerprint(world),rolesByObject:compact(roleLists),extraEventsByObject:compact(extraLists),eventAdditions,eventPatches,beastActors,beastSites,beastAttacks:compactLists(beastLists)};
  }
  async function buildSourceRoles(world,options){const collections=new Map();await scan(world,'collections',header=>collections.set(Number(header.id),roleCollectionHeader(header)),options);const needed=roleEventIds(collections),events=new Map();let lastEventYear=-1;await scan(world,'events',header=>{lastEventYear=Number(header.year);if((needed.has(Number(header.id))&&ROLE_EVENT_TYPES.has(fold(header.type))||fold(header.type)==='creature devoured'))events.set(Number(header.id),roleEventHeader(header));},{...options,rawOnly:true});return buildSourceRolesFromHeaders(world,collections,events,{...options,lastEventYear});}
  async function prepareSourceRoles(world,options={}){
    check(options.signal);await analytics(world,options);if(world.disk?.format!=='file-index')return null;const fingerprint=relationFingerprint(world),cached=sourceRoleCache.get(world);if(cached?.fingerprint===fingerprint)return cached;if(cached)sourceRoleCache.delete(world);if(sourceRoleTasks.has(world))return sharedRead(sourceRoleTasks,world,options.signal,()=>prepareSourceRoles(world,options));
    const task=(async()=>{const db=await database(world.disk.dbName||LEGACY_DATABASE);let saved;try{saved=await readValue(db,'derived',world.disk.id+':sourceRoles-v1',options);}catch(error){if(error.name==='AbortError')throw error;}if(saved?.roles?.version===SOURCE_ROLES_VERSION&&saved.roles.fingerprint===fingerprint){sourceRoleCache.set(world,saved.roles);return saved.roles;}
      await relationLookup(world,options);check(options.signal);if(sourceRoleCache.get(world)?.fingerprint===fingerprint)return sourceRoleCache.get(world);return saveSourceRoles(world,await buildSourceRoles(world,options));})();sourceRoleTasks.set(world,task);try{return await task;}finally{if(sourceRoleTasks.get(world)===task)sourceRoleTasks.delete(world);}
  }
  async function buildRelationLookup(world,options){
    const eventPostings=dictionary(),collectionPostings=dictionary(),parents=dictionary(),eventCollections=dictionary(),types=dictionary(),roleCollections=new Map(),roleEvents=new Map(),eventYears=dictionary(),blockYearTypes=dictionary(),eventBlocks=[...(world.disk.manifest.events||[])].sort((a,b)=>a.minId-b.minId||a.blockNo-b.blockNo),prefixMax=[];let max=-Infinity,lastEventYear=-1;
    for(const block of eventBlocks){max=Math.max(max,block.maxId);prefixMax.push(max);}
    const eventBlocksFor=id=>{let low=0,high=eventBlocks.length;while(low<high){const mid=(low+high)>>>1;if(eventBlocks[mid].minId<=id)low=mid+1;else high=mid;}const result=[];for(let at=low-1;at>=0&&prefixMax[at]>=id;at--)if(eventBlocks[at].maxId>=id)result.push(eventBlocks[at].blockNo);return result;};
    let neededRoleEvents;for(const group of ['collections','events']){if(group==='events')neededRoleEvents=roleEventIds(roleCollections);for await(const {item,block}of orderedBlocks(world,group,world.disk.manifest[group]||[],options)){
      for(const raw of block.headers){if(!raw.primary)continue;let header=hasShadow(world,group,raw.id)?await effectiveHeader(world,group,raw,options):raw;if(group==='events')header=sourceHeader(world,header);
        for(const ref of list(header.refs))appendPosting(group==='events'?eventPostings:collectionPostings,ref.kind,ref.id,item.blockNo);
        if(group==='events'){lastEventYear=Number(header.year);const types=blockYearTypes[item.blockNo]||(blockYearTypes[item.blockNo]=dictionary()),type=fold(header.type),years=types[type]||(types[type]=dictionary());years[header.year]=(years[header.year]||0)+1;if((neededRoleEvents.has(Number(header.id))&&ROLE_EVENT_TYPES.has(fold(header.type))||fold(header.type)==='creature devoured'))roleEvents.set(Number(header.id),roleEventHeader(header));const year=Number(header.year);if(Number.isFinite(year)){const values=eventYears[year]||(eventYears[year]=[]);if(values.at(-1)!==item.blockNo)values.push(item.blockNo);}for(const [siteKey,structureKey]of [['site_id','structure_id'],['site_id','structure'],['site_id','structure_local_id'],['source_site_id','source_structure_id'],['dest_site_id','dest_structure_id']]){const site=factId(header,siteKey),local=factId(header,structureKey),structure=world.disk.aggregates?.structureLookup?.[site+':'+local];if(structure!==undefined)appendPosting(eventPostings,'structures',structure,item.blockNo);}}
        if(group==='collections'){
          roleCollections.set(Number(header.id),roleCollectionHeader(header));const type=fold(header.type),ids=types[type]||(types[type]=[]);ids.push(Number(header.id));
          for(const key of ['attacking_hfid','defending_hfid','noncom_hfid','a_support_merc_hfid','d_support_merc_hfid'])for(const id of list(header[key]))appendPosting(collectionPostings,'figures',id,item.blockNo);
          for(const child of members(header,'children','eventcol'))appendPosting({parents},'parents',child,Number(header.id));
          if(number(header.parent_eventcol)!==null)appendPosting({parents},'parents',header.id,Number(header.parent_eventcol));
          for(const id of members(header,'events','event'))for(const eventBlock of eventBlocksFor(Number(id))){const values=eventCollections[eventBlock]||(eventCollections[eventBlock]=[]);if(values[values.length-1]!==item.blockNo)values.push(item.blockNo);}
        }
      }
      options.progress?.({phase:'relations',message:'正在准备关联索引…'});
    }}
    const sourceRoles=await saveSourceRoles(world,await buildSourceRolesFromHeaders(world,roleCollections,roleEvents,{...options,lastEventYear}));for(const [id,refs]of Object.entries(sourceRoles.eventAdditions))for(const ref of refs)for(const block of eventBlocksFor(Number(id)))appendPosting(eventPostings,ref.kind,ref.id,block);
    const events=dictionary(),collections=dictionary();for(const [group,lists]of Object.entries(eventPostings))events[group]=compactLists(lists);for(const [group,lists]of Object.entries(collectionPostings))collections[group]=compactLists(lists);
    const source=(world.disk.aggregates||world.aggregates)?.virtualEvents,virtualLists=dictionary(),virtualYears=dictionary();if(source){const columns=source.segments||source,length=source.segments?columns.starts.length:source.count;for(let at=0;at<length;at++){const year=columns.years[at];(virtualYears[year]||(virtualYears[year]=[])).push(at);}}if(source)for(let at=0;at<source.count;at++){const id=source.figures[at],values=virtualLists[id]||(virtualLists[id]=[]);values.push(at);if((at&65535)===65535){check(options.signal);await new Promise(resolve=>setTimeout(resolve,0));}}
    return {version:RELATION_VERSION,fingerprint:relationFingerprint(world),events,collections,parents,eventCollections,types:collectionTypeIds(types),eventYears,blockYearTypes,virtualYears:compactLists(virtualYears),virtualYearSegments:Boolean(source?.segments),virtual:compactLists(virtualLists)};
  }
  async function relationLookup(world,options={}){
    check(options.signal);const fingerprint=relationFingerprint(world),cached=relationCache.get(world);if(cached?.fingerprint===fingerprint)return cached;
    if(relationTasks.has(world))return sharedRead(relationTasks,world,options.signal,()=>relationLookup(world,options));
    const task=(async()=>{const db=await database(world.disk.dbName||LEGACY_DATABASE),key=world.disk.id+':relations-v1';let saved;
      try{saved=await readValue(db,'derived',key,options);}catch(error){if(error.name==='AbortError')throw error;}
      let lookup=saved?.lookup;if(lookup?.version!==RELATION_VERSION||lookup?.fingerprint!==fingerprint)lookup=await buildRelationLookup(world,options);check(options.signal);relationCache.set(world,lookup);
      if(saved?.lookup!==lookup){try{const packed=await packValue({importId:key,lookup});const tx=db.transaction('derived','readwrite'),stored=done(tx);tx.objectStore('derived').put(packed);await stored;}catch(error){/* Optional cache writes never prevent browsing. */}}
      return lookup;
    })();relationTasks.set(world,task);try{return await task;}finally{if(relationTasks.get(world)===task)relationTasks.delete(world);}
  }
  async function parentIndex(world,signal){if(parentCache.has(world))return parentCache.get(world);const parents=new Map();await scan(world,'collections',header=>{for(const child of members(header,'children','eventcol')){if(finiteId(child)===null)continue;let values=parents.get(Number(child));if(!values)parents.set(Number(child),values=[]);values.push(Number(header.id));}if(finiteId(header.parent_eventcol)!==null){let values=parents.get(Number(header.id));if(!values)parents.set(Number(header.id),values=[]);values.push(Number(header.parent_eventcol));}},{signal});parentCache.set(world,parents);return parents;}
  function compareRelated(world,kind,key,options={}){const collator=new Intl.Collator('zh-CN',{numeric:true});return(a,b)=>{let result;if(key==='date'){result=Number(a.year??a.start_year??-1)-Number(b.year??b.start_year??-1)||Number(a.seconds72??a.start_seconds72??0)-Number(b.seconds72??b.start_seconds72??0)||Number(a.id)-Number(b.id);}else{const x=sortValue(world,kind,a,key,options),y=sortValue(world,kind,b,key,options);result=typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x??''),String(y??''));if(!Number.isFinite(result))result=0;result=result||Number(a.id)-Number(b.id);}return options.descending?-result:result;};}
  async function relatedCollectionPage(world,kind,id,roles,options={}){const group=descriptor(world,kind).group,ids=Array.from(lookupList(roles.rolesByObject[group],id)),start=((options.page||1)-1)*Math.min(100,Math.max(1,Number(options.pageSize)||10)),size=Math.min(100,Math.max(1,Number(options.pageSize)||10));let ordered=ids;
    if(options.sortKey&&options.sortKey!=='id'){const rows=await batchHeaders(world,ids.map(id=>({kind:'collections',id})),options);let headers=ids.map(id=>mergeHeaders(rows.get('collections:'+id)||[],'collections')).filter(Boolean);if(['html','name'].includes(options.sortKey))headers=await mapBounded(headers,8,header=>recordFromHeaders(world,'collections',header.id,rows.get('collections:'+header.id),options),options.signal);headers.sort(compareRelated(world,'collections',options.sortKey,options));ordered=headers.map(header=>Number(header.id));}else if(options.descending)ordered=[...ids].reverse();
    const collections=await mapBounded(ordered.slice(start,start+size),8,id=>getRecord(world,'collections',id,options),options.signal);return {events:[],collections:collections.filter(Boolean),collectionIds:ids,eventCount:0,collectionCount:ids.length,typeCounts:dictionary(),eventYears:dictionary()};}
  function virtualYearRanges(world,lookup,start,end,descending=false){const source=world.disk.aggregates?.virtualEvents;if(!source||!lookup.virtualYears)return [];const ranges=[],columns=source.segments||source;for(let at=0;at<lookup.virtualYears.ids.length;at++){const year=lookup.virtualYears.ids[at];if(year<start||year>end)continue;for(const index of lookupList(lookup.virtualYears,year))ranges.push({start:source.segments?columns.starts[index]:index,count:source.segments?columns.counts[index]:1,year,seconds:Number(columns.seconds[index])||0});}ranges.sort((a,b)=>descending?b.start-a.start:a.start-b.start);return ranges;}
  async function relatedEra(world,id,lookup,roles,options={}){
    const era=await getRecord(world,'eras',id,options),startYear=Number(era.start_year),endYear=eraEnd(era,world),size=Math.min(100,Math.max(1,Number(options.pageSize)||10)),offset=((options.page||1)-1)*size,excluded=new Set(options.excludeEventTypes||[]),typeCounts=dictionary(),eventYears=dictionary(),eligible=dictionary(),selected=[],descending=Boolean(options.descending);let eventCount=0,skip=offset;
    for(const [block,types]of Object.entries(lookup.blockYearTypes)){let count=0;for(const [type,years]of Object.entries(types))for(const [year,value]of Object.entries(years))if(Number(year)>=startYear&&Number(year)<=endYear){typeCounts[type]=(typeCounts[type]||0)+value;const target=eventYears[type]||(eventYears[type]=dictionary());target[year]=(target[year]||0)+value;if(!excluded.has(type))count+=value;}eligible[block]=count;eventCount+=count;}
    const ranges=virtualYearRanges(world,lookup,startYear,endYear,descending);for(const range of ranges){typeCounts['battle fought']=(typeCounts['battle fought']||0)+range.count;const years=eventYears['battle fought']||(eventYears['battle fought']=dictionary());years[range.year]=(years[range.year]||0)+range.count;if(!excluded.has('battle fought'))eventCount+=range.count;}
    const takeVirtual=()=>{if(excluded.has('battle fought'))return;for(const range of ranges){if(selected.length>=size)break;if(skip>=range.count){skip-=range.count;continue;}for(let at=skip;at<range.count&&selected.length<size;at++)selected.push(virtualHeader(world,range.start+(descending?range.count-at-1:at)));skip=0;}};
    const takeRaw=async()=>{const blocks=descending?[...(world.disk.manifest.events||[])].reverse():world.disk.manifest.events||[];for(const item of blocks){check(options.signal);if(selected.length>=size)break;const count=eligible[item.blockNo]||0;if(skip>=count){skip-=count;continue;}const block=await getBlock(world,'events',item.blockNo,options),headers=descending?[...block.headers].reverse():block.headers;for(const raw of headers){if(!raw.primary)continue;const header=hasShadow(world,'events',raw.id)?await effectiveHeader(world,'events',raw,options):raw,year=Number(header.year);if(!(year>=startYear&&year<=endYear)||excluded.has(fold(header.type)))continue;if(skip){skip--;continue;}selected.push(sourceHeader(world,header));if(selected.length>=size)break;}}};
    if(options.sortKey==='date'){
      const totals=dictionary();for(const [type,years]of Object.entries(eventYears))if(!excluded.has(type))for(const [year,count]of Object.entries(years))totals[year]=(totals[year]||0)+count;
      const years=Object.keys(totals).map(Number).sort((a,b)=>descending?b-a:a-b),chosen=new Set();let remaining=size;for(const year of years){if(skip>=totals[year]){skip-=totals[year];continue;}chosen.add(year);remaining-=totals[year]-skip;if(remaining<=0)break;}
      const blocks=new Set();for(const year of chosen)for(const block of lookup.eventYears[year]||[])blocks.add(block);const runs=[];
      await scan(world,'events',header=>{if(chosen.has(Number(header.year))&&!excluded.has(fold(header.type)))runs.push({header,count:1});},{signal:options.signal,blocks,rawOnly:true});
      const source=world.disk.aggregates.virtualEvents,columns=source?.segments||source;if(!excluded.has('battle fought'))for(const range of ranges)if(chosen.has(range.year))runs.push({header:{year:range.year,seconds72:range.seconds,id:source.startId+range.start},count:range.count,range});
      const compare=compareRelated(world,'events','date',options);runs.sort((a,b)=>compare(a.header,b.header));for(const run of runs){if(selected.length>=size)break;if(skip>=run.count){skip-=run.count;continue;}if(run.range){for(let at=skip;at<run.count&&selected.length<size;at++)selected.push(virtualHeader(world,run.range.start+(descending?run.count-at-1:at)));}else selected.push(run.header);skip=0;}
    }else if(options.sortKey&&options.sortKey!=='id'){
      const heap=[],limit=offset+size,collator=new Intl.Collator('zh-CN',{numeric:true}),compare=(a,b)=>{let result=typeof a.value==='number'&&typeof b.value==='number'?a.value-b.value:collator.compare(String(a.value??''),String(b.value??''));if(!Number.isFinite(result))result=0;result=result||a.id-b.id;return descending?-result:result;},offer=entry=>{if(heap.length===limit){if(compare(entry,heap[0])>=0)return;heap[0]=entry;let at=0;while(true){const left=at*2+1,right=left+1;if(left>=heap.length)break;const child=right<heap.length&&compare(heap[right],heap[left])>0?right:left;if(compare(heap[at],heap[child])>=0)break;[heap[at],heap[child]]=[heap[child],heap[at]];at=child;}}else{heap.push(entry);let at=heap.length-1;while(at>0){const parent=(at-1)>>>1;if(compare(heap[parent],heap[at])>=0)break;[heap[parent],heap[at]]=[heap[at],heap[parent]];at=parent;}}};
      const blocks=new Set();for(const [year,candidates]of Object.entries(lookup.eventYears))if(Number(year)>=startYear&&Number(year)<=endYear)for(const block of candidates)blocks.add(block);await scan(world,'events',async header=>{const year=Number(header.year);if(year<startYear||year>endYear||excluded.has(fold(header.type)))return;const complete=['html','name'].includes(options.sortKey)?await getRecord(world,'events',header.id,options):header;offer({id:Number(header.id),value:sortValue(world,'events',complete,options.sortKey,options)});},{signal:options.signal,blocks});heap.sort(compare);selected.push(...heap.slice(offset,offset+size).map(row=>({id:row.id})));
    }else if(descending){takeVirtual();if(selected.length<size)await takeRaw();}else{await takeRaw();if(selected.length<size)takeVirtual();}
    const collectionIds=Array.from(lookupList(roles.rolesByObject.eras,id)),collectionResult=options.part==='events'?null:await relatedCollectionPage(world,'eras',id,roles,options),events=await mapBounded(selected,8,header=>getRecord(world,'events',header.id,options),options.signal),collections=collectionResult?.collections||[];let eventIds;
    // Full all-event IDs are explicitly opt-in: the era page consumes exact
    // charts/totals and paginated records, not millions of duplicate summaries.
    if(options.includeEventIds){eventIds=[];const blocks=new Set();for(const [year,candidates]of Object.entries(lookup.eventYears))if(Number(year)>=startYear&&Number(year)<=endYear)for(const block of candidates)blocks.add(block);await scan(world,'events',header=>{const year=Number(header.year);if(year>=startYear&&year<=endYear)eventIds.push(Number(header.id));},{...options,blocks});}
    return {events:events.filter(Boolean),collections:collections.filter(Boolean),collectionIds,eventCount,collectionCount:collectionIds.length,typeCounts,eventYears,...(eventIds?{eventIds}:{}),...(options.detail?{detail:{events:[],deaths:[],collections:[]}}:{})};
  }
  async function related(world,kind,id,options={}){
    await analytics(world,{signal:options.signal,progress:options.progress});
    const d=descriptor(world,kind),size=Math.min(100,Math.max(1,Number(options.pageSize)||10)),start=((options.page||1)-1)*size,selected=[],eventIDs=new Set(),collectionIDs=new Set(),typeCounts=dictionary(),eventYears=dictionary(),deaths=[],detailEvents=[],excluded=new Set(options.excludeEventTypes||[]);let eventCount=0;
    if(d.group==='events'){const event=await getRecord(world,kind,id,options);return{events:event?[event]:[],collections:[],eventCount:event?1:0,collectionCount:0};}
    const sourceRoles=await prepareSourceRoles(world,options),lookup=world.disk?.format==='file-index'?await relationLookup(world,options):null,collectionHeaders=new Map(),matchedHeaders=[];if(options.part==='collections'&&sourceRoles)return relatedCollectionPage(world,kind,id,sourceRoles,options);if(d.group==='eras'&&lookup?.blockYearTypes)return relatedEra(world,id,lookup,sourceRoles,options);let eventBlocks;
    if(lookup&&d.group!=='collections'&&d.group!=='eras'){eventBlocks=new Set(lookupList(lookup.events[d.group],id));if(d.group==='written_contents')for(const artifact of world.disk.aggregates?.writtenArtifacts?.[id]||[])for(const block of lookupList(lookup.events.artifacts,artifact))eventBlocks.add(block);}
    if(eventBlocks&&sourceRoles){const extra=Array.from(lookupList(sourceRoles.extraEventsByObject[d.group],id)).sort((a,b)=>a-b);if(extra.length)for(const item of world.disk.manifest.events||[]){let low=0,high=extra.length;while(low<high){const mid=(low+high)>>>1;if(extra[mid]<item.minId)low=mid+1;else high=mid;}if(low<extra.length&&extra[low]<=item.maxId)eventBlocks.add(item.blockNo);}}
    let matches;
    if(d.group==='collections'){
      const pending=[Number(id)],seen=new Set();while(pending.length){check(options.signal);const child=pending.pop();if(seen.has(child))continue;seen.add(child);const headers=await headersFor(world,'collections',child,options);if(headers.length)collectionHeaders.set(Number(child),mergeHeaders(headers,'collections'));for(const header of headers){for(const event of members(header,'events','event'))if(finiteId(event)!==null)eventIDs.add(Number(event));for(const nested of members(header,'children','eventcol')){if(finiteId(nested)===null)continue;pending.push(Number(nested));if(child===Number(id))collectionIDs.add(Number(nested));}}}matches=header=>eventIDs.has(Number(header.id));
    }else if(d.group==='eras'){const era=await getRecord(world,kind,id,options);matches=header=>Number(header.year)>=Number(era.start_year)&&(era.end_year<0||Number(header.year)<=Number(era.end_year));}
    else{const artifactIds=d.group==='written_contents'?new Set(world.disk.aggregates?.writtenArtifacts?.[id]||[]):null;matches=header=>list(header.refs).some(ref=>ref.kind===d.group&&Number(ref.id)===Number(id)||artifactIds&&ref.kind==='artifacts'&&artifactIds.has(Number(ref.id)))||d.group==='structures'&&[['site_id','structure_id'],['site_id','structure'],['site_id','structure_local_id'],['source_site_id','source_structure_id'],['dest_site_id','dest_structure_id']].some(([siteKey,structureKey])=>{const site=factId(header,siteKey),local=factId(header,structureKey);return site!==null&&local!==null&&Number(world.disk.aggregates?.structureLookup?.[site+':'+local])===Number(id);});}
    if(lookup&&d.group==='collections'){const ids=[...eventIDs].sort((a,b)=>a-b);eventBlocks=new Set();for(const item of world.disk.manifest.events||[]){let low=0,high=ids.length;while(low<high){const mid=(low+high)>>>1;if(ids[mid]<item.minId)low=mid+1;else high=mid;}if(low<ids.length&&ids[low]<=item.maxId)eventBlocks.add(item.blockNo);}}
    await scan(world,'events',header=>{if(!matches(header))return;eventIDs.add(Number(header.id));const type=fold(header.type),year=Number(header.year);if(options.detail&&/hf died|abduct|pet|breach|entity link|created site|site taken|created structure|artifact created|artifact stored|artifact copied|written|interaction|attacked site|field battle/.test(type))detailEvents.push({...summarySource(header),refs:header.refs});if(options.detail&&type==='hf died')deaths.push({id:header.id,year:header.year,hfid:header.hfid,slayer_hfid:header.slayer_hfid,slayer_hf:header.slayer_hf,refs:header.refs});typeCounts[type]=(typeCounts[type]||0)+1;if(!eventYears[type])eventYears[type]=dictionary();eventYears[type][year]=(eventYears[type][year]||0)+1;if(excluded.has(type))return;matchedHeaders.push(header);eventCount++;},{signal:options.signal,blocks:eventBlocks,descending:options.descending,rawOnly:!['figures','eras'].includes(d.group),virtualFigure:d.group==='figures'?Number(id):undefined});
    if(['html','name'].includes(options.sortKey)){const full=await mapBounded(matchedHeaders,8,header=>getRecord(world,'events',header.id,options),options.signal);matchedHeaders.length=0;for(const record of full)if(record)matchedHeaders.push(record);}if(options.sortKey)matchedHeaders.sort(compareRelated(world,'events',options.sortKey,options));selected.push(...matchedHeaders.slice(start,start+size));
    if(sourceRoles&&d.group!=='eras'){collectionIDs.clear();for(const collection of lookupList(sourceRoles.rolesByObject[d.group],id))collectionIDs.add(Number(collection));}
    const detailCollections=[];if(options.detail){const missing=[...collectionIDs].filter(id=>!collectionHeaders.has(id)),batches=missing.length?await batchHeaders(world,missing.map(id=>({kind:'collections',id})),options):null;if(batches)for(const id of missing){const rows=batches.get('collections:'+id)||[];if(rows.length)collectionHeaders.set(id,mergeHeaders(rows,'collections'));}}
    if(options.detail)for(const id of [...collectionIDs].sort((a,b)=>a-b)){check(options.signal);const header=collectionHeaders.get(id);if(header)detailCollections.push({...enrich(world,'collections',summary(header,'collections')),event:Array.from(members(header,'events','event')),eventcol:Array.from(members(header,'children','eventcol')),refs:header.refs});}
    const collectionPage=sourceRoles&&options.part!=='events'?await relatedCollectionPage(world,kind,id,sourceRoles,options):null;check(options.signal);return {events:(await mapBounded(selected,8,header=>getRecord(world,'events',header.id,options),options.signal)).filter(Boolean),collections:collectionPage?.collections||[],collectionIds:[...collectionIDs],...(options.detail?{eventIds:[...eventIDs],detail:{deaths,events:detailEvents,collections:detailCollections}}:{}),eventCount,collectionCount:collectionIDs.size,typeCounts,eventYears};
  }
  async function batchHeaders(world,requests,options={}){
    const grouped=new Map(),result=new Map();
    for(const request of requests){const d=descriptor(world,request.kind),id=Number(request.id);let group=grouped.get(d.group);if(!group)grouped.set(d.group,group={ids:new Set(),requests:[]});group.ids.add(id);group.requests.push(request);}
    const work=[];for(const [group,entry]of grouped){entry.sorted=[...entry.ids].sort((a,b)=>a-b);entry.headers=new Map();for(const item of world.disk.manifest[group]||[]){let low=0,high=entry.sorted.length;while(low<high){const middle=(low+high)>>>1;if(entry.sorted[middle]<item.minId)low=middle+1;else high=middle;}if(low<entry.sorted.length&&entry.sorted[low]<=item.maxId)work.push({group,entry,item});}}
    await mapBounded(work,4,async({group,entry,item})=>{const block=await getBlock(world,group,item.blockNo,options);for(const [at,header]of block.headers.entries())if(entry.ids.has(Number(header.id))){let rows=entry.headers.get(Number(header.id));if(!rows)entry.headers.set(Number(header.id),rows=[]);rows.push({blockNo:item.blockNo,at,header});}},options.signal);
    for(const entry of grouped.values())for(const request of entry.requests){const rows=(entry.headers.get(Number(request.id))||[]).sort((a,b)=>a.blockNo-b.blockNo||a.at-b.at);result.set(request.kind+':'+request.id,rows.map(value=>value.header));}return result;
  }
  async function prefetchRefs(world,records,options={}){
    check(options.signal);const refs=new Map();if(Array.isArray(options.references)){for(const ref of options.references)if(ref&&typeof ref.kind==='string'&&Number.isFinite(Number(ref.id)))refs.set(ref.kind+':'+ref.id,ref);}else for(const record of records)for(const ref of global.LegendsLocalStore.references(record,world))refs.set(ref.kind+':'+ref.id,ref);
    const requests=[...refs.values()],headers=await batchHeaders(world,requests,options),output={};
    await mapBounded(requests,8,async ref=>{check(options.signal);const d=descriptor(world,ref.kind),rows=headers.get(ref.kind+':'+ref.id)||[];let record;
      if(d.group==='events'){const events=(world.disk?.aggregates||world.aggregates)?.virtualEvents,index=Number(ref.id)-(events?.startId??Infinity);if(events&&index>=0&&index<events.count)record=normalized(virtualHeader(world,index),'events',Number(ref.id));}
      if(!record&&rows.length){const header=mergeHeaders(rows,d.group),needsParentContext=d.group==='entities'&&/^(?:sitegovernment|site government|government)$/.test(fold(header.type)),needsDescription=['dance_forms','musical_forms','poetic_forms'].includes(d.group);record=options.namesOnly&&!needsParentContext&&!needsDescription?enrich(world,ref.kind,summary(header,d.group)):needsDescription?await artRecord(world,ref.kind,ref.id,options,rows):await recordFromHeaders(world,ref.kind,ref.id,rows,options);}
      if(record)(output[ref.kind]||(output[ref.kind]=[])).push(record);
    },options.signal);return output;
  }
  const ANALYTICS_VERSION=5,CIVILIZATION_RACES_VERSION=1,COPIED_WORKS_VERSION=1,analyticsTasks=new WeakMap();
  // EntityLink's last start_year/end_year/link_type property determines Type.
  // Former positions and ordinary membership never establish a civ's race.
  function currentPosition(link){
    let type='';for(const [key,value]of Object.entries(link||{})){if(key==='start_year')type='position';else if(key==='end_year')type='former position';else if(key==='link_type')type=fold(value);}return type==='position';
  }
  function civilizationPositionIds(figure){
    const ids=new Set(list(figure.civRacePositionIds).map(finiteId).filter(id=>id!==null));
    for(const key of ['entity_link','entity_position_link','entity_former_position_link'])for(const link of list(figure[key]))if(currentPosition(link)){const id=factId(link,'entity_id','entity','target');if(id!==null)ids.add(id);}
    return ids;
  }
  const unknownRace=race=>!String(race??'').trim()||fold(race)==='unknown';
  function inheritCivilizationRace(figure,entities){
    const race=isFlag(figure,'force')?'Force':figure.race;
    if(unknownRace(race)||fold(race).startsWith('demon'))return;
    for(const id of civilizationPositionIds(figure)){const entity=entities.get(id);if(entity?.IsCiv&&unknownRace(entity.race))entity.race=race;}
  }
  async function saveDerived(world,aggregates){const packed=await packValue({importId:world.disk.id,version:ANALYTICS_VERSION,aggregates}),db=await database(world.disk.dbName||CURRENT_DATABASE);if(db.objectStoreNames.contains('derived')){const tx=db.transaction('derived','readwrite'),saved=done(tx);tx.objectStore('derived').put(packed);await saved;}}
  function copiedWorkRecords(aggregates,works,metrics){
    const entries=[];
    for(const work of works){
      const {copies,references}=metrics.counts.get(Number(work.id))||{copies:0,references:0},value=copies+references;if(!value)continue;
      let at=entries.findIndex(entry=>value>entry.value||value===entry.value&&Number(work.id)<entry.id);if(at<0)at=entries.length;if(at>=10)continue;
      const author=aggregates.authorNames?.[factId(work,'author_hfid','author','author_id')];
      entries.splice(at,0,{kind:'writtencontents',id:Number(work.id),record:summary(work,'written_contents'),value,display:value+' 次复制与引用',subtitle:author?'作者：'+author:'佚名',detail:'复制：'+copies+' 次；被其他作品引用：'+references+' 次'});if(entries.length>10)entries.pop();
    }
    aggregates.records.entries.most_copied_works=entries;
    aggregates.copiedWorksVersion=COPIED_WORKS_VERSION;
  }
  async function copiedWorks(world,aggregates,options={}){
    if(aggregates.copiedWorksVersion===COPIED_WORKS_VERSION)return civilizationRaces(world,aggregates,options);
    options.progress?.({phase:'copied-works',message:'正在更新书籍复制与引用排行…'});
    const works=[],artifacts=[];
    await scan(world,'written_contents',header=>{works.push(header);},{signal:options.signal});
    await scan(world,'artifacts',header=>{artifacts.push(header);},{signal:options.signal});
    const metrics=global.LegendsData.writtenWorkMetrics(works,artifacts);
    await scan(world,'events',header=>metrics.addCopy(header),{signal:options.signal,rawOnly:true});
    check(options.signal);copiedWorkRecords(aggregates,works,metrics);
    if(world.disk)await saveDerived(world,aggregates);
    return civilizationRaces(world,aggregates,options);
  }
  async function civilizationRaces(world,aggregates,options={}){
    if(aggregates.civilizationRacesVersion===CIVILIZATION_RACES_VERSION)return world.disk?applyAnalytics(world,aggregates):aggregates;
    const entities=new Map(),civs=new Set(list(aggregates.civilizations).map(Number));
    for(const [id,facts]of Object.entries(aggregates.entityFacts||{}))if(civs.has(Number(id))||facts.IsCiv||facts.is_civ)entities.set(Number(id),{...facts,IsCiv:true});
    for(const entity of world.entities||[])if(civs.has(Number(entity.id))||entity.IsCiv||entity.is_civ){const facts=entities.get(Number(entity.id));entities.set(Number(entity.id),{...entity,...facts,IsCiv:true});}
    if([...entities.values()].some(entity=>unknownRace(entity.race))){
      options.progress?.({phase:'civilization-races',message:'正在补齐文明种族…'});
      // This visits small retained index headers only, never source XML/events.
      await scan(world,'figures',header=>inheritCivilizationRace(header,entities),{signal:options.signal});
    }
    check(options.signal);if(!aggregates.entityFacts)aggregates.entityFacts=dictionary();
    for(const [id,entity]of entities)if(!unknownRace(entity.race)){const facts=aggregates.entityFacts[id]||(aggregates.entityFacts[id]={IsCiv:true,is_civ:true});facts.race=entity.race;}
    aggregates.civilizationRacesVersion=CIVILIZATION_RACES_VERSION;
    if(world.disk)await saveDerived(world,aggregates);
    return applyAnalytics(world,aggregates);
  }
  const analyticGroup=kind=>own(aliases,kind)?'collections':extras[kind]||kind;
  const countTable=()=>dictionary();
  function metricRead(aggregates,group,key,id){const table=aggregates?.counts?.[group]?.[key],chunk=table?.[Math.floor(Number(id)/4096)];return chunk?Number(chunk[Number(id)%4096]):0;}
  function metricSet(aggregates,group,key,id,value){if(!Number.isSafeInteger(Number(id))||id<0)return;const groupTables=aggregates.counts[group]||(aggregates.counts[group]=dictionary()),table=groupTables[key]||(groupTables[key]=countTable()),index=Math.floor(id/4096),chunk=table[index]||(table[index]=new Float64Array(4096));chunk[id%4096]=Number(value)||0;}
  function metricAdd(aggregates,group,key,id,value=1){metricSet(aggregates,group,key,id,metricRead(aggregates,group,key,id)+value);}
  const finiteId=value=>value!==undefined&&value!==null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
  function factId(header,...keys){for(const key of keys){const value=finiteId(header[key]);if(value!==null)return value;}return null;}
  function roleId(header,kind,...keys){const direct=factId(header,...keys);if(direct!==null)return direct;for(const ref of list(header.refs))if(ref.kind===kind&&keys.some(key=>ref.key===key||list(ref.keys).includes(key)))return finiteId(ref.id);return null;}
  function coords(value){return String(value||'').split('|').map(tile=>tile.trim().split(',').map(Number)).filter(tile=>tile.length>=2&&tile.every(Number.isFinite));}
  function isFlag(record,...keys){return keys.some(key=>record[key]!==undefined&&record[key]!==false&&!['false','0'].includes(fold(record[key])));}
  function isCiv(header){return header.IsCiv===true;}
  function metrics(world,kind,record){
    const group=analyticGroup(kind),a=world.disk?.aggregates||world.aggregates,id=Number(record.id),result={};if(!a||a.version!==ANALYTICS_VERSION)return result;
    if(['regions','underground_regions','world_constructions'].includes(group)){result.squareTiles=number(record.square_tiles)??coords(record.coords).length;result.square_tiles=result.squareTiles;}
    if(group==='world_constructions')Object.assign(result,a.constructionFacts?.[id]||{});
    if(group==='mountain_peaks'){result.heightMeter=Number(record.height)*3;result.region_id=a.geographyRegions?.[group]?.[id]??record.region_id;}
    if(group==='sites'&&a.geographyRegions?.sites?.[id]!==undefined){result.region_id=a.geographyRegions.sites[id];result.regionType=(world.regions||[]).find(region=>Number(region.id)===result.region_id)?.type||'';}
    if(group==='entities'){Object.assign(result,a.entityFacts?.[id]||{});result.IsCiv=result.is_civ=a.civilizations?.includes(id)||false;if(result.IsCiv&&!record.type)result.type='civilization';}
    if(group==='written_contents'){result.author_hfid=record.author_hfid??record.author??record.author_id;result.HasArtifact=metricRead(a,group,'hasArtifact',id)>0;}
    if(record.squad_races){result.squad_deaths={};for(const [race,counts]of Object.entries(record.squad_races))result.squad_deaths[race]=(Number(counts.attacking_deaths)||0)+(Number(counts.defending_deaths)||0);result.squadDeaths=result.squad_deaths;}
    if(a.completeGroups.includes(group)){const roles=sourceRoleCache.get(world);result.eventCount=metricRead(a,group,'eventCount',id)+(roles?lookupList(roles.extraEventsByObject[group],id).length:0);result.EventCount=result.eventCount;result.eventCollectionCount=roles?lookupList(roles.rolesByObject[group],id).length:metricRead(a,group,'eventCollectionCount',id);result.EventCollectionCount=result.eventCollectionCount;}
    if(group==='eras'&&sourceRoleCache.has(world)){result.end_year=eraEnd(record,world);result.eventCount=result.EventCount=0;for(const years of Object.values(world.disk.eventYears||{}))for(const [year,count]of Object.entries(years))if(Number(year)>=Number(record.start_year)&&Number(year)<=result.end_year)result.eventCount+=Number(count);result.EventCount=result.eventCount;}
    const fields=a.counts[group]||{};for(const key of Object.keys(fields))if(!['eventCount','eventCollectionCount'].includes(key)){const value=metricRead(a,group,key,id);result[key]=value;result[key[0].toUpperCase()+key.slice(1)]=value;result[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())]=value;}
    if(group==='figures'){
      result.IsDeity=isFlag(record,'deity','is_deity');
      if(list(record.active_interaction).length||world.sourceFiles?.some(file=>/plus/i.test(typeof file==='string'?file:file.name))){const interactions=list(record.active_interaction).map(value=>String(value).toUpperCase());result.IsVampire=interactions.some(value=>/VAMPIRE|DEITY_MAJOR_CURSE/.test(value));result.IsWerebeast=interactions.some(value=>value.includes('WEREBEAST'));result.IsNecromancer=interactions.some(value=>value.includes('SECRET')&&!/ANIMATE|UNDEAD_RES/.test(value));}
      const death=a.figureDeaths[id],birth=number(record.birth_year),end=death??number(record.death_year);
      if(death!==undefined){result.death_year=death;result.DeathYear=death;}
      if(end!==null){result.IsAlive=end===-1;result.is_alive=result.IsAlive;}
      if(birth!==null&&birth!==-1&&end!==null){result.Age=(end===-1?a.currentYear:end)-birth;result.age=result.Age;}
    }
    if(group==='sites'){
      const ownership=a.siteOwnership[id];if(ownership){result.cur_owner_id=ownership.owner??-1;result.civ_id=ownership.civ??-1;result.IsOccupied=ownership.owner!==null;result.owner_history=ownership.history;}
      result.StructureCount=metricRead(a,'sites','structureCount',id);result.HasStructures=result.StructureCount>0;
    }
    if(group==='entities'){result.CurrentSitesCount=metricRead(a,group,'currentSitesCount',id);result.HasCurrentSites=result.CurrentSitesCount>0;result.WarCount=metricRead(a,group,'warCount',id);}
    if(group==='regions'||group==='underground_regions'){result.SiteCount=metricRead(a,group,'siteCount',id);result.HasSites=result.SiteCount>0;result.BattleCount=metricRead(a,group,'battleCount',id);}
    if(group==='collections'){
      result.IsOngoing=Number(record.end_year)===-1;result.Length=(result.IsOngoing?a.currentYear:Number(record.end_year))-Number(record.start_year);
      const map={attackerCount:'AttackerCount',defenderCount:'DefenderCount',attackerDeathCount:'AttackerDeathCount',defenderDeathCount:'DefenderDeathCount',deathCount:'DeathCount',battleCount:'BattleCount',sitesLostCount:'SitesLostCount'};for(const [key,title]of Object.entries(map))result[title]=metricRead(a,group,key,id);
      result.attacker_enid=a.collectionSides?.[id]?.attacker??record.attacking_enid??record.attacker_ent_id??record.aggressor_ent_id;result.defender_enid=a.collectionSides?.[id]?.defender??record.defending_enid??record.defender_ent_id;
      result.HasMercenaries=['individual_merc','company_merc'].some(key=>isFlag(record,key))||['attacking_merc_enid','defending_merc_enid','a_support_merc_enid','d_support_merc_enid','a_support_merc_hfid','d_support_merc_hfid'].some(key=>list(record[key]).some(value=>finiteId(value)!==null));result.HasUndeadSquads=['attacking_squad_animated','defending_squad_animated'].some(key=>list(record[key]).some(value=>value!==false&&!['0','false'].includes(fold(value))));result.HasNotableDefenders=list(record.defending_hfid).some(value=>finiteId(value)!==null);
      result.AttackerDeaths=result.AttackerDeathCount;result.DefenderDeaths=result.DefenderDeathCount;result.TotalDeaths=result.DeathCount;
    }
    return result;
  }
  function enrich(world,kind,record){const group=analyticGroup(kind),patch=sourceRoleCache.get(world)?.eventPatches?.[record.id];if(group==='events'&&patch)for(const [key,value]of Object.entries(patch))if(finiteId(record[key])===null)record[key]=value;Object.assign(record,metrics(world,kind,record));return record;}
  async function refreshFacts(world,options={}){
    if(!world.disk||Number(world.disk?.factsVersion||world.factsVersion)>=3)return world;
    const files=await Promise.all((world.disk.fileInfo||[]).map((info,index)=>/\.xml$/i.test(info.name||'')?getSource(world,index,options):new File([],info.name||'image'))),importId=world.disk.id+'-facts-'+Date.now();
    options.onImportId?.(importId);const session=await createImport({id:importId,files});
    try{const metadata=await global.LegendsFileIndexer.indexFiles(files,{signal:options.signal,onBlock:session.writeBlock,onMetadata:session.metadata,progress:progress=>options.progress?.({...progress,phase:'facts',message:'正在补齐统计索引…'})});const replacement=await session.finish(metadata);const disk=replacement.disk;disk.sourceId=world.disk.sourceId||world.disk.id;disk.sourceDbName=world.disk.sourceDbName||world.disk.dbName||LEGACY_DATABASE;disk.sourcesPersisted=world.disk.sourcesPersisted!==false;for(const key of groups)world[key]=replacement[key];world.extra=replacement.extra;world.disk=disk;world.factsVersion=3;return world;}catch(error){await session.abort();throw error;}
  }
  async function calculateAnalytics(world,options={}){
    await refreshFacts(world,options);check(options.signal);
    const aggregates={version:ANALYTICS_VERSION,currentYear:Number(world.year)||0,counts:dictionary(),completeGroups:world.disk?Object.keys(world.disk.counts):[...groups,...Object.keys(world.extra||{}),'structures'],siteOwnership:dictionary(),positionsByFigure:dictionary(),figureExistence:dictionary(),populationMembers:dictionary(),figureDeaths:dictionary(),records:{entries:dictionary()},authorNames:dictionary(),geographyRegions:{sites:dictionary(),mountain_peaks:dictionary()},structureLookup:dictionary(),constructionFacts:dictionary(),entityFacts:dictionary(),writtenArtifacts:dictionary(),civilizations:[],collectionSides:dictionary(),playerRelatedObjects:[]};
    const figures=new Map(),entities=new Map(),sites=new Map(),artifacts=new Map(),works=new Map(),collections=new Map(),regions=new Map((world.regions||[]).map(record=>[Number(record.id),record])),geoGrid=new Map(),deaths=new Map(),eventExists=(()=>{const chunks=new Map();return{add(id){const block=Math.floor(id/4096);let bits=chunks.get(block);if(!bits)chunks.set(block,bits=new Uint32Array(128));const offset=id%4096;bits[offset>>>5]|=1<<(offset&31);},has(id){const bits=chunks.get(Math.floor(id/4096)),offset=id%4096;return Boolean(bits&&(bits[offset>>>5]&(1<<(offset&31))));}};})(),thiefEvents=[],ownershipEvents=[],positionEvents=[],crimeEvents=[],identityCounts=new Map();
    let maxRawEventId=-1;const virtual={figures:[],segments:{starts:[],counts:[],battles:[],years:[],seconds:[],flags:[],sites:[],regions:[],layers:[]}},virtualYears=dictionary();
    const report=(phase,percent)=>options.progress?.({phase,percent,message:'正在计算世界纪录和统计…'});
    for(const region of regions.values())for(const xy of coords(region.coords))geoGrid.set(xy[0]+','+xy[1],region.id);
    const regionId=header=>{const explicit=factId(header,'subregion_id','region_id');if(explicit!==null&&regions.has(explicit))return explicit;const site=sites.get(factId(header,'site_id','site'));if(site){const point=coords(site.coords)[0];if(point)return geoGrid.get(point[0]+','+point[1])??null;}const point=coords(header.coords)[0];return point?geoGrid.get(point[0]+','+point[1])??null:null;};
    const figureFields=['id','name','translated_name','name_string','title','race','caste','birth_year','death_year','sex','active_interaction','sphere','used_identity_id','entity_link','best_skill','deity','is_deity','force','profession','adventurer','player','is_player','ent_pop_id'];
    const collect=async(group,target)=>scan(world,group,header=>{let value=header;if(group==='figures'){value={};for(const key of figureFields)if(header[key]!==undefined)value[key]=header[key];const positionIds=civilizationPositionIds(header);if(positionIds.size)value.civRacePositionIds=[...positionIds];if(value.entity_link)value.entity_link=list(value.entity_link).slice(0,1);if(!value.best_skill&&header.hf_skill)value.best_skill=[...list(header.hf_skill)].sort((a,b)=>(Number(b.total_ip)||0)-(Number(a.total_ip)||0))[0];}target.set(Number(header.id),value);},{signal:options.signal});
    await collect('figures',figures);report('figures',8);await collect('entities',entities);await collect('sites',sites);await collect('artifacts',artifacts);await collect('written_contents',works);await collect('collections',collections);report('objects',20);
    const writtenMetrics=global.LegendsData.writtenWorkMetrics(works.values(),artifacts.values());
    for(const id of figures.keys()){const block=Math.floor(id/4096),bits=aggregates.figureExistence[block]||(aggregates.figureExistence[block]=new Uint32Array(128)),offset=id%4096;bits[offset>>>5]|=1<<(offset&31);}
    for(const figure of figures.values()){const population=factId(figure,'ent_pop_id');if(population!==null)aggregates.populationMembers[population]=(aggregates.populationMembers[population]||0)+1;}
    const known={figures,entities,sites,artifacts,written_contents:works,collections,regions},civCandidates=new Set([...entities.values()].filter(header=>fold(header.type)==='civilization').map(header=>header.id)),civilizations=new Set(),forcedCivs=new Set(),playerObjects=new Map(),battleSides=new Map();
    const candidateCiv=id=>{const entity=entities.get(id);if(entity){entity.type='civilization';civCandidates.add(id);}};
    const forceCiv=id=>{if(entities.has(id)){candidateCiv(id);forcedCivs.add(id);}};
    for(const figure of figures.values())if(isFlag(figure,'adventurer','player','is_player'))playerObjects.set('figures:'+figure.id,{kind:'figures',id:figure.id});
    const valid=(group,id)=>id!==null&&id>=0&&(known[group]?known[group].has(id):true);
    const add=(group,key,id,n=1)=>{if(valid(group,id))metricAdd(aggregates,group,key,id,n);};
    const parentOf=new Map();for(const entity of entities.values()){const parent=factId(entity,'parentEntity','parentEntityId')??finiteId(list(entity.entity_link).find(link=>fold(link.type||link.link_type)==='parent')?.target);if(parent!==null)parentOf.set(entity.id,parent);}
    for(const header of sites.values()){const region=regionId(header);if(region!==null){add('regions','siteCount',region);aggregates.geographyRegions.sites[header.id]=region;}if(header.structure_count!==undefined)metricSet(aggregates,'sites','structureCount',header.id,header.structure_count);}
    await scan(world,'structures',header=>{aggregates.structureLookup[header.site_id+':'+header.local_id]=header.id;if(!sites.get(header.site_id)?.structure_count)add('sites','structureCount',finiteId(header.site_id));},{signal:options.signal});
    // ResolveEntityToEntityPopulation sets EntityType and Race, not IsCiv.
    await scan(world,'entity_populations',header=>{const id=factId(header,'civ_id','entity_id');if(entities.has(id)){candidateCiv(id);entities.get(id).race=header.race?String(header.race).split(':')[0]:'unknown';}},{signal:options.signal});
    // Occasion constructors explicitly force IsCiv even when Name is absent.
    // ResolveEntityIsMainCiv does the same for unknown-race theft attackers.
    for(const header of collections.values()){
      if(fold(header.type)==='occasion')forceCiv(factId(header,'civ_id'));
      if(fold(header.type)==='theft'){const id=factId(header,'attacking_enid'),entity=entities.get(id);if(entity&&(!String(entity.race||'').trim()||fold(entity.race)==='unknown')){forceCiv(id);entity.race='kobold';}}
    }
    await scan(world,'identities',header=>{const id=factId(header,'histfig_id','nemesis_id');if(id!==null)identityCounts.set(id,(identityCounts.get(id)||0)+1);},{signal:options.signal});
    const victim=header=>roleId(header,'figures','hfid','victim_hf','hf_id','histfig_id','historical_figure_id');
    const killer=header=>roleId(header,'figures','slayer_hfid','slayer_hf');
    await scan(world,'events',header=>{
      const id=Number(header.id),type=fold(header.type);eventExists.add(id);maxRawEventId=Math.max(maxRawEventId,id);
      writtenMetrics.addCopy(header);
      if(['created site','reclaim site'].includes(type)){const civ=factId(header,'civ_id');if(entities.has(civ)&&(!entities.get(civ).type||fold(entities.get(civ).type)==='unknown'))candidateCiv(civ);}
      if(['procession','ceremony','performance','competition'].includes(type))forceCiv(factId(header,'civ_id'));
      if(type==='created world construction'){const construction=factId(header,'wcid'),master=factId(header,'master_wcid');if(construction!==null){const facts=aggregates.constructionFacts[construction]||(aggregates.constructionFacts[construction]={});if(master!==null)facts.master_construction_id=master;for(const key of ['site_id1','site_id2'])if(factId(header,key)!==null)facts[key]=factId(header,key);}}
      if(type==='field battle'||type==='attacked site')battleSides.set(id,{attacker:factId(header,'attacker_civ_id','attacker_id','attacker_enid'),defender:factId(header,'defender_civ_id','defender_id','defender_enid')});
      if(['site retired','site abandoned','site died'].includes(type))for(const ref of list(header.refs))if(['sites','entities'].includes(ref.kind)&&['site_id','site_civ_id'].some(key=>ref.key===key||list(ref.keys).includes(key)))playerObjects.set(ref.kind+':'+ref.id,{kind:ref.kind,id:ref.id});aggregates.currentYear=Math.max(aggregates.currentYear,Number(header.year)||0);
      const seen=new Set();for(const ref of list(header.refs)){const group=analyticGroup(ref.kind),token=group+':'+ref.id;if(!seen.has(token)){seen.add(token);add(group,'eventCount',finiteId(ref.id));}}
      for(const [siteKey,structureKey]of[['site_id','structure_id'],['site_id','structure'],['site_id','structure_local_id'],['source_site_id','source_structure_id'],['dest_site_id','dest_structure_id']]){const site=factId(header,siteKey),local=factId(header,structureKey),globalId=aggregates.structureLookup?.[site+':'+local];if(globalId!==undefined)add('structures','eventCount',globalId);}
      if(type==='hf died'){
        const dead=victim(header),slayer=killer(header);deaths.set(id,{id,year:Number(header.year),victim:dead,killer:slayer});if(valid('figures',slayer))add('figures','notableKills',slayer);
        if(valid('figures',dead)&&Number(figures.get(dead).death_year)===-1&&aggregates.figureDeaths[dead]===undefined)aggregates.figureDeaths[dead]=Number(header.year);
      }
      if(type==='knowledge discovered')add('figures','discoveries',roleId(header,'figures','hfid'));
      if(type==='hf travel')add('figures','travels',roleId(header,'figures','group_hfid'));
      if(type==='created site'||type==='site taken over')add('sites','conquests',factId(header,'site_id'));
      if(['created site','site taken over','destroyed site','reclaim site','site abandoned','site died'].includes(type))ownershipEvents.push(header);
      if(type==='add hf entity link'||type==='remove hf entity link')positionEvents.push(header);
      if(type==='item stolen')thiefEvents.push(header);
      if(type==='failed intrigue corruption'||type==='hfs formed intrigue relationship')crimeEvents.push(header);
    },{signal:options.signal,rawOnly:true,figureExists:id=>figures.has(Number(id))});
    for(const entity of entities.values()){
      const named=entity.__sourceNamed??(typeof entity.name==='string'&&Boolean(entity.name.trim()));
      entity.IsCiv=forcedCivs.has(entity.id)||(civCandidates.has(entity.id)&&named);
      if(entity.IsCiv)civilizations.add(entity.id);
    }
    for(const figure of figures.values())inheritCivilizationRace(figure,entities);
    aggregates.civilizationRacesVersion=CIVILIZATION_RACES_VERSION;
    aggregates.civilizations=[...civilizations];aggregates.playerRelatedObjects=[...playerObjects.values()];report('events',48);
    for(const work of works.values()){const author=factId(work,'author_hfid','author','author_id');add('figures','writtenWorks',author);if(figures.has(author))aggregates.authorNames[author]=figures.get(author).name;}
    // A book's events are those attached to its artifact in the upstream model.
    for(const artifact of artifacts.values()){const contentIds=new Set([...list(artifact.written_content_id),...list(artifact.writing_written_content_id),...list(artifact.page_written_content_id),...list(artifact.item?.writing_written_content_id),...list(artifact.item?.page_written_content_id),...list(artifact.refs).filter(ref=>analyticGroup(ref.kind)==='written_contents').map(ref=>ref.id)].map(Number));for(const id of contentIds)if(works.has(id)){metricAdd(aggregates,'written_contents','eventCount',id,metricRead(aggregates,'artifacts','eventCount',artifact.id));metricSet(aggregates,'written_contents','hasArtifact',id,1);const ids=aggregates.writtenArtifacts[id]||(aggregates.writtenArtifacts[id]=[]);if(!ids.includes(artifact.id))ids.push(artifact.id);}}
    const reverse=new Map();for(const collection of collections.values()){for(const key of ['parent_eventcol','war_eventcol']){const parent=factId(collection,key);if(parent!==null){let set=reverse.get(parent);if(!set)reverse.set(parent,set=new Set());set.add(collection.id);}}}
    const childrenOf=header=>new Set([...members(header,'children','eventcol'),...(reverse.get(header.id)||[])].map(Number).filter(id=>collections.has(id)));
    const allEventCache=new Map(),active=new Set();
    const subEvents=header=>{if(allEventCache.has(header.id))return allEventCache.get(header.id);if(active.has(header.id))return new Set();active.add(header.id);const ids=new Set([...members(header,'events','event')].map(Number).filter(id=>eventExists.has(id)));for(const child of childrenOf(header))for(const event of subEvents(collections.get(child)))ids.add(event);active.delete(header.id);if(childrenOf(header).size)allEventCache.set(header.id,ids);return ids;};
    const theftEventIds=new Set();
    for(const header of collections.values()){
      const id=Number(header.id),type=fold(header.type),direct=[...members(header,'events','event')].map(Number).filter(id=>eventExists.has(id)),children=childrenOf(header);
      metricSet(aggregates,'collections','eventCount',id,direct.length);metricSet(aggregates,'collections','eventCollectionCount',id,children.size);
      if(type==='theft')for(const event of direct)theftEventIds.add(event);
      const refs=new Set();for(const ref of list(header.refs)){const group=analyticGroup(ref.kind),token=group+':'+ref.id;if(!refs.has(token)){refs.add(token);add(group,'eventCollectionCount',finiteId(ref.id));}}
      if(type==='battle'){
        let inferred;for(const event of direct){const sides=battleSides.get(event);if(sides&&(sides.attacker!==null||sides.defender!==null)){inferred=sides;break;}}aggregates.collectionSides[id]={attacker:factId(header,'attacking_enid','attacker_ent_id')??inferred?.attacker??null,defender:factId(header,'defending_enid','defender_ent_id')??inferred?.defender??null};for(const entity of new Set(Object.values(aggregates.collectionSides[id])))if(!refs.has('entities:'+entity))add('entities','eventCollectionCount',entity);
        for(const [key,flags]of [['attacking_hfid',1],['defending_hfid',0],['a_support_merc_hfid',7],['d_support_merc_hfid',6]]){
          const ids=list(header[key]).map(Number).filter(id=>figures.has(id));if(!ids.length)continue;const columns=virtual.segments,year=Number(header.start_year??header.year)||0;
          columns.starts.push(virtual.figures.length);columns.counts.push(ids.length);columns.battles.push(id);columns.years.push(year);columns.seconds.push(Number(header.start_seconds72)||0);columns.flags.push(flags);columns.sites.push(factId(header,'site_id')??-1);columns.regions.push(regionId(header)??-1);columns.layers.push(factId(header,'feature_layer_id')??-1);
          for(const figure of ids){virtual.figures.push(figure);add('figures','eventCount',figure);}virtualYears[year]=(virtualYears[year]||0)+ids.length;
        }
        const attackers=new Set(list(header.attacking_hfid).map(Number).filter(id=>figures.has(id))),defenders=new Set(list(header.defending_hfid).map(Number).filter(id=>figures.has(id)));
        for(const hf of new Set([...attackers,...defenders,...list(header.a_support_merc_hfid).map(Number),...list(header.d_support_merc_hfid).map(Number)]))if(figures.has(hf))add('figures','eventCollectionCount',hf);
        let attackerDeaths=Number(header.attacking_squad_deaths_sum)||0,defenderDeaths=Number(header.defending_squad_deaths_sum)||0;
        for(const event of direct){const death=deaths.get(event);if(death&&attackers.has(death.victim))attackerDeaths++;if(death&&defenders.has(death.victim))defenderDeaths++;}
        metricSet(aggregates,'collections','attackerCount',id,(Number(header.attacking_squad_number_sum)||0)+attackers.size);metricSet(aggregates,'collections','defenderCount',id,(Number(header.defending_squad_number_sum)||0)+defenders.size);
        metricSet(aggregates,'collections','attackerDeathCount',id,attackerDeaths);metricSet(aggregates,'collections','defenderDeathCount',id,defenderDeaths);metricSet(aggregates,'collections','deathCount',id,attackerDeaths+defenderDeaths);
        const region=regionId(header);if(region!==null)add('regions','battleCount',region);add('sites','battleCount',factId(header,'site_id'));add('underground_regions','battleCount',factId(header,'feature_layer_id'));
      }
      if(type==='duel')for(const event of subEvents(header)){const death=deaths.get(event);if(death)add('figures','duelVictories',death.killer);}
      if(type==='beast attack'){let total=0;for(const event of subEvents(header))if(deaths.has(event)&&figures.has(deaths.get(event).victim))total++;metricSet(aggregates,'collections','deathCount',id,total);metricSet(aggregates,'collections','subEventCount',id,subEvents(header).size);}
      if(type==='theft'||type==='abduction')add('entities','crimes',factId(header,'attacking_enid','attacker_ent_id','aggressor_ent_id'));
    }
    for(const war of collections.values())if(fold(war.type)==='war'){
      const attacker=factId(war,'aggressor_ent_id','attacker_ent_id','attacking_enid'),defender=factId(war,'defender_ent_id','defending_enid');add('entities','warCount',attacker);add('entities','warCount',defender);
      let a=0,d=0,battles=0;const lost=new Set();for(const child of childrenOf(war)){const header=collections.get(child),type=fold(header.type);if(type==='battle'){battles++;const ca=metricRead(aggregates,'collections','attackerDeathCount',child),cd=metricRead(aggregates,'collections','defenderDeathCount',child);if((aggregates.collectionSides[child]?.attacker??factId(header,'attacking_enid','attacker_ent_id'))===attacker){a+=ca;d+=cd;}else{a+=cd;d+=ca;}}if(type==='site conquered'||type==='site conquering'){const site=factId(header,'site_id');if(site!==null)lost.add(site);}}
      metricSet(aggregates,'collections','attackerDeathCount',war.id,a);metricSet(aggregates,'collections','defenderDeathCount',war.id,d);metricSet(aggregates,'collections','deathCount',war.id,a+d);metricSet(aggregates,'collections','battleCount',war.id,battles);metricSet(aggregates,'collections','sitesLostCount',war.id,lost.size);metricSet(aggregates,'collections','subEventCount',war.id,subEvents(war).size);
    }
    const virtualSegments={};for(const [key,values]of Object.entries(virtual.segments))virtualSegments[key]=key==='flags'?Uint8Array.from(values):['years','seconds','sites','regions','layers'].includes(key)?Int32Array.from(values):Uint32Array.from(values);
    aggregates.virtualEvents={startId:maxRawEventId+1,count:virtual.figures.length,figures:Uint32Array.from(virtual.figures),segments:virtualSegments};aggregates.virtualEventYears=virtualYears;
    report('collections',68);
    function parent(entity,parent){if(entity!==null&&parent!==null&&entities.has(entity)&&entities.has(parent))parentOf.set(entity,parent);}
    function ownership(site){return aggregates.siteOwnership[site]||(aggregates.siteOwnership[site]={owner:null,civ:null,history:[]});}
    const addPeriod=(site,owner,year,cause,event)=>{const state=ownership(site),period={owner:owner??null,start:year,end:-1,cause,eventId:event.id,founder:factId(event,'builder_hfid')};if(!state.history.some(item=>item.owner===period.owner&&item.start===year&&item.cause===cause))state.history.push(period);};
    for(const event of ownershipEvents){const site=factId(event,'site_id'),state=site===null?null:ownership(site);if(!state)continue;const type=fold(event.type),year=Number(event.year),last=state.history.at(-1),civ=factId(event,'civ_id'),siteEntity=factId(event,'site_civ_id');
      if(type==='created site'){const resident=factId(event,'resident_civ_id');if(resident!==null)addPeriod(site,resident,year,'constructed',event);else if(siteEntity!==null){parent(siteEntity,civ);addPeriod(site,siteEntity,year,'founded',event);}else if(civ!==null)addPeriod(site,civ,year,'founded',event);}
      else if(type==='site taken over'){const attacker=factId(event,'attacker_civ_id'),defender=factId(event,'defender_civ_id'),next=factId(event,'new_site_civ_id');if(!last&&siteEntity!==null){parent(siteEntity,defender);addPeriod(site,siteEntity,-1,'founded',event);}const previous=state.history.at(-1);if(previous){previous.end=year;previous.endCause='taken over';previous.ender=attacker;}parent(next,attacker);addPeriod(site,next,year,'took over',event);}
      else if(type==='reclaim site'){parent(siteEntity,civ);if(last&&last.end===-1){last.end=year-1===0?-1:year-1;last.endCause='abandoned';}addPeriod(site,siteEntity,year,'reclaimed',event);}
      else {if(!last&&siteEntity!==null)addPeriod(site,siteEntity,-1,'founded',event);const previous=state.history.at(-1);if(previous){previous.end=year;previous.endCause=type==='destroyed site'?'destroyed':type==='site abandoned'?'abandoned':'died';}}
    }
    for(const site of sites.values()){
      const state=ownership(site.id),open=state.history.find(period=>period.end===-1);let owner=open?open.owner:finiteId(site.cur_owner_id);if(state.history.length&&!open)owner=null;state.owner=owner;
      let candidate=owner;const visited=new Set();while(candidate!==null&&entities.has(candidate)&&!visited.has(candidate)){visited.add(candidate);if(isCiv(entities.get(candidate))){state.civ=candidate;break;}candidate=parentOf.get(candidate)??null;}
      for(const entity of visited)add('entities','currentSitesCount',entity);
      for(const period of state.history){let candidate=period.owner,seen=new Set();while(candidate!==null&&entities.has(candidate)&&!seen.has(candidate)){seen.add(candidate);add('entities','siteHistoryCount',candidate);if(isCiv(entities.get(candidate)))break;candidate=parentOf.get(candidate)??null;}}
    }
    for(const event of positionEvents){const hf=roleId(event,'figures','hfid','histfig'),entity=factId(event,'civ_id','civ'),position=factId(event,'position_id'),year=number(event.year);if(!figures.has(hf)||position===null||year===null)continue;const list=aggregates.positionsByFigure[hf]||(aggregates.positionsByFigure[hf]=[]),type=fold(event.type),title=String(event.position||'');if(type==='add hf entity link'&&fold(event.link_type??event.link)==='position'){if(!list.some(item=>item.entityId===entity&&item.title===title&&item.start===year))list.push({entityId:entity,positionId:position,title,start:year,end:null});}else if(type==='remove hf entity link'){const previous=[...list].reverse().find(item=>item.entityId===entity&&item.positionId===position);if(previous)previous.end=year;}}
    for(const header of entities.values()){const facts={IsCiv:header.IsCiv,is_civ:header.IsCiv};if(header.race)facts.race=header.race;const parent=parentOf.get(header.id);if(parent!==undefined){facts.parentEntity=parent;facts.parentEntityId=parent;if(!header.entity_link)facts.entity_link=[{type:'PARENT',target:parent}];}if(civCandidates.has(header.id))facts.type='civilization';aggregates.entityFacts[header.id]=facts;}
    const perpetrator=hf=>{const position=aggregates.positionsByFigure[hf]?.find(item=>entities.has(item.entityId));if(position)return position.entityId;const figure=figures.get(hf);for(const link of list(figure?.entity_link)){const id=factId(link,'entity_id','entity','target');if(entities.has(id))return id;}return null;};
    for(const event of thiefEvents)if(!theftEventIds.has(event.id))add('entities','crimes',perpetrator(factId(event,'histfig','hfid')));
    for(const event of crimeEvents)add('entities','crimes',perpetrator(factId(event,'corruptor_hfid')));
    report('ownership',80);
    const entries=aggregates.records.entries;
    const subtitle=header=>{const parts=[],interactions=list(header.active_interaction).map(String);if(interactions.some(s=>/VAMPIRE|DEITY_MAJOR_CURSE/.test(s)))parts.push('吸血鬼');else if(interactions.some(s=>/SECRET/.test(s)&&!/ANIMATE|UNDEAD_RES/.test(s)))parts.push('死灵法师');else if(isFlag(header,'deity','is_deity'))parts.push('神祇');else if(isFlag(header,'force'))parts.push('自然之力');const position=aggregates.positionsByFigure[header.id]?.[0];if(position?.title)parts.push(position.title);if(list(header.sphere).length)parts.push('领域：'+list(header.sphere).join('、'));return parts.join(' • ');};
    function ranked(key,kind,header,value,display,sub='',detail='',extra={}){if(!Number.isFinite(value))return;const rows=entries[key]||(entries[key]=[]),entry={kind,id:Number(header.id),record:summary(header,analyticGroup(kind)),value,display,subtitle:sub,detail,...extra};let at=rows.findIndex(old=>key==='shortest_reigns'?value<old.value||value===old.value&&entry.id<old.id:key==='devastating_rampages'?extra.deathCount>old.deathCount||extra.deathCount===old.deathCount&&extra.eventCount>old.eventCount:value>old.value||key==='notorious_syndicates'&&value===old.value&&entry.id<old.id);if(at<0)at=rows.length;if(at<10){rows.splice(at,0,entry);if(rows.length>10)rows.pop();}}
    for(const header of figures.values()){
      for(const [metric,key,unit]of[['notableKills','top_slayers',' 次击杀'],['duelVictories','fiercest_duelists',' 次决斗获胜'],['discoveries','greatest_scholars',' 次发现'],['writtenWorks','prolific_authors',' 部作品'],['travels','most_travelled',' 次旅行']]){const value=metricRead(aggregates,'figures',metric,header.id);if(value>0)ranked(key,'figures',header,value,value+unit,subtitle(header));}
      const identities=Math.max(list(header.used_identity_id).length,identityCounts.get(header.id)||0);if(identities>0)ranked('masters_of_disguise','figures',header,identities,identities+' 个伪装身份',subtitle(header));
      const death=aggregates.figureDeaths[header.id]??number(header.death_year),birth=number(header.birth_year);if(death===-1&&birth!==null&&birth!==-1&&!isFlag(header,'deity','is_deity')){const age=aggregates.currentYear-birth;if(age>0)ranked('oldest_living','figures',header,age,age+' 岁',subtitle(header));}
      for(const position of aggregates.positionsByFigure[header.id]||[]){const entity=entities.get(position.entityId),definition=list(entity?.entity_position).find(item=>Number(item.id)===Number(position.positionId)),title=position.title||definition?.name||'',leader=position.positionId===0||Number(definition?.id)===0||/monarch|king|queen|emperor|empress|ruler|overlord|high priest|law-giver|lawgiver/i.test(title);if(!leader)continue;const end=position.end??(death!==null&&death!==-1?death:aggregates.currentYear),duration=end-position.start,sub=title+(entity?' · '+(entity.name||'#'+entity.id):'');if(duration>0)ranked('longest_reigns','figures',header,duration,duration+' 年',sub,'从 '+position.start+' 年至 '+end+' 年');if((position.end!==null||death!==null&&death!==-1)&&duration>=0)ranked('shortest_reigns','figures',header,duration,duration?duration+' 年':'不足 1 年',sub,'从 '+position.start+' 年至 '+end+' 年');}
    }
    for(const header of collections.values()){const type=fold(header.type);if(type==='battle'){const a=metricRead(aggregates,'collections','attackerDeathCount',header.id),d=metricRead(aggregates,'collections','defenderDeathCount',header.id),value=a+d;if(value>0){const attacker=entities.get(factId(header,'attacking_enid','attacker_ent_id')),defender=entities.get(factId(header,'defending_enid','defender_ent_id'));ranked('bloodiest_battles','battles',header,value,value+' 人死亡',(attacker?.name||'进攻方')+' 对 '+(defender?.name||'防守方'),'进攻方死亡：'+a+'，防守方死亡：'+d);}}if(type==='beast attack'){const death=metricRead(aggregates,'collections','deathCount',header.id),count=metricRead(aggregates,'collections','eventCount',header.id);ranked('devastating_rampages','rampages',header,death||count,death?death+' 次击杀':count+' 个事件',String(header.start_year)+' 年','',{deathCount:death,eventCount:count});}}
    for(const header of sites.values()){const value=metricRead(aggregates,'sites','conquests',header.id);if(value>0)ranked('contested_sites','sites',header,value,value+' 次征服',header.type||'');}
    for(const header of entities.values()){const sub=[header.type,header.race].filter(Boolean).join(' • '),value=metricRead(aggregates,'entities','siteHistoryCount',header.id);if(isCiv(header)&&value>0)ranked('largest_empires','entities',header,value,value+' 个地点',sub);const crime=metricRead(aggregates,'entities','crimes',header.id);if(crime>0)ranked('notorious_syndicates','entities',header,crime,crime+' 次犯罪',sub);}
    copiedWorkRecords(aggregates,works.values(),writtenMetrics);
    for(const header of artifacts.values()){const value=metricRead(aggregates,'artifacts','eventCount',header.id);if(value>0)ranked('oldest_artifacts','artifacts',header,value,value+' 个事件',header.item_subtype||header.item_type||header.type||'遗物');}
    for(const [group,kind,key]of[['regions','regions','largest_regions'],['underground_regions','undergroundregions','largest_underground_regions']])await scan(world,group,header=>{const value=coords(header.coords).length||Number(header.square_tiles)||0;if(value>0)ranked(key,kind,header,value,value+' 格',[header.type,header.evilness,header.depth===undefined?'':'深度 '+header.depth].filter(Boolean).join(' • '));if(group==='regions'){const battles=metricRead(aggregates,'regions','battleCount',header.id);if(battles>0)ranked('bloodiest_regions','regions',header,battles,battles+' 场战役',[header.type,header.evilness].filter(Boolean).join(' • '));}},{signal:options.signal});
    await scan(world,'rivers',header=>{const value=coords(header.path).length+coords(header.end_pos).length;if(value>0)ranked('longest_rivers','rivers',header,value,value+' 格','河流');},{signal:options.signal});
    const peaks=[];await scan(world,'mountain_peaks',header=>{if(number(header.height)!==null)peaks.push(header);},{signal:options.signal});peaks.sort((a,b)=>Number(b.height)-Number(a.height));peaks.forEach((header,index)=>{metricSet(aggregates,'mountain_peaks','worldRank',header.id,index+1);const region=regionId(header);if(region!==null)aggregates.geographyRegions.mountain_peaks[header.id]=region;ranked('highest_peaks','mountainpeaks',header,Number(header.height),Number(header.height)*3+' 米',isFlag(header,'is_volcano','volcano')?'火山':'山峰');});
    applyAnalytics(world,aggregates);for(const site of world.sites||[])Object.assign(site,metrics(world,'sites',site));for(const entity of world.entities||[])Object.assign(entity,metrics(world,'entities',entity));
    if(world.disk)await saveDerived(world,aggregates);report('complete',100);return aggregates;
  }
  function applyAnalytics(world,aggregates){
    if(world.disk){world.disk.aggregates=aggregates;const rawCount=world.disk.rawEventCount??world.disk.counts.events;world.disk.rawEventCount=rawCount;world.disk.counts.events=rawCount+(aggregates.virtualEvents?.count||0);if(!world.disk.eventYears)world.disk.eventYears={};world.disk.eventYears['battle fought']=aggregates.virtualEventYears||{};}else{world.aggregates=aggregates;world.events=(world.events||[]).filter(event=>!event.synthetic);for(let index=0;index<(aggregates.virtualEvents?.count||0);index++)world.events.push(normalized(virtualHeader(world,index),'events',aggregates.virtualEvents.startId+index));memoryCache.delete(world);}
    for(const group of ['sites','entities','regions'])for(const record of world[group]||[])enrich(world,group,record);
    for(const group of ['landmasses','mountain_peaks','rivers'])for(const record of world.extra?.[group]||[])global.LegendsData.normalizeGeography(record,group);
    for(const group of ['underground_regions','mountain_peaks','rivers'])for(const record of world.extra?.[group]||[])enrich(world,group,record);
    return aggregates;
  }
  function analyticsWorker(world,options){
    const source=global.LegendsData.workerSource+(global.LegendsLocalStore?.workerSource||'')+global.LegendsFileIndexer.workerSource+global.LegendsFastStore.workerSource+`
self.onmessage=async function(message){const world=message.data;const originalId=world.disk?.id;try{await LegendsFastStore.analytics(world,{progress:value=>postMessage({type:'progress',value}),onImportId:id=>postMessage({type:'import',id})});if(world.disk){const name=world.disk.dbName||'legends-file-index';await LegendsFastStore.putHandoff(world.disk.id,'analytics',world,name);postMessage({type:'complete',handoff:true,id:world.disk.id,name,replaced:world.disk.id!==originalId});}else postMessage({type:'complete',aggregates:world.aggregates});}catch(error){const details={};for(const key of ['sourceDbName','sourceId','fileNo','expectedName','expectedSize','worldId','importId','dbName','group','blockNo','storageStore','storageDb','storageKey'])if(error[key]!==undefined)details[key]=error[key];postMessage({type:'error',message:error.message,name:error.name,stack:error.stack,details});}};`;
    return new Promise((resolve,reject)=>{
      check(options.signal);const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));let worker,newId,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;worker?.terminate();URL.revokeObjectURL(url);options.signal?.removeEventListener('abort',abort);if(error){if(newId)abortImport(newId).catch(()=>{});reject(error);}else resolve(value);};
      const abort=()=>finish(abortError());
      try{worker=new Worker(url);worker.onmessage=async message=>{const data=message.data;try{if(data.handoff){const result=await takeHandoff(data.id,'analytics',data.name);if(settled)return;data.aggregates=result.disk.aggregates;if(data.replaced)data.replacement=result;}if(data.type==='progress')options.progress?.(data.value);else if(data.type==='import'){newId=data.id;options.onImportId?.(newId);}else if(data.type==='error'){const error=new Error(data.message);error.name=data.name;error.stack=data.stack;Object.assign(error,data.details||{});finish(error);}else if(data.type==='complete'){if(data.replacement){for(const key of groups)world[key]=data.replacement[key];world.extra=data.replacement.extra;world.disk=data.replacement.disk;world.factsVersion=3;}finish(null,applyAnalytics(world,data.aggregates));}}catch(error){finish(error);}};worker.onerror=event=>finish(new Error(event.message||'统计任务失败。'));options.signal?.addEventListener('abort',abort,{once:true});worker.postMessage(world);}catch(error){finish(error);}
    });
  }
  async function analytics(world,options={}){
    check(options.signal);
    if(world.disk&&world.disk.format!=='file-index')return world.disk.aggregates||null;
    if(analyticsTasks.has(world))return sharedRead(analyticsTasks,world,options.signal,()=>analytics(world,options));
    const task=(async()=>{
      const existing=world.disk?.aggregates||world.aggregates;
      if(existing?.version===ANALYTICS_VERSION)return copiedWorks(world,existing,options);
      const db=world.disk?await database(world.disk.dbName||CURRENT_DATABASE):null,cached=db&&db.objectStoreNames.contains('derived')?await readValue(db,'derived',world.disk.id,options):null;
      if(cached?.version===ANALYTICS_VERSION)return copiedWorks(world,cached.aggregates,options);
      return global.document&&global.Worker?analyticsWorker(world,options):calculateAnalytics(world,options);
    })();analyticsTasks.set(world,task);try{return await task;}finally{if(analyticsTasks.get(world)===task)analyticsTasks.delete(world);}
  }

  // Large worker results stay in IndexedDB. Only their identifier crosses IPC.
  async function putHandoff(id,stage,world,name=CURRENT_DATABASE){
    const value=await packValue({importId:id+':handoff:'+stage,world}),db=await database(name),tx=db.transaction('derived','readwrite'),saved=done(tx);
    tx.objectStore('derived').put(value);await saved;
  }
  async function removeMapSources(world){
    const disk=world.disk;if(disk?.format!=='file-index')return;
    const slots=new Set((disk.fileInfo||[]).flatMap((info,index)=>/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(info.name||'')?[index]:[]));if(!slots.size)return;
    const name=disk.sourceDbName||disk.dbName||LEGACY_DATABASE,id=disk.sourceId||disk.id,db=await database(name),tx=db.transaction('sources','readwrite'),saved=done(tx),store=tx.objectStore('sources'),request=store.openKeyCursor(IDBKeyRange.lowerBound([id]));
    request.onsuccess=()=>{const cursor=request.result;if(!cursor||cursor.key[0]!==id)return;const slot=Array.isArray(cursor.key[1])?cursor.key[1][0]:cursor.key[1];if(slots.has(slot))store.delete(cursor.primaryKey);cursor.continue();};await saved;
    for(const slot of slots){filesCache.delete(name+':'+id+':'+slot);for(const [key,buffer]of sourceChunks)if(key.startsWith(name+':'+id+':'+slot+':')){sourceChunks.delete(key);sourceChunkCacheBytes-=buffer.size??buffer.byteLength;}}
  }
  async function takeHandoff(id,stage,name=CURRENT_DATABASE){
    const key=id+':handoff:'+stage,db=await database(name),value=await readValue(db,'derived',key);
    if(!value?.world)throw new Error('导入结果不存在，请重新选择原 XML。');
    const tx=db.transaction('derived','readwrite'),saved=done(tx);tx.objectStore('derived').delete(key);await saved;return value.world;
  }
  async function clearOrphans(worlds,all=false){
    const listed=typeof indexedDB.databases==='function'?new Set((await indexedDB.databases()).map(row=>row.name)):null;
    let removed=0;
    for(const name of [CURRENT_DATABASE,LEGACY_DATABASE]){
      if(listed&&!listed.has(name))continue;
      const live=new Set();
      for(const world of worlds){const disk=world.disk;if(!disk||disk.format!=='file-index')continue;if((disk.dbName||LEGACY_DATABASE)===name)live.add(disk.id);if((disk.sourceDbName||disk.dbName||LEGACY_DATABASE)===name)live.add(disk.sourceId||disk.id);}
      const db=await database(name),stores=['sources','blocks','derived'].filter(store=>db.objectStoreNames.contains(store)),tx=db.transaction(stores,'readwrite'),saved=done(tx);
      for(const storeName of stores){const store=tx.objectStore(storeName);if(all){store.clear();continue;}const request=store.openKeyCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;const key=cursor.primaryKey,id=Array.isArray(key)?key[0]:String(key).replace(/:(?:relations-v1|sourceRoles-v1|handoff:.*)$/,'');if(!live.has(id)||storeName==='derived'&&String(key).includes(':handoff:')){store.delete(key);removed++;}cursor.continue();};}
      await saved;
    }
    if(all){filesCache.clear();fileReads.clear();sourceChunks.clear();sourceChunkReads.clear();sourceRangeReads.clear();blockCache.clear();blockReads.clear();sourceChunkCacheBytes=0;}
    return removed;
  }
  async function scanHeaders(world,kind,visit,options={}){const d=descriptor(world,kind);return scan(world,d.group,header=>!d.types||d.types.includes(fold(header.type))?visit(header):undefined,options);}
  const headerSummary=(header,kind,world)=>{const record=summary(header,world?descriptor(world,kind).group:(own(aliases,kind)?'collections':extras[kind]||kind));return world?enrich(world,kind,record):record;};
  const getHeaders=(world,kind,id,options)=>headersFor(world,kind,id,options);
  const api={database,putHandoff,takeHandoff,clearOrphans,removeMapSources,relationshipReferences,registerSourceFiles,rebindSourceFiles,persistSourceFiles,persistReboundSources,readSourceFile:getSource,repairBlock,createImport,abortImport,prepareSourceRoles,getRecord,query,related,prefetchRefs,totalFor,scanHeaders,getHeaders,headerSummary,analytics,metrics,refreshFacts};Object.defineProperty(api,'workerSource',{value:(global.LegendsStorageValues?.workerSource||'')+'('+installLegendsFastStore.toString()+')(self);'});global.LegendsFastStore=Object.freeze(api);
  if(global.LegendsLocalStore){const base=global.LegendsLocalStore,wrapped={...base};for(const key of ['getRecord','query','related','prefetchRefs','totalFor'])wrapped[key]=function(world,...args){return world?.disk?.format==='file-index'?api[key](world,...args):base[key](world,...args);};wrapped.abortImport=async id=>{await Promise.all([api.abortImport(id),base.abortImport(id)]);};
    async function savedWorld(id){if(base.getWorld)return base.getWorld(id);const db=await base.database();return readValue(db,'worlds',id);}
    wrapped.saveWorld=async world=>{if(world.disk?.format==='file-index'&&world.disk.sourcesPersisted===false){const disk=world.disk,name=disk.sourceDbName||disk.dbName||LEGACY_DATABASE,id=disk.sourceId||disk.id,files=(disk.fileInfo||[]).map((_,index)=>filesCache.get(name+':'+id+':'+index));if(!files.length||files.some(file=>!file))throw new Error('世界原文件尚未保存，请重新选择原文件。');await persistSourceFiles(world,files);}let previous;try{previous=await savedWorld(world.id);}catch(error){if(error.storageStore!=='worlds')throw error;}await base.saveWorld(world);if(previous?.disk?.format==='file-index'&&previous.disk.id!==world.disk?.id)await api.abortImport(previous.disk.id,{dbName:previous.disk.dbName||LEGACY_DATABASE,keepSources:world.disk.sourceId===previous.disk.id&&world.disk.sourceDbName===(previous.disk.dbName||LEGACY_DATABASE)});};
    wrapped.deleteWorld=async id=>{const previous=await savedWorld(id);await base.deleteWorld(id);if(previous?.disk?.format==='file-index'){await api.abortImport(previous.disk.id,{dbName:previous.disk.dbName||LEGACY_DATABASE});if(previous.disk.sourceId&&(previous.disk.sourceId!==previous.disk.id||previous.disk.sourceDbName!==previous.disk.dbName))await api.abortImport(previous.disk.sourceId,{dbName:previous.disk.sourceDbName||previous.disk.dbName||LEGACY_DATABASE});}};
    wrapped.workerSource=base.workerSource;global.LegendsLocalStore=Object.freeze(wrapped);}
})(typeof window==='undefined'?self:window);

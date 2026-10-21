const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {indexedDB,IDBKeyRange}=require(process.env.LEGENDS_TEST_NODE_MODULES ? path.join(process.env.LEGENDS_TEST_NODE_MODULES,'fake-indexeddb') : 'fake-indexeddb');
const {JSDOM}=require(process.env.LEGENDS_TEST_NODE_MODULES ? path.join(process.env.LEGENDS_TEST_NODE_MODULES,'jsdom') : 'jsdom');
const root=path.resolve(__dirname,'..');
const blobs=new Map(),workers=new Set(),messages=[];let workerId=0,maxWorkers=0,disableNested=false;
const TestURL=class extends URL{};
TestURL.createObjectURL=blob=>{const key='blob:test/'+crypto.randomUUID();blobs.set(key,blob);return key;};TestURL.revokeObjectURL=key=>blobs.delete(key);
const timers=new Set();
function globals(owner){
 const intervals=new Set(),timeouts=new Set();
 const base={console,Blob,File,Date,Map,Set,RegExp,TextEncoder,TextDecoder,ArrayBuffer,DataView,Uint8Array,Uint32Array,Int32Array,Float64Array,Uint16Array,Int8Array,Uint8ClampedArray,Int16Array,Float32Array,BigInt64Array,BigUint64Array,DOMException,AbortController,crypto,performance,indexedDB,IDBKeyRange,URL:TestURL,
 setTimeout(fn,ms,...args){const t=setTimeout(()=>{timeouts.delete(t);fn(...args);},ms);timeouts.add(t);return t;},clearTimeout(t){clearTimeout(t);timeouts.delete(t);},setInterval(fn,ms){const t=setInterval(fn,ms);intervals.add(t);return t;},clearInterval(t){clearInterval(t);intervals.delete(t);},
 close(){for(const t of intervals)clearInterval(t);for(const t of timeouts)clearTimeout(t);for(const child of [...workers])if(child.owner===owner)child.terminate();},
 createImageBitmap:async()=>({width:2,height:2,close(){}})};
 base.Worker=class{
  constructor(url){if(owner&&disableNested)throw new Error('Nested workers unavailable');this.owner=owner;this.id=++workerId;this.children=new Set();workers.add(this);maxWorkers=Math.max(maxWorkers,workers.size);this.queue=[];this.ready=false;
   const blob=blobs.get(url);if(!blob)throw Error('Unknown worker source');
   blob.text().then(code=>{if(this.terminated)return;this.scope=globals(this);this.scope.self=this.scope;this.scope.postMessage=data=>{const clone=structuredClone(data);messages.push({worker:this.id,type:clone.type,hasWorld:!!clone.world});queueMicrotask(()=>{if(!this.terminated)this.onmessage?.({data:clone});});};this.context=vm.createContext(this.scope);
    try{vm.runInContext(code,this.context);this.ready=true;for(const msg of this.queue)this.dispatch(msg);this.queue=[];}catch(error){this.onerror?.({message:error.message,preventDefault(){}});}
   });
  }
  postMessage(data){const clone=structuredClone(data);if(this.ready)this.dispatch(clone);else this.queue.push(clone);}
  dispatch(data){queueMicrotask(()=>{if(this.terminated)return;try{Promise.resolve(this.scope.onmessage?.({data})).catch(error=>this.onerror?.({message:error.message,preventDefault(){}}));}catch(error){this.onerror?.({message:error.message,preventDefault(){}});}});}
  terminate(){if(this.terminated)return;this.terminated=true;this.scope?.close();workers.delete(this);}
 };
 return base;
}
const context=vm.createContext(globals(null));context.self=context;context.window=context;
function load(ctx,file){vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx,{filename:file});}
for(const file of ['storage-values','data','local-store','file-indexer','fast-store','import-pipeline','import-client'])load(context,'js/'+file+'.js');
const get=(db,store,key)=>new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const keys=(db,store)=>new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const put=(db,store,value)=>new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
function fixture(count=7000,padding=0){return new File(['<df_world><name>Local Regression</name><historical_figures><historical_figure><id>1</id><name>Urist</name><race>DWARF</race></historical_figure><historical_figure><id>2</id><name>Domas</name><race>DWARF</race></historical_figure></historical_figures><historical_events>',...Array.from({length:count},(_,i)=>`<historical_event><id>${i}</id><year>${i%100}</year><type>hf died</type><hfid>1</hfid><slayer_hf>2</slayer_hf><detail>${'x'.repeat(padding)}</detail></historical_event>`),'</historical_events></df_world>'],'test-legends.xml');}
const results=[];
async function test(name,fn){const at=performance.now();await fn();results.push({name,passed:true,ms:Math.round(performance.now()-at)});console.log('PASS',name);}
(async()=>{
let parallel,single;
await test('storage roundtrip without composing stored Blobs',async()=>{
 const buffer=new ArrayBuffer(400000),a=new Uint32Array(buffer,0,50000),b=new Uint8Array(buffer,80,500);a[2]=123;
 const value={id:'roundtrip',text:'世界'.repeat(170000),a,b,map:new Map([[1,new Set([2,3])]]),date:new Date('2026-01-01'),undefinedValue:undefined,nan:NaN,minus:-0};
 const packed=await context.LegendsStorageValues.pack(value);assert.ok(packed.chunks.length>1);
 class GuardBlob extends Blob{constructor(parts,opts){if(parts?.some(p=>p instanceof Blob))throw Error('Stored Blob composition is forbidden');super(parts,opts);}}
 const original=context.Blob;context.Blob=GuardBlob;
 // Keep isPacked's native Blob check while trapping any attempted constructor.
 Object.defineProperty(GuardBlob,Symbol.hasInstance,{value:x=>x instanceof original});
 let restored;try{restored=await context.LegendsStorageValues.unpack(packed);}finally{context.Blob=original;}
 assert.equal(restored.text,value.text);assert.equal(restored.a[2],123);assert.equal(restored.a.buffer,restored.b.buffer);assert.ok(Number.isNaN(restored.nan));assert.ok(Object.is(restored.minus,-0));assert.equal(restored.date.toISOString(),value.date.toISOString());assert.deepEqual([...restored.map.get(1)],[2,3]);
});
await test('two-worker pipeline preserves every event and cleans handoff records',async()=>{
 parallel=await context.LegendsData.parseFiles([fixture()],()=>{},{storage:'file-index',threads:2});
 assert.equal(parallel.disk.rawEventCount,7000);assert.equal(parallel.disk.counts.figures,2);assert.ok(maxWorkers>=2);assert.ok(messages.some(m=>m.type==='stored'&&!m.hasWorld));
 assert.equal(workers.size,0);const db=await context.LegendsFastStore.database();assert.ok(!(await keys(db,'derived')).some(key=>String(key).includes(':handoff:')));
 const last=await context.LegendsFastStore.getRecord(parallel,'events',6999);assert.equal(last.id,6999);
});
await test('single-worker mode produces identical index and analytics',async()=>{
 maxWorkers=0;single=await context.LegendsData.parseFiles([fixture()],null,{storage:'file-index',threads:1});
 assert.equal(maxWorkers,1);assert.equal(single.disk.rawEventCount,parallel.disk.rawEventCount);assert.equal(JSON.stringify(single.disk.aggregates),JSON.stringify(parallel.disk.aggregates));
});
await test('cancel stops parser and nested writer; no imports remain',async()=>{
 const controller=new AbortController();await assert.rejects(context.LegendsData.parseFiles([fixture(20000)],progress=>{if(progress.percent>5)controller.abort();},{storage:'file-index',threads:2,signal:controller.signal}),error=>error.name==='AbortError');
 const until=Date.now()+5000;while(context.LegendsImport.getStatus().pendingCleanups&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.equal(workers.size,0);assert.equal(context.LegendsImport.getStatus().pendingCleanups,0);
});
await test('source persistence detaches File slices and map removal preserves XML slots',async()=>{
 const xml=fixture(5),image=new File(['map-pixels'],'map.png',{type:'image/png'}),world={disk:{format:'file-index',id:'sources',dbName:'legends-file-index-v3',fileInfo:[{name:xml.name,size:xml.size},{name:image.name,size:image.size}]}};
 await context.LegendsFastStore.persistSourceFiles(world,[xml,image]);const db=await context.LegendsFastStore.database();assert.ok((await get(db,'sources',['sources',1])).token);
 await context.LegendsFastStore.removeMapSources(world);assert.equal(await get(db,'sources',['sources',1]),undefined);assert.ok(await get(db,'sources',['sources',0]));
 const fresh=vm.createContext(globals(null));fresh.self=fresh;fresh.window=fresh;for(const file of ['storage-values','data','local-store','file-indexer','fast-store'])load(fresh,'js/'+file+'.js');
 const restored=await fresh.LegendsFastStore.readSourceFile(world,0);assert.equal(await restored.text(),await xml.text());
});
await test('orphan cleanup retains live indexes, shared source slots and legacy records',async()=>{
 const db=await context.LegendsFastStore.database();await put(db,'blocks',{importId:'orphan',group:'events',blockNo:0,headers:[]});await put(db,'derived',{importId:'orphan:handoff:import',world:{}});
 await context.LegendsFastStore.clearOrphans([parallel,{disk:{format:'file-index',id:'other',dbName:db.name,sourceId:'sources',sourceDbName:db.name}}]);
 assert.ok((await keys(db,'blocks')).some(k=>k[0]===parallel.disk.id));assert.ok(!(await keys(db,'blocks')).some(k=>k[0]==='orphan'||k[0]===single.disk.id));assert.ok(await get(db,'sources',['sources',0]));
});
await test('large file defaults to disk pipeline (over 32 MiB)',async()=>{
 maxWorkers=0;const large=fixture(350,100000);assert.ok(large.size>32*1024*1024);const world=await context.LegendsData.parseFiles([large]);assert.equal(world.disk.format,'file-index');assert.equal(world.disk.rawEventCount,350);assert.ok(maxWorkers>=2);await context.LegendsFastStore.abortImport(world.disk.id);
});
await test('analytics worker returns identifier instead of large structured results',async()=>{
 const expected=JSON.stringify(parallel.disk.aggregates),db=await context.LegendsFastStore.database();
 await new Promise((resolve,reject)=>{const tx=db.transaction('derived','readwrite');tx.objectStore('derived').delete(parallel.disk.id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
 delete parallel.disk.aggregates;context.document={};
 try{await context.LegendsFastStore.analytics(parallel);}finally{delete context.document;}
 assert.equal(JSON.stringify(parallel.disk.aggregates),expected);assert.ok(messages.some(m=>m.type==='complete'&&!m.hasWorld));assert.equal(workers.size,0);
});
await test('writer failure is reported and bounded queued work is terminated',async()=>{
 const db=await context.LegendsFastStore.database(),proto=Object.getPrototypeOf(db),original=proto.transaction;let failed=false;
 proto.transaction=function(stores,mode,...args){if(!failed&&mode==='readwrite'&&(stores==='blocks'||Array.isArray(stores)&&stores.includes('blocks')&&stores.length===1)){failed=true;throw new Error('simulated storage failure');}return original.call(this,stores,mode,...args);};
 try{await assert.rejects(context.LegendsData.parseFiles([fixture()],null,{storage:'file-index',threads:2}),/simulated storage failure/);}finally{proto.transaction=original;}
 const until=Date.now()+5000;while(context.LegendsImport.getStatus().pendingCleanups&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(failed);assert.equal(workers.size,0);
});
await test('unavailable nested worker safely falls back to one worker',async()=>{
 disableNested=true;maxWorkers=0;try{const world=await context.LegendsData.parseFiles([fixture(30)],null,{storage:'file-index',threads:2});assert.equal(world.disk.rawEventCount,30);assert.equal(maxWorkers,1);await context.LegendsFastStore.abortImport(world.disk.id);}finally{disableNested=false;}assert.equal(workers.size,0);
});
await test('UI exposes deletion on active world; map removal persists and all-cache reset works',async()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const dom=new JSDOM(html,{url:'https://local-test.invalid/',runScripts:'outside-only'}),win=dom.window;
 Object.assign(win,globals(null));win.self=win;win.confirm=()=>true;
 win.DFTranslate={ready:Promise.resolve(),name:record=>record?.name||'',term:value=>value,translate:value=>value};win.LegendsMap={invalidate(){},imageForWorld(){return '';}};
 const ctx=dom.getInternalVMContext();
 for(const file of ['storage-values','data','local-store','file-indexer','fast-store','import-pipeline','import-client','upstream-ui'])load(ctx,'js/'+file+'.js');
 let app=fs.readFileSync(path.join(root,'js/app.js'),'utf8');app=app.replace('  init();','  window.__cacheTest={changeCache,renderWorlds};');vm.runInContext(app,ctx);
 const world={id:'map-world',name:'Map World',sourceFiles:['world.xml','map.png'],mapImage:'data:image/png;base64,AAAA',mapImageWidth:2,mapImageHeight:2,mapFileName:'map.png',figures:[],events:[],collections:[],extra:{}};
 await win.LegendsLocalStore.saveWorld(world);win.LegendsApp.state.world=world;await win.__cacheTest.renderWorlds();
 assert.ok(win.document.querySelector('[data-delete-world="map-world"]'));assert.ok(win.document.querySelector('[data-remove-map="map-world"]'));
 win.confirm=()=>false;await win.__cacheTest.changeCache('map','map-world');assert.ok(world.mapImage);assert.ok((await win.LegendsLocalStore.getWorld(world.id)).mapImage);win.confirm=()=>true;
 await win.__cacheTest.changeCache('map','map-world');assert.equal(world.mapImage,undefined);assert.equal((await win.LegendsLocalStore.getWorld(world.id)).mapImage,undefined);assert.equal(JSON.stringify(world.sourceFiles),JSON.stringify(['world.xml']));
 await win.__cacheTest.changeCache('world','map-world');assert.equal(win.LegendsApp.state.world,null);assert.equal(await win.LegendsLocalStore.getWorld(world.id),undefined);
 await win.LegendsLocalStore.saveWorld({...world,id:'clear-test'});await win.__cacheTest.changeCache('all');assert.equal((await win.LegendsLocalStore.bookmarks()).length,0);const db=await win.LegendsFastStore.database();for(const store of ['sources','blocks','derived'])assert.equal((await keys(db,store)).length,0);
 dom.window.close();
});
fs.writeFileSync(path.join(__dirname,'local-deployment-results.json'),JSON.stringify({environment:'Node VM Worker simulation + fake-indexeddb + jsdom; not Chromium',results},null,2));
console.log(JSON.stringify(results));process.exit(0);
})().catch(error=>{console.error(error);for(const w of [...workers])w.terminate();process.exit(1);});

/* Offline Legends import transport. The parser runtime is supplied by data.js.
 * Blob workers work under ordinary file:// without fetching local script URLs.
 * Files are cloned as browser-managed File handles, never as whole XML strings.
 * Small worlds return in acknowledged batches. Large XML streams directly into
 * IndexedDB in the worker; only a bounded world summary returns to the page. */
(function (global) {
  'use strict';
  const core = global.LegendsData;
  if (!core || typeof core.parseFiles !== 'function') throw new Error('请先加载 data.js');
  const active = new Set();
  const cleanups = new Set();
  const capability = {supported:null,mode:'idle',storage:'memory',format:'memory',reason:'',importsStarted:0,cleanupError:''};
  const STARTUP_TIMEOUT = 3000, DISK_THRESHOLD = 32 * 1024 * 1024;

  // Self-contained on purpose: this function is embedded into the Blob URL.
  // It must not close over main-thread variables, DOM APIs, or source files.
  function workerRuntime() {
    'use strict';
    const BATCH_SIZE = 512;
    let busy = false, sequence = 0, acknowledge = null, store = null, importId = '', pipeline = null;
    const fail = async error => {
      // The page owns cleanup after errors or termination. Report failure
      // before any potentially slow storage deletion can delay the UI.
      pipeline?.close();self.postMessage({type:'error', error:serializeError(error)}); self.close();
    };
    const serializeError = error => ({name: String(error?.name || 'Error'), message: String(error?.message || error || '无法读取 XML。')});
    const send = payload => new Promise(resolve => {
      const seq = ++sequence;
      acknowledge = {seq, resolve};
      self.postMessage({...payload, seq});
    });
    self.onmessage = async event => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ack') {
        if (acknowledge?.seq === message.seq) {
          const done = acknowledge.resolve; acknowledge = null; done();
        }
        return;
      }
      if (message.type === 'prepare' && !busy) {
        busy = true;
        try {
          importId = message.id;
          if(message.storage==='file-index'&&self.LegendsImportPipeline){
            pipeline=await self.LegendsImportPipeline.createStore({id:importId,files:message.files},message.writerSource,message.threads!==1);
            store=pipeline.store;
          }else store = await (message.storage === 'file-index' ? self.LegendsFastStore : self.LegendsLocalStore).createImport({id:importId,files:message.files});
          busy = false; self.postMessage({type:'prepared', id:importId,workers:pipeline?.workers||1});
        } catch (error) { await fail(error); }
        return;
      }
      if (message.type !== 'parse' || busy) return;
      busy = true;
      try {
        let latestProgress = {};
        if (message.storage === 'file-index') {
          if (!store || importId !== message.id) throw new Error('本地文件存储尚未准备完成。');
          const metadata = await self.LegendsFileIndexer.indexFiles(message.files,{
            onBlock:block=>store.writeBlock(block),
            onMetadata:(key,value)=>store.metadata(key,value),
            progress:progress=>{
              latestProgress=progress||{};
              self.postMessage({type:'progress',progress:{...latestProgress,
                percent:Math.max(0,Math.min(85,(Number(progress?.percent)||0)*0.85)),
                parserPercent:Number(progress?.percent)||0,phase:progress?.phase||'fileIndex'}});
            }
          });
          self.postMessage({type:'progress',progress:{...latestProgress,percent:85,phase:'store',message:'正在完成本地索引…'}});
          const compactWorld=await store.finish(metadata);
          const image=message.files.find(file=>/^image\//i.test(file.type||'')||/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file.name||''));
          if(image)await self.LegendsData.readMapImage(compactWorld,image);
          await self.LegendsFastStore.analytics(compactWorld,{progress:progress=>self.postMessage({type:'progress',progress:{...progress,percent:85+(Number(progress.percent)||0)*.14}})});
          await self.LegendsFastStore.putHandoff(importId,'import',compactWorld);
          self.postMessage({type:'stored',id:importId,handoff:true,
            progress:{...latestProgress,percent:100,phase:'complete',message:'读取完成'}});
          return;
        }
        if (message.storage === 'disk') {
          if (!store || importId !== message.id) throw new Error('本地存储尚未准备完成。');
          const metadata = await self.LegendsData.parseFilesStream(message.files, {
            onBatch:(entries, info) => store.writeBatch(entries, info),
            onMetadata:(key, value) => store.metadata(key, value),
            progress:progress => {
              latestProgress = progress || {};
              self.postMessage({type:'progress', progress:{...latestProgress,
                percent:Math.max(0,Math.min(99,(Number(progress?.percent)||0)*0.99)),
                parserPercent:Number(progress?.percent)||0, phase:progress?.phase||'parse'}});
            }
          });
          self.postMessage({type:'progress', progress:{...latestProgress,percent:99,phase:'store',message:'正在完成本地索引…'}});
          const compactWorld = await store.finish(metadata);
          self.postMessage({type:'stored',id:importId,world:compactWorld,
            progress:{...latestProgress,percent:100,phase:'complete',message:'读取完成'}});
          return;
        }
        const world = await self.LegendsData.parseFiles(message.files, progress => {
          latestProgress = progress || {};
          const percent = Math.max(0, Math.min(96, (Number(progress?.percent) || 0) * 0.96));
          self.postMessage({type:'progress', progress:{...latestProgress, percent, parserPercent: Number(progress?.percent) || 0, phase: progress?.phase || 'parse'}});
        });
        const metadata = Object.create(null), extraMetadata = Object.create(null), sections = [];
        for (const key of Object.keys(world)) {
          if (key === 'extra' && world.extra && typeof world.extra === 'object') {
            for (const extraKey of Object.keys(world.extra)) {
              if (Array.isArray(world.extra[extraKey])) sections.push({scope:'extra', key:extraKey, records:world.extra[extraKey]});
              else extraMetadata[extraKey] = world.extra[extraKey];
            }
          } else if (Array.isArray(world[key]) && key !== 'sourceFiles') {
            sections.push({scope:'world', key, records:world[key]});
          } else metadata[key] = world[key];
        }
        const totalRecords = sections.reduce((sum, section) => sum + section.records.length, 0);
        let delivered = 0;
        await send({type:'begin', metadata, extraMetadata, sections:sections.map(({scope,key,records})=>({scope,key,length:records.length})), totalRecords});
        for (let sectionId = 0; sectionId < sections.length; sectionId++) {
          const section = sections[sectionId], records = section.records;
          for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
            const end = Math.min(records.length, offset + BATCH_SIZE);
            const items = records.slice(offset, end);
            await send({type:'batch', sectionId, offset, items, delivered:delivered + items.length, totalRecords});
            // Drop worker-side references only after the browser has accepted
            // this batch. At most one record batch can be in flight.
            for (let index = offset; index < end; index++) records[index] = null;
            delivered += items.length;
          }
          records.length = 0;
          section.records = null;
          if (section.scope === 'extra') world.extra[section.key] = null;
          else world[section.key] = null;
        }
        self.postMessage({type:'done', totalRecords, progress:{...latestProgress, percent:100, phase:'complete', message:'读取完成'}});
      } catch (error) {
        await fail(error);
      } finally {
        pipeline?.close();
        self.close();
      }
    };
    self.postMessage({type:'ready', capabilities:{
      images:typeof self.createImageBitmap === 'function' && typeof self.FileReader === 'function',
      fast:typeof self.LegendsFileIndexer?.indexFiles === 'function' && typeof self.LegendsFastStore?.createImport === 'function' && !!self.indexedDB,
      disk:typeof self.LegendsData.parseFilesStream === 'function' && typeof self.LegendsLocalStore?.createImport === 'function' && !!self.indexedDB
    }});
    self.setInterval(()=>self.postMessage({type:'heartbeat'}),1000);
  }

  function abortError() {
    if (typeof DOMException === 'function') return new DOMException('已取消导入。', 'AbortError');
    const error = new Error('已取消导入。'); error.name = 'AbortError'; return error;
  }
  function toOptions(onProgress, options) {
    if (onProgress && typeof onProgress === 'object') { options = onProgress; onProgress = options.onProgress; }
    if (options && typeof options.addEventListener === 'function' && typeof options.aborted === 'boolean') options = {signal:options};
    return {onProgress: typeof onProgress === 'function' ? onProgress : null, options:options || {}};
  }
  function define(object, key, value) {
    // XML element names must remain ordinary own properties, including a
    // possible literal '__proto__'; never invoke an inherited setter.
    Object.defineProperty(object, key, {value, writable:true, configurable:true, enumerable:true});
  }

  function parseFiles(input, onProgress, options) {
    const normalized = toOptions(onProgress, options);
    onProgress = normalized.onProgress; options = normalized.options;
    const signal = options.signal, files = Array.from(input || []);
    if (signal?.aborted) return Promise.reject(abortError());
    const xmlBytes = files.reduce((sum,file) => sum + (/\.xml$/i.test(file.name || '') ? Number(file.size)||0 : 0),0);
    const disk = ['disk','file-index','records'].includes(options.storage) || options.storage !== 'memory' && xmlBytes > DISK_THRESHOLD;
    const fast = disk && options.storage !== 'records';
    const localStore = fast ? global.LegendsFastStore : global.LegendsLocalStore;
    const indexer = global.LegendsFileIndexer;
    if (disk && (typeof localStore?.createImport !== 'function' || (fast ? typeof indexer?.indexFiles !== 'function' : typeof core.parseFilesStream !== 'function'))) {
      return Promise.reject(new Error('大文件本地存储模块未加载。请刷新页面后重试。'));
    }
    const importId = disk ? (typeof global.crypto?.randomUUID === 'function' ? global.crypto.randomUUID() : 'import-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)) : '';
    const fileInfo = files.map(file => ({name:String(file.name||''),size:Number(file.size)||0,lastModified:Number(file.lastModified)||0}));
    capability.importsStarted++; capability.storage=disk?'disk':'memory'; capability.format=fast?'file-index':disk?'records':'memory';
    return new Promise((resolve, reject) => {
      let settled = false, worker = null, url = null, startupTimer = 0, watchdogTimer = 0, started = false, lastHeartbeat = Date.now();
      let world = null, destinations = null, expectedLengths = null, storageSession = null, storagePromise = null;
      const controller = new AbortController();
      const session = {worker:null,workers:1}; active.add(session);
      const releaseUrl = () => {if (url) {global.URL.revokeObjectURL(url); url = null;}};
      const stopWorker = () => {
        global.clearTimeout(startupTimer); startupTimer = 0;
        global.clearInterval(watchdogTimer); watchdogTimer=0;
        global.document?.removeEventListener('visibilitychange',resetHeartbeat);
        if (worker) {worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = null;}
        session.worker = null; session.workers=0; releaseUrl();
      };
      const resetHeartbeat=()=>{lastHeartbeat=Date.now();};
      const cleanupStorage = async () => {
        const errors=[];
        try {if(storagePromise)await storagePromise;} catch(error){errors.push(error);}
        try {if(storageSession)await storageSession.abort();} catch(error){errors.push(error);}
        try {if(disk)await localStore.abortImport(importId);} catch(error){errors.push(error);}
        if(errors.length){
          capability.cleanupError=errors.map(error=>String(error?.message||error)).join('; ');
          global.console?.warn('Legends import cleanup:',capability.cleanupError);
        }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true; stopWorker(); controller.abort();
        signal?.removeEventListener('abort', cancel);
        destinations = null; expectedLengths = null;
        if (error) {
          world = null;
          active.delete(session);reject(error);
          // Cancel releases the UI immediately; deleting a large old namespace
          // continues independently and can never hold the caller's promise.
          if(disk){
            const cleanup=Promise.resolve().then(cleanupStorage).catch(cause=>{
              capability.cleanupError=String(cause?.message||cause);
              global.console?.warn('Legends import cleanup:',capability.cleanupError);
            });
            cleanups.add(cleanup);
            cleanup.then(()=>cleanups.delete(cleanup),()=>cleanups.delete(cleanup));
          }
        } else {if(fast&&result?.disk)global.LegendsFastStore.registerSourceFiles(result,files);active.delete(session);resolve(result);}
      };
      const cancel = () => finish(abortError());
      const report = progress => {if (!settled && onProgress) onProgress({...progress,storage:disk?'disk':'memory'});};
      signal?.addEventListener('abort', cancel, {once:true});
      // Covers an AbortController fired synchronously between the first check
      // and listener registration without starting a parser unnecessarily.
      if (signal?.aborted) {cancel(); return;}
      const fallback = (reason, unavailable) => {
        if (settled) return;
        stopWorker();
        if (unavailable) capability.supported = false;
        capability.mode = 'main'; capability.reason = String(reason || '');
        Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw abortError();
          if (!disk) return core.parseFiles(files,progress=>report({...progress,execution:'main'}),{...options,signal:controller.signal});
          // Worker restrictions must never trigger a full multi-GB memory parse.
          storagePromise = localStore.createImport({id:importId,files:fast?files:fileInfo});
          storageSession = await storagePromise;
          if (controller.signal.aborted) throw abortError();
          if(fast){
            const metadata=await indexer.indexFiles(files,{
              signal:controller.signal,onBlock:block=>storageSession.writeBlock(block),
              onMetadata:(key,value)=>storageSession.metadata(key,value),
              progress:progress=>report({...progress,percent:Math.min(85,(Number(progress.percent)||0)*0.85),phase:progress.phase||'fileIndex',execution:'main'})
            });
            if(controller.signal.aborted)throw abortError();
            report({percent:85,phase:'store',execution:'main',message:'正在完成本地索引…'});
            const result=await storageSession.finish(metadata);
            const image=files.find(file=>/^image\//i.test(file.type||'')||/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file.name||''));
            if(image)await core.readMapImage(result,image,controller.signal);
            await global.LegendsFastStore.analytics(result,{signal:controller.signal,progress:progress=>report({...progress,percent:85+(Number(progress.percent)||0)*.14,execution:'main'})});
            if(controller.signal.aborted)throw abortError();
            report({percent:100,phase:'complete',execution:'main',message:'读取完成'});
            return result;
          }
          const metadata = await core.parseFilesStream(files,{
            signal:controller.signal,
            onBatch:(entries,info)=>storageSession.writeBatch(entries,info),
            onMetadata:(key,value)=>storageSession.metadata(key,value),
            progress:progress=>report({...progress,percent:Math.min(99,(Number(progress.percent)||0)*0.99),phase:progress.phase||'parse',execution:'main'})
          });
          if (controller.signal.aborted) throw abortError();
          report({percent:99,phase:'store',execution:'main',message:'正在完成本地索引…'});
          const result = await storageSession.finish(metadata);
          if (controller.signal.aborted) throw abortError();
          report({percent:100,phase:'complete',execution:'main',message:'读取完成'});
          return result;
        }).then(result => {if(signal?.aborted)finish(abortError());else finish(null,result);},error=>finish(error));
      };
      const source = typeof core.workerSource === 'string' ? core.workerSource : '';
      const storeSource = disk && typeof localStore.workerSource === 'string' ? localStore.workerSource : '';
      const indexerSource=fast&&typeof indexer.workerSource==='string'?indexer.workerSource:'';
      const pipelineSource=global.LegendsImportPipeline?.workerSource||'';
      if (options.worker === false || disk && !storeSource || fast && !indexerSource || capability.supported === false || !source || typeof global.Worker !== 'function' || !global.Blob || !global.URL?.createObjectURL) {
        fallback(options.worker === false ? 'Worker disabled by caller' : !source ? 'Parser runtime is unavailable' : 'Worker is unavailable', options.worker !== false && !!source);
        return;
      }
      try {
        url = global.URL.createObjectURL(new Blob([source, '\n', indexerSource, '\n', storeSource, '\n',pipelineSource,'\n;(', workerRuntime.toString(), ')();\n'], {type:'text/javascript'}));
        worker = new Worker(url, {name:'Legends XML import'}); session.worker = worker;
      } catch (error) {fallback(error?.name || 'Worker startup failed', true); return;}
      startupTimer = global.setTimeout(() => {
        if (!started && !settled) fallback('Worker startup timed out', true);
      }, STARTUP_TIMEOUT);
      worker.onerror = event => {
        event.preventDefault?.();
        if (!started) fallback(event.message || 'Worker startup failed', true);
        else finish(new Error(event.message || '读取线程意外停止。'));
      };
      worker.onmessageerror = () => {
        if (!started) fallback('Worker message cloning failed', true);
        else finish(new Error('无法接收导入数据。'));
      };
      worker.onmessage = async event => {
        if (settled) return;
        lastHeartbeat=Date.now();
        const message = event.data;
        try {
          if (!message || typeof message !== 'object') throw new Error('导入线程消息无效。');
          if (message.type === 'ready') {
            global.clearTimeout(startupTimer); startupTimer = 0; releaseUrl();
            capability.supported = true; capability.mode = 'worker'; capability.reason = '';
            global.document?.addEventListener('visibilitychange',resetHeartbeat);
            watchdogTimer=global.setInterval(()=>{
              if(global.document?.hidden){resetHeartbeat();return;}
              if(Date.now()-lastHeartbeat>30000)finish(new Error('读取线程停止响应，请重新载入世界。'));
            },3000);
            if (signal?.aborted) {cancel(); return;}
            if (disk && !(fast?message.capabilities?.fast:message.capabilities?.disk)) {fallback('Persistent worker storage is unavailable',false);return;}
            if (!message.capabilities?.images && files.some(file => /^image\//i.test(file.type || '') || /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file.name || ''))) {
              fallback('Image decoding is unavailable in this worker', false); return;
            }
            try {worker.postMessage(disk ? {type:'prepare',storage:fast?'file-index':'disk',id:importId,files:fast?files:fileInfo,threads:options.threads===1?1:2,writerSource:fast?source+'\n'+indexerSource+'\n'+storeSource:''} : {type:'parse',files}); started = true;}
            catch (error) {fallback(error?.name || 'File handles could not be cloned', false);}
          } else if (message.type === 'heartbeat') {
            // Independent of parser/IndexedDB progress, including long IO.
          } else if (message.type === 'prepared') {
            if (!disk || message.id !== importId) throw new Error('本地存储准备消息无效。');
            session.workers=message.workers||1;
            report({percent:0,phase:'prepared',workers:session.workers,message:session.workers===2?'双线程已启动：解析与缓存写入并行':'单线程解析已启动'});
            worker.postMessage({type:'parse',storage:fast?'file-index':'disk',id:importId,files});
          } else if (message.type === 'stored') {
            if(message.handoff){
              if(!fast||message.id!==importId)throw new Error('本地结果标识无效。');
              global.clearInterval(watchdogTimer);watchdogTimer=0;
              message.world=await localStore.takeHandoff(importId,'import');
              if(settled)return;
            }
            if (!disk || message.id !== importId || !message.world || message.world.disk?.id !== importId) throw new Error('本地存储结果无效。');
            report({...message.progress,execution:'worker'}); if(!settled)finish(null,message.world);
          } else if (message.type === 'progress') {
            report({...message.progress, execution:'worker'});
          } else if (message.type === 'begin') {
            if (disk || world || !Array.isArray(message.sections)) throw new Error('导入数据起始消息无效。');
            world = {};
            for (const key of Object.keys(message.metadata || {})) define(world, key, message.metadata[key]);
            const extra = Object.create(null);
            for (const key of Object.keys(message.extraMetadata || {})) define(extra, key, message.extraMetadata[key]);
            define(world, 'extra', extra);
            destinations = []; expectedLengths = [];
            for (const section of message.sections) {
              if (!section || !['world','extra'].includes(section.scope) || typeof section.key !== 'string' || !Number.isSafeInteger(section.length) || section.length < 0) throw new Error('导入数据分组无效。');
              const records = [];
              define(section.scope === 'extra' ? extra : world, section.key, records);
              destinations.push(records); expectedLengths.push(section.length);
            }
            report({percent:96, phase:'receive', execution:'worker', message:'正在准备浏览数据…', records:0, totalRecords:message.totalRecords});
            if (!settled) worker.postMessage({type:'ack', seq:message.seq});
          } else if (message.type === 'batch') {
            if (!world || !Number.isSafeInteger(message.sectionId) || !destinations[message.sectionId] || !Array.isArray(message.items) || message.items.length > 512 || message.offset !== destinations[message.sectionId].length) throw new Error('导入数据批次无效。');
            const destination = destinations[message.sectionId];
            if (destination.length + message.items.length > expectedLengths[message.sectionId]) throw new Error('导入记录数量超出分组长度。');
            destination.push(...message.items);
            report({percent:96 + 4 * message.delivered / Math.max(1,message.totalRecords), phase:'receive', execution:'worker', message:'正在准备浏览数据…', records:message.delivered, totalRecords:message.totalRecords});
            if (!settled) worker.postMessage({type:'ack', seq:message.seq});
          } else if (message.type === 'done') {
            if (disk || !world || destinations.some((records,index) => records.length !== expectedLengths[index])) throw new Error('导入记录数量不完整。');
            report({...message.progress, execution:'worker'});
            if (!settled) finish(null,world);
          } else if (message.type === 'error') {
            const error = new Error(message.error?.message || '无法读取 XML。');
            error.name = message.error?.name || 'Error'; finish(error);
          } else throw new Error('导入线程消息类型无效。');
        } catch (error) {finish(error);}
      };
    });
  }
  const getStatus = () => ({...capability,activeImports:active.size,activeWorkers:[...active].reduce((sum,session)=>sum+(session.worker?session.workers:0),0),pendingCleanups:cleanups.size});
  global.LegendsImport = Object.freeze({parseFiles,getStatus,diskThreshold:DISK_THRESHOLD});
  // Preserve the original public API and every existing parser helper.
  global.LegendsData = Object.freeze({...core, parseFiles});
})(window);

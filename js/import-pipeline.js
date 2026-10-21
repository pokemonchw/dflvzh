/* Two-stage bounded pipeline: one XML parser and one index/storage worker.
 * A single XML benefits; records are committed in their original order. */
(function installImportPipeline(global){
  'use strict';
  function writerRuntime(){
    let store,chain=Promise.resolve();
    self.onmessage=event=>{
      const message=event.data;
      chain=chain.then(async()=>{
        let value;
        if(message.type==='prepare')store=await LegendsFastStore.createImport(message.options);
        else if(message.type==='block'){
          for(const [key,value]of Object.entries(message.metadata))store.metadata(key,value);
          await store.writeBlock(message.block);
        }else if(message.type==='finish'){
          const world=await store.finish(message.metadata);
          await LegendsFastStore.putHandoff(world.disk.id,'writer',world);
          value=world.disk.id;
        }else throw new Error('未知缓存写入任务。');
        postMessage({seq:message.seq,value});
      }).catch(error=>postMessage({seq:message.seq,error:{name:error.name,message:error.message}}));
    };
    postMessage({ready:true});
  }
  async function createStore(options,source,parallel=true){
    if(!parallel||typeof global.Worker!=='function')return {store:await LegendsFastStore.createImport(options),workers:1,close(){}};
    let worker,url,timer,sequence=0,closed=false,failure=null;const pending=new Map(),queue=[];let metadata=Object.create(null);
    const fail=error=>{failure=error;for(const entry of pending.values())entry.reject(error);pending.clear();};
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);worker?.terminate();if(url)URL.revokeObjectURL(url);fail(new Error('缓存写入线程已停止。'));};
    let ready;
    try{
      url=URL.createObjectURL(new Blob([source,';(',writerRuntime.toString(),')();'],{type:'text/javascript'}));
      ready=new Promise((resolve,reject)=>{
        worker=new Worker(url,{name:'Legends index storage'});
        timer=setTimeout(()=>reject(new Error('缓存线程启动超时。')),5000);
        worker.onmessage=event=>{
          const data=event.data;if(data.ready){clearTimeout(timer);resolve();return;}
          const entry=pending.get(data.seq);if(!entry)return;pending.delete(data.seq);
          if(data.error){const error=new Error(data.error.message);error.name=data.error.name;entry.reject(error);}else entry.resolve(data.value);
        };
        worker.onerror=event=>{const error=new Error(event.message||'缓存线程失败。');reject(error);fail(error);};
        worker.onmessageerror=()=>{const error=new Error('无法接收缓存线程消息。');reject(error);fail(error);};
      });
      await ready;
    }catch(error){close();return {store:await LegendsFastStore.createImport(options),workers:1,reason:error.message,close(){}};}
    function request(type,data={}){
      if(closed)return Promise.reject(new Error('缓存写入线程已停止。'));
      if(failure)return Promise.reject(failure);
      const seq=++sequence;return new Promise((resolve,reject)=>{
        pending.set(seq,{resolve,reject});try{worker.postMessage({type,seq,...data});}catch(error){pending.delete(seq);reject(error);}
      });
    }
    try{await request('prepare',{options});}catch(error){close();throw error;}
    const store={
      metadata(key,value){Object.defineProperty(metadata,key,{value,writable:true,enumerable:true,configurable:true});},
      async writeBlock(block){
        const task=request('block',{block,metadata});metadata=Object.create(null);task.catch(()=>{});queue.push(task);
        // Only two batches may exist outside the parser at any time.
        if(queue.length>=2)await queue.shift();
      },
      async finish(meta){
        await Promise.all(queue);queue.length=0;
        const id=await request('finish',{metadata:{...metadata,...meta}});
        try{return await LegendsFastStore.takeHandoff(id,'writer');}finally{close();}
      }
    };
    return {store,workers:2,close};
  }
  const api={createStore};Object.defineProperty(api,'workerSource',{value:'('+installImportPipeline.toString()+')(self);'});
  global.LegendsImportPipeline=Object.freeze(api);
})(typeof window==='undefined'?self:window);

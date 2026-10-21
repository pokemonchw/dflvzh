/* Keep large structured values out of Chromium's implicit IndexedDB wrappers.
 * Explicit bounded Blob payloads retain native typed arrays after restoration.
 * This factory is also embedded into the offline import/analytics workers. */
(function installLegendsStorageValues(global) {
  'use strict';
  const STORAGE_TAG='$legends.storage.v1',VALUE_TAG='$legends.value.v1';
  const INLINE_LIMIT=32768,CHUNK_BYTES=256*1024;
  const identities=['id','importId','group','blockNo'];
  const arrayTypes=['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array'];
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const abortError=()=>new DOMException('读取已取消。','AbortError');
  function check(signal){if(signal?.aborted)throw abortError();}
  function isBlob(value){return typeof global.Blob==='function'&&value instanceof global.Blob;}
  function isPacked(value){return Boolean(value&&typeof value==='object'&&value[STORAGE_TAG]===1&&Array.isArray(value.chunks)&&Number.isSafeInteger(value.jsonBytes)&&value.jsonBytes>=0&&value.chunks.every(isBlob));}
  function sizeHint(value){
    const pending=[value],seen=new WeakSet();let size=0,hasBlob=false;
    while(pending.length){
      const item=pending.pop(),type=typeof item;
      if(type==='string')size+=item.length*3+16;
      else if(!item||type!=='object')size+=16;
      else if(!seen.has(item)){
        seen.add(item);
        if(isBlob(item)){hasBlob=true;continue;}
        if(item instanceof ArrayBuffer)size+=item.byteLength+32;
        else if(ArrayBuffer.isView(item)){size+=item.buffer.byteLength+64;}
        else if(item instanceof Map){size+=item.size*32;for(const pair of item)pending.push(...pair);}
        else if(item instanceof Set){size+=item.size*16;for(const entry of item)pending.push(entry);}
        else if(item instanceof Date||item instanceof RegExp)size+=128;
        else{size+=32;for(const key of Object.keys(item)){size+=key.length*3+16;pending.push(item[key]);}}
      }
      // Traversal continues after crossing the threshold to detect Blob/File
      // inputs. These are already native storage handles and are left intact.
    }
    return {size,hasBlob};
  }
  async function pack(value){
    if(isPacked(value))return value;
    const hint=sizeHint(value);if(hint.hasBlob||hint.size<=INLINE_LIMIT)return value;
    const buffers=[],bufferIds=new WeakMap(),generated=new WeakSet(),envelope={value,buffers:[]};
    function marker(type,...values){const result={[VALUE_TAG]:[type,...values]};generated.add(result);return result;}
    function bufferId(buffer){let id=bufferIds.get(buffer);if(id===undefined){id=buffers.length;buffers.push(buffer);bufferIds.set(buffer,id);envelope.buffers.push(buffer.byteLength);}return id;}
    const json=JSON.stringify(envelope,function(key,next){
      const original=this[key];
      if(next===undefined)return marker('undefined');
      if(typeof next==='function'||typeof next==='symbol')throw new TypeError('本地数据包含无法保存的值。');
      if(typeof next==='bigint')return marker('bigint',String(next));
      if(typeof next==='number'&&(!Number.isFinite(next)||Object.is(next,-0)))return marker('number',Object.is(next,-0)?'-0':String(next));
      if(!next||typeof next!=='object'){
        // Date.toJSON runs before the replacer, including for invalid dates.
        if(original instanceof Date)return marker('date',Number.isNaN(original.getTime())?null:original.toISOString());
        return next;
      }
      if(generated.has(next))return next;
      if(next instanceof ArrayBuffer)return marker('buffer',bufferId(next));
      if(ArrayBuffer.isView(next)){
        const type=next instanceof DataView?'DataView':next.constructor.name;
        if(type!=='DataView'&&!arrayTypes.includes(type))throw new Error('无法保存此二进制数组类型：'+type);
        return marker('view',type,bufferId(next.buffer),next.byteOffset,next instanceof DataView?next.byteLength:next.length);
      }
      if(next instanceof Map)return marker('map',Array.from(next.entries()));
      if(next instanceof Set)return marker('set',Array.from(next.values()));
      if(next instanceof RegExp)return marker('regexp',next.source,next.flags,next.lastIndex);
      // Escape the reserved key in actual data. XML element names cannot
      // contain '$', but this also protects arbitrary JavaScript objects.
      if(own(next,VALUE_TAG))return marker('object',Object.entries(next));
      return next;
    });
    const text=new TextEncoder().encode(json),payload=new Blob([text,...buffers],{type:'application/vnd.legends.storage+binary'}),chunks=[];
    for(let offset=0;offset<payload.size;offset+=CHUNK_BYTES)chunks.push(payload.slice(offset,offset+CHUNK_BYTES));
    const packed={[STORAGE_TAG]:1,jsonBytes:text.byteLength,chunks};
    for(const key of identities)if(value&&typeof value==='object'&&own(value,key)&&['string','number','boolean'].includes(typeof value[key]))packed[key]=value[key];
    return packed;
  }
  async function unpack(value,options={}){
    check(options.signal);if(!isPacked(value))return value;
    // Do not compose a new Blob from IndexedDB-owned Blob handles. Chromium
    // can kill the renderer while resolving those handles across processes.
    const total=value.chunks.reduce((sum,chunk)=>sum+chunk.size,0);
    if(value.jsonBytes>total)throw new Error('本地数据的编码长度无效。');
    let chunkNo=0,chunkOffset=0,current;
    async function readBytes(size){
      const bytes=new Uint8Array(size);let written=0;
      while(written<size){
        check(options.signal);
        if(!current||chunkOffset===current.length){
          if(chunkNo>=value.chunks.length)throw new Error('本地数据被截断。');
          current=new Uint8Array(await value.chunks[chunkNo++].arrayBuffer());chunkOffset=0;
          if(!current.length)continue;
        }
        const count=Math.min(size-written,current.length-chunkOffset);
        bytes.set(current.subarray(chunkOffset,chunkOffset+count),written);written+=count;chunkOffset+=count;
      }
      return bytes;
    }
    const envelope=JSON.parse(new TextDecoder().decode(await readBytes(value.jsonBytes)));check(options.signal);
    if(!envelope||!Array.isArray(envelope.buffers)||!own(envelope,'value'))throw new Error('本地数据的编码结构无效。');
    const buffers=[];let offset=value.jsonBytes;
    for(const size of envelope.buffers){
      if(!Number.isSafeInteger(size)||size<0||offset+size>total)throw new Error('本地数据的二进制长度无效。');
      buffers.push((await readBytes(size)).buffer);offset+=size;check(options.signal);
    }
    if(offset!==total)throw new Error('本地数据含有未识别的二进制内容。');
    function restore(item){
      if(!item||typeof item!=='object')return item;
      if(own(item,VALUE_TAG)&&Object.keys(item).length===1){
        const spec=item[VALUE_TAG];if(!Array.isArray(spec))throw new Error('本地数据的类型标记无效。');
        const [type,...parts]=spec;
        if(type==='undefined')return undefined;
        if(type==='bigint')return BigInt(parts[0]);
        if(type==='number')return parts[0]==='-0'?-0:parts[0]==='NaN'?NaN:Number(parts[0]);
        if(type==='date')return parts[0]===null?new Date(NaN):new Date(parts[0]);
        if(type==='regexp'){const result=new RegExp(parts[0],parts[1]);result.lastIndex=parts[2];return result;}
        if(type==='buffer'){if(!buffers[parts[0]])throw new Error('本地数据引用了不存在的二进制内容。');return buffers[parts[0]];}
        if(type==='view'){
          const [name,id,start,length]=parts,buffer=buffers[id];
          if(!buffer)throw new Error('本地数据引用了不存在的二进制内容。');
          if(name==='DataView')return new DataView(buffer,start,length);
          if(!arrayTypes.includes(name)||typeof global[name]!=='function')throw new Error('无法读取此二进制数组类型：'+name);
          return new global[name](buffer,start,length);
        }
        if(type==='map')return new Map(parts[0].map(pair=>[restore(pair[0]),restore(pair[1])]));
        if(type==='set')return new Set(parts[0].map(restore));
        if(type==='object'){const result={};for(const pair of parts[0])Object.defineProperty(result,pair[0],{value:restore(pair[1]),writable:true,enumerable:true,configurable:true});return result;}
        throw new Error('本地数据含有未知的类型标记：'+type);
      }
      for(const key of Object.keys(item))Object.defineProperty(item,key,{value:restore(item[key]),writable:true,enumerable:true,configurable:true});
      return item;
    }
    return restore(envelope.value);
  }
  const labels={worlds:'世界',catalog:'世界目录',blocks:'记录索引',derived:'世界统计',sources:'世界原文件',records:'记录',payloads:'记录内容'};
  function contextualError(cause,db,store,key){
    const error=new Error('无法读取本地'+(labels[store]||'数据')+'，请重试。');
    error.name=cause?.name||'Error';error.cause=cause;error.storageDb=db.name;error.storageStore=store;error.storageKey=key;return error;
  }
  function transient(error){return error?.name==='UnknownError'&&String(error.message||'').includes('Failed to read large IndexedDB value');}
  function pause(delay,signal){return new Promise((resolve,reject)=>{
    check(signal);let timer;
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(abortError());};
    timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},delay);signal?.addEventListener('abort',abort,{once:true});
  });}
  function readOnce(db,store,key,signal){return new Promise((resolve,reject)=>{
    check(signal);let tx,settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{try{tx?.abort();}catch(_){}finish(abortError());};
    try{
      tx=db.transaction(store,'readonly');const request=tx.objectStore(store).get(key);
      request.onsuccess=()=>finish(null,request.result);request.onerror=()=>finish(request.error||new Error('本地读取失败。'));
      tx.onabort=()=>finish(tx.error||new Error('本地读取事务已中止。'));
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    }catch(error){finish(error);}
  });}
  async function read(db,store,key,options={}){
    const attempts=Math.min(3,Math.max(1,Math.floor(Number(options.retries??3))||1));
    for(let attempt=0;attempt<attempts;attempt++){
      check(options.signal);
      try{return await unpack(await readOnce(db,store,key,options.signal),options);}
      catch(error){if(error?.name==='AbortError')throw error;if(attempt+1<attempts&&transient(error)){await pause(20*(attempt+1),options.signal);continue;}throw contextualError(error,db,store,key);}
    }
  }
  const api={pack,unpack,read};Object.defineProperty(api,'workerSource',{value:'('+installLegendsStorageValues.toString()+')(self);'});
  global.LegendsStorageValues=Object.freeze(api);
})(typeof globalThis!=='undefined'?globalThis:window);

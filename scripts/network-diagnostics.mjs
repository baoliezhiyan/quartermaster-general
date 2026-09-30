import {AsyncLocalStorage} from 'node:async_hooks';
/** Bounded, in-memory timing metadata; no commands, card contents or identity tokens. */
export function createNetworkDiagnostics(){
 const context=new AsyncLocalStorage(),requests=[],clients=new Map();
 const sample=s=>{const entry=context.getStore();if(entry&&Number.isFinite(s.ms)&&entry.stages.length<80)entry.stages.push({name:s.name,ms:s.ms,...(s.bytes===undefined?{}:{bytes:s.bytes})});};
 return{sample,
  async run(id,method,fn){const entry={id:String(id??'').slice(0,100),method:['dispatch','sync','seat','view','metrics','exportDiagnostics'].includes(method)?method:'management',at:new Date().toISOString(),stages:[]};return context.run(entry,async()=>{const start=performance.now();try{return await fn(entry);}finally{entry.serverMs=performance.now()-start;if(method!=='metrics'){requests.push(entry);if(requests.length>120)requests.shift();}}});},
  clients(connection,input){if(!Array.isArray(input))return;const safe=input.slice(-30).filter(x=>x&&['http','decode','snapshot_wait','frames'].includes(x.kind)&&Number.isFinite(x.ms)&&x.ms>=0&&x.ms<300000).map(x=>({kind:x.kind,ms:x.ms,...(Number.isFinite(x.bytes)&&x.bytes>=0?{bytes:x.bytes}:{}),...(Number.isFinite(x.serverMs)&&x.serverMs>=0?{serverMs:x.serverMs,transportAndClientMs:Math.max(0,x.ms-x.serverMs)}:{}),...(typeof x.requestId==='string'?{requestId:x.requestId.slice(0,100)}:{})}));if(!safe.length)return;const key=String(connection).slice(0,100);const old=clients.get(key)?.samples??[];clients.delete(key);clients.set(key,{at:new Date().toISOString(),samples:[...old,...safe].slice(-100)});if(clients.size>32)clients.delete(clients.keys().next().value);},
  snapshot(){return{format:'quartermaster-network-timing',version:1,note:'HTTP 减服务器耗时包含线路、收发与客户端处理开销，不是单向网络时延；客户端上报数据仅供诊断。内存保留最近120项请求、32个连接各100项客户端样本。',requests:structuredClone(requests),clients:[...clients].map(([connection,v])=>({connection,...v}))};}
 };
}

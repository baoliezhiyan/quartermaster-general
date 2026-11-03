import {cachedReference} from './local-ai-reference-cache.mjs';
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const started=performance.now();
const args=process.argv.slice(2),command=args[0]??'help';
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
if(command==='help'){console.log('node scripts/local-ai-cli.mjs connect|status|observe|reference|wait|submit|disconnect --config <私有JSON> [--timeout 毫秒] [--request-file UTF8.json]\n配置: {"url":"http://127.0.0.1:4185","token":"个人返回链接中 identity 的值"}\n先在普通网页创建 AI 用户并入座、绑定同阵营国家，再 connect 接管该身份。');process.exit(0);}
try{
 if(!['connect','status','observe','reference','wait','submit','disconnect'].includes(command))throw Object.assign(Error('未知命令'),{code:'INVALID_REQUEST'});
 const configPath=resolve(option('--config',join(root,'local-ai-private/session.json'))),config=await readFile(configPath,'utf8').then(text=>{try{return JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw Object.assign(Error('身份配置不是有效 JSON；未输出文件内容'),{code:'CONFIG'});}});
 const url=new URL(config.url);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw Object.assign(Error('只允许本机 HTTP 房间'),{code:'CONFIG'});
 const cachePath=configPath+'.observation.json';let previous;try{previous=JSON.parse(await readFile(cachePath,'utf8'));}catch{}
 let body={};
 if(command==='wait')body={after:Number(option('--after',previous?.sequence??-1)),timeout:Number(option('--timeout',30000))};
 if(command==='submit'){const file=option('--request-file');if(!file)throw Object.assign(Error('缺少 --request-file'),{code:'INVALID_REQUEST'});body=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}
 const response=await fetch(new URL('/api/local-ai/'+(command==='reference'?'observe':command),url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify(body),signal:AbortSignal.timeout(command==='wait'?70000:120000)});
 const value=await response.json();if(!value.ok)throw Object.assign(Error(value.result?.message??'接口拒绝'),{code:value.result?.code??'REJECTED'});
 if(value.result?.result?.ok===false)throw Object.assign(Error('正式控制器拒绝操作：'+value.result.result.error),{code:'ENGINE_REJECTED'});
 const observation=value.result.observation??(value.result.interfaceVersion?value.result:null);
 if(observation){
  const referencePath=configPath+'.reference.json';
  const reference=await cachedReference(referencePath,observation,async referenceId=>{
   const res=await fetch(new URL('/api/local-ai/reference',url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify({referenceId}),signal:AbortSignal.timeout(30000)});
   const reply=await res.json();if(!reply.ok)throw Object.assign(Error(reply.result?.message??'静态资料读取失败'),{code:reply.result?.code??'REFERENCE_FAILED'});return reply.result;
  });
  value.referenceCache={path:referencePath,id:reference.data.id,digest:reference.digest};
  if(command==='reference')value.result=reference;
  const continuous=previous?.gameId===observation.gameId&&previous?.epoch===observation.epoch;
  value.changes={resync:!continuous,fromSequence:previous?.sequence??null,toSequence:observation.sequence,fields:continuous?Object.fromEntries(['public','mapFacts','reference','privateCountries','decisions','phase','activeSeat','round','status'].filter(k=>JSON.stringify(previous[k])!==JSON.stringify(observation[k])).map(k=>[k,observation[k]])):null};
  await mkdir(dirname(cachePath),{recursive:true});await writeFile(cachePath,JSON.stringify(observation),'utf8');
 }
 await mkdir(join(root,'local-ai-private'),{recursive:true});
 await appendFile(join(root,'local-ai-private/bridge.jsonl'),JSON.stringify({at:new Date().toISOString(),command,ms:performance.now()-started,requestId:body.requestId,ok:true,status:observation?.status,sequence:observation?.sequence})+'\n');
 if(command==='status'){const o=value.result;value.result={interfaceVersion:o.interfaceVersion,gameVersion:o.gameVersion,gameId:o.gameId,serverId:o.serverId,userId:o.userId,name:o.name,bindings:o.bindings,status:o.status,phase:o.phase,decisionSeats:o.decisionSeats,locked:o.locked,replay:o.replay,rules:o.rules,preludeEnabled:o.preludeEnabled};delete value.changes;}
 console.log(JSON.stringify(value,null,2));
}catch(e){const code=e.code??'TRANSPORT';try{await mkdir(join(root,'local-ai-private'),{recursive:true});await appendFile(join(root,'local-ai-private/bridge.jsonl'),JSON.stringify({at:new Date().toISOString(),command,ms:performance.now()-started,ok:false,errorCode:code})+'\n');}catch{}console.log(JSON.stringify({ok:false,error:{code,message:e.message}},null,2));process.exitCode=['STALE','WRONG_GAME'].includes(code)?3:['DISCONNECTED','AUTH','REJECTED','ENGINE_REJECTED'].includes(code)?4:code==='ILLEGAL_CHOICE'||code==='INVALID_REQUEST'?2:5;}

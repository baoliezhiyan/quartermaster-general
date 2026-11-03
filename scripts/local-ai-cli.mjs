import {compactObservationChange,decisionObservation,decisionSummary} from './local-ai-compact.mjs';
import {cachedReference} from './local-ai-reference-cache.mjs';
import {readFile,writeFile,mkdir,appendFile,rename} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),started=performance.now(),args=process.argv.slice(2),command=args[0]??'help';
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
if(command==='help'){console.log('connect|status|observe|reference|wait|submit|submit-action|wait-decision|cancel-wait|result|disconnect\n--config 私有JSON --request-file UTF8.json --compact / --full --wait --wait-id 自选编号\nwait-decision 内部续订，只有本身份新决策或终止事件输出JSON；Ctrl+C 或 cancel-wait 可取消。');process.exit(0);}
const privateDir=resolve(process.env.QM_AI_PRIVATE_DIR||join(root,'local-ai-private'));
let controller=new AbortController(),cancelRemote,stats={httpRequests:0,leases:0,eventsIgnored:0,waitMs:0};
try{
 if(!['connect','status','observe','reference','wait','submit','submit-action','wait-decision','cancel-wait','result','disconnect'].includes(command))throw Object.assign(Error('未知命令'),{code:'INVALID_REQUEST'});
 const configPath=resolve(option('--config',join(root,'local-ai-private/session.json'))),config=await readFile(configPath,'utf8').then(text=>{try{return JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw Object.assign(Error('身份配置JSON无效'),{code:'CONFIG'});}});
 const url=new URL(config.url);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw Object.assign(Error('只允许本机HTTP'),{code:'CONFIG'});
 const deliveredPath=configPath+'.delivered.json';let delivered;try{delivered=JSON.parse(await readFile(deliveredPath,'utf8'));}catch{}
 const cachePath=configPath+'.observation.json';let previous;try{previous=JSON.parse(await readFile(cachePath,'utf8'));}catch{}
 const request=async(operation,body,signal=controller.signal)=>{stats.httpRequests++;const response=await fetch(new URL('/api/local-ai/'+operation,url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(operation==='wait'?70000:120000)])});const v=await response.json();if(!v.ok)throw Object.assign(Error(v.result?.message??'接口拒绝'),{code:v.result?.code??'REJECTED'});return v;};
 let body={},operation=command;
 if(command==='wait')body={after:Number(option('--after',previous?.sequence??-1)),timeout:Number(option('--timeout',30000))};
 if(['submit','submit-action'].includes(command)){const file=option('--request-file');if(!file)throw Object.assign(Error('缺少 --request-file'),{code:'INVALID_REQUEST'});body=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));if(args.includes('--wait'))operation=command+'-wait';}
 if(command==='reference')operation='observe';
 if(command==='result')body={requestId:option('--request-id')};
 const continuous=command==='wait-decision'||operation.endsWith('-wait'),waitFile=configPath+'.wait.json';
 if(continuous){const waitId=option('--wait-id',body.requestId??crypto.randomUUID());let cursor;try{cursor=JSON.parse(await readFile(configPath+'.decision.json','utf8'));}catch{}
  const wait={waitId,leaseMs:Number(option('--lease-ms',25000)),...(command==='wait-decision'?{after:args.includes('--fresh')?null:cursor?.cursor,expected:previous?{gameId:previous.gameId,epoch:previous.epoch,bindings:previous.bindings}:undefined}:{})};
  body=command==='wait-decision'?wait:{...body,wait};await writeFile(waitFile,JSON.stringify({waitId,pid:process.pid}));
  cancelRemote=()=>request('cancel-wait',{waitId},new AbortController().signal).catch(()=>{});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void cancelRemote();controller.abort();});
 }
 if(command==='cancel-wait'){let waitId=option('--wait-id');if(!waitId)waitId=JSON.parse(await readFile(waitFile,'utf8')).waitId;body={waitId};}
 let value,failures=0;
 while(true){try{value=await request(operation,body);failures=0;}catch(e){if(!continuous||e.code||controller.signal.aborted||++failures>3)throw e;await new Promise(r=>setTimeout(r,500*failures));continue;}
  stats.waitMs+=value.result.statistics?.waitMs??0;stats.eventsIgnored+=value.result.statistics?.eventsIgnored??0;
  if(continuous&&value.result.leaseExpired){stats.leases++;continue;}break;
 }
 if(value.result?.result?.ok===false)throw Object.assign(Error('正式控制器拒绝：'+value.result.result.error),{code:'ENGINE_REJECTED'});
 const observation=value.result.observation??(value.result.interfaceVersion?value.result:null);
 if(observation){
  const referencePath=configPath+'.reference.json';const reference=await cachedReference(referencePath,observation,async referenceId=>(await request('reference',{referenceId})).result);
  value.referenceCache={path:referencePath,id:reference.data.id,digest:reference.digest};if(command==='reference')value.result=reference;
  const same=previous?.gameId===observation.gameId&&previous?.epoch===observation.epoch;
  value.changes={resync:!same,fromSequence:previous?.sequence??null,toSequence:observation.sequence,fields:same?Object.fromEntries(['public','mapFacts','reference','privateCountries','decisions','phase','activeSeat','round','status'].filter(k=>JSON.stringify(previous[k])!==JSON.stringify(observation[k])).map(k=>[k,observation[k]])):null};
  await mkdir(dirname(cachePath),{recursive:true});await writeFile(cachePath,JSON.stringify(observation),'utf8');
  if(value.result.cursor!==undefined)await writeFile(configPath+'.decision.json',JSON.stringify({cursor:value.result.cursor}));
 }
 if(command==='status'){const o=value.result;value.result={interfaceVersion:o.interfaceVersion,gameVersion:o.gameVersion,gameId:o.gameId,serverId:o.serverId,userId:o.userId,name:o.name,bindings:o.bindings,status:o.status,phase:o.phase,decisionSeats:o.decisionSeats,locked:o.locked,replay:o.replay,rules:o.rules};delete value.changes;}
 if(observation&&!['status','reference'].includes(command)){
  if(args.includes('--compact')||(['submit-action','wait-decision'].includes(command)||operation.endsWith('-wait'))&&!args.includes('--full')){
   value.changes=compactObservationChange(delivered,observation);const shown=value.changes.mode==='snapshot'?value.changes.snapshot:decisionSummary(observation);
   if(value.result===observation)value.result=shown;else value.result.observation=shown;
  }
  const temp=deliveredPath+'.'+crypto.randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(decisionObservation(observation)));await rename(temp,deliveredPath);
 }
 value.statistics={...stats,totalMs:performance.now()-started};await mkdir(privateDir,{recursive:true});await appendFile(join(privateDir,'bridge.jsonl'),JSON.stringify({at:new Date().toISOString(),command,requestId:body.requestId,ok:true,...value.statistics})+'\n');
 console.log(JSON.stringify(value,null,2));if(value.result.receipt?.status==='rejected')process.exitCode=2;
}catch(e){const code=controller.signal.aborted?'CANCELLED':e.code??'TRANSPORT';try{await mkdir(privateDir,{recursive:true});await appendFile(join(privateDir,'bridge.jsonl'),JSON.stringify({at:new Date().toISOString(),command,ms:performance.now()-started,ok:false,errorCode:code,...stats})+'\n');}catch{}console.log(JSON.stringify({ok:false,error:{code,message:code==='CANCELLED'?'等待已取消':e.message},statistics:stats},null,2));process.exitCode=code==='CANCELLED'?130:['STALE','WRONG_GAME'].includes(code)?3:['DISCONNECTED','AUTH','REJECTED','ENGINE_REJECTED'].includes(code)?4:['ILLEGAL_CHOICE','INVALID_REQUEST','DUPLICATE_CONFLICT'].includes(code)?2:5;}

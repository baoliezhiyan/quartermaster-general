import {build} from 'vite';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createWriteStream,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

const args=process.argv.slice(2);
const get=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const logPath=get('--log',null);
const logSnapshots=args.includes('--log-snapshots');
const bundlePath=get('--bundle',null);
const entryPath=get('--entry','src/training/ppoArena.ts');
let code;
if(bundlePath&&existsSync(bundlePath))code=readFileSync(bundlePath,'utf8');
else {
  const compiled=await build({configFile:false,logLevel:'silent',build:{ssr:entryPath,
    write:false,rollupOptions:{input:entryPath}}});
  code=compiled.output[0].code;
  if(bundlePath){mkdirSync(dirname(resolve(bundlePath)),{recursive:true});writeFileSync(bundlePath,code,'utf8');}
}
const fingerprint=createHash('sha256').update(code).digest('hex');
const {PpoTrainingArena,PPO_STATIC_SCHEMA}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
let arena=null;
let log=null;
if(logPath){const path=resolve(logPath);mkdirSync(dirname(path),{recursive:true});log=createWriteStream(path,{encoding:'utf8'});}
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const record=value=>{if(log)log.write(`${JSON.stringify(value)}\n`);};
send({ready:true,buildFingerprint:fingerprint,staticSchema:PPO_STATIC_SCHEMA});
const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){
  let request;
  try{request=JSON.parse(line);let response;
    const operationStarted=process.hrtime.bigint();
    if(request.op==='reset'){
      arena=new PpoTrainingArena(request.seed,request.gameId??`ppo-${request.seed}`,{
        mode:request.mode,cardSet:request.cardSet??'events',
        buildFingerprint:fingerprint,trace:request.trace??'none',captureReplay:logSnapshots});
      record({recordType:'AI训练记录',logFormat:'quartermaster-ppo-training-jsonl-v2',
        trainingMetadata:request.recordMetadata??null,...arena.header});
      response={observation:arena.observe(),header:arena.header};
      if(logSnapshots)record({recordType:'state',decisionCount:arena.decisions,
        snapshot:arena.exportSnapshot()});
    }else if(request.op==='step'){
      if(!arena)throw new Error('Reset the arena first');
      response=arena.step(request.action);
      if(response.record)record(response.record);
      if(logSnapshots)record({recordType:'state',decisionCount:arena.decisions,
        snapshot:arena.exportSnapshot()});
      if(response.result)record({recordType:'result',...response.result});
    }else if(request.op==='truncate'){
      if(!arena)throw new Error('Reset the arena first');
      response={result:arena.truncate(request.reason)};
      record({recordType:'result',...response.result});
    }else if(request.op==='snapshot'){
      if(!arena)throw new Error('Reset the arena first');
      response={snapshot:arena.exportSnapshot()};
    }else if(request.op==='restore'){
      arena=PpoTrainingArena.fromSnapshot(request.snapshot,{mode:request.snapshot.header.mode,
        cardSet:request.snapshot.header.cardSet,buildFingerprint:fingerprint,trace:request.trace??'none'});
      response={observation:arena.observe(),header:arena.header,result:arena.result};
    }else if(request.op==='close'){
      send({ok:true});break;
    }else throw new Error('Unknown operation');
    const operationSeconds=Number(process.hrtime.bigint()-operationStarted)/1e9;
    send({ok:true,tag:request.tag??null,operationSeconds,...response});
  }catch(error){send({ok:false,error:error instanceof Error?error.message:String(error)});}
}
if(log)await new Promise(done=>log.end(done));
process.exit(0);

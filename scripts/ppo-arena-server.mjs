import {build} from 'vite';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createWriteStream,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

const args=process.argv.slice(2);
const get=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const logPath=get('--log',null);
const compiled=await build({configFile:false,logLevel:'silent',build:{ssr:'src/training/ppoArena.ts',
  write:false,rollupOptions:{input:'src/training/ppoArena.ts'}}});
const code=compiled.output[0].code;
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
    if(request.op==='reset'){
      arena=new PpoTrainingArena(request.seed,request.gameId??`ppo-${request.seed}`,{
        mode:request.mode,cardSet:request.cardSet??'events',
        buildFingerprint:fingerprint,trace:request.trace??'none'});
      record({recordType:'AI训练记录',...arena.header});
      response={observation:arena.observe(),header:arena.header};
    }else if(request.op==='step'){
      if(!arena)throw new Error('Reset the arena first');
      response=arena.step(request.action);
      if(response.record)record(response.record);
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
    send({ok:true,...response});
  }catch(error){send({ok:false,error:error instanceof Error?error.message:String(error)});}
}
if(log)await new Promise(done=>log.end(done));
process.exit(0);

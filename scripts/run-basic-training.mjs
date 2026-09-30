import { build } from 'vite';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const args=process.argv.slice(2);
const option=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
const count=Number(option('--games','1'));
const firstSeed=Number(option('--seed','1'));
const output=resolve(option('--out','outputs/ai-training-records.jsonl'));
const metricsOutput=option('--metrics-out',null);
const maxDecisions=Number(option('--max-decisions','2000'));
const trace=option('--trace','full');
const policy=option('--policy','uniform');
if(!['none','summary','full'].includes(trace))throw new Error('--trace must be none, summary, or full');
if(!['uniform','biased'].includes(policy))throw new Error('--policy must be uniform or biased');
if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(firstSeed)||firstSeed<0||firstSeed+count-1>0xffffffff||!Number.isSafeInteger(maxDecisions)||maxDecisions<1) {
  throw new Error('Usage: node scripts/run-basic-training.mjs --games 1 --seed 1 --out outputs/ai-training-records.jsonl [--max-decisions 2000]');
}
const compiled=await build({configFile:false,logLevel:'silent',build:{ssr:'src/training/basicArena.ts',write:false,rollupOptions:{input:'src/training/basicArena.ts'}}});
const code=compiled.output[0].code;
const {BasicTrainingArena,basicActionWeight}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const buildFingerprint=createHash('sha256').update(code).digest('hex');
mkdirSync(dirname(output),{recursive:true});
const stream=createWriteStream(output,{encoding:'utf8'});
const line=async item=>{if(!stream.write(`${JSON.stringify(item)}\n`))await once(stream,'drain');};
const processCpuMs=(after,before)=>(after.user-before.user+after.system-before.system)/1000;
const cpuCounters=()=>os.cpus().map(c=>({...c.times}));
const systemCpuPercent=(start,end)=>{
  let busy=0,total=0;
  for(let i=0;i<start.length;i++){
    const a=start[i],b=end[i];
    for(const key of Object.keys(a)){const delta=b[key]-a[key];total+=delta;if(key!=='idle')busy+=delta;}
  }
  return total?busy/total*100:0;
};
const resourceCounts=header=>Object.fromEntries(Object.entries(header.basicCardCounts).map(([seat,counts])=>
  [seat,Object.fromEntries(Object.keys(counts).map(type=>[type,0]))]));
const results=[];
const logicalProcessors=os.cpus().length;
try {
  for(let game=0;game<count;game++){
    const seed=firstSeed+game;
    const policySeed=(seed^0x9e3779b9)>>>0;
    const arena=new BasicTrainingArena(seed,`training-${seed}-${game}`,
      {trace,keepRecords:false,buildFingerprint,requireBuildFingerprint:true,
        policyId:`${policy}-legal-v1`,policySeed});
    await line(arena.header);
    const usage=resourceCounts(arena.header);
    let passes=0,emptyBattles=0,repeatedBuilds=0;
    const wallStart=process.hrtime.bigint(),cpuStart=process.cpuUsage(),systemStart=cpuCounters();
    const memoryTotal=os.totalmem();
    let peakRss=process.memoryUsage().rss,peakHeap=process.memoryUsage().heapUsed;
    let peakSystemUsed=memoryTotal-os.freemem();
    const sample=()=>{
      const mem=process.memoryUsage();
      peakRss=Math.max(peakRss,mem.rss);peakHeap=Math.max(peakHeap,mem.heapUsed);
      peakSystemUsed=Math.max(peakSystemUsed,memoryTotal-os.freemem());
    };
    const timer=setInterval(sample,25);
    timer.unref();
    // Equal-probability choice among every current legal candidate, including pass.
    // Rejection sampling removes modulo bias from the deterministic seeded RNG.
    let random=policySeed;
    const randomIndex=n=>{
      const limit=0x100000000-(0x100000000%n);
      do{random=(Math.imul(random,1664525)+1013904223)>>>0;}while(random>=limit);
      return random%n;
    };
    const choose=obs=>{
      if(policy==='uniform')return obs.candidates[randomIndex(obs.candidates.length)];
      const weights=obs.candidates.map(action=>basicActionWeight(obs,action));
      const total=weights.reduce((a,b)=>a+b,0);
      const fraction=randomIndex(0x1000000)/0x1000000;
      let draw=fraction*total;
      for(let i=0;i<weights.length;i++){draw-=weights[i];if(draw<0)return obs.candidates[i];}
      return obs.candidates.at(-1);
    };
    try {
      while(!arena.done){
        if(arena.decisions>=maxDecisions){arena.truncate();break;}
        const obs=arena.observe();
        const selected=choose(obs);
        if(selected.kind==='pass')passes++;
        else {
          usage[obs.activeSeat][selected.cardType]++;
          if((selected.cardType==='land_battle'||selected.cardType==='sea_battle')&&!selected.option.defenderId)emptyBattles++;
          if(selected.kind==='play'&&(selected.cardType==='build_army'||selected.cardType==='build_navy')&&
              obs.units.some(u=>u.country===obs.activeSeat&&u.regionId===selected.option.regionId&&u.type===(selected.cardType==='build_army'?'army':'navy')))repeatedBuilds++;
        }
        const {record}=arena.step({...obs.decision,actionId:selected.id});
        if(record)await line(record);
        sample();
      }
    } finally {
      clearInterval(timer);
    }
    await line(arena.result);
    sample();
    const wallMs=Number(process.hrtime.bigint()-wallStart)/1e6;
    const cpuMs=processCpuMs(process.cpuUsage(),cpuStart);
    const systemCpu=systemCpuPercent(systemStart,cpuCounters());
    const remaining=Object.fromEntries(Object.entries(arena.header.basicCardCounts).map(([seat,counts])=>
      [seat,Object.fromEntries(Object.entries(counts).map(([type,initial])=>[type,initial-usage[seat][type]]))]));
    results.push({seed,termination:arena.result.termination,winner:arena.result.winner,
      victoryReason:arena.result.victoryReason,round:arena.result.round,
      decisions:arena.decisions,resourceUsage:{spent:usage,remaining,passes,emptyBattles,repeatedBuilds},
      performance:{wallMs,cpuMs,cpuOneCorePercent:cpuMs/wallMs*100,
        cpuMachineCapacityPercent:cpuMs/wallMs/logicalProcessors*100,systemCpuPercent:systemCpu,
        peakProcessRssMiB:peakRss/1048576,peakProcessHeapMiB:peakHeap/1048576,
        peakSystemMemoryUsedPercent:peakSystemUsed/memoryTotal*100}});
  }
} finally {
  stream.end();
  await once(stream,'close');
}
if(metricsOutput){const path=resolve(metricsOutput);mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify({format:'quartermaster-basic-benchmark-v2',policy:`${policy}-legal-v1`,trace,buildFingerprint,
    seed:firstSeed,games:count,logicalProcessors,systemMemoryGiB:os.totalmem()/1073741824,
    output,results},null,2),'utf8');}
process.stdout.write(`${JSON.stringify({output,games:results},null,2)}\n`);

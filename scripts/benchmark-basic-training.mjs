import { build } from 'vite';

const games=Number(process.argv[2]??10);
const firstSeed=Number(process.argv[3]??280901);
if(!Number.isSafeInteger(games)||games<1||!Number.isSafeInteger(firstSeed))throw new Error('Usage: benchmark-basic-training.mjs [games] [firstSeed]');
const compiled=await build({configFile:false,logLevel:'silent',build:{ssr:'src/training/basicArena.ts',write:false,
  rollupOptions:{input:'src/training/basicArena.ts'}}});
const {BasicTrainingArena}=await import(`data:text/javascript;base64,${Buffer.from(compiled.output[0].code).toString('base64')}`);

function run(fast,seed) {
  const arena=new BasicTrainingArena(seed,`benchmark-${seed}`,{trace:'none'});
  // The comparison deliberately toggles this internal optimization flag only.
  arena.state.trainingBasicOnly=fast;
  let random=(seed^0x9e3779b9)>>>0;
  const randomIndex=n=>{const limit=0x100000000-(0x100000000%n);
    do{random=(Math.imul(random,1664525)+1013904223)>>>0;}while(random>=limit);
    return random%n;};
  const start=process.hrtime.bigint(),cpu=process.cpuUsage();
  while(!arena.done){const obs=arena.observe(),selected=obs.candidates[randomIndex(obs.candidates.length)];
    arena.step({...obs.decision,actionId:selected.id});}
  const elapsedMs=Number(process.hrtime.bigint()-start)/1e6;
  const usage=process.cpuUsage(cpu);
  return {seed,fast,decisions:arena.decisions,round:arena.result.round,winner:arena.result.winner,
    elapsedMs,cpuMs:(usage.user+usage.system)/1000};
}
run(false,firstSeed);run(true,firstSeed);
const batches=[];
for(const fast of [false,true,true,false]){
  const results=[];for(let i=0;i<games;i++)results.push(run(fast,firstSeed+i));
  batches.push({fast,results,elapsedMs:results.reduce((n,r)=>n+r.elapsedMs,0),cpuMs:results.reduce((n,r)=>n+r.cpuMs,0)});
}
for(let i=1;i<batches.length;i++)for(let j=0;j<games;j++){
  const a=batches[0].results[j],b=batches[i].results[j];
  if(a.decisions!==b.decisions||a.round!==b.round||a.winner!==b.winner)
    throw new Error(`Different result at seed ${a.seed}`);
}
process.stdout.write(`${JSON.stringify({games,firstSeed,batches:batches.map(({fast,elapsedMs,cpuMs})=>({fast,elapsedMs,cpuMs}))},null,2)}\n`);

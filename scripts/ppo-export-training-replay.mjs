import {build} from 'vite';
import {readFile,writeFile} from 'node:fs/promises';

const [source,target]=process.argv.slice(2);
if(!source||!target)throw Error('Usage: node scripts/ppo-export-training-replay.mjs raw.jsonl replay.jsonl');
try{
  const bundle=await build({configFile:false,logLevel:'silent',build:{ssr:'src/training/trainingReplayExport.ts',
    write:false,rollupOptions:{input:'src/training/trainingReplayExport.ts'}}});
  const code=bundle.output[0].code;
  const {exportTrainingReplay}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const result=await exportTrainingReplay(await readFile(source,'utf8'));
  await writeFile(target,result,'utf8');
  console.log(JSON.stringify({format:'quartermaster-match-log',mode:'resource_pool',
    bytes:Buffer.byteLength(result),lines:result.split('\n').length-1}));
}catch(error){console.error('Training replay export failed: '+(error instanceof Error?error.message:String(error)));
  process.exitCode=1;}

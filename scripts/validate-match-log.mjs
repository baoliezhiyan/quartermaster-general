import {readFile,access} from 'node:fs/promises';
let modulePath=new URL('../dist-server/Room.mjs',import.meta.url);try{await access(modulePath);}catch{modulePath=new URL('../dist-server/Room.js',import.meta.url);}
const {parseReplay,ReplayPlayer,parseTrainingReplay,TrainingController}=await import(modulePath.href);
try{
 if(!process.argv[2])throw Error('用法：node scripts/validate-match-log.mjs <文件> [--replay]');
 const text=await readFile(process.argv[2],'utf8');
 if(JSON.parse(text.split('\n')[0]).mode==='resource_pool'){const a=await parseTrainingReplay(text);if(process.argv.includes('--replay'))await new TrainingController(a).checkReplay();console.log(JSON.stringify({valid:true,formatVersion:3,mode:'resource_pool',adapter:a.header.replayAdapter,steps:a.steps.length,integrity:'verified',sceneReexecuted:process.argv.includes('--replay')},null,2));process.exit(0);}
 const a=await parseReplay(text);
 const replay=process.argv.includes('--replay');if(replay&&a.groups.length)await new ReplayPlayer(a).seek(a.groups.at(-1).root.actionId,true,true);
 console.log(JSON.stringify({valid:true,formatVersion:a.header.formatVersion,gameVersion:a.header.gameVersion,groups:a.groups.length,recordingRevision:a.header.recordingRevision,integrity:'verified',rulesReexecuted:replay},null,2));
}catch(e){console.error(JSON.stringify({valid:false,error:e.message}));process.exitCode=1;}

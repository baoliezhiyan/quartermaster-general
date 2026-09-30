import {createHash} from 'node:crypto';
/** Materialized host JSONL archive. The session journal is the recovery authority.
 * Publication waits for BOTH writes; errors latch the writer until restart.
 * On restart replay the committed journal to repair a failed materialization.
 */
import {mkdir,readFile,open,rename} from 'node:fs/promises';
import {join} from 'node:path';
export function withMatchLogs(store,directory){
 let failed=null,queue=Promise.resolve(),active=null;
 function seal(records,reason){const prefix=records.map(r=>JSON.stringify(r)).join('\n')+'\n',state=records.at(-1).state;return prefix+JSON.stringify({recordType:'end',seq:records.length,lastStateSeq:records.length-1,recordingStatus:state.gameStatus==='finished'?'complete':'partial',stopReason:reason,gameStatus:state.gameStatus,winner:state.result?.winner??null,victoryReason:state.result?.victoryReason??null,finalScores:state.scores,frameCount:records.length-2,decisionCount:records.filter(r=>r.action).length,prefixSha256:createHash('sha256').update(prefix).digest('hex')})+'\n';}
 async function replace(path,text){const file=await open(path+'.tmp','w');try{await file.writeFile(text);await file.sync();}finally{await file.close();}await rename(path+'.tmp',path);}
 async function materialize(session){
  const r=session?.matchRecording;if(!r)return;
  const h=r.records[0];if(!/^[a-zA-Z0-9-]+$/.test(h.recordingId))throw Error('Invalid recording ID');
  await mkdir(directory,{recursive:true});const path=join(directory,h.recordingId+'.qmreplay.jsonl');
  // Immutable prefix objects are shared by the controller. Ordinary commits
  // serialize and append ONLY the new suffix, without rereading the old file.
  if(active?.path===path&&active.records.at(-1).state.gameStatus!=='finished'&&r.records.at(-1).state.gameStatus!=='finished'&&active.records.length<=r.records.length&&active.records.every((entry,i)=>entry===r.records[i])){
   const suffix=r.records.slice(active.records.length).map(x=>JSON.stringify(x)).join('\n');
   if(suffix){const file=await open(path,'a');try{await file.writeFile(suffix+'\n');await file.sync();}finally{await file.close();}}
   active={path,records:r.records};return;
  }
  const text=r.records.at(-1).state.gameStatus==='finished'?seal(r.records,'natural_game_end'):r.records.map(x=>JSON.stringify(x)).join('\n')+'\n';
  if(!active){try{const previous=JSON.parse(await readFile(join(directory,'.active-recording.json'),'utf8'));if(previous.recordingId!==h.recordingId&&/^[a-zA-Z0-9-]+$/.test(previous.recordingId)){const previousPath=join(directory,previous.recordingId+'.qmreplay.jsonl'),raw=await readFile(previousPath,'utf8');if(!raw.endsWith('\n'))throw Error('旧对局记录尾行损坏，不能自动封口');const records=raw.trimEnd().split('\n').map(line=>JSON.parse(line));if(records.at(-1)?.recordType!=='end')active={path:previousPath,records};}}catch(e){if(e.code!=='ENOENT')throw e;}}
  if(active&&active.path!==path)await replace(active.path,seal(active.records,active.records.at(-1).state.gameStatus==='finished'?'natural_game_end':'interrupted'));
  active={path,records:r.records};let old='';try{old=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(old===text){await replace(join(directory,'.active-recording.json'),JSON.stringify({recordingId:h.recordingId}));return;}
  if(text.startsWith(old)&&old.endsWith('\n')){const file=await open(path,'a');try{await file.writeFile(text.slice(old.length));await file.sync();}finally{await file.close();}}
  else{const temp=path+'.tmp',file=await open(temp,'w');try{await file.writeFile(text);await file.sync();}finally{await file.close();}await rename(temp,path);}
  await replace(join(directory,'.active-recording.json'),JSON.stringify({recordingId:h.recordingId}));
 }
 return {...store,async read(id){const s=await store.read(id);await materialize(s);return s;},list:()=>store.list(),write(session,...args){const task=queue.then(async()=>{if(failed)throw Error('对局记录写入失败，已停止提交。请重启恢复：'+failed);try{await store.write(session,...args);await materialize(session);}catch(e){failed=e.message;throw e;}});queue=task.catch(()=>{});return task;}};
}

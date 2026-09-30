import {mkdir,open,rename} from 'node:fs/promises';
import {join} from 'node:path';
/** Journal and materialization serialize together. Pending groups are replaced
 * atomically; immutable completed prefixes append. Exports seal a copy. */
export function withMatchLogs(store,directory){
 let failed=null,queue=Promise.resolve(),active=null;
 async function materialize(session){
  const records=session?.actionRecording?.records;if(!records)return;
  const h=records[0];if(h.type!=='header'||h.formatVersion!==3||!/^[a-zA-Z0-9-]+$/.test(h.recordingId))throw Error('Invalid action recording');
  await mkdir(directory,{recursive:true});const path=join(directory,h.recordingId+'.qmreplay.jsonl');
  const append=active?.path===path&&active.records.length<=records.length&&active.records.every((r,i)=>r===records[i]);
  const text=(append?records.slice(active.records.length):records).map(r=>JSON.stringify(r)).join('\n');
  if(append&&!text)return;
  const target=append?path:path+'.tmp',file=await open(target,append?'a':'w');
  try{await file.writeFile(text+'\n');await file.sync();}finally{await file.close();}
  if(!append)await rename(target,path);
  active={path,records};
 }
 function serialize(run){const task=queue.then(async()=>{if(failed)throw Error('对局记录写入失败，已停止提交。请重启恢复：'+failed);try{return await run();}catch(e){failed=e.message;throw e;}});queue=task.catch(()=>{});return task;}
 return {...store,list:()=>store.list(),read:id=>serialize(async()=>{const s=await store.read(id);await materialize(s);return s;}),write:(session,...args)=>serialize(async()=>{await store.write(session,...args);await materialize(session);})};
}

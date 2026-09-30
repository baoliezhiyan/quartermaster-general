import {readFile,open,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

/** One writer (the server's data-directory lock), durable append before acknowledgement. */
export function createJournalStore(directory,{diff,apply,checkpointEvery=50,maxJournalBytes=16*1024*1024,onMetric=()=>{},onWarning=()=>{},fault=async()=>{}}){
 let base=null,generation='',sequence=0,checkpointSequence=0,bytes=0,loaded=false,poisoned=false,resetPending=false;
 const checkpoint=join(directory,'current-game.json'),journal=join(directory,'current-game.journal');
 const checksum=p=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
 const read=async path=>{try{return await readFile(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
 async function atomic(path,text){const f=await open(path+'.tmp','w');try{await f.writeFile(text);await f.sync();}finally{await f.close();}await fault('before_rename');await rename(path+'.tmp',path);}
 async function load(){
  if(loaded)return;await mkdir(directory,{recursive:true});const file=await read(checkpoint);
  if(!file){loaded=true;return;}
  const parsed=JSON.parse(file.toString('utf8'));
  if(parsed.format!=='quartermaster-checkpoint'){base=parsed;loaded=true;return;}
  if(parsed.version!==1||typeof parsed.generation!=='string'||!Number.isSafeInteger(parsed.sequence)||parsed.sequence<0||checksum(parsed.session)!==parsed.sha256)throw Error('存档检查点校验失败');
  base=parsed.session;generation=parsed.generation;sequence=checkpointSequence=parsed.sequence;
  const raw=await read(journal);
  if(raw){
   const end=raw.lastIndexOf(10)+1;
   for(const line of raw.subarray(0,end).toString('utf8').split('\n')){
    if(!line)continue;const record=JSON.parse(line),p=record.payload;
    if(!p||checksum(p)!==record.sha256)throw Error('操作日志校验失败，不能跳过已确认的记录');
    if(p.generation!==generation||p.sequence<=checkpointSequence)continue;
    if(p.sequence!==sequence+1||p.base!==base.updatedAt||!Array.isArray(p.patch))throw Error('操作日志校验失败，不能跳过已确认的记录');
    base=apply(base,p.patch);sequence=p.sequence;
   }
   // A crash may leave an unacknowledged partial final record; remove only that tail.
   if(end!==raw.length){const f=await open(journal,'r+');try{await f.truncate(end);await f.sync();}finally{await f.close();}}
   bytes=end;
  }
  loaded=true;
 }
 async function saveCheckpoint(session,newGeneration=generation,newSequence=sequence){
  const start=performance.now(),text=JSON.stringify({format:'quartermaster-checkpoint',version:1,generation:newGeneration,sequence:newSequence,session,sha256:checksum(session)});
  await atomic(checkpoint,text);onMetric({name:'checkpoint_write',ms:performance.now()-start,bytes:Buffer.byteLength(text)});
 }
 async function resetJournal(){await atomic(journal,'');bytes=0;resetPending=false;}
 return {
  read:async id=>{await load();return base&&(!id||base.state.gameId===id)?base:null;},
  list:async()=>[],
  async write(session,expectedUpdatedAt,replaceExisting=false){
   await load();if(poisoned)throw Error('日志写入状态异常，请重启服务后恢复对局');
   if(expectedUpdatedAt&&base?.updatedAt!==expectedUpdatedAt)throw Error('存档版本已变化');
   if(!generation||!base||replaceExisting||session.state.gameId!==base.state.gameId){
    const nextGeneration=randomUUID();await saveCheckpoint(session,nextGeneration,0);
    base=session;generation=nextGeneration;sequence=checkpointSequence=0;resetPending=true;
    try{await resetJournal();}catch(e){onWarning('新检查点已保存；旧日志清理将在下次写入前重试：'+e.message);}
    return;
   }
   if(resetPending)await resetJournal();
   const start=performance.now(),patch=diff(base,session);
   const payload={generation,sequence:sequence+1,base:base.updatedAt,patch};
   const line=JSON.stringify({payload,sha256:checksum(payload)})+'\n';
   onMetric({name:'journal_encode',ms:performance.now()-start,bytes:Buffer.byteLength(line)});
   const writeStart=performance.now(),f=await open(journal,'r+').catch(e=>{if(e.code==='ENOENT')return open(journal,'w+');throw e;}),size=(await f.stat()).size;
   try{await fault('before_append');const buffer=Buffer.from(line);let offset=0;while(offset<buffer.length){const result=await f.write(buffer,offset,buffer.length-offset,size+offset);if(!result.bytesWritten)throw Error('日志写入未完成');offset+=result.bytesWritten;}await fault('before_sync');await f.sync();}
   catch(e){try{await f.truncate(size);await f.sync();}catch{poisoned=true;}throw e;}
   finally{await f.close();}
   onMetric({name:'journal_fsync',ms:performance.now()-writeStart,bytes:Buffer.byteLength(line)});
   base=session;sequence++;bytes+=Buffer.byteLength(line);
   if(sequence-checkpointSequence>=checkpointEvery||bytes>=maxJournalBytes){
    try{await saveCheckpoint(base);checkpointSequence=sequence;await resetJournal();}
    catch(e){onWarning('检查点暂未整理，已确认操作仍保存在日志中：'+e.message);}
   }
  },
 };
}

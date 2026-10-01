import {it,expect} from 'vitest';
// @ts-expect-error Node-only test dependency.
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
// @ts-expect-error Node-only test dependency.
import {join} from 'node:path';
// @ts-expect-error Node-only test dependency.
import {tmpdir} from 'node:os';
// @ts-expect-error Node-only test dependency.
import {withMatchLogs} from '../scripts/match-log-store.mjs';
import {SEATS} from '../src/core';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay} from '../src/actionReplay/codec';

import type {SaveSession} from '../src/controller/saveFormat';
it('host appends live JSONL, atomically truncates suffix and retains an interrupted external origin',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qm-facts-test-'));let saved:SaveSession|null=null;
 try{const underlying={read:async()=>saved,list:async()=>[],write:async(s:SaveSession)=>{saved=s;}};const store=withMatchLogs(underlying,dir),c=new LocalGameController(store,true);while(!c.getSessionInfo().ready)await new Promise(r=>setTimeout(r,1));await c.dispatch({type:'CREATE_GAME',gameId:'disk',seed:1,mode:'FULL'});
 const name=(await readdir(dir)).find((s:string)=>s.endsWith('.jsonl'))!,path=join(dir,name),first=await readFile(path,'utf8');expect(first.endsWith('\n')).toBe(true);expect(first).not.toContain('"recordType":"end"');
 const s=c.getSnapshot()!;await c.dispatch({type:'KEEP_OPENING',seat:'germany',expectedRevision:s.revision,cardIds:s.decks.germany.hand.slice(0,7).map(c=>c.id)});expect((await readFile(path,'utf8')).startsWith(first)).toBe(true);
 const download=await c.exportReplay();await parseReplay(download);expect(await readFile(path,'utf8')).not.toContain('"recordType":"end"');
 for(let i=1;i<6;i++){const s=c.getSnapshot()!;await c.dispatch({type:'KEEP_OPENING',seat:SEATS[i],expectedRevision:s.revision,cardIds:s.decks[SEATS[i]].hand.slice(0,7).map(v=>v.id)});}
 while(c.getSnapshot()!.resolution?.choice){const s=c.getSnapshot()!,q=s.resolution!.choice!;expect(await c.dispatch({type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:q.options.slice(0,q.min).map(o=>o.id)})).toEqual({ok:true});}
 const before=await c.exportReplay();expect(await c.dispatch({type:'ADVANCE_PHASE',seat:c.getSnapshot()!.activeSeat,expectedRevision:c.getSnapshot()!.revision})).toEqual({ok:true});await c.undo();const after=await parseReplay(await c.exportReplay());expect(after.groups).toEqual((await parseReplay(before)).groups);const disk=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);expect(disk).toHaveLength(after.end.seq);expect(disk[0].recordingRevision).toBe(after.header.recordingRevision);
 const external=new LocalGameController();await external.dispatch({type:'CREATE_GAME',gameId:'other',seed:13});await c.importSave(await external.exportSave());expect((await readdir(dir)).filter((s:string)=>s.endsWith('.jsonl'))).toHaveLength(2);expect(await readFile(path,'utf8')).toBe(disk.map(JSON.stringify).join('\n')+'\n');

 }finally{await rm(dir,{recursive:true,force:true});}
},60000);
it('disk failure is visible, prevents state publication and latches later writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qm-facts-fault-'));try{const bad=join(dir,'not-a-directory');await writeFile(bad,'x');let saved:SaveSession|null=null;const c=new LocalGameController(withMatchLogs({read:async()=>saved,list:async()=>[],write:async(s:SaveSession)=>{saved=s;}},bad),true);while(!c.getSessionInfo().ready)await new Promise(r=>setTimeout(r,1));await expect(c.dispatch({type:'CREATE_GAME',gameId:'failure',seed:1})).rejects.toThrow('未提交');expect(c.getSnapshot()).toBeNull();expect(c.getSessionInfo().storageError).toContain('保存失败');await expect(c.dispatch({type:'CREATE_GAME',gameId:'failure2',seed:2})).rejects.toThrow('未提交');}finally{await rm(dir,{recursive:true,force:true});}
});
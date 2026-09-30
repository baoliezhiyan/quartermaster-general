import {it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createJournalStore} from '../scripts/journal-store.mjs';
import {diffValue,applyPatch} from '../src/network/jsonPatch.ts';
import {LocalGameController} from '../src/controller/LocalGameController.ts';
import {validateSession,verifyReplay} from '../src/controller/saveFormat.ts';
const options={diff:diffValue,apply:applyPatch,checkpointEvery:3};
const state=(n,gameId='game')=>({state:{gameId,revision:n},updatedAt:String(n),history:Array.from({length:n},(_,i)=>({text:'中文'+i}))});
const dir=()=>mkdtemp(join(tmpdir(),'qm-journal-'));
it('recovers consecutive durable patches and checkpoint rotations without duplicates',async()=>{
 const d=await dir(),store=createJournalStore(d,options);for(let i=0;i<9;i++)await store.write(state(i),i?String(i-1):undefined);
 const restored=await createJournalStore(d,options).read();expect(restored).toEqual(state(8));
});
it('drops only an unacknowledged partial tail and can append after restart',async()=>{
 const d=await dir(),s=createJournalStore(d,options);await s.write(state(0));await s.write(state(1),'0');await appendFile(join(d,'current-game.journal'),'{"payload":{"broken":');
 const recovered=createJournalStore(d,options);expect(await recovered.read()).toEqual(state(1));await recovered.write(state(2),'1');expect(await createJournalStore(d,options).read()).toEqual(state(2));
});
it('rejects a corrupt complete record instead of silently losing confirmed actions',async()=>{
 const d=await dir(),s=createJournalStore(d,options);await s.write(state(0));await s.write(state(1),'0');const p=join(d,'current-game.journal'),text=await readFile(p,'utf8');await writeFile(p,text.replace('中文0','损坏0'));await expect(createJournalStore(d,options).read()).rejects.toThrow('校验失败');
});
it('rolls back a failed append and does not publish the failed action',async()=>{
 const d=await dir();let fail=false;const s=createJournalStore(d,{...options,fault:async stage=>{if(fail&&stage==='before_sync')throw Error('disk failure');}});await s.write(state(0));fail=true;await expect(s.write(state(1),'0')).rejects.toThrow('disk failure');expect(await createJournalStore(d,options).read()).toEqual(state(0));fail=false;await s.write(state(1),'0');expect(await createJournalStore(d,options).read()).toEqual(state(1));
});
it('retains acknowledged journals when checkpoint consolidation fails',async()=>{
 const d=await dir();let fail=false;const warnings=[];const s=createJournalStore(d,{...options,checkpointEvery:1,onWarning:x=>warnings.push(x),fault:async stage=>{if(fail&&stage==='before_rename')throw Error('checkpoint failure');}});await s.write(state(0));fail=true;await s.write(state(1),'0');expect(warnings).toHaveLength(1);expect(await createJournalStore(d,options).read()).toEqual(state(1));
});
it('migrates legacy JSON and clears the old game journal on replacement',async()=>{
 const d=await dir();await writeFile(join(d,'current-game.json'),JSON.stringify(state(0)));const s=createJournalStore(d,options);expect(await s.read()).toEqual(state(0));await s.write(state(1),'0');await s.write(state(2),'1');await s.write(state(0,'new'),undefined,true);expect(await readFile(join(d,'current-game.journal'),'utf8')).toBe('');expect(await createJournalStore(d,options).read()).toEqual(state(0,'new'));
});
it('recovers when a checkpoint is committed but its covered journal could not be cleared',async()=>{
 const d=await dir();let renames=0;const s=createJournalStore(d,{...options,checkpointEvery:1,fault:async stage=>{if(stage==='before_rename'&&++renames===4)throw Error('journal reset failure');}});
 await s.write(state(0));await s.write(state(1),'0');expect((await readFile(join(d,'current-game.journal'),'utf8')).length).toBeGreaterThan(0);
 const restored=createJournalStore(d,options);expect(await restored.read()).toEqual(state(1));await restored.write(state(2),'1');expect(await createJournalStore(d,options).read()).toEqual(state(2));
});
it('preserves exported game, undo and deterministic replay through actual controller recovery',async()=>{
 const d=await dir(),s=createJournalStore(d,options),c=new LocalGameController(s,true);await c.dispatch({type:'CREATE_GAME',gameId:'journal-game',seed:1940,mode:'FULL'});
 for(const seat of ['germany','united_kingdom','japan','soviet_union','italy','united_states']){const state=c.getSnapshot();await c.dispatch({type:'KEEP_OPENING',seat,expectedRevision:state.revision,cardIds:state.decks[seat].hand.slice(0,7).map(c=>c.id)});}
 const recovered=await createJournalStore(d,options).read();expect(()=>validateSession(recovered)).not.toThrow();expect(verifyReplay(recovered)).toBe(true);
 const {matchRecording,...save}=recovered;expect(matchRecording.records.length).toBeGreaterThan(2);
 expect(JSON.stringify(save)===JSON.stringify(JSON.parse(c.exportSave()))).toBe(true);
 const reloaded=new LocalGameController(createJournalStore(d,options),true);await reloaded.exportReplay();
 expect(await reloaded.exportReplay()===await c.exportReplay()).toBe(true);
});
it('applies deltas without mutating the old view and rejects prototype paths',()=>{
 const a={list:[{a:1}],extra:'x'},b={list:[{a:2},{a:3}]};expect(applyPatch(a,diffValue(a,b))).toEqual(b);expect(a).toEqual({list:[{a:1}],extra:'x'});expect(()=>applyPatch(a,[{op:'set',path:['__proto__','polluted'],value:true}])).toThrow();
});

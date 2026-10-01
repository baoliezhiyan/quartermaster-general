import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay,seal} from '../src/actionReplay/codec';
import {readHistorySave} from '../src/actionReplay/historySave';
import {hashText,stateHash} from '../src/actionReplay/state';
import {SEATS,type Command} from '../src/core';
async function send(c:LocalGameController,input:Record<string,unknown>){const s=c.getSnapshot()!;expect(await c.dispatch({seat:s.operatorSeat,expectedRevision:s.revision,...input} as Command)).toEqual({ok:true});}
async function ready(){const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'history-save',seed:1940,mode:'BASIC_DEBUG'});for(const seat of SEATS)await send(c,{type:'KEEP_OPENING',seat,cardIds:c.getSnapshot()!.decks[seat].hand.slice(0,7).map(c=>c.id)});return c;}
async function turn(c:LocalGameController){const seat=c.getSnapshot()!.activeSeat;for(let n=0;n<30&&c.getSnapshot()!.activeSeat===seat;n++){const s=c.getSnapshot()!;await send(c,s.phase==='DISCARD'?{type:'DISCARD_HAND',cardIds:[]}:{type:'ADVANCE_PHASE'});}expect(c.getSnapshot()!.activeSeat).not.toBe(seat);}
it('unifies save/replay, restores all prefix slots and exports exact national starts',async()=>{
 const c=await ready(),hashes=new Map<string,string>();
 for(let i=0;i<8;i++){const p=c.getSessionInfo().savePoints!.at(-1)!;hashes.set(p.id,await stateHash(c.getSnapshot()!));await turn(c);}
 const text=await c.exportSave();expect(text).toBe(await c.exportReplay());
 const d=new LocalGameController();await d.importSave(text);expect(await stateHash(d.getSnapshot()!)).toBe(await stateHash(c.getSnapshot()!));
 expect(d.getSessionInfo().rounds.map(p=>p.id)).toEqual(c.getSessionInfo().rounds.map(p=>p.id));expect(d.getSessionInfo().nations.map(p=>p.id)).toEqual(c.getSessionInfo().nations.map(p=>p.id));
 expect(d.getSessionInfo().savePoints!.map(p=>p.id)).toEqual(c.getSessionInfo().savePoints!.map(p=>p.id));
 for(const [id,digest]of hashes){const prefix=await d.exportSave(id),restored=await readHistorySave(prefix);expect(await stateHash(restored.state),id).toBe(digest);const a=await parseReplay(prefix);expect(a.end.contentHash).toBeTruthy();}
});
it('C then X then E restores the saved E history instead of starting a snapshot recording',async()=>{
 const c=await ready();for(let i=0;i<7;i++)await turn(c);
 const e=await c.exportSave(),a=await parseReplay(e),digest=await stateHash(c.getSnapshot()!);
 await c.loadCheckpoint('round:1');await send(c,{type:'ADVANCE_PHASE'});await c.loadCheckpoint('nation:2:united_kingdom');
 expect(await stateHash(c.getSnapshot()!)).toBe(digest);expect((await parseReplay(await c.exportSave())).groups).toEqual(a.groups);
 await c.importSave(e);await turn(c);const later=await parseReplay(await c.exportSave());expect(later.groups.slice(0,a.groups.length)).toEqual(a.groups);
});
it('does not merge a new national response into the previous national action group',async()=>{
 const c=await ready();await turn(c);const before=await parseReplay(await c.exportSave());const last=before.groups.at(-1)!;expect(last.status).toBe('complete');await send(c,{type:'ADVANCE_PHASE'});const after=await parseReplay(await c.exportSave());expect(after.groups.find(g=>g.groupId===last.groupId)).toEqual(last);
});
it('rejects damaged histories without replacing the live state',async()=>{
 const c=await ready();await turn(c);const before=c.getSnapshot(),text=await c.exportSave();await expect(c.importSave(text.slice(0,-20))).rejects.toThrow();expect(c.getSnapshot()).toBe(before);
 const records=(await parseReplay(text)).records.slice(0,-1);const group=records.find(r=>r.type==='action_group')!;if(group.type==='action_group')group.root.input={type:'PLAY_BASIC',cardId:'missing',optionId:'missing'};
 await expect(c.importSave(await seal(records as any))).rejects.toThrow();expect(c.getSnapshot()).toBe(before);
});

it('accepts a valid history larger than 64 MiB without a file-size rejection',async()=>{
 const c=await ready(),original=await c.exportSave(),lines=original.trimEnd().split('\n');
 const end=JSON.parse(lines.pop()!);for(let i=0;i<5;i++)lines[i]+=' '.repeat(14*1024*1024);
 const prefix=lines.join('\n')+'\n';end.contentHash=await hashText(prefix);const large=prefix+JSON.stringify(end)+'\n';
 expect(large.length).toBeGreaterThan(64*1024*1024);const target=new LocalGameController();await target.importSave(large);expect(await stateHash(target.getSnapshot()!)).toBe(await stateHash(c.getSnapshot()!));
},30000);

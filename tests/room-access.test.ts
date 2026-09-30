import {expect,it} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {recoverRecord} from '../src/controller/saveFormat';
import {SEATS,type Command} from '../src/core';
async function send(c:LocalGameController,p:Record<string,unknown>){const s=c.getSnapshot()!;expect(await c.dispatch({seat:s.viewSeat,expectedRevision:s.revision,...p} as Command)).toEqual({ok:true});}
it('national seats stay pinned through setup and full turn completion; GM keeps automatic switching',async()=>{
 const c=new LocalGameController();c.setRoomAccess({kind:'player',seat:'germany'});await c.dispatch({type:'CREATE_GAME',gameId:'pinned',seed:2,mode:'BASIC_DEBUG'});
 for(const seat of SEATS){c.setRoomAccess({kind:'player',seat});await send(c,{type:'SET_VIEW',seat});const s=c.getSnapshot()!;await send(c,{type:'KEEP_OPENING',cardIds:s.decks[seat].hand.slice(0,7).map(x=>x.id)});expect(c.getSnapshot()!.viewSeat).toBe(seat);}
 c.setRoomAccess({kind:'player',seat:'germany'});await c.dispatch({type:'SET_VIEW',seat:'germany',expectedRevision:c.getSnapshot()!.revision});
 for(let i=0;i<12&&c.getSnapshot()!.activeSeat==='germany';i++){const s=c.getSnapshot()!;await send(c,s.phase==='DISCARD'?{type:'DISCARD_HAND',cardIds:[]}:{type:'ADVANCE_PHASE'});}
 expect(c.getSnapshot()!.activeSeat).toBe('united_kingdom');expect(c.getSnapshot()!.viewSeat).toBe('germany');expect(recoverRecord(JSON.parse(c.exportSave()).recovery)).toEqual(c.getSnapshot());
 c.setRoomAccess({kind:'gm'});await c.dispatch({type:'CREATE_GAME',gameId:'gm-auto',seed:2,mode:'FULL'});await send(c,{type:'KEEP_OPENING',cardIds:c.getSnapshot()!.decks.germany.hand.slice(0,7).map(x=>x.id)});expect(c.getSnapshot()!.viewSeat).toBe('united_kingdom');
});
it('observer commands and undo cannot change the game',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'observer',seed:2});
 for(const access of [{kind:'observer',seat:'germany'},{kind:'public'}] as const){c.setRoomAccess(access);const before=c.getSnapshot();expect((await c.dispatch({type:'KEEP_OPENING',seat:'germany',expectedRevision:before!.revision,cardIds:before!.decks.germany.hand.slice(0,7).map(x=>x.id)})).ok).toBe(false);expect((await c.dispatch({type:'CREATE_GAME',gameId:'blocked',seed:4})).ok).toBe(false);await expect(c.undo()).rejects.toThrow('观察者');expect(c.getSnapshot()).toBe(before);}
});


import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {LocalGameController as OldController} from '../outputs/room-optimization/baseline/src/controller/LocalGameController';
import {responsePreset} from '../src/controller/responsePresets';
import type {Command} from '../src/core';
import {setPerformanceSink} from '../src/controller/performanceProbe';
import {createViewProjector} from '../src/network/viewProjector';
import {guidedChoices} from '../src/ui/guidedChoices';
import {resolutionTargets} from '../src/ui/map/targetChoices';
import {pendingResponseSeats} from '../src/core/resolution';
import {triggerContext} from '../src/ui/triggerContext';

// v1.6.2 also numbers non-balance resolutions for notification deduplication.
const gameplay=(value:unknown)=>JSON.parse(JSON.stringify(value,(key,value)=>key==='balanceResolutionSerial'?undefined:value));
it('room dispatch evaluates actions once and matches former view/action commands, undo and replay',async()=>{
 const old=new OldController(),now=new LocalGameController();
 const save=responsePreset('guided-battle','atomic-room');save.state.viewSeat='united_kingdom';save.replayBase=structuredClone(save.state);
 await old.importSave(JSON.stringify(save));await now.importSave(JSON.stringify(save));
 const card=now.getSnapshot()!.decks.germany.hand.find(c=>c.definitionId==='land_battle')!;
 async function both(data:Record<string,unknown>){
  let s=old.getSnapshot()!;const c={...data,expectedRevision:s.revision} as Command;
  if(c.type!=='CREATE_GAME'&&s.viewSeat!==c.seat){expect((await old.dispatch({type:'SET_VIEW',seat:c.seat,expectedRevision:s.revision})).ok).toBe(true);c.expectedRevision=old.getSnapshot()!.revision;}
  expect((await old.dispatch(c)).ok).toBe(true);
  const samples:string[]=[];setPerformanceSink(v=>samples.push(v.name));
  try{expect((await now.dispatchFromRoom({...data,expectedRevision:now.getSnapshot()!.revision} as Command)).ok).toBe(true);}finally{setPerformanceSink(undefined);}
  expect(samples.filter(n=>n==='engine_transition')).toHaveLength(1);
  expect(gameplay(now.getSnapshot())).toEqual(gameplay(old.getSnapshot()));expect(await now.checkReplay()).toBe(true);
 }
 await both({type:'PLAY_CARD',seat:'germany',cardId:card.id,guided:true,effectIndices:[0],targetIds:[]});
 const source=now.getSnapshot()!,view=createViewProjector()(source,{kind:'gm'},source.viewSeat)!;
 expect(source.resolution!.frames.some(f=>f.rollback)).toBe(true);
 expect(view.resolution!.frames.every(f=>!Object.hasOwn(f,'rollback')&&!Object.hasOwn(f,'extraRollback'))).toBe(true);
 expect(guidedChoices(view)).toEqual(guidedChoices(source));expect(resolutionTargets(view)).toEqual(resolutionTargets(source));expect(triggerContext(view)).toEqual(triggerContext(source));expect(pendingResponseSeats(view)).toEqual(pendingResponseSeats(source));
 // Skipping must still restore the host's complete rollback, despite its omission on the wire.
 const choice=source.resolution!.choice!;
 await both({type:'RESOLVE_ENGINE_CHOICE',seat:choice.seat,choiceId:choice.id,ids:[],guided:true});
 await now.undo();await old.undo();expect(gameplay(now.getSnapshot())).toEqual(gameplay(old.getSnapshot()));expect(await now.checkReplay()).toBe(true);
});
it('invalid and failed durable room actions commit neither view changes nor gameplay',async()=>{
 let fail=false,writes=0;const controller=new LocalGameController({read:async()=>null,list:async()=>[],write:async()=>{writes++;if(fail)throw Error('disk');}},true);
 const save=responsePreset('guided-battle','failure-room');save.state.viewSeat='united_kingdom';save.replayBase=structuredClone(save.state);await controller.importSave(JSON.stringify(save));
 const before=controller.getSnapshot()!,session=controller.exportSave(),count=writes;
 expect((await controller.dispatchFromRoom({type:'PLAY_CARD',seat:'germany',expectedRevision:before.revision,cardId:'missing',guided:true,targetIds:[],effectIndices:[0]})).ok).toBe(false);
 expect(controller.getSnapshot()).toBe(before);expect(controller.exportSave()).toBe(session);expect(writes).toBe(count);
 const card=before.decks.germany.hand.find(c=>c.definitionId==='land_battle')!;fail=true;
 await expect(controller.dispatchFromRoom({type:'PLAY_CARD',seat:'germany',expectedRevision:before.revision,cardId:card.id,guided:true,targetIds:[],effectIndices:[0]})).rejects.toThrow('未提交');
 expect(controller.getSnapshot()).toBe(before);expect(controller.exportSave()).toBe(session);
});

import {expect,it} from 'vitest';
import {createGame} from '../src/core/game';
import {resolveChoice,startResolution} from '../src/core/resolution';
import type {GameState} from '../src/core/types';
import type {TriggerRule} from '../src/core/resolutionTypes';
// Pure training replay metadata; not a formal engine rule.
// @ts-ignore TypeScript project does not emit declarations for the .mjs helper.
import {RouteCausality} from '../scripts/ppo_route_causality.mjs';

function fixture(){
  const state=createGame('route-causality',42,'FULL',false,false,true);
  state.phase='PLAY';state.status='PLAYING';state.round=2;
  state.activeSeat=state.viewSeat=state.operatorSeat='germany';
  state.settings.ignoreOtherPlayerInterrupts=false;
  const rules:TriggerRule[]=[
    {id:'cancel',label:'取消当前 A',sourceInstanceId:'system:cancel',
      owner:'united_kingdom',timing:'Before',on:'A',mandatory:false,
      source:'system',effects:[{kind:'cancel',label:'阻止当前 A'}]},
    {id:'insert',label:'插入合法响应',sourceInstanceId:'system:insert',
      owner:'united_kingdom',timing:'Before',on:'A',mandatory:false,
      source:'system',effects:[{kind:'score',seat:'united_kingdom',amount:1,
        label:'插入响应加分'}]},
    {id:'followup',label:'德国后续 A',sourceInstanceId:'system:followup',
      owner:'germany',timing:'After',on:'A',mandatory:false,
      source:'system',effects:[{kind:'score',seat:'germany',amount:1,label:'后续加分'}]},
  ];
  expect(startResolution(state,'两个相同 A','germany',[
    {kind:'score',seat:'germany',amount:1,label:'A'},
    {kind:'score',seat:'germany',amount:1,label:'A'}],rules)).toBe(true);
  return state;
}
function choose(state:GameState,selected?:string){
  const choice=state.resolution!.choice!;
  const ids=selected?[choice.options.find(item=>item.id.includes(selected))!.id]:[];
  expect(resolveChoice(state,choice.seat,choice.id,ids)).toBe(true);
}
it('unseen cancelled first window cannot be replaced by the next identical real-engine trigger',()=>{
  const normal=fixture(),cancelled=fixture();
  const normalTracker=new RouteCausality(),cancelTracker=new RouteCausality();
  expect(normal.resolution!.choice!.seat).toBe('united_kingdom');
  choose(normal); // Britain declines; Germany sees the first after-window.
  const first=normalTracker.ingest(normal);
  expect(normal.resolution!.choice!.seat).toBe('germany');
  expect(first.origin).toBeTruthy();
  const renumbered=structuredClone(normal),resolution=renumbered.resolution!;
  const frames=new Map(resolution.frames.map((frame,index)=>[frame.id,`other-frame-${index}`]));
  const events=new Map(resolution.events.map((event,index)=>[event.id,`other-event-${index}`]));
  const windows=new Map(resolution.windows.map((window,index)=>[window.id,`other-window-${index}`]));
  for(const frame of resolution.frames){frame.id=frames.get(frame.id)!;
    frame.parentEventId=frame.parentEventId?events.get(frame.parentEventId)!:null;}
  for(const event of resolution.events)event.id=events.get(event.id)!,
    event.frameId=frames.get(event.frameId)!;
  for(const window of resolution.windows){window.id=windows.get(window.id)!;
    window.originEventId=events.get(window.originEventId)!;}
  if(resolution.choice?.windowId)resolution.choice.windowId=windows.get(resolution.choice.windowId)!;
  if(resolution.choice?.frameId)resolution.choice.frameId=frames.get(resolution.choice.frameId)!;
  expect(new RouteCausality().ingest(renumbered).origin).toBe(first.origin);
  choose(cancelled,'cancel'); // Britain cancels first A; Germany never sees its after-window.
  cancelTracker.ingest(cancelled);
  expect(cancelled.resolution!.choice!.seat).toBe('united_kingdom');
  choose(cancelled); // Britain declines on the second A.
  const second=cancelTracker.ingest(cancelled);
  expect(cancelled.resolution!.choice!.seat).toBe('germany');
  expect(second.origin).toBeTruthy();
  expect(second.origin).not.toBe(first.origin);
  expect(cancelled.resolution!.events[0].outcome).toBe('cancelled');
  const restored=structuredClone(cancelled),restoredTracker=new RouteCausality();
  expect(restoredTracker.ingest(restored).origin).toBe(second.origin);
});

it('an inserted response preserves its parent; two legal same-kind events stay distinct',()=>{
  const state=fixture(),tracker=new RouteCausality();
  choose(state); // British window closes without cancelling the source event.
  const first=tracker.ingest(state),copy=structuredClone(state);
  expect(new RouteCausality().ingest(copy).origin).toBe(first.origin);
  choose(state); // Germany declines first follow-up; second score starts.
  expect(state.resolution!.choice!.seat).toBe('united_kingdom');
  choose(state);
  const second=tracker.ingest(state);
  expect(second.origin).not.toBe(first.origin);
  expect(state.resolution!.events.filter(event=>event.label==='A'&&event.applied)).toHaveLength(2);
  const inserted=fixture(),insertedTracker=new RouteCausality();
  choose(inserted,'insert');
  // Other legal responses may still be offered for the same parent event.
  for(let n=0;n<8&&inserted.resolution?.choice?.seat==='united_kingdom';n++)choose(inserted);
  expect(inserted.resolution!.choice!.seat).toBe('germany');
  expect(insertedTracker.ingest(inserted).origin).toBe(first.origin);
});

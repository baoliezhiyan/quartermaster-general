import type {GameState} from '../core';
import type {Checkpoint} from '../controller/saveFormat';
import type {Recording} from './recorder';
import {anchor} from './anchors';
import {activeAction,groupOrder} from './recorder';
import {parseReplay,validateRecords} from './codec';
import {playGroup,Player} from './player';
import {restore,stateHash} from './state';
import type {Shuffle} from './contract';
export type SavePoint=Pick<Checkpoint,'id'|'round'|'seat'|'stage'> & {hash:string};
export function turnPoint(s:GameState):SavePoint {
 const prelude=!!s.prelude?.active,round=prelude?s.prelude!.round??Math.floor((s.prelude!.turn-1)/6)+1:s.round;
 return {id:`${prelude?'prelude:':''}nation:${round}:${s.activeSeat}`,round,seat:s.activeSeat,...(prelude?{stage:'prelude' as const}:{}),hash:''};
}
export function startsTurn(old:GameState|undefined,s:GameState){
 if(s.prelude?.active)return !old||!old.prelude?.active||old.prelude.turn!==s.prelude.turn||old.activeSeat!==s.activeSeat;
 return s.status==='PLAYING'&&s.round>0&&s.phase!=='SETUP'&&(!old||old.phase==='SETUP'||old.round!==s.round||old.activeSeat!==s.activeSeat);
}
/** Slots use the same archive loader: nearest checkpoint plus its remaining actions. */
export async function restoreHistoryTail(recording:Recording){
 const a=await validateRecords(JSON.parse(JSON.stringify(recording.records)),false),last=recording.records.at(-1)!;
 if(last.type==='start')return restore(last.state);
 if(last.type==='checkpoint'){
  const source=last.state??a.records.find(r=>(r.type==='start'||r.type==='checkpoint')&&r.checkpointId===last.reuseCheckpointId&&r.state);
  const snap=source&&'ruleState'in source?source:source&&'state'in source?source.state:undefined;
  if(!snap)throw Error('末尾检查点缺失');return restore(snap);
 }
 const g=a.groups.at(-1);return g?new Player(a).seek(g.root.actionId,true):restore(a.start.state);
}
/** Rebuild the timeline once; only the usual round/six-nation slots retain full states. */
export async function readHistorySave(text:string){
 const a=await parseReplay(text);
 const recording:Recording={records:a.records.filter(r=>r.type!=='end'),cursors:{},groupStarts:{}};
 let state=restore(a.start.state);
 const rounds:Checkpoint[]=[],nations:Checkpoint[]=[],points:SavePoint[]=[];
 async function mark(old?:GameState){if(!startsTurn(old,state))return;
  const point={...turnPoint(state),hash:await stateHash(state)};points.push(point);
  const cp:Checkpoint={...point,createdAt:new Date().toISOString(),state:structuredClone(state)};
  const i=nations.findIndex(c=>c.seat===cp.seat);if(i>=0)nations.splice(i,1);nations.push(cp);
  if(cp.seat==='germany')rounds.push({...cp,id:cp.id.replace('nation:', 'round:').replace(':germany','')});
 }
 recording.cursors[await stateHash(state)]={seq:1,order:0};await mark();
 for(const g of a.groups){
  const before=state;recording.groupStarts![g.groupId]=await stateHash(before);
  let observed=before;const boundaries:{state:GameState;order:number}[]=[];
  state=(await playGroup(state,g,a.records.filter((r):r is Shuffle=>r.type==='shuffle'&&r.groupId===g.groupId).sort((x,y)=>x.order-y.order),undefined,[],undefined,(next,order)=>{
    if(startsTurn(observed,next))boundaries.push({state:structuredClone(next),order});observed=next;
  })).state;
  const checkpoint=a.records[g.seq+1];if(checkpoint?.type==='checkpoint'&&await stateHash(state)!==checkpoint.stateHash)throw Error('历史与轮末检查点不一致');
  const final=state;
  for(const item of boundaries){state=item.state;const q=state.resolution?.choice;
    const frontier=state.resolution?.running||state.pendingAir.length||state.pendingDiscard?{at:anchor(state,activeAction(g,state).actionId),decisionSeat:q?.seat??state.operatorSeat,decisionKind:q?.kind??(state.resolution?.revealGroup?'reveal':state.pendingAir.length?'RELOCATE':'FORCE_HAND')}:undefined;
    recording.cursors[await stateHash(state)]={seq:g.seq,groupId:g.groupId,order:item.order,...(frontier?{frontier}:{})};await mark();
  }
  state=final;
  recording.cursors[await stateHash(state)]={seq:g.seq,groupId:g.groupId,order:groupOrder(g,recording.records),...(g.status==='pending'?{frontier:g.frontier}:{})};
 }
 const tail=a.records.at(-2);
 if(tail?.type==='checkpoint'){
  const source=tail.state??a.records.find(r=>(r.type==='start'||r.type==='checkpoint')&&r.checkpointId===tail.reuseCheckpointId&&r.state);
  const snap=source&&'ruleState'in source?source:source&&'state'in source?source.state:undefined;
  if(!snap)throw Error('末尾检查点缺失');
  if(await stateHash(state)!==tail.stateHash)throw Error('末尾检查点与历史不一致');
  state=restore(snap);
  recording.cursors[await stateHash(state)]={seq:tail.seq,order:0};
 }
 return {state,recording,rounds,nations,points};
}

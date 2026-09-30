import {Narrative} from './narrative';
import type {GameState,SeatId} from '../core/types';
import {transition,resumeReplayBoundary} from '../core/game';
import {withReplayHooks} from '../core/replayHooks';
import type {Action,ActionGroup,Anchor,Checkpoint,ObjectData,Shuffle} from './contract';
import type {Archive} from './codec';
import {restore,stateHash,canonical} from './state';
import {anchor,sameAnchor,liveCommand,optionKey} from './anchors';
import {cardName} from '../core/basic';
import {specialCard} from '../core/cardCatalog';
export const displayOption=(label:string)=>specialCard(label)?.name??(['build_army','build_navy','land_battle','sea_battle','air_power'].includes(label)?cardName({definitionId:label}):label);
import {actions} from './recorder';
import {observeFacts} from '../core/factObserver';
export interface Detail {id:string;label:string;}
export interface Entry {id:string;groupId:string;round:number;stage:string;seat:SeatId;summary:string;kind:string;}
export function entries(a:Archive):Entry[]{return a.groups.flatMap(g=>actions(g.root).map(x=>({id:x.actionId,groupId:g.groupId,round:g.round,stage:g.stage,seat:x.decisionSeat,summary:x.summary??'规则动作',kind:x.kind})));}
interface Step {at:Anchor;order:number;seat:SeatId;input:ObjectData;action?:Action;}
function steps(root:Action):Step[]{return [...root.choices.map(c=>({at:c.at,order:c.order,seat:c.decisionSeat,input:c.answer as ObjectData})),...root.interventions.flatMap(i=>[{at:i.at,order:i.order,seat:i.action.decisionSeat,input:i.action.input,action:i.action},...steps(i.action)])].sort((a,b)=>a.order-b.order);}
export async function playGroup(initial:GameState,g:ActionGroup,shuffles:Shuffle[],target?:{id:string;after:boolean},details:Detail[]=[],narrative?:Narrative):Promise<{state:GameState;selected?:GameState}> {
 let s=structuredClone(initial),selected:GameState|undefined,randomIndex=0,boundaryState:GameState|undefined;
 const scheduled=steps(g.root);let currentAction=g.root,consumedOrder=0;
 const automaticAck=()=>{const reveal=s.resolution?.revealGroup;if(!reveal)return false;for(const item of reveal.items){for(const id of [item.requestId,item.resultId]){const notice=s.responseNotices?.find(n=>n.id===id);if(notice&&!notice.readBy.includes(item.seat)){execute({type:'ACK_RESPONSE_NOTICE',noticeId:id},item.seat);return true;}}}throw Error('缺少必要翻牌确认上下文');};
 function execute(input:ObjectData,seat:SeatId){
  s={...s,viewSeat:seat,operatorSeat:seat};
  const observer=(state:GameState)=>{const all=actions(g.root),f=state.resolution?.frames.find(f=>f.id===[...(state.resolution?.stack??[])].reverse().find(v=>v.kind==='frame')?.id);const owner=[...all].reverse().find(a=>a.cardInstanceId&&a.cardInstanceId===f?.cardId)??currentAction;narrative?.observe(state,owner);};
  observeFacts((state,b)=>{
   observer(state);
   if(!['EFFECT_APPLIED','EFFECT_INVALID','EFFECT_CANCELLED','FINISH_CARD_RESOLUTION'].includes(b.code))return;
   const id=g.root.actionId+'@effect:'+details.length;details.push({id,label:b.text});
   if(target?.id===id)selected=structuredClone(state);
   const card=actions(g.root).find(a=>a.actionId===target?.id)?.cardInstanceId;
   if(!selected&&target?.after&&b.code==='FINISH_CARD_RESOLUTION'&&card&&state.resolution?.frames.some(f=>f.cardId===card&&f.status==='COMPLETE'))selected=structuredClone(state);
  },()=>withReplayHooks({boundary:(state)=>{boundaryState=structuredClone(state);return true;},shuffle:(items,state)=>{
   const line=shuffles[randomIndex++];if(!line)throw Error('动作 '+g.groupId+' 缺少洗牌记录');
   if(line.order<=consumedOrder)throw Error('随机记录执行顺序不一致');consumedOrder=line.order;
   const ids=items.map(v=>(v as {id:string}).id);if(canonical([...ids].sort())!==canonical([...line.cardInstanceIds].sort()))throw Error('洗牌实例集合不一致：'+line.shuffleId);
   const at=anchor(state as GameState,line.at.actionId);if(!sameAnchor(at,line.at))throw Error('洗牌时点不一致：'+line.shuffleId);
   const map=new Map(items.map(v=>[(v as {id:string}).id,v]));items.splice(0,items.length,...line.cardInstanceIds.map(id=>map.get(id)!));state.randomState=line.randomStreamAfter!.randomState as number;return true;
  }},()=>{
   if(input.type==='CONTINUE_BOUNDARY'){
    // This boundary was already verified. Suppress its initial repeat while resuming.
    resumeReplayBoundary(s,input.boundary as 'formal_start'|'round_end');
   }else{const result=transition(s,liveCommand(s,input,seat));if(!result.ok)throw Error(`动作 ${currentAction.actionId} 无法重演：${result.error}`);s=result.state;}
  }));
  if(boundaryState)s=boundaryState;
  observer(s);
 }
 if(target?.id===g.root.actionId&&!target.after)selected=structuredClone(s);
 execute(g.root.input,g.root.decisionSeat);
 let guard=0,index=0;
 while(++guard<20000){
  const next=scheduled[index];
  if(g.status==='pending'&&sameAnchor(anchor(s,g.frontier.at.actionId),g.frontier.at)&&!next)break;
  if(boundaryState)break;
  if(automaticAck())continue;
  if(next&&sameAnchor(anchor(s,next.at.actionId),next.at)){
   if(next.order<=consumedOrder)throw Error('选择与随机记录执行顺序不一致');consumedOrder=next.order;
   if(next.action){currentAction=next.action;if(target?.id===next.action.actionId&&!target.after)selected=structuredClone(s);}
   const choiceId=g.root.actionId+'@choice:'+next.order;
   const question=s.resolution?.choice,keys=next.input.ids as string[]|undefined,labels=question&&keys?question.options.filter(o=>keys.includes(optionKey(s,question,o.id))).map(o=>displayOption(o.label)):[];
   details.push({id:choiceId,label:(question?.prompt??'执行选择')+(keys?' → '+(labels.join('、')||'跳过'):'')});
   if(target?.id===choiceId&&!target.after)selected=structuredClone(s);
   execute(next.input,next.seat);index++;
   if(target?.id===choiceId&&target.after)selected=structuredClone(s);
   continue;
  }
  const q=s.resolution?.choice;
  if(q?.kind==='TRIGGER'){execute({type:'RESOLVE_ENGINE_CHOICE',ids:[]},q.seat);continue;}
  if(next)throw Error(`动作 ${g.groupId} 选择锚点不匹配：${next.at.timing}`);
  if(s.resolution?.running||s.pendingDiscard||s.pendingAir.length)throw Error(`动作 ${g.groupId} 缺少必选答案或 frontier`);
  break;
 }
 if(guard>=20000)throw Error('回放自动推进超出上限');
 if(index!==scheduled.length||randomIndex!==shuffles.length)throw Error('存在未消费的选择或随机记录');
 if(g.status==='complete'&&g.afterHash){const actual=await stateHash(s);if(actual!==g.afterHash)throw Error(`动作状态摘要不一致：${g.groupId} seq=${g.seq} ${g.root.summary} expected=${g.afterHash} actual=${actual}`);}
 if(target?.id===g.root.actionId&&target.after)selected=structuredClone(s);
 return {state:s,selected};
}
export class Player {
 details:Detail[]=[];
 private cache=new Map<number,GameState>();
 constructor(readonly archive:Archive){}
 async seek(id:string|null,after=false,fromStart=false):Promise<GameState>{
  const a=this.archive,target=id?a.groups.find(g=>actions(g.root).some(x=>x.actionId===id?.split('@')[0])):undefined;
  if(id&&!target)throw Error('回放动作不存在');if(!target)return restore(a.start.state);
  let state=restore(a.start.state),seq=1;
  if(!fromStart){const checkpoints=a.records.filter((r):r is Checkpoint=>r.type==='checkpoint'&&r.seq<target.seq);const cp=checkpoints.at(-1);if(cp){const referenced=a.records.find(r=>(r.type==='start'||r.type==='checkpoint')&&r.checkpointId===cp.reuseCheckpointId);const snap=cp.state??(referenced&&'state'in referenced?referenced.state:undefined);if(!snap)throw Error('检查点缺失');state=restore(snap);seq=cp.seq;}}
  for(const r of a.records){if(r.seq<=seq||r.seq>target.seq)continue;
   if(r.type==='action_group'){
    const hit=!fromStart&&r!==target?this.cache.get(r.seq):undefined;
    if(hit){state=structuredClone(hit);continue;}
    const details:Detail[]=[];
    const result=await playGroup(state,r,a.records.filter((x):x is Shuffle=>x.type==='shuffle'&&x.groupId===r.groupId).sort((x,y)=>x.order-y.order),r===target?{id:id!,after}:undefined,details);
    state=result.state;if(r===target){this.details=details;return result.selected??state;}
    this.cache.set(r.seq,structuredClone(state));while(this.cache.size>3)this.cache.delete(this.cache.keys().next().value!);
   }else if(r.type==='checkpoint'&&await stateHash(state)!==r.stateHash)throw Error('轮末检查点与推导状态不一致：'+r.completedRound);
  }return state;
 }
}

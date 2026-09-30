import type {MatchArchive} from './codec';
import type {State,Seat,Scope,Frame,Header,Area} from './contract';
export type Perspective='omniscient'|'public'|Seat;
const allowed=(scope:Scope,p:Perspective)=>p==='omniscient'||scope.public||p!=='public'&&scope.seats.includes(p);
export function projectFacts(state:State,p:Perspective):State{
 if(p==='omniscient')return state;
 const k=p==='public'?state.knowledge.public:state.knowledge.seats[p];
 const cards:State['cards']={},areas:Area[]=k.areas.map(v=>{const a=state.areas.find(a=>a.areaId===v.areaId)!;for(const c of v.knownCards)cards[c.instanceId]=state.cards[c.instanceId];const ids=v.knownOrder??[...v.knownTopPrefix,...v.knownCards.map(c=>c.instanceId).filter(id=>!v.knownTopPrefix.includes(id)).sort()];return {...a,cardIds:ids,ordered:!!v.knownOrder,displayOrder:null};});
 const scrub=(v:any):any=>typeof v==='string'?Object.keys(state.cards).some(id=>!cards[id]&&v.includes(id))?null:v:Array.isArray(v)?v.map(scrub):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([key])=>key!=='memory').map(([key,val])=>[key,scrub(val)])):v;
 const resolution={frames:state.resolution.frames.flatMap(f=>{const effectsOrdered=f.effectsOrdered.filter(e=>k.visibleEffectIds.includes(e.effectId));return effectsOrdered.length?[{...f,sourceCardInstanceId:f.sourceCardInstanceId&&cards[f.sourceCardInstanceId]?f.sourceCardInstanceId:null,effectsOrdered:effectsOrdered.map(e=>({...e,definition:scrub(e.definition),result:scrub(e.result),boundEntities:Object.fromEntries(Object.entries(e.boundEntities).map(([key,refs])=>[key,refs.filter(ref=>ref.kind!=='card'||cards[ref.id])])),selectedTargetsOrdered:e.selectedTargetsOrdered.filter(ref=>ref.kind!=='card'||cards[ref.id])}))}]:[];}),executionOrder:state.resolution.executionOrder.filter(id=>state.resolution.frames.find(f=>f.frameId===id)?.effectsOrdered.some(e=>k.visibleEffectIds.includes(e.effectId)))};
 return {...state,cards,areas,installed:state.installed.filter(i=>cards[i.instanceId]),flags:state.flags.filter(f=>k.visibleFlagIds.includes(f.flagId)),pendingDecisions:k.decisions,notifications:state.notifications.filter(n=>k.notificationIds.includes(n.notificationId)),resolution,availability:state.availability?Object.fromEntries(Object.entries(state.availability).map(([seat,v])=>[seat,{...v,openInstanceIds:k.knownOpenInstanceIds[seat as Seat]??[],openCount:k.knownOpenInstanceIds[seat as Seat]?.length??0}])) as State['availability']:null,knowledge:{public:k,seats:{} as State['knowledge']['seats']},extensions:undefined};
}
export function replayNode(a:MatchArchive,seq:number,before=true,p:Perspective='omniscient'){
 const entry=seq===1?a.start:a.frames.find(f=>f.seq===seq);if(!entry)throw Error('回放节点不存在');
 const target=entry.recordType==='frame'&&'action'in entry&&entry.action&&before?entry.decisionBeforeStateSeq!:entry.seq;
 const source=target===1?a.start:a.frames.find(f=>f.seq===target)!;
 const state=projectFacts(source.state,p),k=p==='omniscient'?null:p==='public'?source.state.knowledge.public:source.state.knowledge.seats[p];
 const events=entry.recordType==='frame'?entry.events.filter(e=>allowed(e.visibility,p)&&e.entities.every(ref=>ref.kind!=='card'||state.cards[ref.id])):[];
 const decisionSource=entry.recordType==='frame'&&'decisionBeforeStateSeq'in entry&&entry.decisionBeforeStateSeq?(entry.decisionBeforeStateSeq===1?a.start:a.frames.find(f=>f.seq===entry.decisionBeforeStateSeq)):source;
 const decisionKnowledge=p==='omniscient'?null:p==='public'?decisionSource?.state.knowledge.public:decisionSource?.state.knowledge.seats[p];
 const action=entry.recordType==='frame'&&'action'in entry&&entry.action&&(!decisionKnowledge||decisionKnowledge.visibleDecisionIds.includes(entry.action.decisionId))?entry.action:null;
 let safeAction=action;
 if(action&&decisionKnowledge){const original=decisionSource!.state.pendingDecisions.find(d=>d.decisionId===action.decisionId)!,visible=decisionKnowledge.decisions.find(d=>d.decisionId===action.decisionId)!;safeAction={...action,optionIdsOrdered:action.optionIdsOrdered.map(id=>visible.options[original.options.findIndex(o=>o.optionId===id)]?.optionId??'不可见选项'),selection:(function safe(v:any):any{if(typeof v==='string')return Object.keys(decisionSource!.state.cards).some(id=>!decisionKnowledge.areas.some(a=>a.knownCards.some(c=>c.instanceId===id))&&v.includes(id))?null:v;if(Array.isArray(v))return v.map(safe);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([key,value])=>[key,safe(value)]));return v;})(action.selection)};}
 const random=entry.recordType==='frame'&&entry.kind==='random'&&allowed(entry.randomResult.visibility,p)?entry.randomResult:null;
 return {state,stateSeq:target,events,action:safeAction,knowledge:k,random};
}
export function visibleFrameLabel(f:Frame,h:Header,p:Perspective){const events=f.events.filter(e=>allowed(e.visibility,p));if('action'in f&&f.action){const d=(f.state.pendingDecisions.find(d=>d.decisionId===f.action!.decisionId));return p==='omniscient'||p===f.action.actorSeat?`${f.action.actorSeat} · ${d?.prompt??'做出选择'}`:'其他国家做出选择';}return events.map(e=>e.text).join('；')|| (f.kind==='random'?'随机步骤（结果按视角可见）':f.kind==='control'?'场景控制操作':`${h.mode==='resource_pool'?'资源':'规则'}结算步骤`);}

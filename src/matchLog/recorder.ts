import type {GameState,Command} from '../core/types';
import type {FactBoundary} from '../core/factObserver';
import type * as C from './contract';
import {normalize,makeHeader,localControllers,noCause,scope,json} from './normalize';
import {sha256} from './codec';
import {shareFactState} from './sharing';
export interface Recording {records:(C.Header|C.Start|C.Frame)[]; checkpoints:Record<string,number>;}
export interface Capture {state:C.State;boundary:FactBoundary; nativeEvents?:C.Event[];}
export const stateKey=(s:GameState)=>JSON.stringify({...s,revision:0,viewSeat:'germany',operatorSeat:'germany',events:[],publicLog:[],responseNotices:s.responseNotices?.map(n=>({...n,readBy:[]}))});
export function factCapture(s:GameState,boundary:FactBoundary,controllers:C.ControllerMap,turns:number,previous?:C.State):Capture{
 const prefix=`${s.gameId}/${s.balanceResolutionSerial??0}/`;
 const nativeEvents:C.Event[]=(s.resolution?.events??[]).map(e=>{const f=s.resolution!.frames.find(f=>f.id===e.frameId);return {eventId:prefix+e.id,eventType:'effect_declared',actorSeat:f?.owner??null,sourceSeat:f?.owner??null,entities:f?.cardId?[{kind:'card',id:f.cardId}]:[],cause:{...noCause(),resolutionFrameId:prefix+e.frameId,effectId:e.effectIndex!==undefined?prefix+e.frameId+'/'+e.effectIndex:null,sourceCardInstanceId:f?.cardId??null,parentEventId:f?.parentEventId?prefix+f.parentEventId:null},visibility:f?.owner?scope(f.owner):scope(),outcome:'occurred',before:null,after:null,details:json(e.effect),text:e.label};});
 return {state:shareFactState(previous,normalize(s,controllers,turns)),boundary:structuredClone(boundary),nativeEvents};
}
const eventCodes:Record<string,C.EventType>={FRAME_STARTED:'card_declared',FINISH_CARD_RESOLUTION:'card_finalized',CARD_OWN_EFFECTS_COMPLETE:'card_effects_completed',EFFECT_APPLIED:'effect_applied',EFFECT_DECLARED:'effect_declared',EFFECT_INVALID:'effect_skipped',EFFECT_CANCELLED:'effect_cancelled',EFFECT_ENDED:'effect_finished',WINDOW_OPENED:'window_opened',PHASE_ENTERED:'phase_started',GAME_FINISHED:'game_finished',AIR_REMOVED:'unit_removed',RESOLUTION_COMPLETE:'effect_finished',RANDOM_CARD_REVEALED:'random_resolved'};
export function appendCapture(r:Recording,c:Capture,transactionId:string){
 c={...c,state:shareFactState((r.records.at(-1) as C.Start|C.Frame).state,c.state)};
 if(c.boundary.code==='automatic_choice'){
  const data=c.boundary.details as {seat:C.Seat;prompt:string;options:{id:string;label:string}[];selected:string[];reason:string};
  const state=structuredClone(c.state),decisionId=`automatic/${transactionId}/${r.records.length}`;
  const d:C.Decision={decisionId,activeSeat:state.activeSeat,decisionSeat:data.seat,controllerId:state.controllers[data.seat].controllerId,sourceSeat:data.seat,unitCountry:null,kind:'branch',prompt:data.prompt,cause:noCause(),triggerEventId:null,triggerContext:json(data),visibility:scope(data.seat),options:data.options.map(o=>({optionId:o.id,label:o.label,semanticType:data.reason,entities:[],payload:json(o)})),constraints:{min:1,max:1,ordered:false,allowSkip:false,allowCancel:false,allowDecline:false,dependencies:null},selectedSoFar:[]};state.pendingDecisions.push(d);state.knowledge.seats[data.seat].visibleDecisionIds.push(decisionId);state.knowledge.seats[data.seat].decisions.push(d);
  appendCapture(r,{state,boundary:{code:'decision_opened',text:data.prompt}},transactionId);const seq=r.records.length;
  r.records.push({recordType:'frame',seq,beforeStateSeq:seq-1,decisionBeforeStateSeq:seq-1,timelineId:(r.records[1] as C.Start).timelineId,cause:noCause(),events:[],state:c.state,kind:'automatic',automationReason:data.reason,action:{actionId:`${transactionId}/${seq}`,decisionId,actorSeat:data.seat,controllerId:state.controllers[data.seat].controllerId,optionIdsOrdered:data.selected,selection:json(data),disposition:'submit',origin:data.reason==='forced_single_option'?'forced_single_option':'autopolicy'}});return;
 }
 const previous=r.records.at(-1) as C.Start|C.Frame,seq=r.records.length,header=r.records[0] as C.Header;
 const current=c.state.resolution.frames.find(f=>f.frameId===c.state.resolution.executionOrder.at(-1))??c.state.resolution.frames.at(-1),cause:C.Cause={...noCause(),transactionId,rootActionId:transactionId,resolutionFrameId:current?.frameId??null,effectId:current?.currentEffectId??null,sourceCardInstanceId:current?.sourceCardInstanceId??null};
 const privateSeat=(c.boundary.details as {seat?:C.Seat}|undefined)?.seat??current?.sourceSeat;
 const visible=['unit_built','unit_moved','unit_removed','unit_recruited','neutrality_ended','GAME_FINISHED','PHASE_ENTERED','transaction_finished'].includes(c.boundary.code)?scope():privateSeat?scope(privateSeat):{public:false,seats:[]};
 const event:C.Event={eventId:`${header.recordingId}/${header.recordingRevision}/${seq}`,eventType:eventCodes[c.boundary.code]??(['card_moved','cost_paid','decision_opened','window_closed','unit_built','unit_moved','card_installed','random_resolved','unit_removed','unit_recruited','neutrality_ended'].includes(c.boundary.code)?c.boundary.code as C.EventType:'effect_applied'),actorSeat:current?.sourceSeat??c.state.activeSeat,sourceSeat:current?.sourceSeat??null,entities:current?.sourceCardInstanceId?[{kind:'card',id:current.sourceCardInstanceId}]:[],cause,visibility:visible,outcome:c.boundary.code==='EFFECT_CANCELLED'?'cancelled':c.boundary.code==='EFFECT_INVALID'?'skipped':'occurred',before:null,after:null,details:json(c.boundary.details),text:c.boundary.text};
 const base:C.FrameBase={recordType:'frame',seq,beforeStateSeq:previous.seq,timelineId:(r.records[1] as C.Start).timelineId,cause,events:[...(c.nativeEvents??[]).filter(e=>!r.records.some(rec=>rec.recordType==='frame'&&rec.events.some(v=>v.eventId===e.eventId))).map(e=>({...e,cause:{...e.cause,transactionId,rootActionId:transactionId}})),event],state:c.state};
 if(c.boundary.random){const random=c.boundary.random,ids=(a:unknown[])=>a.map(v=>typeof v==='object'&&v&&'id'in v?String(v.id):String(v));r.records.push({...base,kind:'random',randomResult:{randomId:event.eventId+'/random',streamId:'game',purpose:String((current?.effectsOrdered.find(e=>e.effectId===cause.effectId)?.definition as {label?:string}|undefined)?.label??c.boundary.text),effectId:cause.effectId,decisionId:null,samplingRule:{kind:'fisher_yates',version:'1'},domain:{stateSeq:previous.seq,areaId:previous.state.areas.find(a=>a.cardIds.length===random.input.length&&a.cardIds.every(id=>ids(random.input).includes(id)))?.areaId??null,orderedIds:ids(random.input)},result:json({permutation:ids(random.output)}),visibility:{public:false,seats:[]},rngBefore:random.before,rngAfter:random.after}});}else r.records.push({...base,kind:'automatic',automationReason:c.boundary.code});
}
export async function recordTransaction(old:Recording|undefined,base:GameState|null,next:GameState,command:Command,captures:Capture[],controllers=localControllers(),participants:C.Controller[]=[{controllerId:'local',kind:'human',displayName:'本地操作者'}],fingerprint='development'):Promise<Recording>{
 const transactionId=crypto.randomUUID();let r:Recording;
 if(!old||command.type==='CREATE_GAME'){
  const first=captures.find(c=>c.boundary.code==='recording_start'),start=first?.state??normalize(base??next,controllers),id=crypto.randomUUID();
  r={records:[makeHeader(next,[start,...captures.map(c=>c.state),normalize(next,controllers)],first?'creation':'snapshot',id,controllers,participants,fingerprint),{recordType:'start',seq:1,timelineId:id,state:start}],checkpoints:{}};
 }else {const updated=recordControllers(old,controllers,participants);r={records:[...updated.records],checkpoints:{...old.checkpoints}};}
 if(base&&command.type!=='CREATE_GAME'&&command.type!=='SET_VIEW'){
  const prior=normalize(base,controllers,(r.records.at(-1) as C.Start|C.Frame).state.completedCountryTurns),seat='seat'in command?command.seat:base.activeSeat;
  let d=command.type==='ACK_RESPONSE_NOTICE'?prior.pendingDecisions.find(d=>d.decisionId===`notice/${command.noticeId}/${seat}`):prior.pendingDecisions.find(d=>d.decisionSeat===seat&&d.kind!=='confirm_effect');
  if(['SET_CARD_RESPONSE','SET_INTERRUPTS','DEBUG_DECK','DEBUG_PLACEMENT','START_RESOLUTION_SCENARIO'].includes(command.type)){const seq=r.records.length;r.records.push({recordType:'frame',seq,beforeStateSeq:seq-1,timelineId:(r.records[1] as C.Start).timelineId,cause:noCause(),kind:'control',control:{kind:'gm_edit',reason:command.type,actorControllerId:controllers[seat].controllerId},events:[],state:normalize(next,controllers,prior.completedCountryTurns)});d=undefined;}
  if(d){
   appendCapture(r,{state:prior,boundary:{code:'decision_opened',text:d.prompt,details:{seat:d.decisionSeat}}},transactionId);
   const data=command as any,ids:string[]=command.type==='ACK_RESPONSE_NOTICE'?['acknowledge']:command.type==='REDISTRIBUTE'?['REDISTRIBUTE']:data.ids??data.cardIds??(data.cardId?[data.cardId]:data.action?[data.action]:[command.type]);
   const selected=ids.filter(id=>d!.options.some(o=>o.optionId===id));
   const before=r.records.length-1,seq=r.records.length,disposition:C.Action['disposition']=data.ids?.length===0?(d.kind==='response'?'decline':'skip'):command.type==='SELECT_AIR_ACTION'&&command.action===null?'skip':'submit';
   const after=captures[0]?.state??normalize(next,controllers,prior.completedCountryTurns);
   r.records.push({recordType:'frame',seq,beforeStateSeq:before,decisionBeforeStateSeq:before,timelineId:(r.records[1] as C.Start).timelineId,cause:{...d.cause,transactionId,rootActionId:transactionId},kind:'decision',action:{actionId:transactionId,decisionId:d.decisionId,actorSeat:seat,controllerId:controllers[seat].controllerId,optionIdsOrdered:selected,selection:json(command),disposition,origin:'user'},nativeCommand:{engineId:'quartermaster',schemaVersion:'1',command:json(command)},events:[],state:after});
  }
 }
 for(const c of captures)if(c.boundary.code!=='recording_start')appendCapture(r,c,transactionId);
 const last=(r.records.at(-1) as C.Start|C.Frame).state;let turns=last.completedCountryTurns;
 if(base&&(base.activeSeat!==next.activeSeat||base.round!==next.round)&&base.status==='PLAYING')turns=Math.max(turns,((old?.records.at(-1) as C.Start|C.Frame|undefined)?.state.completedCountryTurns??0)+1);
 appendCapture(r,{state:normalize(next,controllers,turns),boundary:{code:'transaction_finished',text:'操作结算完成'}},transactionId);
 r.checkpoints[await sha256(stateKey(next))]=r.records.length-1;return r;
}
export async function restoreRecording(old:Recording|undefined,target:GameState,gm=false):Promise<Recording>{
 const key=await sha256(stateKey(target)),index=old?.checkpoints[key];
 if(old&&index!==undefined&&!gm){const records=old.records.slice(0,index+1);records[0]={...records[0],recordingRevision:(old.records[0] as C.Header).recordingRevision+1} as C.Header;return {records,checkpoints:Object.fromEntries(Object.entries(old.checkpoints).filter(([,v])=>v<=index))};}
 if(old&&gm){const r={records:[...old.records],checkpoints:{...old.checkpoints}},seq=r.records.length,state=normalize(target,(r.records.at(-1) as C.Start|C.Frame).state.controllers,(r.records.at(-1) as C.Start|C.Frame).state.completedCountryTurns);r.records.push({recordType:'frame',kind:'control',seq,beforeStateSeq:seq-1,timelineId:(r.records[1] as C.Start).timelineId,cause:noCause(),control:{kind:'gm_edit',reason:'GM 修改场景',actorControllerId:null},events:[],state});r.checkpoints[key]=seq;return r;}
 return recordTransaction(undefined,target,target,{type:'CREATE_GAME',gameId:target.gameId,seed:target.seed},[],localControllers());
}

export function recordControllers(old:Recording,controllers:C.ControllerMap,participants:C.Controller[]):Recording {
 const h=old.records[0] as C.Header,last=old.records.at(-1) as C.Start|C.Frame;
 if(JSON.stringify(last.state.controllers)===JSON.stringify(controllers)&&participants.every(p=>h.participants.some(v=>v.controllerId===p.controllerId)))return old;
 const merged=[...h.participants];for(const p of participants)if(!merged.some(v=>v.controllerId===p.controllerId))merged.push(p);
 const state=structuredClone(last.state);state.controllers=structuredClone(controllers);for(const d of state.pendingDecisions)d.controllerId=controllers[d.decisionSeat].controllerId;for(const k of [state.knowledge.public,...Object.values(state.knowledge.seats)])for(const d of k.decisions)d.controllerId=controllers[d.decisionSeat].controllerId;
 const seq=old.records.length;
 return {...old,records:[{...h,participants:merged},...old.records.slice(1),{recordType:'frame',kind:'control',seq,beforeStateSeq:seq-1,timelineId:(old.records[1] as C.Start).timelineId,cause:noCause(),control:{kind:'controller_change',reason:'房间国家操作者变更',actorControllerId:null},events:[],state}]};
}

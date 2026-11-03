import {cardName,seatOf,allianceOf} from '../core/basic';
import {specialCard} from '../core/cardCatalog';
import {REGIONS} from '../core/map';
import {cardTargetChoices} from '../core/extraCards';
import {seatAirMoveOptions,airDestinations} from '../core/actions';
import {airActionOptions} from '../core/phaseAvailability';
import {playableCard,usableStatus} from '../ui/playAvailability';
import {resolutionTargets} from '../ui/map/targetChoices';
import {suppliedUnits} from '../core/supply';
import {projectState} from '../network/project';
import type {ReadState,SeatId,CardInstance} from '../core/types';
import {AI_INTERFACE_VERSION,type Offer} from './contract';
import {VERSION} from '../actionReplay/state';
const card=(c:CardInstance)=>({id:c.id,definitionId:c.definitionId,country:c.country,name:c.definitionId==='hidden'?'未知牌':cardName(c),type:specialCard(c.definitionId,c.balance)?.type??'基本牌',text:specialCard(c.definitionId,c.balance)?.text??cardName(c)});
const sorted=(cs:readonly CardInstance[])=>cs.map(card).sort((a,b)=>a.definitionId.localeCompare(b.definitionId)||a.id.localeCompare(b.id));
export function offersFor(s:ReadState,seat:SeatId):Offer[]{
 const result:Offer[]=[],d=s.decks[seat];
 const add=(key:string,label:string,command:Record<string,unknown>,selections?:Offer['selections'])=>result.push({id:seat+':'+key,seat,label,command,selections});
 for(const n of s.responseNotices??[])if(n.recipients.includes(seat)&&!n.readBy.includes(seat))add('notice:'+n.id,n.text,{type:'ACK_RESPONSE_NOTICE',noticeId:n.id});
 if(s.status==='FINISHED')return result;
 if(s.resolution?.running){const q=s.resolution.choice;if(q?.seat===seat){if(q.canSkip&&q.min>0)add('skip:'+q.id,'跳过：'+q.prompt,{type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,guided:true,ids:[]});add('choice:'+q.id,q.prompt,{type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,guided:true},{ids:{ids:q.options.map(o=>o.id).sort(),min:q.min,max:q.max,ordered:true,requirements:q.requirements}});}return result;}
 if(s.pendingDiscard){if(s.pendingDiscard.seat===seat)add('forced','选择被迫弃置的手牌',{type:'RESOLVE_FORCED_DISCARD'},{cardIds:{ids:d.hand.map(c=>c.id),min:Math.min(s.pendingDiscard.count,d.hand.length),max:Math.min(s.pendingDiscard.count,d.hand.length)}});return result;}
 if(s.pendingAir.length){const air=s.units.find(u=>u.id===s.pendingAir[0]);if(air&&seatOf(air.country)===seat)for(const regionId of airDestinations(s,air.id))add('relocate:'+regionId,'免费调度至'+regionId,{type:'RELOCATE_AIR',regionId});return result;}
 if(s.prelude?.active){if(s.activeSeat===seat){const p=s.prelude,pd=p.decks[seat];if(pd.drawPile.length)add('burn','弃置序章牌库顶',{type:'DISCARD_PRELUDE_TOP'});for(const c of [...(s.rules?.balanceEnabled&&p.discarded?[]:pd.hand),...pd.drawPile.slice(0,1)])add('prelude:'+c.id,'打出'+cardName(c),{type:'PLAY_PRELUDE',cardId:c.id});}return result;}
 if(s.phase==='SETUP'){if(!s.setupCompleted.includes(seat))add('opening','选择保留起手牌',{type:'KEEP_OPENING'},{cardIds:{ids:d.hand.map(c=>c.id),min:Math.min(7,d.hand.length),max:Math.min(7,d.hand.length)}});return result;}
 if(seat!==s.activeSeat)return result;
 if(s.phase==='DISCARD'){add('discard','弃牌；可选择不弃牌，后果按当前规则结算',{type:'DISCARD_HAND'},{cardIds:{ids:d.hand.map(c=>c.id),min:0,max:d.hand.length}});return result;}
 if(s.phase==='AIR'){
 for(const o of airActionOptions(s).filter(o=>o.enabled))add('air:'+o.id,o.label,{type:'SELECT_AIR_ACTION',action:o.id});
 if(s.airAction)add('air:back','返回空军行动选择',{type:'SELECT_AIR_ACTION',action:null});
 if(s.airAction==='move')for(const o of seatAirMoveOptions(s,seat))add('move:'+o.id,o.label+'；弃置一张手牌',{type:'MOVE_AIR',optionId:o.id},{cardId:{ids:d.hand.map(c=>c.id),min:1,max:1}});
 }
 if(['PLAY','AIR'].includes(s.phase)){
 for(const c of d.hand.filter(c=>playableCard(s,c))){const targets=cardTargetChoices(s,c);add('play:'+c.id,'打出'+cardName(c),{type:'PLAY_CARD',cardId:c.id,effectIndices:[],targetIds:[],guided:true},targets.length?{targetIds:{ids:targets,min:1,max:specialCard(c.definitionId,c.balance)?.sourceIndex===162?Math.min(3,targets.length):1,ordered:true}}:undefined);}
 for(const c of d.active.filter(c=>usableStatus(s,c)))add('status:'+c.id,'发动'+cardName(c),{type:'STATUS_ACTION',cardId:c.id,guided:true});
 }
 if(s.prelude&&['PLAY','AIR','TURN_START_WINDOW'].includes(s.phase))add('armament','查看本国回合内军备窗口',{type:'ARMAMENT_WINDOW'});
 if(['PLAY','AIR','SUPPLY','SCORE','DRAW'].includes(s.phase))add('advance','推进阶段；出牌阶段放弃出牌的费用由正式规则处理',{type:'ADVANCE_PHASE'});
 return result;
}
const supportedChoices=new Set(['WITHDRAW','BUILD_ORDER','EFFECT_DECISION','AIR_DEFENSE','AIR_INTERCEPT','TRIGGER','ORDER_MANDATORY_TRIGGERS','FORCE_HAND','PAY_COST','ACTION','RELOCATE','REALLOCATE','EFFECTS','SELECT','CARDS','EXTRA_CARD','EXTRA_TARGET','EXTRA_EFFECTS']);
export function observePlayer(source:ReadState|null,bindings:SeatId[],meta:{epoch:string;sequence:number;serverId:string;userId:string;name:string;locked:boolean;replay:boolean}){
 const base={interfaceVersion:AI_INTERFACE_VERSION,gameVersion:VERSION,...meta,bindings};
 if(!source)return {...base,gameId:null,revision:null,status:'waiting_game',offers:[] as Offer[]};
 const views=bindings.map(seat=>projectState(source,{kind:'player',seat},seat)!);
 const pub=projectState(source,{kind:'public'},'germany')!;
 const privateCountries=Object.fromEntries(views.map(s=>{const seat=s.viewSeat,d=s.decks[seat],p=s.prelude?.decks[seat];return [seat,{hand:d.hand.map(card),deckComposition:sorted(d.drawPile),discard:d.discardPile.map(card),faceDown:d.faceDown.map(card),active:d.active.map(card),resolving:d.resolving.map(card),removed:d.removed.map(card),prelude:p?{hand:p.hand.map(card),knownTop:p.drawPile[0]?card(p.drawPile[0]):null,deckComposition:sorted(p.drawPile),discard:p.discardPile.map(card)}:null,notices:s.responseNotices,disabledResponseIds:s.disabledResponseIds,uses:Object.fromEntries(Object.entries(source.resolution?.turnUses??{}).filter(([key])=>[...d.active,...d.faceDown,...d.hand,...d.resolving].some(c=>key.includes(c.id))))}];}));
 const offers=meta.locked||meta.replay?[]:views.flatMap(s=>offersFor(s,s.viewSeat));
 const decisions=views.flatMap(s=>{const q=s.resolution?.choice;if(!q)return [];const targets=resolutionTargets(s);const f=s.resolution?.frames.find(f=>f.id===q.frameId);
  const windowIds=new Set([q.windowId,...q.options.map(o=>o.windowId)].filter(Boolean));
  const triggerReasons=(source.resolution?.windows??[]).filter(w=>windowIds.has(w.id)).map(w=>{
   const event=source.resolution?.events.find(e=>e.id===w.originEventId),effect=event?.effect,parent=source.resolution?.frames.find(f=>f.id===event?.frameId);
   const c=Object.values(s.decks).flatMap(d=>Object.values(d).flat()).find(c=>c.id===parent?.cardId&&c.definitionId!=='hidden');
   return {timing:w.timing,sourceCard:c?card(c):undefined,effect:effect?.kind==='action'?{kind:effect.kind,country:effect.country,action:effect.action,regionId:effect.option?.regionId??effect.selection?.regionId}:effect?.kind==='signal'?{kind:effect.kind,phase:effect.tag.startsWith('PHASE:')?effect.tag.slice(6):undefined}:effect?.kind==='remove'?{kind:effect.kind,unit:effect.unit,cause:effect.cause}:effect&&['deckTop','forceHand','draw'].includes(effect.kind)?{kind:effect.kind}:undefined};
  });
  return [{triggerReasons,seat:s.viewSeat,id:q.id,kind:q.kind,prompt:q.prompt,min:q.min,max:q.max,canSkip:q.canSkip,requirements:q.requirements,options:[...q.options].sort((a,b)=>a.id.localeCompare(b.id)).map(o=>({...o,label:specialCard(o.label)?.name??o.label,regionId:targets.find(t=>t.id===o.id)?.regionId})),context:f?{source:f.source,cardId:f.cardId,effects:f.effects.map(e=>({kind:e.kind,label:e.label,fee:e.fee,...(e.kind==='cards'?{from:e.from,to:e.to,min:e.min,max:e.max,filter:e.filter,requirements:e.requirements,order:e.order}:e.kind==='action'?{action:e.action,country:e.country,regions:e.regions,selection:e.selection}:e.kind==='extraPlay'?{from:e.from,filter:e.filter,allowSkip:e.allowSkip}:{})})),stage:f.stage}:undefined}];});
 const noDecision=source.resolution?.running&&!source.resolution.choice;
 const unsupported=source.mode!=='FULL'||!!source.trainingCourse||!!noDecision||!!source.resolution?.choice&&!supportedChoices.has(source.resolution.choice.kind);
 return {...base,gameId:source.gameId,revision:source.revision,rules:pub.rules,preludeEnabled:!!source.prelude,phase:pub.phase,round:pub.round,activeSeat:pub.activeSeat,decisionSeats:[...new Set(offers.map(o=>o.seat))],status:source.status==='FINISHED'?'finished':unsupported?'unsupported':offers.length?'needs_ai':'waiting_other',unsupportedReason:unsupported?'需要 FULL 正式对局及明确决策节点；未自动执行任何选择':undefined,public:{units:pub.units,suppliedUnitIds:[...suppliedUnits(pub)].sort(),scores:pub.scores,neutrality:pub.neutrality,turnFlags:pub.turnFlags,airAction:pub.airAction,basicPlaysRemaining:pub.basicPlaysRemaining,winner:pub.winner,victoryReason:pub.victoryReason,prelude:pub.prelude?{active:pub.prelude.active,turn:pub.prelude.turn,round:pub.prelude.round,tension:pub.prelude.tension,discarded:pub.prelude.discarded,played:pub.prelude.played}:null,countries:Object.fromEntries(Object.entries(pub.decks).map(([seat,d])=>[seat,{handCount:d.hand.length,deckCount:d.drawPile.length,faceDownCount:d.faceDown.length,active:d.active.map(card),visibleDiscard:d.discardPile.map(card),revealedResponses:d.faceDown.filter(c=>c.definitionId!=='hidden').map(card)}])),log:pub.publicLog},privateCountries,decisions,offers:unsupported?[]:offers,regions:REGIONS.map(r=>({id:r.id,name:r.name,type:r.type})),alliance:bindings.length?allianceOf(bindings[0]):null};
}

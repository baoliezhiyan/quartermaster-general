import {sortCardChoices} from './cardChoiceOrder';
import {fact} from './factObserver';
import {publicCostIds} from './cardCosts';
import {ACTION_NAMES} from './effectNames';
import {applyBalanceEffect} from './balanceEffects';
import {isLastOwnEffect,inWindowLane,isBatchScore,closeWindow} from './resolutionLifecycle';
import {copiedStatusRules} from './copiedStatus';
import {checkNeutralitySupply,checkNeutralityAttack,mayReallocate} from './neutrality';
import {applyPreludeEffect} from './prelude';
import {declarePublicCard,recordPublicEffect,revealPublic,concealPublic,publicRecord} from './publicHistory';
import { COUNTRY_NAMES, shuffle, insertRandom, canReallocateCard, reallocationCards, seatOf } from './basic';
import { boardOptions, applyBoardEffect } from './boardEffects';
import { airDestinations } from './actions';
import { realTriggers } from './specialCards';
import { cardName } from './basic';
import { specialCard } from './cardCatalog';
import { cardTargetChoices, extraCandidates, extraEffects } from './extraCards';
import { suppliedUnits, adjacent } from './supply';
import { hasStatus } from './modifiers';
import { coversCost, matchesCard, canAffordHandCost } from './cardCosts';
import { REGION_BY_ID, REGIONS } from './map';
import { putDiscardedCards, discardHandCards, drawCards, discardDeckTop, forceDiscardHand, payDiscardCost } from './decks';
import type { GameState, ReadState, SeatId } from './types';
import { SEATS } from './types';
import { addResponseNotice,notifyResponseFrame,notifyAirDecision,notifyAttack } from './responseNotices';
import type { ChoiceRequest, Effect, FinalZone, ResolutionFrame, ResolutionState, TriggerRule, TriggerWindow } from './resolutionTypes';

const engine = (s:GameState) => s.resolution!;
const uid = (r:ResolutionState, prefix:string) => `${prefix}:${++r.serial}`;
const frameById = (r:ResolutionState,id:string) => r.frames.find(f=>f.id===id)!;
const windowById = (r:ResolutionState,id:string) => r.windows.find(w=>w.id===id)!;
function record(s:GameState,code:string,text:string) {
  s.events.push({type:'RULE_EVENT',revision:s.revision,code,text});
  fact(s,code,text);
}
function ask(s:GameState, value:Omit<ChoiceRequest,'id'>) {
  const r=engine(s);
  r.choice={...value,options:sortCardChoices(value.options),id:uid(r,'choice')}; s.operatorSeat=value.seat;
  if(s.settings.ignoreOtherPlayerInterrupts)s.viewSeat=value.seat;
  for (const task of r.stack) if (task.kind==='frame') frameById(r,task.id).status=value.kind==='TRIGGER' ? 'WAITING_RESPONSE' : 'WAITING_CHOICE';
  fact(s,'decision_opened',value.prompt,{seat:value.seat});
}
function sourceZone(rule:TriggerRule): 'active'|'hand'|'faceDown' {
  return rule.source==='response' || rule.faceDownEnhancement ? 'faceDown' : rule.source==='enhancement' ? 'hand' : 'active';
}
const isHandFee=(e:Effect):e is Extract<Effect,{kind:'cards'}> & {fee:true;from:'hand';to:'discardPile'}=>e.kind==='cards' && !!e.fee && !e.deferredFee && e.from==='hand' && e.to==='discardPile';
/** Match all immediate hand fees together so one card cannot pay two costs. */
function canPayEffectFees(s:ReadState,effects:Effect[]):boolean {
  for(const seat of SEATS) {
    const fees=effects.filter((e):e is Extract<Effect,{kind:'cards'}>=>isHandFee(e)&&e.seat===seat);
    const slots=fees.flatMap(e=>(e.requirements??Array(e.min).fill('*')).map((requirement:string)=>
      s.decks[seat].hand.filter(c=>(!e.allowedIds||e.allowedIds.includes(c.id))&&(!e.filter||matchesCard(c,e.filter))&&matchesCard(c,requirement)).map(c=>c.id)));
    const matched=new Map<string,number>();
    function assign(i:number,seen:Set<string>):boolean {
      for(const id of slots[i])if(!seen.has(id)){seen.add(id);const old=matched.get(id);if(old===undefined||assign(old,seen)){matched.set(id,i);return true;}}
      return false;
    }
    if(!slots.every((_,i)=>assign(i,new Set())))return false;
  }
  return effects.every(e=>!e.fee||e.deferredFee||validEffect(s,e));
}
function validEffect(s:ReadState,e:Effect,f?:ResolutionFrame):boolean {
  if(e.kind==='balance')return !!s.rules?.balanceEnabled;
  if(e.kind==='prelude'||e.kind==='copyStatus')return !!s.prelude;
  if(e.requires && (!SEATS.includes(e.requires.seat) || s.decks[e.requires.seat].hand.length<e.requires.minHand)) return false;
  if(e.kind==='trace' || e.kind==='signal') return true;
  if(e.kind==='flag')return e.flag==='noAirDefense'||e.ids.length>0;
  if(e.kind==='randomPlay'&&e.group)return true;
  if(e.kind==='randomPlay'||e.kind==='randomReturn')return s.decks[e.seat].discardPile.length>0;
  if(e.kind==='frameChange')return !!s.resolution?.frames.some(f=>f.id===e.frameId&&f.status!=='COMPLETE');
  if(e.kind==='countChange')return !!s.resolution?.events.some(v=>v.id===e.eventId&&!v.applied&&v.effect?.kind==='deckTop');
  if(e.kind==='remove')return s.units.some(u=>u.id===e.unit.id)&&!s.turnFlags?.protected.includes(e.unit.id)&&!s.turnFlags?.battleProtected.includes(`${f?.parentEventId}:${e.unit.id}`);
  if(e.kind==='choose')return e.options.filter(o=>canExecuteEffects(s,o.effects)).length>=Math.max(1,e.min);
  if(e.kind==='cards') {
    const cards=s.decks[e.seat][e.from].filter(c=>(!e.allowedIds||e.allowedIds.includes(c.id))&&(!e.filter||matchesCard(c,e.filter)));return cards.length>=e.min&&(!e.requirements||coversCost(cards,e.requirements));
  }
  if(e.kind==='extraPlay')return extraCandidates(s,e).some(c=>(!e.onlyRemember||!!f?.memory?.[e.onlyRemember]?.includes(c.id))&&(!e.selectedCardId||c.id===e.selectedCardId));
  if(e.kind==='rebuild')return e.withdrawnIds?e.withdrawnIds.some(id=>!s.units.some(u=>u.id===id)):s.units.some(u=>u.country===e.country&&u.type==='army');
  if(e.kind==='action'&&e.fromBinding&&!f?.memory?.[e.fromBinding]?.some(id=>s.units.some(u=>u.id===id)))return false;
  if(e.kind==='action') return boardOptions(s,e).some(o=>!e.option || o.id===e.option.id);
  if(e.kind==='reallocate') return mayReallocate(s,e.seat) && !s.redistributed && reallocationCards(s,e.seat).length>0;
  if(e.kind==='cancel') {
    const event=s.resolution?.events.find(v=>v.id===f?.parentEventId);
    return !!event && !event.applied && !event.cancelled;
  }
  if(!SEATS.includes(e.seat)) return false;
  return e.kind==='score' ? Number.isSafeInteger(e.amount) : Number.isSafeInteger(e.count) && e.count>=0 && e.count<=100;
}
function legal(s:GameState, rule:TriggerRule, w:TriggerWindow): boolean {
  if(s.disabledResponseIds?.includes(rule.sourceInstanceId))return false;
  if(s.prelude?.active&&rule.source==='enhancement'&&!rule.faceDownEnhancement)return false;
  const r=engine(s), event=r.events.find(e=>e.id===w.originEventId)!;
  const parent=frameById(r,event.frameId), deck=s.decks[rule.owner];
  if(rule.boundEventId && rule.boundEventId!==event.id)return false;
  if (w.closed || !inWindowLane(rule,w) || w.timing==='Before' && event.cancelled) return false;
  if (!rule.mandatory && s.settings.ignoreOtherPlayerInterrupts && rule.owner!==r.owner) return false;
  if (r.fired.includes(`${event.id}:${rule.id}`) || rule.source!=='system'&&parent.sourceAncestors.includes(rule.sourceInstanceId)) return false;
  if (rule.source!=='system' && !deck[sourceZone(rule)].some(c=>c.id===rule.sourceInstanceId && c.deckOwner===rule.owner)) return false;
  if(rule.source==='active' && deck.active.find(c=>c.id===rule.sourceInstanceId)?.definitionId.startsWith('special_') && !hasStatus(s,Number(deck.active.find(c=>c.id===rule.sourceInstanceId)?.definitionId.replace('special_',''))))return false;
  if (!rule.effects.some(e=>!e.fee && !(e.kind==='signal'&&e.tag==='ARMAMENT') && validEffect(s,e,{...parent,parentEventId:event.id}))) return false;
  const available=deck.hand.filter(c=>c.id!==rule.sourceInstanceId);
  const probe={...s,decks:{...s.decks,[rule.owner]:{...deck,hand:available}}};
  if(!canPayEffectFees(probe,[...(rule.cost?[{kind:'cards',seat:rule.owner,from:'hand',to:'discardPile',min:rule.cost,max:rule.cost,requirements:rule.costRequirements,fee:true,label:'发动费用'} as Effect]:[]),...rule.effects]))return false;
  if(!canAffordHandCost(available,rule.costRequirements??Array(rule.cost??0).fill('*')))return false;
  if(rule.oncePerRound&&s.roundUses?.[rule.sourceInstanceId]===s.round)return false;
  return deck.hand.length >= (rule.minHand??0) && (!rule.oncePerTurn || !r.turnUses[`${s.round}:${s.activeSeat}:${rule.sourceInstanceId}:${rule.scopeId??rule.id}`]);
}
/** Refresh event-bound handlers without retaining conditions that have ceased to match. */
function refreshRules(s:GameState,frame:ResolutionFrame,eventId:string,timing:'Before'|'After') {
 const r=engine(s),event=r.events.find(e=>e.id===eventId)!;if(!event.effect)return;
 const fresh=realTriggers(s,{...frame,currentEventId:eventId},event.effect,timing).map(rule=>({...rule,generated:true}));
 const ids=new Set(fresh.map(rule=>rule.id));
 r.rules=r.rules.filter(rule=>!rule.generated||rule.boundEventId!==eventId||rule.timing!==timing||ids.has(rule.id));
 for(const rule of fresh){const i=r.rules.findIndex(old=>old.id===rule.id&&old.timing===timing);if(i<0)r.rules.push(rule);else r.rules[i]=rule;}
}
function remaining(s:GameState,w:TriggerWindow):TriggerRule[] {
  const r=engine(s);
  if(!s.resolutionVersion){
    w.remaining=w.remaining.filter(id=>legal(s,r.rules.find(rule=>rule.id===id)!,w));
    return w.remaining.map(id=>r.rules.find(rule=>rule.id===id)!);
  }
  if(w.closed)return [];
  const event=r.events.find(e=>e.id===w.originEventId)!;
  const frame=frameById(r,event.frameId);
  refreshRules(s,frame,event.id,w.timing);
  const related=r.rules.filter(rule=>rule.timing===w.timing&&rule.on===event.label&&(!rule.boundEventId||rule.boundEventId===event.id)&&inWindowLane(rule,w));
  w.opportunities=Object.fromEntries(related.map(rule=>[rule.id,r.fired.includes(`${event.id}:${rule.id}`)?'fired':w.declinedSeats?.includes(rule.owner)?'declined':legal(s,rule,w)?'available':'temporarily-illegal']));
  w.remaining=related.filter(rule=>w.opportunities![rule.id]==='available').map(rule=>rule.id);
  return w.remaining.map(id=>r.rules.find(rule=>rule.id===id&&rule.timing===w.timing)!);
}
function openWindow(s:GameState,frame:ResolutionFrame,timing:'Before'|'After',lane?:TriggerWindow['lane'],batchId?:string) {
  const r=engine(s), parent=[...r.stack].reverse().find(t=>t.kind==='window' && !windowById(r,t.id).closed);
  const parentWindow=parent ? windowById(r,parent.id) : null;
  const w:TriggerWindow={lane,batchId,id:uid(r,'window'),originEventId:frame.currentEventId!,parentWindowId:parentWindow?.id??null,depth:(parentWindow?.depth??-1)+1,timing,initialCandidates:[],remaining:[],mandatoryOrder:null,closed:false};
  const event=r.events.find(e=>e.id===w.originEventId)!;
  refreshRules(s,frame,event.id,timing);
  w.initialCandidates=r.rules.filter(rule=>rule.timing===timing && rule.on===event.label && legal(s,rule,w)).map(rule=>rule.id);
  w.remaining=[...w.initialCandidates];
  if (!w.remaining.length) return;
  r.windows.push(w); r.stack.push({kind:'window',id:w.id});
  record(s,'WINDOW_OPENED',`${event.label} · ${timing==='Before'?'生效前':'生效后'}时点打开。`);
}
function pushFrame(s:GameState, source:string, owner:SeatId,effects:Effect[],cardId?:string,finalZone:FinalZone='discardPile',parentWindow?:TriggerWindow,rollback?:GameState,committed=false) {
  effects=structuredClone(effects);
  const publicSourceZone=cardId?Object.entries(s.decks[owner]).find(([,cards])=>cards.some((c:{id:string})=>c.id===cardId))?.[0]:undefined;
  const r=engine(s), parentEvent=parentWindow ? r.events.find(e=>e.id===parentWindow.originEventId)! : null;
  const parent=parentEvent ? frameById(r,parentEvent.frameId) : null;
  if (cardId) {
    const deck=s.decks[owner];
    for (const zone of ['hand','faceDown','active'] as const) {
      const index=deck[zone].findIndex(c=>c.id===cardId);
      if(index>=0) { deck.resolving.push(...deck[zone].splice(index,1)); break; }
    }
  }
  const f:ResolutionFrame={noticeKind:parentEvent?.effect?.kind==='extraPlay'?'extra':undefined,publicSourceZone,id:uid(r,'frame'),source,cardId,owner,effects:structuredClone(effects),nextEffectIndex:0,stage:'Validate',status:'RUNNING',parentEventId:parentEvent?.id??null,ancestorIds:parentEvent?[...parentEvent.ancestorIds,parentEvent.id]:[],sourceAncestors:[...(parent?.sourceAncestors??[]),...(cardId?[cardId]:[])],currentEventId:null,finalZone};
  if(r.guided && cardId){f.guided=true;f.rollback=rollback;f.committed=committed;f.effects=f.effects.map(e=>({...e,optional:!e.fee && (e.kind!=='signal'||e.tag==='INSTALL')}));}
  if(cardId && s.decks[owner].resolving.some(c=>c.id===cardId&&specialCard(c.definitionId,c.balance)) && !effects.some(e=>e.kind==='signal'&&e.tag==='INSTALL'))f.effects.unshift({kind:'signal',tag:'CARD_EFFECT',label:`【${source}】开始生效`});
  if(cardId&&s.decks[owner].resolving.some(c=>c.id===cardId&&specialCard(c.definitionId,c.balance))&&finalZone==='active'&&!effects.some(e=>e.kind==='signal'&&e.tag==='INSTALL'))f.effects.push({kind:'signal',tag:'CARD_EFFECT_DONE',label:`【${source}】效果已结算`});
  if(f.guided){f.declarationPending=f.effects.some(e=>e.kind==='signal'&&e.tag==='CARD_EFFECT');f.effects=f.effects.filter(e=>e.kind!=='signal'||e.tag!=='CARD_EFFECT');}
  if(f.guided&&cardId&&s.decks[owner].resolving.some(c=>c.id===cardId&&c.definitionId==='special_98'))f.effects=f.effects.map(e=>e.kind==='choose'?{kind:'action',country:'united_kingdom',action:'build_army',buildEither:true,optional:true,label:'请选择建设陆军或海军'}:e);
  r.frames.push(f); r.stack.push({kind:'frame',id:f.id});
  if(!f.guided||f.committed)declarePublicCard(s,f);
  record(s,'FRAME_STARTED',`开始结算【${source}】${cardId?'，卡牌进入结算中区域':''}。`);
}
function fire(s:GameState,w:TriggerWindow,rule:TriggerRule,rollback?:GameState) {
  const r=engine(s);
  // An ancestor activation leaves the descendant branch. Delay closure until fire()
  // so merged target selection and payment both retain their original window context.
  const selectedIndex=r.stack.findIndex(task=>task.kind==='window'&&task.id===w.id);
  if(selectedIndex>=0)for(const task of r.stack.slice(selectedIndex+1))if(task.kind==='window') {
    const child=windowById(r,task.id);
    if(!child.closed){closeWindow(child,'branch-left');fact(s,'window_closed','切换触发分支，关闭子窗口',{windowId:child.id});}
  }
  w.remaining=w.remaining.filter(id=>id!==rule.id);
  r.fired.push(`${w.originEventId}:${rule.id}`);
  const scope=`${s.round}:${s.activeSeat}:${rule.sourceInstanceId}:${rule.scopeId??rule.id}`;
  if(rule.oncePerRound)(s.roundUses??={})[rule.sourceInstanceId]=s.round;
  r.turnUses[scope]=(r.turnUses[scope]??0)+1;
  pushFrame(s,rule.label,rule.owner,rule.effects,rule.source==='system'?undefined:rule.sourceInstanceId,rule.finalZone??(rule.source==='active'?'active':'discardPile'),w,rollback,!!rule.cost||rule.mandatory);
  r.frames[r.frames.length-1].noticeKind='trigger';
  if(rule.atomic||rule.mandatory){const f=r.frames[r.frames.length-1];f.effects.forEach(e=>e.optional=false);}
  if(rule.effects.filter(e=>!e.fee).length===1){const f=r.frames[r.frames.length-1],e=f.effects.find(e=>e.optional);if(e&&e.kind!=='action'){e.accepted=true;f.committed=true;f.rollback=undefined;declarePublicCard(s,f);}}
}
function activate(s:GameState,w:TriggerWindow,rule:TriggerRule,selected=false,rollback?:GameState) {
  if(!engine(s).guided && s.mode!=='BASIC_DEBUG' && !rule.atomic && !selected && !rule.mandatory && rule.effects.filter(e=>!e.fee).length>1) {
    const options=rule.effects.flatMap((e,i)=>e.fee?[]:[{id:String(i),label:e.label}]);
    ask(s,{kind:'EFFECTS',seat:rule.owner,prompt:`选择【${rule.label}】要执行的效果，仍按牌面顺序结算`,min:1,max:options.length,options,windowId:w.id,triggerId:rule.id}); return;
  }
  if (rule.cost) {
    const cards=s.decks[rule.owner].hand.filter(c=>c.id!==rule.sourceInstanceId);
    const count=rule.cost;
    ask(s,{kind:'PAY_COST',seat:rule.owner,prompt:`为【${rule.label}】支付 ${rule.cost} 张手牌费用${rule.costRequirements?`（${rule.costRequirements.map(id=>id==='*'?'任意手牌':cardName({definitionId:id})).join('、')}）`:''}；选择 ${count} 张`,min:count,max:count,options:cards.map(c=>({id:c.id,label:c.definitionId})),windowId:w.id,triggerId:rule.id});
  } else fire(s,w,rule,rollback);
}
/** Prepare independent status frames, then expose one response list per batch boundary. */
function startScoreBatch(s:GameState,w:TriggerWindow,rules:TriggerRule[]) {
 const r=engine(s),batch={id:uid(r,'score-batch'),windowId:w.id,frameIds:[] as string[],phase:'before' as const,index:0};
 (r.scoreBatches??=[]).push(batch);
 for(const rule of rules){
  fire(s,w,rule);const f=r.frames[r.frames.length-1];r.stack.pop();
  f.scoreBatchId=batch.id;batch.frameIds.push(f.id);
 }
 r.stack.push({kind:'scoreBatch',id:batch.id});
 for(const id of [...batch.frameIds].reverse()){
  const f=frameById(r,id),effect:Effect={kind:'signal',tag:'CARD_EFFECT',label:`【${f.source}】开始生效`};
  f.currentEventId=uid(r,'event');r.events.push({id:f.currentEventId,label:effect.label,frameId:f.id,ancestorIds:[...f.ancestorIds],cancelled:false,applied:false,outcome:'declared',effect});
  openWindow(s,f,'Before',undefined,batch.id);
 }
}
function runScoreBatch(s:GameState,id:string) {
 const r=engine(s),batch=r.scoreBatches!.find(b=>b.id===id)!;
 if(batch.phase==='before'){for(const fid of batch.frameIds){const f=frameById(r,fid),event=r.events.find(e=>e.id===f.currentEventId);if(event&&!f.cancelled){event.applied=true;event.started=true;event.ended=true;event.outcome='succeeded';}}batch.phase='run';}
 if(batch.phase==='run'){
  if(batch.index<batch.frameIds.length){
   const f=frameById(r,batch.frameIds[batch.index++]);
   // Re-read amounts at execution; suppression/cancellation never becomes a score.
   if(!f.cancelled){
    const origin=r.events.find(e=>e.id===f.parentEventId)!,parent=frameById(r,origin.frameId);
    const fresh=realTriggers(s,{...parent,currentEventId:origin.id},origin.effect!,'After',true,true,f.cardId).find(rule=>rule.sourceInstanceId===f.cardId);
    if(fresh&&isBatchScore(fresh,origin.effect))f.effects=structuredClone(fresh.effects);
    else f.effects=[];
    f.nextEffectIndex=0;f.stage='Validate';f.currentEventId=null;
   }
   r.stack.push({kind:'frame',id:f.id});return;
  }
  batch.phase='after';
  for(const fid of [...batch.frameIds].reverse()){
   const f=frameById(r,fid);if(f.cancelled)continue;
   f.effectCompletionNotified=true;
   const effect:Effect={kind:'signal',tag:'CARD_EFFECT_DONE',completedFrameId:f.id,label:`【${f.source}】效果已结算`};
   f.currentEventId=uid(r,'event');r.events.push({id:f.currentEventId,label:effect.label,frameId:f.id,ancestorIds:[...f.ancestorIds],cancelled:false,applied:true,outcome:'succeeded',started:true,ended:true,effect});
   openWindow(s,f,'After',undefined,batch.id);
  }
  return;
 }
 batch.phase='finish';
 for(const fid of batch.frameIds){const f=frameById(r,fid);r.stack.push({kind:'frame',id:fid});finishFrame(s,f);}
 r.stack.pop();
}
function commitEffect(_s:GameState,f:ResolutionFrame,e:Effect) {
  declarePublicCard(_s,f);
  e.accepted=true;f.committed=true;f.rollback=undefined;
  if(f.declarationPending){f.declarationPending=false;f.effects.splice(f.nextEffectIndex,0,{kind:'signal',tag:'CARD_EFFECT',label:`【${f.source}】开始生效`});}
}
function finishFrame(s:GameState,f:ResolutionFrame) {
  if(!f.ownEffectsComplete){f.ownEffectsComplete=true;record(s,'CARD_OWN_EFFECTS_COMPLETE',`【${f.source}】自身效果结束${f.cancelled?'（已取消）':''}。`);} 
  if(f.scoreBatchId&&engine(s).scoreBatches?.find(b=>b.id===f.scoreBatchId)?.phase!=='finish'){engine(s).stack.pop();f.status='WAITING_RESPONSE';return;}
  if(!f.declined){declarePublicCard(s,f);notifyResponseFrame(s,f);}
  if (f.cardId) {
    const deck=s.decks[f.owner], index=deck.resolving.findIndex(c=>c.id===f.cardId);
    if(index>=0) {
      const cards=deck.resolving.splice(index,1);
      if(s.rules?.balanceEnabled&&cards[0]?.definitionId==='special_251'&&f.finalZone==='discardPile')f.finalZone='removed';
      if(s.prelude?.historyDiscard&&f.finalZone==='discardPile'&&cards.every(c=>c.definitionId.startsWith('prelude_')&&specialCard(c.definitionId,c.balance)?.type==='历史'))s.prelude.decks[f.owner].discardPile.push(...cards);
      else if(f.finalZone==='drawPile')for(const card of cards)insertRandom(deck.drawPile,card,s);
      else deck[f.finalZone].push(...cards);
    }
  }
  f.status='COMPLETE'; engine(s).stack.pop();
  checkNeutralitySupply(s);
  record(s,'FINISH_CARD_RESOLUTION',`【${f.source}】及其子结算完成${f.cardId?`；最终去向：${({discardPile:'弃牌堆',active:'持续生效区',hand:'手牌',drawPile:'牌库随机位置',removed:'移出游戏',faceDown:'暗置区'})[f.finalZone]}`:''}。`);
}
function paymentBranch(e:Effect){
 if(e.kind!=='choose'||e.min!==0||e.max!==1||e.options.length!==1)return;
 const cost=e.options[0].effects[0];
 if(cost?.kind==='cards'&&isHandFee(cost)&&cost.seat===e.seat)return cost;
}
function selectionRequest(s:GameState,f:ResolutionFrame,e:Effect):boolean {
 const payment=paymentBranch(e),cost=e.kind==='cards'?e:payment;
 if(cost&&!cost.random){
  const cards=s.decks[cost.seat][cost.from].slice(0,cost.topCount).filter(c=>(!cost.allowedIds||cost.allowedIds.includes(c.id))&&(!cost.filter||matchesCard(c,cost.filter)));
  ask(s,{kind:'CARDS',preselect:true,seat:cost.from==='faceDown'?f.owner:cost.seat,prompt:payment?e.label:cost.label,min:cost.min,max:Math.min(cost.max,cards.length),requirements:cost.requirements,options:cards.map((c,i)=>({id:c.id,label:cost.from==='faceDown'?`暗置卡牌 ${i+1}`:c.definitionId})),frameId:f.id,canSkip:!!payment||!!e.optional&&!e.accepted||!!e.fee&&!f.committed});return true;
 }
 if(e.kind==='choose'){
  const options=e.options.filter(o=>canExecuteEffects(s,o.effects));
  if(e.autoSingle&&e.min===1&&options.length===1){e.selectedIds=[options[0].id];e.accepted=true;return false;}
  ask(s,{kind:'SELECT',preselect:true,seat:e.seat,prompt:e.label,min:e.min,max:Math.min(e.max,options.length),options:options.map(o=>({id:o.id,label:o.label})),frameId:f.id,canSkip:e.min===0||e.seat===f.owner&&!!e.optional&&!e.accepted});return true;
 }
 return false;
}
function applySelectedCards(s:GameState,f:ResolutionFrame,e:Extract<Effect,{kind:'cards'}>,ids:string[]):boolean {
 const r=engine(s);
    const deck=s.decks[e.seat];
    const cards=ids.map(id=>deck[e.from].find(card=>card.id===id));
    if(cards.some(card=>!card||e.allowedIds&&!e.allowedIds.includes(card.id)||e.filter&&!matchesCard(card,e.filter)))return false;
    if(e.requirements&&!coversCost(cards.filter((card):card is NonNullable<typeof card>=>!!card),e.requirements))return false;
    const publicIds=publicCostIds(cards.filter((c):c is NonNullable<typeof c>=>!!c),e.requirements,e.filter,e.publicDiscard);
    if(isHandFee(e)) {
      const after={...s,decks:{...s.decks,[e.seat]:{...deck,hand:deck.hand.filter(card=>!ids.includes(card.id))}}};
      if(!canPayEffectFees(after,f.effects.slice(f.nextEffectIndex+1)))return false;
      if(!payDiscardCost(s,e.seat,e.min,ids,false,undefined,publicIds))return false;
    } else if(e.from==='hand'&&e.to==='discardPile'){discardHandCards(s,e.seat,ids,publicIds);
    } else {
      deck[e.from]=deck[e.from].filter(card=>!ids.includes(card.id));
      if(e.to==='discardPile')putDiscardedCards(s,e.seat,cards.map(c=>c!));else if(e.to==='drawPile'&&!e.bottom)deck.drawPile.unshift(...cards.map(c=>c!));else deck[e.to].push(...cards.map(c=>c!));
    }
    if(e.shuffle)shuffle(deck.drawPile,s);
    if(e.to==='discardPile'&&['drawPile','faceDown'].includes(e.from)&&cards.length){r.events.find(event=>event.id===f.currentEventId)!.detailedNoticeSeats=[e.seat];addResponseNotice(s,[e.seat],`${COUNTRY_NAMES[e.seat]}被弃置：${cards.map(c=>`【${cardName(c!)}】`).join('、')}。`,cards.map(c=>c!),'弃牌结果');}
    if(e.from==='active'&&e.to==='discardPile'){revealPublic(s,cards.map(c=>c!));publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+'弃置持续生效卡牌：'+cards.map(c=>'【'+cardName(c!)+'】').join('、')+'。');}
    if(['hand','drawPile','faceDown'].includes(e.to))concealPublic(s,ids);
    if(e.remember){f.memory??={};f.memory[e.remember]=ids;}
    Object.assign(r.events.find(event=>event.id===f.currentEventId)!,{applied:true,outcome:'succeeded'});
    fact(s,e.fee?'cost_paid':'card_moved',e.label,{seat:e.seat,from:e.from,to:e.to,cardIds:ids});
    r.trace.push(e.label);return true;
}
function apply(s:GameState,f:ResolutionFrame,e:Effect):boolean {
  const r=engine(s), event=r.events.find(v=>v.id===f.currentEventId)!;
  if(e.kind==='copyStatus'){
    const origin=r.events.find(v=>v.id===e.eventId),originFrame=origin&&r.frames.find(v=>v.id===origin.frameId);
    if(origin?.effect&&originFrame){const rules=copiedStatusRules(s,{...originFrame,currentEventId:origin.id},origin.effect,e.timing);
      if(!e.cardId)f.effects.splice(f.nextEffectIndex+1,0,{kind:'choose',seat:e.seat,min:1,max:1,label:e.label,options:rules.map(rule=>({id:rule.sourceInstanceId,label:s.decks[e.seat].discardPile.find(c=>c.id===rule.sourceInstanceId)!.definitionId,effects:[{...e,cardId:rule.sourceInstanceId}]}))});
      else {const rule=rules.find(v=>v.sourceInstanceId===e.cardId),deck=s.decks[e.seat],i=deck.discardPile.findIndex(c=>c.id===e.cardId);if(rule&&i>=0){const card=deck.discardPile.splice(i,1)[0];deck.active.push(card);const scope=`${s.round}:${s.activeSeat}:${card.id}:${rule.scopeId??rule.id}`;r.turnUses[scope]=(r.turnUses[scope]??0)+1;pushFrame(s,cardName(card),e.seat,rule.effects,card.id,'discardPile',{originEventId:origin.id} as TriggerWindow);r.frames[r.frames.length-1].effects.forEach(v=>v.optional=false);if(card.definitionId==='special_135')s.resolutionResume={phase:'AIR',apply:false};}}
    }
  }else if(e.kind==='balance'){applyBalanceEffect(s,f,e);}
  else if(e.kind==='prelude'){applyPreludeEffect(s,f,e,(card,effects,zone)=>{pushFrame(s,cardName(card),card.deckOwner,effects,card.id,zone,{originEventId:f.currentEventId!} as TriggerWindow);r.frames[r.frames.length-1].noticeKind='extra';});}
  else if(e.kind==='choose') {
    if(e.selectedIds){const payment=paymentBranch(e);const options=payment?e.options:e.options.filter(o=>e.selectedIds!.includes(o.id));if(options.some(o=>!canExecuteEffects(s,o.effects))){delete e.selectedIds;selectionRequest(s,f,e);return false;}const effects=structuredClone(options.flatMap(o=>o.effects));if(payment&&effects[0]?.kind==='cards')effects[0].selectedIds=[...e.selectedIds];f.effects.splice(f.nextEffectIndex+1,0,...effects);event.applied=true;event.outcome='succeeded';r.trace.push(e.label);return true;}
    const options=e.options.filter(o=>canExecuteEffects(s,o.effects));
    if(e.autoSingle&&e.min===1&&options.length===1){f.effects.splice(f.nextEffectIndex+1,0,...structuredClone(options[0].effects));fact(s,'automatic_choice',e.label,{seat:e.seat,selected:[options[0].id],reason:'only_legal_option'});event.applied=true;event.outcome='succeeded';r.trace.push(e.label);return true;}
    ask(s,{kind:'SELECT',seat:e.seat,prompt:e.label,min:e.min,max:Math.min(e.max,options.length),options:options.map(o=>({id:o.id,label:o.label})),frameId:f.id});return false;
  } else if(e.kind==='randomReturn') {
    const deck=s.decks[e.seat],random=[...deck.discardPile];shuffle(random,s);
    const cards=random.slice(0,f.memory?.[e.countFrom]?.length??0);
    deck.discardPile=deck.discardPile.filter(c=>!cards.some(v=>v.id===c.id));deck.drawPile.unshift(...cards);
  } else if(e.kind==='randomPlay') {
    if(e.group){
      r.revealGroup={frameId:f.id,items:e.group.map(seat=>{
        const random=[...s.decks[seat].discardPile];shuffle(random,s);const card=random[0];
        const d=card&&specialCard(card.definitionId,card.balance);
        const play:Effect={kind:'extraPlay',seat,from:'discardPile',onlyCardIds:card?[card.id]:[],label:e.label};
        const requestId=uid(r,`reveal-request:${s.balanceResolutionSerial??0}`),resultId=uid(r,`reveal-result:${s.balanceResolutionSerial??0}`);
        (s.responseNotices??=[]).push({id:requestId,recipients:[seat],readBy:[],title:'确认翻牌',text:`意大利打出了【${f.source}】，请确认随机翻开本国弃牌堆的一张牌。`,cards:[]});
        return {seat,requestId,resultId,card,playable:!!card&&(!d||['状态','经济战'].includes(d.type))&&extraCandidates(s,play).some(c=>c.id===card.id)};
      })};
    } else {
    const deck=s.decks[e.seat],random=[...deck.discardPile];shuffle(random,s);const card=random[0];
    if(card) {
      record(s,'RANDOM_CARD_REVEALED',`${COUNTRY_NAMES[e.seat]}随机展示【${cardName(card)}】。`);
      const d=specialCard(card.definitionId,card.balance);
      const play:Effect={kind:'extraPlay',seat:e.seat,from:'discardPile',selectedCardId:card.id,allowSkip:true,returnOnSkip:true,label:`可额外打出【${cardName(card)}】，或置于牌库顶`};
      if((!d||['状态','经济战'].includes(d.type))&&extraCandidates(s,play).some(c=>c.id===card.id)) {
        play.selectedCardId=undefined;play.onlyCardIds=[card.id];f.effects.splice(f.nextEffectIndex+1,0,play);
      } else {deck.discardPile=deck.discardPile.filter(c=>c.id!==card.id);deck.drawPile.unshift(card);}
    }
    }
  } else if(e.kind==='extraPlay') {
    const deck=s.decks[e.seat],card=deck[e.from].find(c=>c.id===e.selectedCardId)!;
    const effects=extraEffects(s,card,e.targets??[]).filter((effect,i)=>effect.fee||e.indices?.includes(i));
    const probe={...s,decks:{...s.decks,[e.seat]:{...deck,hand:deck.hand.filter(c=>c.id!==card.id)}}};
    if(!canExecuteEffects(probe,effects))return true;
    if(r.guided&&!f.extraRollback){
      const snapshot=structuredClone(s),sr=snapshot.resolution!;
      sr.choice={id:uid(sr,'retry-extra'),kind:'EXTRA_CARD',seat:e.seat,prompt:e.label,min:e.allowSkip?0:1,max:1,options:[{id:card.id,label:card.definitionId}],frameId:f.id};snapshot.operatorSeat=e.seat;f.extraRollback=snapshot;
    }
    if(e.from!=='hand'){deck[e.from]=deck[e.from].filter(c=>c.id!==card.id);deck.hand.push(card);}
    if(e.shuffle)shuffle(deck.drawPile,s);
    const d=specialCard(card.definitionId,card.balance);
    const rollback=f.extraRollback;f.extraRollback=undefined;
    pushFrame(s,cardName(card),e.seat,[...effects,{kind:'signal',tag:'CARD_PLAYED',label:`额外打出【${cardName(card)}】后`}],card.id,d?.type==='状态'?'active':d?.type==='响应'?'faceDown':'discardPile',{originEventId:f.currentEventId!} as TriggerWindow,rollback);
  } else if(e.kind==='cards') {
    if(e.selectedIds){if(applySelectedCards(s,f,e,[...e.selectedIds]))return true;delete e.selectedIds;}
    const cards=s.decks[e.seat][e.from].slice(0,e.topCount).filter(c=>(!e.allowedIds||e.allowedIds.includes(c.id))&&(!e.filter||matchesCard(c,e.filter)));
    if(e.random){
      const candidates=[...cards];shuffle(candidates,s);const selected=candidates.slice(0,e.min),ids=selected.map(c=>c.id),deck=s.decks[e.seat];
      deck[e.from]=deck[e.from].filter(c=>!ids.includes(c.id));if(e.to==='discardPile')putDiscardedCards(s,e.seat,selected);else deck[e.to].push(...selected);
      const shown=selected.filter(c=>s.faceUpResponseIds?.includes(c.id));concealPublic(s,ids);revealPublic(s,shown);
      const object=e.from==='faceDown'?'响应卡':'卡牌';
      event.applied=true;event.outcome='succeeded';event.resultText=selected.length?`${COUNTRY_NAMES[f.owner]}弃置了${COUNTRY_NAMES[e.seat]}的 ${selected.length} 张${object}`:`${COUNTRY_NAMES[e.seat]}没有可弃置的${object}`;
      if(selected.length&&e.to==='discardPile'){
        const revealed=(f.memory?.revealedResponses??[]).flatMap(id=>Object.values(s.decks[e.seat]).flat().filter(c=>c.id===id));
        addResponseNotice(s,[e.seat],`${revealed.length?`${COUNTRY_NAMES[f.owner]}揭开了${COUNTRY_NAMES[e.seat]}的响应：${revealed.map(c=>`【${cardName(c)}】`).join('、')}；`:''}${COUNTRY_NAMES[f.owner]}弃置了${COUNTRY_NAMES[e.seat]}的卡牌：${selected.map(c=>`【${cardName(c)}】`).join('、')}。`,[...revealed,...selected],'弃牌结果');
        event.detailedNoticeSeats=[e.seat];
        publicRecord(s,f.owner,event.resultText+'。');
      }
      r.trace.push(e.label);return true;
    }
    ask(s,{kind:'CARDS',seat:e.from==='faceDown'?f.owner:e.seat,prompt:e.label,min:Math.min(e.min,cards.length),max:Math.min(e.max,cards.length),options:cards.map((c,i)=>({id:c.id,label:e.from==='faceDown'?`暗置卡牌 ${i+1}`:c.definitionId})),frameId:f.id});return false;
  } else if(e.kind==='rebuild') {
    if(!e.withdrawnIds) {
      const armies=s.units.filter(u=>u.country===e.country&&u.type==='army'),supplied=suppliedUnits(s);
      f.effects.splice(f.nextEffectIndex+1,0,...armies.map((unit):Effect=>({kind:'remove',unit:{...unit},supplied:supplied.has(unit.id),cause:'rebuild',label:'收回陆军'})),{...e,withdrawnIds:armies.map(u=>u.id)});
    }else {
      const withdrawn=e.withdrawnIds.filter(id=>!s.units.some(u=>u.id===id));
      f.effects.splice(f.nextEffectIndex+1,0,...withdrawn.map((_,i):Effect=>({kind:'action',country:e.country,action:'build_army',newOnly:true,label:`重新建设第 ${i+1}/${withdrawn.length} 支陆军`})));
    }
  } else if(e.kind==='frameChange') {
    const target=frameById(r,e.frameId);
    if(e.finalZone)target.finalZone=e.finalZone;
    // A returned card is available for other costs at this same timing. The
    // parent frame will not move it again once it has left resolving.
    if(s.resolutionVersion===3&&e.finalZone==='hand'&&target.cardId){
      const deck=s.decks[target.owner],index=deck.resolving.findIndex(c=>c.id===target.cardId);
      if(index>=0)deck.hand.push(...deck.resolving.splice(index,1));
    }
    if(e.cancel){target.cancelled=true;target.nextEffectIndex=target.effects.length;const current=r.events.find(v=>v.id===target.currentEventId);if(current){current.cancelled=true;current.outcome='cancelled';}}
  } else if(e.kind==='countChange') {
    const target=r.events.find(v=>v.id===e.eventId)!;const parent=frameById(r,target.frameId),effect=parent.effects[parent.nextEffectIndex];
    if(effect.kind==='deckTop')effect.count+=e.delta;
    if(target.effect?.kind==='deckTop')target.effect.count=effect.kind==='deckTop'?effect.count:target.effect.count;
  } else if(e.kind==='flag') {
    s.turnFlags??={protected:[],battleProtected:[],supplied:[],supplyCountries:[],supplyRegions:[],suppressed:[],noAirDefense:false};
    if(e.flag==='noAirDefense')s.turnFlags.noAirDefense=true;else s.turnFlags[e.flag].push(...e.ids.map(id=>e.flag==='battleProtected'?`${f.parentEventId}:${id}`:id));
  } else if(e.kind==='remove') {
    s.units=s.units.filter(u=>u.id!==e.unit.id);
    if(e.unit.type!=='air'&&!s.units.some(u=>u.country===e.unit.country&&u.type!=='air'&&u.regionId===e.unit.regionId))s.pendingAir.push(...s.units.filter(u=>u.country===e.unit.country&&u.type==='air'&&u.regionId===e.unit.regionId).map(u=>u.id));
    fact(s,'unit_removed',e.label,{unit:e.unit,cause:e.cause});
  } else if(e.kind==='action') {
    const removals:Effect[]=[],supplied=suppliedUnits(s);
    if(e.action==='destroy')e.destroyedType=s.units.find(u=>u.id===e.option?.defenderId)?.type;
    if(!applyBoardEffect(s,e,id=>{const unit=s.units.find(u=>u.id===id);if(unit)removals.push({kind:'remove',unit:{...unit},supplied:supplied.has(id),cause:e.action,label:`移除${COUNTRY_NAMES[unit.country]}${REGION_BY_ID[unit.regionId].name}的部队`});})) return true;
    event.effect=structuredClone(e);
    if(e.bindAs&&e.resultUnitId){f.memory??={};f.memory[e.bindAs]=[e.resultUnitId];}
    if(removals.length)pushFrame(s,'部队移除',f.owner,removals,undefined,'discardPile',{originEventId:f.currentEventId!} as TriggerWindow);
  }
  else if(e.kind==='reallocate') {
    ask(s,{kind:'REALLOCATE',seat:e.seat,prompt:'资源重整：取得一张基本牌（含空中力量）',min:1,max:1,options:reallocationCards(s,e.seat).map(c=>({id:c.id,label:c.definitionId})),frameId:f.id});return false;
  } else if(e.kind==='forceHand') {
    const hand=s.decks[e.seat].hand, count=Math.min(e.count,hand.length);
    if(count && count<hand.length) {
      ask(s,{kind:'FORCE_HAND',seat:e.seat,prompt:`${COUNTRY_NAMES[e.seat]}必须弃置 ${count} 张手牌`,min:count,max:count,options:hand.map(c=>({id:c.id,label:c.definitionId})),frameId:f.id});
      return false;
    }
    forceDiscardHand(s,e.seat,e.count,hand.slice(0,count).map(c=>c.id));
    event.resultText=`${COUNTRY_NAMES[e.seat]}弃置手牌 ${count} 张`;
  } else if(e.kind==='draw') {const count=drawCards(s,e.seat,e.count);event.resultText=`${COUNTRY_NAMES[e.seat]}摸牌 ${count} 张`;}
  else if(e.kind==='deckTop') {const result=discardDeckTop(s,e.seat,e.count,f.owner);if(e.count)event.detailedNoticeSeats=[e.seat];event.resultText=`${COUNTRY_NAMES[e.seat]}弃置牌库顶 ${result.discarded} 张${result.lost?`，牌库不足扣 ${result.lost} 分`:''}`;}
  else if(e.kind==='score') s.scores[e.seat]+=e.amount;
  else if(e.kind==='cancel') {
    const target=r.events.find(v=>v.id===f.parentEventId);
    if(!target || target.applied) return true;
    target.cancelled=true;
  }
  recordPublicEffect(s,f,e);
  event.applied=true;event.outcome='succeeded'; r.trace.push(e.label);
  checkNeutralitySupply(s);
  record(s,'EFFECT_APPLIED',`执行：${e.label}。`);
  return true;
}
/** Runs until a real player decision. Stack, windows and cursor are all serializable. */
export function runResolution(s:GameState) {
  const r=engine(s);
  while(r.stack.length && !r.choice && !r.revealGroup) {
    if(s.neutralityStatusPending){
      s.neutralityStatusPending=false;
      const effect:Effect={kind:'extraPlay',seat:'soviet_union',from:'hand',filter:'状态',allowSkip:true,label:'混乱的政局：可以打出一张手牌中的状态牌，或跳过'};
      if(validEffect(s,effect)){pushFrame(s,'混乱的政局：参战效果','soviet_union',[effect]);r.frames[r.frames.length-1].noticeKind='neutrality';continue;}
    }
    if(s.pendingAir.length) {
      const air=s.units.find(u=>u.id===s.pendingAir[0]);
      if(!air) {s.pendingAir.shift();continue;}
      const destinations=airDestinations(s,air.id);
      if(!destinations.length) {s.units=s.units.filter(u=>u.id!==air.id);s.pendingAir.shift();record(s,'AIR_REMOVED','空军无合法免费调度位置，移回储备。');continue;}
      ask(s,{kind:'RELOCATE',seat:seatOf(air.country),prompt:'请选择空军免费强制调度位置',min:1,max:1,options:destinations.map(id=>({id,label:REGION_BY_ID[id].name})),airId:air.id});continue;
    }
    const task=r.stack[r.stack.length-1];
    if(task.kind==='scoreBatch'){runScoreBatch(s,task.id);continue;}
    if(task.kind==='window') {
      const w=windowById(r,task.id), available=remaining(s,w);
      // Resolve the defender's post-battle opportunities before offering follow-up
      // attacks. Use the battle snapshot: the defeated unit may already be gone.
      const origin=r.events.find(event=>event.id===w.originEventId)?.effect;
      const defender=w.timing==='After'&&origin?.kind==='action'&&(['land_battle','sea_battle'].includes(origin.action)||origin.action==='air_power'&&origin.option?.mode==='supremacy')&&origin.option?.defenderCountry?seatOf(origin.option.defenderCountry):undefined;
      const defensive=defender?available.filter(rule=>rule.owner===defender):[];
      const candidates=defensive.length?defensive:available;
      if(w.closed || !candidates.length) { closeWindow(w); r.stack.pop(); fact(s,'window_closed','响应窗口关闭',{windowId:w.id});continue; }
      const mandatory=candidates.filter(rule=>rule.mandatory);
      if(r.schedulerVersion&&mandatory.length>1&&mandatory.every(rule=>isBatchScore(rule,r.events.find(e=>e.id===w.originEventId)?.effect))){startScoreBatch(s,w,mandatory);continue;}
      if(mandatory.length) {
        if(mandatory.length>1 && w.mandatoryOrder===null && !mandatory.every(rule=>!rule.cost&&rule.effects.every(effect=>effect.kind==='score'))) {
          const frame=frameById(r,r.events.find(e=>e.id===w.originEventId)!.frameId);
          ask(s,{kind:'ORDER_MANDATORY_TRIGGERS',seat:frame.owner,prompt:'请决定这些必发效果的完整顺序',min:mandatory.length,max:mandatory.length,options:mandatory.map(rule=>({id:rule.id,label:rule.label})),windowId:w.id});
        } else {
          const next=w.mandatoryOrder?.find(id=>mandatory.some(rule=>rule.id===id));
          const chosen=mandatory.find(rule=>rule.id===next)??mandatory[0];
          fact(s,'automatic_choice','执行必发效果',{seat:chosen.owner,prompt:chosen.label,options:[{id:chosen.id,label:chosen.label}],selected:[chosen.id],reason:'mandatory_trigger'});
          activate(s,w,chosen);
        }
        continue;
      }
      const open=r.stack.filter(t=>t.kind==='window').map(t=>windowById(r,t.id)).filter(win=>!win.closed&&(w.batchId?win.batchId===w.batchId:!win.batchId));
      const order=[r.owner,...SEATS.filter(seat=>seat!==r.owner)];
      const priority=candidates.filter(rule=>rule.placementPriority&&!rule.mandatory);
      const eligible=priority.length?priority:candidates;
      const responder=order.find(seat=>eligible.some(rule=>!rule.mandatory&&rule.owner===seat))!;
      const options=open.flatMap(win=>remaining(s,win).filter(rule=>!rule.mandatory&&rule.owner===responder&&(!defensive.length||win.id===w.id)&&(!priority.length||win.id===w.id&&rule.placementPriority)).map(rule=>({id:`${win.id}/${rule.id}`,label:rule.label,windowId:win.id})));
      const labelled=options.map(option=>{const win=windowById(r,option.windowId!),event=r.events.find(e=>e.id===win.originEventId)!,frame=frameById(r,event.frameId);return w.batchId?{...option,label:`${option.label} → ${frame.source}`} :option;});
      const mergedTriggers:NonNullable<ChoiceRequest['mergedTriggers']>={};
      const blitz=labelled.filter(o=>r.rules.find(rule=>o.id===`${o.windowId}/${rule.id}`)?.scopeId==='special_136');
      if(blitz.length>1){const refs=blitz.map(o=>({windowId:o.windowId!,ruleId:r.rules.find(rule=>o.id===`${o.windowId}/${rule.id}`)!.id}));const key=blitz[0].id;mergedTriggers[key]=refs;for(const o of blitz.slice(1))labelled.splice(labelled.indexOf(o),1);}
      ask(s,{kind:'TRIGGER',batchResponse:w.batchId?(w.timing==='Before'?'before':'after'):undefined,mergedTriggers,seat:responder,prompt:responder===r.owner?'选择要触发的效果，或结束本国在当前时点的响应':'是否响应？选择要发动的效果，或放弃本次响应',min:0,max:1,options:labelled,windowId:w.id});
      continue;
    }
    const f=frameById(r,task.id); f.status='RUNNING';
    if(f.nextEffectIndex>=f.effects.length) {
      if(f.guided&&!f.committed&&f.rollback){const revision=s.revision,view=s.viewSeat,disabledResponseIds=s.disabledResponseIds;const restored=structuredClone(f.rollback);Object.keys(s).forEach(k=>delete (s as unknown as Record<string,unknown>)[k]);Object.assign(s,restored,{revision,viewSeat:view,disabledResponseIds});return;}
      finishFrame(s,f); continue;
    }
    const e=f.effects[f.nextEffectIndex];
    if(f.scoreBatchId&&e.kind==='signal'&&['CARD_EFFECT','CARD_EFFECT_DONE'].includes(e.tag)){f.nextEffectIndex++;continue;}
    if(e.kind==='signal'&&e.tag==='CARD_EFFECT_DONE'&&f.effectCompletionNotified){f.nextEffectIndex++;continue;}
    if(f.guided&&!f.committed&&e.kind==='signal'&&['CARD_PLAYED','CARD_EFFECT_DONE','STANDARD_CARD_PLAYED'].includes(e.tag)){f.nextEffectIndex++;continue;}
    if(e.kind==='action'&&e.fromBinding){const unit=s.units.find(u=>u.id===f.memory?.[e.fromBinding!]?.[0]);if(e.bindAttacker)e.boundAttackerId=unit?.id??'missing';if(unit)e.regions=REGIONS.filter(r=>adjacent(s,e.country,unit.regionId,r.id)).map(r=>r.id);}
    if(f.stage==='Validate') {
      if(f.guided&&e.kind==='action'&&e.buildEither){
        const options=(['build_army','build_navy'] as const).flatMap(action=>[...new Set(boardOptions(s,{...e,action}).map(o=>o.regionId))].map(id=>({id:`${action}|${id}`,label:REGION_BY_ID[id].name})));
        if(options.length){ask(s,{kind:'BUILD_ORDER',seat:seatOf(e.country),prompt:e.label,min:1,max:1,options,frameId:f.id,canSkip:true});continue;}
        e.buildEither=false;
      }
      if((f.guided||r.guided)&&e.selectedIds===undefined&&validEffect(s,e,f)&&selectionRequest(s,f,e))continue;
      if(f.guided&&e.kind==='signal'&&e.tag==='INSTALL'&&!e.accepted){commitEffect(s,f,e);continue;}
      if(f.guided && e.optional && !e.accepted) {
        if(!validEffect(s,e,f)){commitEffect(s,f,e);continue;}
        if(e.kind!=='action'&&e.kind!=='choose'&&(e.kind!=='cards'||e.random)&&e.kind!=='extraPlay'&&e.kind!=='reallocate') {ask(s,{kind:'EFFECT_DECISION',seat:f.owner,prompt:e.label,min:0,max:1,options:[{id:'execute',label:'执行'}],frameId:f.id,canSkip:true});continue;}
      }
      if(f.guided && e.fee && !f.committed&&!(e.kind==='cards'&&e.selectedIds)){ask(s,{kind:'EFFECT_DECISION',seat:f.owner,prompt:`发动【${f.source}】并支付费用`,min:0,max:1,options:[{id:'execute',label:'执行'}],frameId:f.id,canSkip:true});continue;}
      if(f.guided && f.declarationPending && (e.fee||!e.optional||e.accepted)){commitEffect(s,f,e);continue;}
      if(!validEffect(s,e,f)) {
        r.events.push({id:uid(r,'event'),label:e.label,frameId:f.id,ancestorIds:[...f.ancestorIds],cancelled:false,applied:false,outcome:'invalid',started:false,ended:true,effectIndex:f.nextEffectIndex,effect:structuredClone(e)});
        record(s,'EFFECT_INVALID',`${e.label}当前条件不满足${e.fee?'，不能支付费用，停止后续效果':'，跳过此效果'}。`); if(e.fee)f.nextEffectIndex=f.effects.length;else f.nextEffectIndex++; continue;
      }
      if(e.kind==='extraPlay') {
        if(e.optional&&!e.accepted)e.allowSkip=true;
        if(!e.selectedCardId){ask(s,{kind:'EXTRA_CARD',seat:e.seat,prompt:e.label,min:e.allowSkip?0:1,max:1,options:extraCandidates(s,e).filter(c=>!e.onlyRemember||f.memory?.[e.onlyRemember]?.includes(c.id)).map(c=>({id:c.id,label:c.definitionId})),frameId:f.id});continue;}
        const card=s.decks[e.seat][e.from].find(c=>c.id===e.selectedCardId)!;
        const targets=cardTargetChoices(s,card);
        if(e.targets===undefined&&targets.length){ask(s,{kind:'EXTRA_TARGET',seat:e.seat,prompt:'选择额外打牌的目标',min:1,max:card.definitionId==='special_162'?Math.min(3,targets.length):1,options:targets.map(id=>({id,label:COUNTRY_NAMES[id as SeatId]??REGION_BY_ID[s.units.find(u=>u.id===id)!.regionId].name})),frameId:f.id});continue;}
        if(e.indices===undefined){const effects=extraEffects(s,card,e.targets??[]);if(r.guided){e.indices=effects.map((_,i)=>i);continue;}ask(s,{kind:'EXTRA_EFFECTS',seat:e.seat,prompt:'选择要执行的独立效果，费用仍须支付',min:1,max:effects.filter(e=>!e.fee).length,options:effects.flatMap((e,i)=>e.fee?[]:[{id:String(i),label:e.label}]),frameId:f.id});continue;}
      }
      if(e.kind==='action' && !e.option) {
        let options=boardOptions(s,e); const sel=e.selection??{};
        if(sel.regionId) options=options.filter(o=>o.regionId===sel.regionId);
        if(sel.defenderId) options=options.filter(o=>(o.defenderId??'empty')===sel.defenderId);
        if(sel.attackerId) options=options.filter(o=>o.attackerId===sel.attackerId);
        const battle=e.action==='land_battle' || e.action==='sea_battle';
        if(f.guided&&battle&&sel.regionId&&sel.defenderId&&sel.attackerId){
          if(!e.accepted){commitEffect(s,f,e);continue;}
          notifyAttack(s,e,sel.defenderId);
          const defender=s.units.find(u=>u.id===sel.defenderId),attacker=s.units.find(u=>u.id===sel.attackerId);
          const defense=!s.turnFlags?.noAirDefense&&defender&&s.units.some(u=>u.country===defender.country&&u.regionId===defender.regionId&&u.type==='air');
          if(defense&&e.airDefense===undefined){ask(s,{kind:'AIR_DEFENSE',seat:seatOf(defender!.country),prompt:`${COUNTRY_NAMES[e.country]}攻击${REGION_BY_ID[defender!.regionId].name}，是否进行空军防御？`,min:1,max:1,options:[{id:'yes',label:'是'},{id:'no',label:'否'}],frameId:f.id});continue;}
          if(e.airDefense&&attacker&&s.units.some(u=>u.country===attacker.country&&u.regionId===attacker.regionId&&u.type==='air')&&e.airIntercept===undefined){ask(s,{kind:'AIR_INTERCEPT',seat:seatOf(e.country),prompt:'是否进行空军拦截？',min:1,max:1,options:[{id:'yes',label:'是'},{id:'no',label:'否'}],frameId:f.id});continue;}
          e.option=options.find(o=>!!o.intercept===!!e.airIntercept);continue;
        }
        const field=!sel.regionId?'regionId':(battle||e.action==='destroy') && !sel.defenderId?'defenderId':battle && !sel.attackerId?'attackerId':'option';
        const choices=[...new Map(options.map(o=>{
          const id=field==='option'?o.id:field==='defenderId'?o.defenderId??'empty':o[field]!;
          const unit=s.units.find(u=>u.id===id);
          return [id,{id,label:field==='regionId'?REGION_BY_ID[id].name:field==='option'?o.label:unit?`${COUNTRY_NAMES[unit.country]} · ${REGION_BY_ID[unit.regionId].name}`:'空地区'}];
        })).values()];
        if(field!=='regionId' && choices.length===1) {
          fact(s,'automatic_choice','自动选择唯一合法方案',{seat:f.owner,prompt:e.label,options:choices,selected:[choices[0].id],reason:'forced_single_option'});
          if(field==='option') e.option=options[0]; else e.selection={...sel,[field]:choices[0].id};
          continue;
        }
        ask(s,{kind:'ACTION',seat:['build_army','build_navy','air_deploy','air_power','air_move'].includes(e.action)?seatOf(e.country):f.owner,prompt:field==='regionId'?(['build_army','recruit_army','build_navy','recruit_navy'].includes(e.action)?`请选择${COUNTRY_NAMES[e.country]}${ACTION_NAMES[e.action]}的地区`:['land_battle','sea_battle'].includes(e.action)?'请选择要攻击的地区':e.label):field==='defenderId'?'请选择要攻击的国家部队':field==='attackerId'?'请选择发起攻击的部队':'确认行动方案',min:1,max:1,options:choices,frameId:f.id,field,canSkip:!!f.guided&&!!e.optional&&!e.accepted});continue;
      }
      if(f.guided&&e.optional&&!e.accepted){commitEffect(s,f,e);continue;}
      notifyAttack(s,e);
      f.currentEventId=uid(r,'event');
      if(e.kind==='action')e.decisionSeat??=f.owner;
      r.events.push({id:f.currentEventId,label:e.label,frameId:f.id,ancestorIds:[...f.ancestorIds],cancelled:false,applied:false,outcome:'declared',effectIndex:f.nextEffectIndex,effect:structuredClone(e)});
      if(s.prelude&&e.kind==='action'&&['land_battle','sea_battle'].includes(e.action)&&e.option?.defenderCountry)s.prelude.wars.push({revision:s.revision,attacker:seatOf(e.country),defender:seatOf(e.option.defenderCountry)});
      record(s,'EFFECT_DECLARED',`宣告：${e.label}。`);
      f.stage='Apply'; openWindow(s,f,'Before');
    } else if(f.stage==='Apply') {
      const event=r.events.find(v=>v.id===f.currentEventId)!;
      if(e.kind==='deckTop')e.count=Math.max(0,e.count);
      if(e.kind==='action'&&e.recycledId) {
        if(s.units.some(u=>u.id===e.recycledId)){event.cancelled=true;}
        else e.option=boardOptions(s,{...e,option:undefined}).find(o=>o.regionId===e.option?.regionId&&!o.recycleId);
        if(!e.option)event.cancelled=true;
        e.recycledId=undefined;
      }
      if(event.cancelled) {event.outcome='cancelled';event.ended=true; record(s,'EFFECT_CANCELLED',`${e.label}被取消，不产生成功后的触发。`); f.stage='Resume'; continue; }
      // A declared battle survives evacuation of its sole defender. Recheck the
      // same attacker's current supply/range; never substitute another attacker.
      if(e.kind==='action'&&['land_battle','sea_battle'].includes(e.action)&&e.option?.defenderId&&!s.units.some(u=>u.id===e.option!.defenderId)) {
        const original=e.option;
        const empty=boardOptions(s,{...e,option:undefined,targetIds:undefined}).find(o=>o.regionId===original.regionId&&o.attackerId===original.attackerId&&!o.defenderId);
        if(empty){e.option=empty;e.targetIds=undefined;event.effect=structuredClone(e);}
      }
      if(!validEffect(s,e,f)) {event.outcome='invalid';event.ended=true; event.resultText=`${e.label}因响应后的局面变化无法执行`;record(s,'EFFECT_INVALID',`${e.label}在响应后已不合法，跳过且不产生成功后的触发。`); f.stage='Resume'; continue; }
      if(e.kind==='action'&&(['land_battle','sea_battle'].includes(e.action)||e.option?.mode==='supremacy')){
        if(s.rules?.balanceEnabled&&['germany','italy'].includes(e.country)&&s.units.find(u=>u.id===e.option?.defenderId)?.country==='soviet_union'){for(const card of s.decks.soviet_union.faceDown.filter(c=>c.definitionId==='prelude_SU-18'))(s.balanceFirstAttacks??={})[card.id]??=`${s.balanceResolutionSerial}:${event.id}`;}
        checkNeutralityAttack(s,e.country,s.units.find(u=>u.id===e.option?.defenderId)?.country);
        if(s.neutralityStatusPending)continue;
      }
      if(e.kind==='action'&&e.option?.recycleId) {
        const unit=s.units.find(u=>u.id===e.option?.recycleId)!;e.recycledId=unit.id;
        pushFrame(s,'库存不足：先回收部队',f.owner,[{kind:'remove',unit:{...unit},supplied:suppliedUnits(s).has(unit.id),cause:'recycle',label:'回收部队'}],undefined,'discardPile',{originEventId:f.currentEventId!} as TriggerWindow);continue;
      }
      event.started=true;
      if(!apply(s,f,e)) continue;
      f.stage='After';
    } else if(f.stage==='After') {
      const event=r.events.find(v=>v.id===f.currentEventId)!;
      if(!event.ended){event.ended=true;record(s,'EFFECT_ENDED',`子效果结束：${e.label}。`);}
      f.stage='AfterImmediate';
      if(r.schedulerVersion&&event.applied)openWindow(s,f,'After','immediate');
    } else if(f.stage==='AfterImmediate') {
      const event=r.events.find(v=>v.id===f.currentEventId)!;
      if(event.applied&&e.kind!=='signal'&&isLastOwnEffect(f)&&!f.ownEffectsComplete){
        f.ownEffectsComplete=true;
        record(s,'CARD_OWN_EFFECTS_COMPLETE',`【${f.source}】自身效果结束。`);
      }
      if(event.applied&&e.kind!=='signal'&&!f.effectCompletionNotified&&!f.scoreBatchId&&f.cardId&&f.finalZone==='active'&&f.publicSourceZone==='active'&&specialCard(s.decks[f.owner].resolving.find(c=>c.id===f.cardId)?.definitionId??'',!!s.rules?.balanceEnabled)?.type==='状态'&&isLastOwnEffect(f)){
        f.effectCompletionNotified=true;
        pushFrame(s,'状态效果结算完成',f.owner,[{kind:'signal',tag:'CARD_EFFECT_DONE',completedFrameId:f.id,label:`【${f.source}】效果已结算`}],undefined,'discardPile',{originEventId:event.id} as TriggerWindow);
        continue;
      }
      f.stage='Resume';if(event.applied)openWindow(s,f,'After',r.schedulerVersion?'followup':undefined);
    } else { f.nextEffectIndex++; f.stage='Validate'; f.currentEventId=null; }
  }
  if(!r.stack.length) {
    r.running=false; s.operatorSeat=r.owner;
    if(s.settings.ignoreOtherPlayerInterrupts)s.viewSeat=r.owner;
    record(s,'RESOLUTION_COMPLETE','本次嵌套结算全部完成。');
  }
}
export function startResolution(s:GameState,source:string,owner:SeatId,effects:Effect[],rules:TriggerRule[],cardId?:string,finalZone:FinalZone='discardPile',guided=false,rollback?:GameState) {
  if(s.resolution?.running || !SEATS.includes(owner)) return false;
  effects=effects.flatMap((e):Effect[]=>e.kind!=='signal'?[e]:e.tag==='PHASE:TURN_START_WINDOW'?[{...e,tag:'PHASE:EARLY_TURN_START',label:'回合最开始：一日之狮'},e]:e.tag==='PHASE:SCORE'?[e,{...e,tag:'PHASE:SCORE_STATUS',label:'计分阶段末：结算加分状态'}]:[e]);
  const probe=cardId?{...s,decks:{...s.decks,[owner]:{...s.decks[owner],hand:s.decks[owner].hand.filter(c=>c.id!==cardId)}}}:s;
  if(!canExecuteEffects(probe,effects)&&!(guided&&effects.some(e=>!e.fee)&&canPayEffectFees(probe,effects)))return false;
  if(cardId && !(['hand','active','faceDown'] as const).some(zone=>s.decks[owner][zone].some(c=>c.id===cardId && c.deckOwner===owner))) return false;
  // Battle protection belongs only to events in this resolution, whose IDs restart at zero.
  if(s.turnFlags)s.turnFlags.battleProtected=[];
  s.balanceResolutionSerial=(s.balanceResolutionSerial??0)+1;
  s.resolution={schedulerVersion:s.mode==='BASIC_DEBUG'||!s.resolutionVersion?undefined:1,scoreBatches:[],guided,owner,scenario:source,running:true,serial:0,frames:[],windows:[],stack:[],events:[],rules:structuredClone(rules),choice:null,trace:[],fired:[],turnUses:{...(s.resolution?.turnUses??{})}};
  pushFrame(s,source,owner,effects,cardId,finalZone,undefined,rollback); runResolution(s); return true;
}
export const canExecuteEffects=(s:ReadState,effects:Effect[])=>canPayEffectFees(s,effects)&&effects.some(e=>!e.fee && validEffect(s,e));
/** Called only on a cloned state by the command boundary. Revalidates all selections. */
export function resolveChoice(s:GameState,seat:SeatId,choiceId:string,ids:string[],guided=false):boolean {
  const r=engine(s), c=r.choice;
  if(!c || c.id!==choiceId || c.seat!==seat || !Array.isArray(ids) || new Set(ids).size!==ids.length || (ids.length<c.min&&!(c.canSkip&&!ids.length)) || ids.length>c.max || ids.some(id=>!c.options.some(o=>o.id===id))) return false;
  if(guided)r.guided=true;
  const rollback=r.guided&&c.kind==='TRIGGER'?structuredClone(s):undefined;
  if(c.triggerTargets){const ref=c.triggerTargets[ids[0]],w=ref&&windowById(r,ref.windowId),rule=w&&remaining(s,w).find(rule=>rule.id===ref.ruleId);if(!rule)return false;const effects=structuredClone(rule.effects),action=effects.find(e=>e.kind==='action');if(action?.kind!=='action'||!boardOptions(s,action).some(o=>o.regionId===ids[0]))return false;action.selection={regionId:ids[0]};const selectionRollback=r.guided?structuredClone(s):undefined;r.choice=null;activate(s,w!,{...rule,effects},true,selectionRollback);runResolution(s);return true;}
  if(c.kind==='TRIGGER'&&c.mergedTriggers?.[ids[0]]){const refs=c.mergedTriggers[ids[0]],targets:NonNullable<ChoiceRequest['triggerTargets']>={};for(const ref of refs){const w=windowById(r,ref.windowId),rule=remaining(s,w).find(rule=>rule.id===ref.ruleId);const action=rule?.effects.find(e=>e.kind==='action');if(action?.kind==='action')for(const option of boardOptions(s,action))targets[option.regionId]??=ref;}if(!Object.keys(targets).length)return false;ask(s,{kind:'ACTION',seat,field:'regionId',prompt:'闪电战：选择建设地区',min:1,max:1,options:Object.keys(targets).map(id=>({id,label:REGION_BY_ID[id].name})),triggerTargets:targets});return true;}
  if(c.preselect){
    const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex],payment=paymentBranch(e);
    if(!ids.length){
      if(!c.canSkip&&c.min!==0)return false;
      if(f.finishOnSkip){f.declined=true;f.committed=true;f.rollback=undefined;f.declarationPending=false;f.nextEffectIndex=f.effects.length;}
      else if(e.fee)f.nextEffectIndex=f.effects.length;else f.nextEffectIndex++;
      f.stage='Validate';f.currentEventId=null;r.choice=null;runResolution(s);return true;
    }
    if(c.kind==='CARDS'){
      const cost=e.kind==='cards'?e:payment;if(!cost)return false;
      const cards=s.decks[cost.seat][cost.from].filter(card=>ids.includes(card.id));
      if(cards.length!==ids.length||cards.some(card=>cost.allowedIds&&!cost.allowedIds.includes(card.id)||cost.filter&&!matchesCard(card,cost.filter))||cost.requirements&&!coversCost(cards,cost.requirements))return false;
    }else if(e.kind==='choose'&&ids.some(id=>!e.options.some(o=>o.id===id&&canExecuteEffects(s,o.effects))))return false;
    e.selectedIds=[...ids];if(f.stage==='Validate')commitEffect(s,f,e);r.choice=null;runResolution(s);return true;
  }
  if((c.canSkip||c.kind==='EFFECT_DECISION')&&!ids.length){const f=frameById(r,c.frameId!);if(f.effects[f.nextEffectIndex].fee)f.nextEffectIndex=f.effects.length;else f.nextEffectIndex++;r.choice=null;runResolution(s);return true;}
  if(c.kind==='BUILD_ORDER'){const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex];if(e.kind!=='action')return false;const [action,regionId]=ids[0].split('|');e.buildEither=false;e.action=action as 'build_army'|'build_navy';e.selection={regionId};e.label=action==='build_army'?'建设陆军':'建设海军';f.effects.splice(f.nextEffectIndex+1,0,{kind:'action',country:e.country,action:action==='build_army'?'build_navy':'build_army',optional:true,label:action==='build_army'?'请选择建设海军的地区':'请选择建设陆军的地区'});r.choice=null;}
  else if(c.kind==='EFFECT_DECISION'){const f=frameById(r,c.frameId!);commitEffect(s,f,f.effects[f.nextEffectIndex]);r.choice=null;}
  else if(c.kind==='AIR_DEFENSE'||c.kind==='AIR_INTERCEPT'){const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex];if(e.kind!=='action')return false;notifyAirDecision(s,f,e,c.seat,c.kind,ids[0]==='yes');if(ids[0]==='yes')publicRecord(s,c.seat,COUNTRY_NAMES[c.seat]+(c.kind==='AIR_DEFENSE'?'进行了空军防御。':'进行了空军拦截。'));if(c.kind==='AIR_DEFENSE')e.airDefense=ids[0]==='yes';else e.airIntercept=ids[0]==='yes';r.choice=null;}
  else if(c.kind==='ACTION') {
    const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex];
    if(e.kind!=='action') return false;
    if(c.field==='option') {const o=boardOptions(s,e).find(o=>o.id===ids[0]);if(!o)return false;e.option=o;}
    else e.selection={...e.selection,[c.field!]:ids[0]};
    r.choice=null;
  } else if(c.kind==='RELOCATE') {
    const air=s.units.find(u=>u.id===c.airId);
    if(!air || !airDestinations(s,air.id).includes(ids[0]))return false;
    const effect:Effect={kind:'action',country:air.country,action:'air_move',label:'免费强制调度空军'};
    effect.option=boardOptions(s,effect).find(o=>o.airId===air.id&&o.regionId===ids[0]);
    if(!effect.option)return false;
    s.pendingAir=s.pendingAir.filter(id=>id!==air.id);r.choice=null;
    const parent=[...r.stack].reverse().find(t=>t.kind==='frame');
    const eventId=parent?frameById(r,parent.id).currentEventId:undefined;
    pushFrame(s,'免费强制调度',seatOf(air.country),[effect],undefined,'discardPile',eventId?{originEventId:eventId} as TriggerWindow:undefined);
  } else if(c.kind==='EXTRA_CARD'||c.kind==='EXTRA_TARGET'||c.kind==='EXTRA_EFFECTS') {
    const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex];
    if(e.kind!=='extraPlay')return false;
    if(c.kind==='EXTRA_CARD') {
      if(r.guided&&ids.length)f.extraRollback=structuredClone(s);
      if(!ids.length&&e.allowSkip){
        if(e.returnOnSkip){const deck=s.decks[e.seat],card=deck[e.from].find(c=>c.id===e.onlyCardIds?.[0]);if(card){deck[e.from]=deck[e.from].filter(c=>c.id!==card.id);deck.drawPile.unshift(card);}}
        f.nextEffectIndex++;f.stage='Validate';f.currentEventId=null;f.extraRollback=undefined;
      }else e.selectedCardId=ids[0];
    }
    else if(c.kind==='EXTRA_TARGET')e.targets=ids;
    else {
      const card=s.decks[e.seat][e.from].find(c=>c.id===e.selectedCardId);
      if(!card)return false;
      const effects=extraEffects(s,card,e.targets??[]).filter((e,i)=>e.fee||ids.includes(String(i)));
      if(!canExecuteEffects(s,effects))return false;
      e.indices=ids.map(Number);
    }
    r.choice=null;
  } else if(c.kind==='CARDS') {
    const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex];
    if(e.kind!=='cards')return false;
    if(!applySelectedCards(s,f,e,ids))return false;f.stage='After';r.choice=null;
  } else if(c.kind==='SELECT') {
    const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex];
    if(e.kind!=='choose')return false;
    const options=ids.map(id=>e.options.find(o=>o.id===id));
    if(options.some(o=>!o||!canExecuteEffects(s,o.effects)))return false;
    f.effects.splice(f.nextEffectIndex+1,0,...structuredClone(options.flatMap(o=>o!.effects)));
    Object.assign(r.events.find(event=>event.id===f.currentEventId)!,{applied:true,outcome:'succeeded'});
    r.trace.push(e.label);f.stage='After';r.choice=null;
  } else if(c.kind==='REALLOCATE') {
    const f=frameById(r,c.frameId!),e=f.effects[f.nextEffectIndex];
    if(e.kind!=='reallocate' || s.redistributed || !mayReallocate(s,e.seat))return false;
    const deck=s.decks[e.seat],source=deck.drawPile.some(c=>c.id===ids[0])?deck.drawPile:deck.discardPile;
    if(!reallocationCards(s,e.seat).some(c=>c.id===ids[0]))return false;
    const index=source.findIndex(card=>card.id===ids[0] && canReallocateCard(card));
    if(index<0)return false;
    publicRecord(s,e.seat,COUNTRY_NAMES[e.seat]+'执行资源重整。');
    deck.hand.push(...source.splice(index,1));s.redistributed=true;
    Object.assign(r.events.find(event=>event.id===f.currentEventId)!,{applied:true,outcome:'succeeded'});
    r.trace.push(e.label);f.stage='After';r.choice=null;
  } else if(c.kind==='EFFECTS') {
    const w=windowById(r,c.windowId!),rule=r.rules.find(rule=>rule.id===c.triggerId)!;
    if(!legal(s,rule,w))return false;
    const chosen=rule.effects.filter((e,i)=>e.fee || ids.includes(String(i)));
    if(!canExecuteEffects(s,chosen))return false;
    rule.effects=chosen;r.choice=null;activate(s,w,rule,true);
  } else if(c.kind==='FORCE_HAND') {
    const f=frameById(r,c.frameId!), e=f.effects[f.nextEffectIndex];
    if(e.kind!=='forceHand' || !forceDiscardHand(s,e.seat,e.count,ids)) return false;
    r.events.find(event=>event.id===f.currentEventId)!.resultText=`${COUNTRY_NAMES[e.seat]}弃置手牌 ${ids.length} 张`;
    Object.assign(r.events.find(event=>event.id===f.currentEventId)!,{applied:true,outcome:'succeeded'});
    r.trace.push(e.label); record(s,'EFFECT_APPLIED',`执行：${e.label}。`);
    f.stage='After';r.choice=null;
  } else if(c.kind==='ORDER_MANDATORY_TRIGGERS') {
    const w=windowById(r,c.windowId!);
    const mandatory=remaining(s,w).filter(rule=>rule.mandatory);
    if(ids.length!==mandatory.length || ids.some(id=>!mandatory.some(rule=>rule.id===id))) return false;
    w.mandatoryOrder=[...ids]; r.choice=null;
  } else if(c.kind==='PAY_COST') {
    const w=windowById(r,c.windowId!), rule=r.rules.find(rule=>rule.id===c.triggerId)!;
    if(rule.costRequirements && !coversCost(s.decks[seat].hand.filter(card=>ids.includes(card.id)),rule.costRequirements))return false;
    const after={...s,decks:{...s.decks,[seat]:{...s.decks[seat],hand:s.decks[seat].hand.filter(card=>!ids.includes(card.id)&&card.id!==rule.sourceInstanceId)}}};
    if(!canPayEffectFees(after,rule.effects))return false;
    if(!legal(s,rule,w))return false;
    if(rule.source==='enhancement'){
      // Reserve the selected fee until CARD_EFFECT's Before window has closed.
      // Cancellation must neither discard these cards nor trigger discard benefits.
      const fee:Effect={kind:'cards',seat,from:'hand',to:'discardPile',min:rule.cost!,max:rule.cost!,requirements:rule.costRequirements,selectedIds:[...ids],fee:true,label:`为【${rule.label}】支付 ${rule.cost} 张手牌费用`};
      r.choice=null;fire(s,w,{...rule,effects:[fee,...rule.effects]});
    }else{
      if(!payDiscardCost(s,seat,rule.cost!,ids,false,rule.sourceInstanceId,publicCostIds(s.decks[seat].hand.filter(c=>ids.includes(c.id)),rule.costRequirements)))return false;
      r.choice=null;fire(s,w,rule);
    }
  } else {
    if(!ids.length) {
      const w=windowById(r,c.windowId!);
      if(w.batchId)for(const peer of r.windows.filter(v=>v.batchId===w.batchId&&!v.closed)){(peer.declinedSeats??=[]).push(seat);}
      if(!!s.resolutionVersion)(w.declinedSeats??=[]).push(seat);
      w.remaining=w.remaining.filter(id=>r.rules.find(rule=>rule.id===id)?.owner!==seat);
      if(!w.remaining.length)w.closed=true;
      r.choice=null;
    }
    else {
      const selected=c.options.find(o=>o.id===ids[0])!, w=windowById(r,selected.windowId!);
      const rule=remaining(s,w).find(rule=>`${w.id}/${rule.id}`===ids[0]);
      if(!rule || rule.mandatory || rule.owner!==seat) return false;
      // Validate the selected window; fire() closes the abandoned descendant branch.
      const index=r.stack.findIndex(t=>t.kind==='window' && t.id===w.id);
      if(index<0) return false;
      if(!r.schedulerVersion)for(const task of r.stack.slice(index+1))if(task.kind==='window')closeWindow(windowById(r,task.id),'legacy-branch');
      r.choice=null; activate(s,w,rule,false,rollback);
    }
  }
  checkNeutralitySupply(s);runResolution(s); return true;
}

/** GM-only convenience: all countries with a currently legal pending response. */
export function pendingResponseSeats(input:import('./types').ReadState) {
  const s=structuredClone(input) as GameState,r=s.resolution;
  if(r?.revealGroup)return r.revealGroup.items.filter(item=>!s.responseNotices?.find(n=>n.id===item.resultId)?.readBy.includes(item.seat)).map(item=>item.seat);
  if(!r?.running||!r.choice)return [];
  const seats=new Set([r.choice.seat]);
  if(r.choice.kind==='TRIGGER')for(const task of r.stack){if(task.kind!=='window')continue;const w=windowById(r,task.id);if(!w.closed)for(const rule of remaining(s,w))if(!rule.mandatory)seats.add(rule.owner);}
  return SEATS.filter(seat=>seats.has(seat));
}

/** Independent acknowledgements form a barrier before the ordered extra plays. */
export function acknowledgeReveal(s:GameState,noticeId:string,seat:SeatId) {
  const r=s.resolution,group=r?.revealGroup,item=group?.items.find(i=>i.seat===seat&&(i.requestId===noticeId||i.resultId===noticeId));
  if(!r||!group||!item)return;
  if(noticeId===item.requestId){
    const text=item.card?`翻开的是【${cardName(item.card)}】。${item.playable?'全部国家查看后，按德国、意大利、日本的顺序询问是否打出。':'此牌不能打出，将置于牌库顶。'}`:'弃牌堆没有卡牌，无牌可翻。';
    (s.responseNotices??=[]).push({id:item.resultId,recipients:[seat],readBy:[],title:'翻牌结果',text,cards:item.card?[item.card]:[]});
    record(s,'RANDOM_CARD_REVEALED',`${COUNTRY_NAMES[seat]}${text}`);
  }
  if(!group.items.every(i=>s.responseNotices?.find(n=>n.id===i.resultId)?.readBy.includes(i.seat)))return;
  const effects:Effect[]=[];
  for(const i of group.items)if(i.card){
    if(i.playable)effects.push({kind:'extraPlay',seat:i.seat,from:'discardPile',onlyCardIds:[i.card.id],allowSkip:true,returnOnSkip:true,label:`可额外打出【${cardName(i.card)}】，或置于牌库顶`});
    else {const d=s.decks[i.seat];d.discardPile=d.discardPile.filter(c=>c.id!==i.card!.id);d.drawPile.unshift(i.card);}
  }
  const frame=frameById(r,group.frameId);frame.effects.splice(frame.nextEffectIndex+1,0,...effects);
  delete r.revealGroup;runResolution(s);
}

/** Only involved players see this notice, never merely because it is another turn. */
export function waitingResponseSeats(s:import('./types').ReadState,seat:SeatId):SeatId[] {
  const r=s.resolution;if(!r?.running)return [];
  if(r.revealGroup){
    if(r.revealGroup.items.some(i=>i.seat===seat&&!s.responseNotices?.find(n=>n.id===i.resultId)?.readBy.includes(seat)))return [];
    return r.revealGroup.items.filter(i=>!s.responseNotices?.find(n=>n.id===i.resultId)?.readBy.includes(i.seat)).map(i=>i.seat);
  }
  if(!r.choice||r.choice.seat===seat)return [];
  const queued=r.frames.some(f=>f.status!=='COMPLETE'&&f.effects.slice(f.nextEffectIndex).some(e=>e.kind==='extraPlay'&&e.seat===seat&&e.returnOnSkip));
  return seat===r.owner||queued?[r.choice.seat]:[];
}

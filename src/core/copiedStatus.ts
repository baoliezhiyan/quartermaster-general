import {triggerCandidate} from './triggerIndex';
import type {GameState,CardInstance} from './types';
import type {Effect,ResolutionFrame,TriggerRule} from './resolutionTypes';
import {specialCard} from './cardCatalog';
import {realTriggers} from './specialCards';
import {hasStatus} from './modifiers';
import {statusActionEffects} from './statusActions';
import {canExecuteEffects} from './resolution';

/** Evaluate the real status handler in the original window, after the proposed fee. */
export function copiedStatusRules(state:GameState,frame:ResolutionFrame,event:Effect,timing:'Before'|'After',feeCard?:CardInstance):TriggerRule[]{
 const original=state.decks.germany;const s={...state,decks:{...state.decks,germany:{...original,hand:[...original.hand],active:[...original.active],discardPile:[...original.discardPile]}}},deck=s.decks.germany;
 if(feeCard){deck.hand=deck.hand.filter(c=>c.id!==feeCard.id);deck.discardPile.push(feeCard);}
 const result:TriggerRule[]=[];
 for(const card of [...deck.discardPile]){
  if(specialCard(card.definitionId,card.balance)?.type!=='状态'||card.country!=='germany'||frame.sourceAncestors.includes(card.id))continue;
  // Manual status actions have a separate ARMAMENT_ANYTIME fallback below.
  if(!(timing==='After'&&event.kind==='signal'&&event.tag==='ARMAMENT_ANYTIME')&&!triggerCandidate(card.definitionId,event,timing))continue;
  deck.discardPile=deck.discardPile.filter(c=>c.id!==card.id);deck.active.push(card);
  let rule=realTriggers(s,frame,event,timing,false,false,card.id).find(r=>r.sourceInstanceId===card.id&&r.source==='active');
  if(!rule&&timing==='After'&&event.kind==='signal'&&event.tag==='ARMAMENT_ANYTIME'){
   const effects=statusActionEffects(s,card);
   if(effects.length)rule={id:`${card.id}:${frame.currentEventId}`,scopeId:card.definitionId,boundEventId:frame.currentEventId!,label:specialCard(card.definitionId,card.balance)!.name,owner:'germany',sourceInstanceId:card.id,source:'active',timing,on:event.label,mandatory:false,effects};
  }
  const resolvingProbe={...s,decks:{...s.decks,germany:{...deck,active:deck.active.filter(c=>c.id!==card.id),resolving:[...deck.resolving,card]}}};
  if(rule&&hasStatus(s,Number(card.definitionId.slice(8)))&&(!rule.oncePerTurn||!s.resolution?.turnUses[`${s.round}:${s.activeSeat}:${card.id}:${rule.scopeId??rule.id}`])&&canExecuteEffects(resolvingProbe,rule.effects))result.push(rule);
  deck.active=deck.active.filter(c=>c.id!==card.id);deck.discardPile.push(card);
 }
 return result;
}

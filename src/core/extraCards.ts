import { specialCard } from './cardCatalog';
import { TRAINING_EVENT_IDS,TRAINING_A2S1_IDS } from './trainingCourse';
import { cardEffects, barbarossaTargets, realTriggers } from './specialCards';
import { matchesCard, canAffordHandCost } from './cardCosts';
import type { ReadState, CardInstance, GameState } from './types';
import type { Effect, ResolutionFrame } from './resolutionTypes';
import { canExecuteEffects } from './resolution';

export function cardTargetChoices(s:ReadState,c:CardInstance):string[] {
  switch(specialCard(c.definitionId,c.balance)?.sourceIndex) {
    case 25:return ['germany','italy'];
    case 100:case 102:return ['germany','italy','japan'];
    case 164:case 165:return ['united_kingdom','soviet_union','united_states'];
    case 162:return barbarossaTargets(s);
    default:return [];
  }
}
const checking=new Set<string>();
export function extraEffects(s:ReadState,c:CardInstance,targets:string[]=[]):Effect[] {
  if(specialCard(c.definitionId,c.balance)?.type!=='增强')return cardEffects(s,c,targets);
  const deck=s.decks[c.deckOwner];
  const simulated={...s,decks:{...s.decks,[c.deckOwner]:{...deck,hand:[...deck.hand.filter(x=>x.id!==c.id),c]}}} as GameState;
  for(const w of s.resolution?.windows.filter(w=>!w.closed)??[]) {
    const event=s.resolution!.events.find(e=>e.id===w.originEventId)!;
    const frame=s.resolution!.frames.find(f=>f.id===event.frameId)!;
    if(!event.effect)continue;
    const rule=realTriggers(simulated,frame as ResolutionFrame,event.effect as Effect,w.timing,true,true,c.id).find(r=>r.sourceInstanceId===c.id);
    if(!rule)continue;
    const available=deck.hand.filter(x=>x.id!==c.id);
    const requirements=rule.costRequirements??Array(rule.cost??0).fill('*') as string[];
    if(!canAffordHandCost(available,requirements)||!canExecuteEffects(s,rule.effects))continue;
    const costs:Effect[]=requirements.sort((a,b)=>Number(a==='*')-Number(b==='*')).map(filter=>({kind:'cards',seat:c.deckOwner,from:'hand',to:'discardPile',min:1,max:1,filter,fee:true,label:`支付增强牌费用：${filter}`}));
    return [...costs,...rule.effects];
  }
  return [];
}
export function extraCandidates(s:ReadState,e:Extract<Effect,{kind:'extraPlay'}>):CardInstance[] {
  return s.decks[e.seat][e.from].filter(c=>{
    if(s.trainingCourse && (e.from==='hand'&&!s.trainingCourse.openIds[e.seat].includes(c.id) ||
      c.definitionId.startsWith('special_') && !(s.trainingCourse.version==='ppo-signals-a2s1-v2'?
        TRAINING_A2S1_IDS:TRAINING_EVENT_IDS).has(c.definitionId)))return false;
    if(e.onlyCardIds&&!e.onlyCardIds.includes(c.id))return false;
    if(checking.has(c.id))return false;
    const d=specialCard(c.definitionId,c.balance);
    if(e.filter&&!matchesCard(c,e.filter) || e.mention&&!d?.text.includes(e.mention))return false;
    const targets=cardTargetChoices(s,c);
    const probe={...s,decks:{...s.decks,[c.deckOwner]:{...s.decks[c.deckOwner],hand:s.decks[c.deckOwner].hand.filter(card=>card.id!==c.id)}}};
    checking.add(c.id);
    try{return targets.length?targets.some(t=>canExecuteEffects(probe,extraEffects(s,c,[t]))):canExecuteEffects(probe,extraEffects(s,c));}
    finally{checking.delete(c.id);}
  });
}

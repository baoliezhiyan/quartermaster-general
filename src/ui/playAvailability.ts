import type {ReadState,CardInstance} from '../core';
import {cardEffects} from '../core/specialCards';
import {specialCard} from '../core/cardCatalog';
import {cardTargetChoices} from '../core/extraCards';
import {canExecuteEffects} from '../core/resolution';
import {statusActionEffects} from '../core/statusActions';
export function usableStatus(state:ReadState,c:CardInstance){return state.status==='PLAYING'&&state.viewSeat===state.activeSeat&&!state.resolution?.running&&!state.pendingDiscard&&!state.pendingAir.length&&state.phase==='PLAY'&&canExecuteEffects(state,statusActionEffects(state,c));}
export function playableCard(state:ReadState,c:CardInstance){
 if(state.status!=='PLAYING'||state.viewSeat!==state.activeSeat||state.resolution?.running||state.pendingDiscard||state.pendingAir.length)return false;
 if(state.phase==='AIR'&&!['deploy','supremacy'].includes(state.airAction??''))return false;
 if(state.phase==='AIR'?c.definitionId!=='air_power':state.phase!=='PLAY'||c.definitionId==='air_power')return false;
 if(state.rules?.balanceEnabled&&state.basicPlaysRemaining&&specialCard(c.definitionId,c.balance))return false;
 if(specialCard(c.definitionId,c.balance)?.type==='增强')return false;
 const probe={...state,decks:{...state.decks,[c.deckOwner]:{...state.decks[c.deckOwner],hand:state.decks[c.deckOwner].hand.filter(v=>v.id!==c.id)}}};
 const targets=cardTargetChoices(state,c),sets=targets.length?targets.map(id=>[id]):[[]];
 return sets.some(ids=>{const effects=cardEffects(state,c,ids);return effects.some(e=>!e.fee)&&canExecuteEffects(probe,[...effects.filter(e=>e.fee),{kind:'trace',label:'费用核验'}]);});
}

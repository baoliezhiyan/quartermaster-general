import {fact} from './factObserver';
import {neutralityDiscardPenalty} from './neutrality';
import {hasStatus} from './modifiers';
import {publicRecord} from './publicHistory';
import {concealPublic,revealDiscardedCards} from './publicHistory';
import { addResponseNotice } from './responseNotices';
import { COUNTRY_NAMES, cardName } from './basic';
import type { CardInstance, GameState, ReadState, SeatId } from './types';

const countValid = (n: number) => Number.isSafeInteger(n) && n >= 0;
export function validHandSelection(state: ReadState, seat: SeatId, ids: unknown): ids is string[] {
  return Array.isArray(ids) && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && state.decks[seat].hand.some(c => c.id === id));
}
export function canPayDiscardCost(state: ReadState, seat: SeatId, count: number) {
  return countValid(count) && state.decks[seat].hand.length >= count;
}
/** Vichy is permanently removed whenever it would enter a discard pile. */
export function putDiscardedCards(state:GameState,seat:SeatId,cards:CardInstance[]) {
  for(const card of cards)state.decks[seat][state.rules?.balanceEnabled&&card.definitionId==='special_251'?'removed':'discardPile'].push(card);
}
export function discardHandCards(state: GameState, seat: SeatId, ids: string[], publicIds:readonly string[] = []) {
  const deck = state.decks[seat];
  if(state.trainingCourse)state.trainingCourse.openIds[seat]=state.trainingCourse.openIds[seat].filter(id=>!ids.includes(id));
  if(state.rules?.balanceEnabled&&seat==='soviet_union'&&hasStatus(state,49)){const count=deck.hand.filter(c=>ids.includes(c.id)&&c.definitionId==='build_army').length;if(count){state.scores[seat]+=count;publicRecord(state,seat,`苏联发动状态【消耗战】，获得 ${count} 分。`);}}
  const shown=deck.hand.filter(c=>ids.includes(c.id)&&(publicIds.includes(c.id)||state.rules?.balanceEnabled&&seat==='soviet_union'&&hasStatus(state,49)&&c.definitionId==='build_army'));
  concealPublic(state,ids);
  revealDiscardedCards(state,seat,shown);
  putDiscardedCards(state,seat,deck.hand.filter(c => ids.includes(c.id)));
  deck.hand = deck.hand.filter(c => !ids.includes(c.id));
  fact(state,'card_moved','弃置手牌',{seat,cardIds:ids,from:'regular_hand',to:'regular_discard'});
}
/** Voluntary hand costs must be paid in full; never consume deck cards. */
export function payDiscardCost(state: GameState, seat: SeatId, count: number, ids: string[], _legacyAuthorization = false, excludedCardId?:string, publicIds:readonly string[]=[]): boolean {
  const available=state.decks[seat].hand.filter(c=>c.id!==excludedCardId);
  if (!countValid(count) || available.length<count || !validHandSelection(state,seat,ids) || ids.some(id=>id===excludedCardId) || ids.length !== count) return false;
  discardHandCards(state,seat,ids,publicIds);
  fact(state,'cost_paid','支付手牌费用',{seat,cardIds:ids});
  return true;
}
export function forceDiscardHand(state: GameState, seat: SeatId, count: number, ids: string[]): boolean {
  if (!countValid(count) || !validHandSelection(state,seat,ids) || ids.length !== Math.min(count,state.decks[seat].hand.length)) return false;
  discardHandCards(state,seat,ids); return true;
}
export function discardPhase(state: GameState, seat: SeatId, ids: string[]): boolean {
  if (!validHandSelection(state,seat,ids)) return false;
  const publicIds=!state.rules?.balanceEnabled&&seat==='soviet_union'&&hasStatus(state,49)?state.decks[seat].hand.filter(c=>ids.includes(c.id)&&c.definitionId==='build_army').map(c=>c.id):[];
  discardHandCards(state,seat,ids,publicIds);
  if(!ids.length)state.scores[seat]-=neutralityDiscardPenalty(state,seat);
  return true;
}
export function drawCards(state: GameState, seat: SeatId, count: number): number {
  if (!countValid(count)) throw new Error('Invalid draw count');
  const drawn = state.decks[seat].drawPile.splice(0,count);
  concealPublic(state,drawn.map(c=>c.id));
  state.decks[seat].hand.push(...drawn);fact(state,'card_moved','摸牌',{seat,cardIds:drawn.map(c=>c.id),from:'regular_deck',to:'regular_hand'}); return drawn.length;
}
/** Each missing top card is one loss for the deck owner, never the effect actor. */
export function discardDeckTop(state: GameState, owner: SeatId, count: number, _initiator: SeatId = owner, notify = true) {
  if (!countValid(count)) throw new Error('Invalid discard count');
  const cards=state.trainingCourse?[] as CardInstance[]:state.decks[owner].drawPile.slice(0,count);
  let discarded = 0, lost = 0;
  for (let i = 0; i < count; i++) {
    let card:CardInstance|undefined;
    if(state.trainingCourse){
      const pool=state.decks[owner].hand;
      if(pool.length){
        const course=state.trainingCourse;
        const limit=0x100000000-(0x100000000%pool.length);
        do{course.discardRandomState=(Math.imul(course.discardRandomState,1664525)+1013904223)>>>0;}while(course.discardRandomState>=limit);
        card=pool[course.discardRandomState%pool.length];
        discardHandCards(state,owner,[card.id]);cards.push(card);
      }
    }else card=state.decks[owner].drawPile.shift();
    if (card) { if(!state.trainingCourse)putDiscardedCards(state,owner,[card]); discarded++; }
    else { state.scores[owner]--; lost++; }
    state.events.push({ type:'RULE_EVENT', revision:state.revision, code:card ? 'DECK_TOP_DISCARDED' : 'DECK_TOP_SHORTFALL', text:`${COUNTRY_NAMES[owner]}：弃牌库顶 ${i+1}/${count}，${card ? `弃置【${cardName(card)}】` : '牌库为空，牌库所属席位扣 1 分'}。` });
  }
  if(count&&notify) addResponseNotice(state,[owner],`${COUNTRY_NAMES[owner]}弃置牌库顶：${cards.length?cards.map(c=>`【${cardName(c)}】`).join('、'):'无牌可弃'}${lost?`；牌库不足，${COUNTRY_NAMES[owner]}扣 ${lost} 分`:''}。`,cards,'弃牌结果');
  fact(state,'card_moved','弃置牌库顶',{seat:owner,cardIds:cards.map(c=>c.id),lost,from:'regular_deck',to:'regular_discard'});
  return { discarded, lost };
}

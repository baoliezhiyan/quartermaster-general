import {shuffle} from './basic';
import {specialCard} from './cardCatalog';
import type {GameState,SeatId} from './types';
/** Resolve the inspection atomically before publishing any candidates. */
export function inspectTen(s:GameState,seat:SeatId,type:'状态'|'响应'){
 const pile=s.decks[seat].drawPile;
 if(!pile.slice(0,10).some(c=>specialCard(c.definitionId,c.balance)?.type===type))shuffle(pile,s);
 return pile.slice(0,10);
}

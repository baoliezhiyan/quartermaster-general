import {shuffle} from './basic';
import {fact} from './factObserver';
import {SEATS} from './types';
import type {GameState,SeatId} from './types';

/** A separate deterministic stream; creation never consumes the card-effect stream. */
export function initializeManualShuffle(s:GameState){
 let seed=(s.seed^0xa511e9b3)>>>0;
 seed=Math.imul(seed^(seed>>>16),0x7feb352d)>>>0;
 seed=Math.imul(seed^(seed>>>15),0x846ca68b)>>>0;
 seed=(seed^(seed>>>16))>>>0;
 s.manualShuffle={seed,randomState:seed,counters:{},pending:[]};
}
export function requestManualShuffle(s:GameState,seat:SeatId){
 if(s.prelude?.active||s.phase==='SETUP'||s.status!=='PLAYING')return;
 if(!s.manualShuffle)initializeManualShuffle(s);
 const m=s.manualShuffle!;
 if(m.pending.includes(seat))return;
 m.counters[seat]=((m.counters[seat]??0)+1)%5;
 if(m.counters[seat]===3)m.pending.push(seat);
 s.revision++;
}
/** Only called between national turns, after the replay boundary is resumed. */
export function executeManualShuffles(s:GameState){
 const m=s.manualShuffle;if(!m)return;
 for(const seat of SEATS){
  if(!m.pending.includes(seat))continue;
  const normal=s.randomState;
  try{s.randomState=m.randomState;shuffle(s.decks[seat].drawPile,s);m.randomState=s.randomState;}
  finally{s.randomState=normal;}
  m.pending=m.pending.filter(v=>v!==seat);
  fact(s,'manual_shuffle','玩家洗牌',{seat,cardIds:s.decks[seat].drawPile.map(c=>c.id),randomState:m.randomState});
 }
}

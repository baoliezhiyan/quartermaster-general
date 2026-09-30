import type {ReadState,SeatId} from './types';
/** Cards already on the table remain public and in play while their effects resolve. */
export function publicActiveCards(state:ReadState,seat:SeatId){
 const d=state.decks[seat];
 const ids=new Set(state.resolution?.frames.filter(f=>f.status!=='COMPLETE'&&f.publicSourceZone==='active').map(f=>f.cardId));
 return [...new Map([...d.active,...d.resolving.filter(c=>ids.has(c.id))].map(c=>[c.id,c])).values()];
}

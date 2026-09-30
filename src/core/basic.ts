import {randomFact,recordingFacts} from './factObserver';
import {injectReplayShuffle} from './replayHooks';
import { SPECIAL_CARDS, regularCatalog, specialCard } from './cardCatalog';
import { SEATS } from './types';
import { hasStatus } from './modifiers';
import type { Alliance, CardInstance, CountryId, DeckState, GameState, ReadState, SeatId, Unit } from './types';

export const COUNTRY_NAMES: Record<CountryId, string> = {
  germany: '德国', united_kingdom: '英国', japan: '日本', soviet_union: '苏联',
  italy: '意大利', united_states: '美国', france: '法国', china: '中国',
};
export const UNIT_NAMES = { army: '陆军', navy: '海军', air: '空军' };
export const BASIC_NAMES = {
  build_army: '建设陆军', land_battle: '发起陆战', build_navy: '建设海军', sea_battle: '发起海战', air_power: '空中力量',
};
export type BasicId = keyof typeof BASIC_NAMES;
/** Rules: resource reallocation searches all five basic card types. */
export const REALLOCATION_CARD_IDS: readonly BasicId[] = ['build_army','land_battle','build_navy','sea_battle','air_power'];
export const canReallocateCard = (card: { definitionId: string }) => REALLOCATION_CARD_IDS.some(id => id === card.definitionId);
export function reallocationCards(s:ReadState,seat:SeatId) {
  const d=s.decks[seat];
  return [...d.drawPile,...(seat==='united_states'&&hasStatus(s,81)?d.discardPile:[])].filter(canReallocateCard);
}
export const reallocationCost=(s:ReadState)=>s.activeSeat==='united_states'&&hasStatus(s,82)?1:3;
// Design v1.2 §2.1: the debug deck contains only these real basic-card counts.
export const BASIC_COUNTS: Record<SeatId, readonly number[]> = {
  germany: [6,8,2,2,5], united_kingdom: [5,4,6,5,4], japan: [4,3,7,4,5],
  soviet_union: [9,7,1,2,3], italy: [4,5,4,2,3], united_states: [5,4,5,4,6],
};
export const UNIT_TOTALS: Record<CountryId, Record<Unit['type'], number>> = {
  united_kingdom: { army:6, navy:5, air:2 }, france: { army:3, navy:2, air:1 },
  united_states: { army:5, navy:5, air:2 }, china: { army:2, navy:0, air:1 },
  soviet_union: { army:7, navy:1, air:1 }, germany: { army:7, navy:3, air:2 },
  italy: { army:4, navy:3, air:1 }, japan: { army:5, navy:5, air:2 },
};
export const allianceOf = (country: CountryId): Alliance => ['germany','italy','japan'].includes(country) ? 'axis' : 'allies';
export const seatOf = (country: CountryId): SeatId => country === 'france' ? 'united_kingdom' : country === 'china' ? 'united_states' : country;
export const phaseCountries = (seat: SeatId): CountryId[] => seat === 'united_kingdom' ? [seat,'france'] : seat === 'united_states' ? [seat,'china'] : [seat];
export const reserve = (state: ReadState, country: CountryId, type: Unit['type']) => UNIT_TOTALS[country][type] + (state.rules?.balanceEnabled&&country==='italy'&&type==='army'?1:0) - state.units.filter(u => u.country === country && u.type === type).length;
export const cardName = (card: { definitionId: string; balance?:boolean }) => BASIC_NAMES[card.definitionId as BasicId] ?? specialCard(card.definitionId,card.balance)?.name ?? card.definitionId;

/** Explicit serializable PRNG state; seed zero is valid. */
export function shuffle<T>(items: T[], state: Pick<GameState, 'randomState'>): void {
  if(injectReplayShuffle(items,state))return;
  const before=state.randomState,input=recordingFacts()?structuredClone(items):[];
  for (let i = items.length - 1; i > 0; i--) {
    state.randomState = (state.randomState + 0x6d2b79f5) >>> 0;
    let n = state.randomState;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    const j = Math.floor(((n ^ n >>> 14) >>> 0) / 4294967296 * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  if(recordingFacts())randomFact(state,before,input,structuredClone(items));
}
export function makeDecks(state: Pick<GameState, 'randomState'>, mode:GameState['mode']='BASIC_DEBUG',balance=false,neutrality=false,initialize=true): Record<SeatId, DeckState> {
  return Object.fromEntries<DeckState>(SEATS.map(seat => {
    const cards: CardInstance[] = [];
    (Object.keys(BASIC_NAMES) as BasicId[]).forEach((id, index) => {
      for (let i = 0; i < BASIC_COUNTS[seat][index]+(balance&&seat==='italy'&&['build_navy','sea_battle'].includes(id)?1:0); i++) cards.push({ id: `${seat}:${id}:${i+1}`, definitionId:id, country:seat, deckOwner:seat });
    });
    if(mode!=='BASIC_DEBUG') for(const d of (mode==='FULL'?regularCatalog(balance,neutrality):SPECIAL_CARDS).filter(d=>d.deckOwner===seat)) cards.push({id:`${seat}:${d.id}`,definitionId:d.id,country:d.country,deckOwner:seat,...(balance?{balance:true}:{})});
    if(initialize)shuffle(cards, state);
    return [seat, { hand:initialize?cards.splice(0,12):[], drawPile:cards, discardPile:[], active:[], faceDown:[], resolving:[], removed:[] }];
  })) as Record<SeatId, DeckState>;
}

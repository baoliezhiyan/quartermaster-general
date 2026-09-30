import type { ResolutionState } from './resolutionTypes';
/** Serializable contracts only. This module has no React or browser dependency. */
export const SEATS = ['germany', 'united_kingdom', 'japan', 'soviet_union', 'italy', 'united_states'] as const;
export type SeatId = typeof SEATS[number];
export type CountryId = SeatId | 'france' | 'china';
export type Alliance = 'axis' | 'allies';
export type Phase = 'PRELUDE' | 'SETUP' | 'TURN_START_WINDOW' | 'PLAY' | 'AIR' | 'SUPPLY' | 'SCORE' | 'DISCARD' | 'DRAW';

export interface CardInstance {
  balance?:boolean;
  id: string;
  definitionId: string;
  deckOwner: SeatId;
  country: CountryId;
}
export interface Unit {
  id: string;
  country: CountryId;
  type: 'army' | 'navy' | 'air';
  regionId: string;
}
export interface DeckState {
  drawPile: CardInstance[];
  hand: CardInstance[];
  discardPile: CardInstance[];
  faceDown: CardInstance[];
  active: CardInstance[];
  resolving: CardInstance[];
  removed: CardInstance[];
}
export interface PreludeState {
  historyDiscard?:boolean; round?:number;
  active:boolean; turn:number; tension:number; played:boolean; discarded:number;
  decks:Record<SeatId,{drawPile:CardInstance[];hand:CardInstance[];discardPile:CardInstance[]}>;
  installed:Record<string,number>; installedWar?:Record<string,number>; installedEvent?:Record<string,number>; wars:{revision:number;attacker:SeatId;defender:SeatId}[];
}
export interface GameState {
  unitSerial?:number;
  /** Isolated PPO curriculum data; absent in ordinary games. */
  trainingCourse?: {
    version: 'ppo-events-v1'; mode: 'A' | 'B';
    openIds: Record<SeatId,string[]>;
    openRandomState: number; discardRandomState: number;
  };
  /** Arena-only fast path: every deck contains basic cards exclusively. */
  trainingBasicOnly?: boolean;
  rules?:{preludeEnabled:boolean;neutralityEnabled:boolean;balanceEnabled?:boolean};
  neutrality?:Record<'soviet_union'|'united_states',{neutral:boolean;reason?:string;eventId?:string;round?:number}>;
  neutralityNotices?:{id:string;seat:'soviet_union'|'united_states';reason:string}[];
  neutralityStatusPending?:boolean;
  prelude?:PreludeState;
  resolutionVersion?:2|3;
  scoringStart?:number;
  publicArmamentCounts?:Partial<Record<SeatId,number>>;
  publicDiscardCounts?:Partial<Record<SeatId,number>>;
  publicLog?: {round:number;seat:SeatId;text:string}[];
  publicCardIds?: string[];
  faceUpResponseIds?: string[];
  balanceResolutionSerial?:number;
  balanceFirstAttacks?:Record<string,string>;
  roundUses?:Record<string,number>;
  basicPlaysRemaining?:number;
  airAction?:'move'|'deploy'|'supremacy';
  responseNotices?: ResponseNotice[];
  disabledResponseIds?: string[];
  schemaVersion: 1;
  rulesVersion: '1.4.0';
  gameId: string;
  seed: number;
  revision: number;
  status: 'SETUP' | 'PLAYING' | 'FINISHED';
  mode: 'BASIC_DEBUG' | 'REPRESENTATIVE' | 'FULL';
  resolutionResume: { phase:Phase; apply:boolean; continuePlay?:boolean } | null;
  randomState: number;
  setupCompleted: SeatId[];
  redistributed: boolean;
  turnFlags?: { protected:string[]; battleProtected:string[]; supplied:string[]; supplyCountries:string[]; supplyRegions:string[]; suppressed:string[]; noAirDefense:boolean };
  pendingAir: string[];
  resolution: ResolutionState | null;
  pendingDiscard: { seat: SeatId; count: number; returnSeat: SeatId } | null;
  resumePhase: 'AIR' | 'SUPPLY' | null;
  winner: Alliance | null;
  victoryReason: 'TWENTY_ROUNDS' | 'AXIS_LEAD' | 'ALLIES_LEAD' | null;
  axisBonus: number;
  round: number;
  phase: Phase;
  activeSeat: SeatId;
  viewSeat: SeatId;
  operatorSeat: SeatId;
  settings: { ignoreOtherPlayerInterrupts: boolean };
  scores: Record<SeatId, number>;
  decks: Record<SeatId, DeckState>;
  units: Unit[];
  events: GameEvent[];
}
export type Command =
  | { type:'SET_CARD_RESPONSE'; seat:SeatId; expectedRevision:number; cardId:string; enabled:boolean }
  | { type:'ACK_RESPONSE_NOTICE'; seat:SeatId; expectedRevision:number; noticeId:string }
  | { type: 'CREATE_GAME'; gameId: string; seed: number; mode?:GameState['mode']; prelude?:boolean; neutrality?:boolean; balance?:boolean }
  | { type: 'SET_VIEW'; seat: SeatId; expectedRevision: number }
  | ({ seat: SeatId; expectedRevision: number } & (
    | { type:'ARMAMENT_WINDOW' }
    | { type:'SELECT_AIR_ACTION'; action:'move'|'deploy'|'supremacy'|null }
    | { type:'DISCARD_PRELUDE_TOP' }
    | { type:'PLAY_PRELUDE'; cardId:string }
    | { type: 'KEEP_OPENING'; cardIds: string[] }
    | { type: 'ADVANCE_PHASE' }
    | { type: 'DISCARD_HAND'; cardIds: string[] }
    | { type: 'REDISTRIBUTE'; cardIds: string[]; takeCardId: string }
    | { type: 'PLAY_BASIC'; cardId: string; optionId: string }
    | { type: 'PLAY_CARD'; guided?:boolean; cardId:string; effectIndices:number[]; targetIds:string[] }
    | { type: 'STATUS_ACTION'; guided?:boolean; cardId:string }
    | { type: 'MOVE_AIR'; cardId: string; optionId: string }
    | { type: 'RELOCATE_AIR'; regionId: string }
    | { type: 'RESOLVE_FORCED_DISCARD'; cardIds: string[] }
    | { type: 'START_RESOLUTION_SCENARIO'; scenarioId: string }
    | { type: 'SET_INTERRUPTS'; enabled:boolean }
    | { type: 'RESOLVE_ENGINE_CHOICE'; guided?:boolean; choiceId: string; ids: string[] }
    | { type: 'DEBUG_DECK'; operation: 'pay' | 'force' | 'top' | 'draw'; target: SeatId; count: number; cardIds: string[] }
    | { type: 'DEBUG_PLACEMENT'; country: CountryId; unitType: 'army' | 'navy'; mode: 'build' | 'recruit'; regionId: string; optionId: string; cost: number; cardIds: string[] }
  ));
export type GameEvent =
  | { type: 'UNIT_PLACED'; revision: number; mode: 'build' | 'recruit'; country: CountryId; unitId: string; regionId: string; repeated: boolean }
  | { type: 'GAME_CREATED'; revision: number; gameId: string; seed: number }
  | { type: 'VIEW_CHANGED'; revision: number; seat: SeatId }
  | { type: 'RULE_EVENT'; revision: number; code: string; text: string };
export type CommandError = 'INVALID_COMMAND' | 'GAME_NOT_CREATED' | 'STALE_REVISION' | 'WRONG_OPERATOR' | 'ILLEGAL_ACTION';
export type Transition =
  | { ok: true; state: GameState }
  | { ok: false; error: CommandError };
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ReadState = DeepReadonly<GameState>;
export interface ResponseNotice {
  id:string; recipients:SeatId[]; readBy:SeatId[]; text:string; title?:string;
  cards:CardInstance[];
}

import type { CountryId, SeatId, Unit, GameState } from './types';
import type { BasicOption } from './actions';

export type Effect = { label: string; selectedIds?:readonly string[]; attackNotified?:boolean; buildEither?:boolean; optional?:boolean; accepted?:boolean; airDefense?:boolean; airIntercept?:boolean; fee?:boolean; deferredFee?:boolean; handCostAuthorized?:boolean; requires?:{ seat:SeatId; minHand:number } } & (
  | { kind:'balance';seat:SeatId;op:string;cardId?:string }
  | { kind:'prelude'; seat:SeatId; op:string; count:number; cardId?:string }
  | { kind:'copyStatus'; seat:SeatId; eventId:string; timing:'Before'|'After'; cardId?:string }
  | { kind:'trace' }
  | { kind:'score'; seat:SeatId; amount:number }
  | { kind:'draw' | 'deckTop' | 'forceHand'; seat:SeatId; count:number }
  | { kind:'cancel' }
  | { kind:'signal'; tag:string; completedFrameId?:string }
  | { kind:'reallocate'; seat:SeatId }
  | { kind:'choose'; seat:SeatId; min:number; max:number; options:{id:string;label:string;effects:Effect[]}[] }
  | { kind:'rebuild'; country:CountryId; withdrawnIds?:string[] }
  | { kind:'remove'; unit:Unit; supplied:boolean; cause:string }
  | { kind:'flag'; flag:'protected'|'battleProtected'|'supplied'|'supplyCountries'|'supplyRegions'|'suppressed'|'noAirDefense'; ids:string[] }
  | { kind:'frameChange'; frameId:string; finalZone?:FinalZone; cancel?:boolean }
  | { kind:'countChange'; eventId:string; delta:number }
  | { kind:'randomReturn'; seat:SeatId; countFrom:string }
  | { kind:'randomPlay'; seat:SeatId; group?:SeatId[] }
  | { kind:'cards'; publicDiscard?:boolean; allowedIds?:string[]; requirements?:string[]; strictFee?:boolean; random?:boolean; remember?:string; seat:SeatId; from:'hand'|'drawPile'|'discardPile'|'faceDown'|'active'; to:FinalZone; min:number; max:number; filter?:string; shuffle?:boolean; bottom?:boolean; topCount?:number; order?:boolean }
  | { kind:'extraPlay'; allowSkip?:boolean; returnOnSkip?:boolean; onlyCardIds?:string[]; onlyRemember?:string; seat:SeatId; from:'hand'|'drawPile'|'discardPile'; filter?:string; mention?:string; selectedCardId?:string; targets?:string[]; indices?:number[]; shuffle?:boolean }
  | { kind:'action'; destroyedType?:Unit['type']; airMode?:'deploy'|'supremacy'; decisionSeat?:SeatId; destroyTypes?:readonly ('army'|'navy'|'air')[]; recycledId?:string; bindAs?:string; fromBinding?:string;bindAttacker?:boolean;boundAttackerId?:string; resultUnitId?:string; country:CountryId; action:'build_army'|'build_navy'|'recruit_army'|'recruit_navy'|'land_battle'|'sea_battle'|'air_power'|'air_deploy'|'air_move'|'destroy'; regions?:string[]; newOnly?:boolean; targetIds?:string[]; option?:BasicOption; selection?:{regionId?:string;defenderId?:string;attackerId?:string}; }
);
export type FinalZone = 'discardPile' | 'active' | 'hand' | 'drawPile' | 'removed' | 'faceDown';
export interface TriggerRule {
  generated?:boolean;
  /** Resolve immediate placement reactions before optional follow-up actions. */
  placementPriority?:boolean;
  id:string; label:string; sourceInstanceId:string; owner:SeatId;
  timing:'Before' | 'After'; on:string;
  mandatory:boolean;
  source:'active' | 'response' | 'enhancement' | 'system';
  scopeId?:string;
  boundEventId?:string;
  faceDownEnhancement?:boolean;
  effects:Effect[];
  cost?:number; minHand?:number; oncePerTurn?:boolean;oncePerRound?:boolean;
  costRequirements?:string[]; atomic?:boolean;
  finalZone?:FinalZone;
}
export interface ResolutionEvent {
  /** Facts survive removal of their resulting units and closure of response windows. */
  outcome?:'declared'|'succeeded'|'cancelled'|'invalid';
  started?:boolean;
  ended?:boolean;
  effectIndex?:number;
  resultText?:string;
  detailedNoticeSeats?:SeatId[];
  id:string; label:string; frameId:string; ancestorIds:string[];
  cancelled:boolean; applied:boolean;
  effect?:Effect;
}
export interface ResolutionFrame {
  finishOnSkip?:boolean; declined?:boolean;
  noticeKind?:'trigger'|'extra'|'neutrality';
  ownEffectsComplete?:boolean;
  cancelled?:boolean;
  scoreBatchId?:string;
  effectCompletionNotified?:boolean;
  publicDeclared?:boolean;
  publicSourceZone?:string;
  guided?:boolean; committed?:boolean; declarationPending?:boolean; rollback?:GameState; extraRollback?:GameState;
  id:string; source:string; cardId?:string; owner:SeatId; effects:Effect[];
  nextEffectIndex:number; stage:'Validate' | 'Apply' | 'After' | 'AfterImmediate' | 'Resume';
  status:'RUNNING' | 'WAITING_CHOICE' | 'WAITING_RESPONSE' | 'COMPLETE';
  parentEventId:string | null; ancestorIds:string[]; sourceAncestors:string[];
  memory?:Record<string,string[]>;
  currentEventId:string | null; finalZone:FinalZone;
}
export interface TriggerWindow {
  lane?:'immediate'|'followup';
  batchId?:string;
  closeReason?:'exhausted'|'cancelled'|'legacy-branch';
  opportunities?:Record<string,'available'|'temporarily-illegal'|'declined'|'fired'>;
  id:string; originEventId:string; parentWindowId:string | null; depth:number;
  timing:'Before' | 'After'; initialCandidates:string[]; remaining:string[];
  mandatoryOrder:string[] | null; closed:boolean; declinedSeats?:SeatId[];
}
export interface ChoiceRequest {
  batchResponse?:'before'|'after';
  /** A merged entry retains all original event/rule bindings. */
  mergedTriggers?:Record<string,{windowId:string;ruleId:string}[]>;
  triggerTargets?:Record<string,{windowId:string;ruleId:string}>;
  id:string; kind:'BUILD_ORDER' | 'EFFECT_DECISION' | 'AIR_DEFENSE' | 'AIR_INTERCEPT' | 'TRIGGER' | 'ORDER_MANDATORY_TRIGGERS' | 'FORCE_HAND' | 'PAY_COST' | 'ACTION' | 'RELOCATE' | 'REALLOCATE' | 'EFFECTS' | 'SELECT' | 'CARDS' | 'EXTRA_CARD' | 'EXTRA_TARGET' | 'EXTRA_EFFECTS';
  canSkip?:boolean;
  preselect?:boolean;
  requirements?:string[];
  field?:'regionId'|'defenderId'|'attackerId'|'option';
  airId?:string;
  seat:SeatId; prompt:string; min:number; max:number;
  options:{ id:string; label:string; windowId?:string }[];
  windowId?:string; frameId?:string; triggerId?:string;
}
export interface ResolutionState {
  schedulerVersion?:1;
  scoreBatches?:{id:string;windowId:string;frameIds:string[];phase:'before'|'run'|'after'|'finish';index:number}[];
  revealGroup?:{frameId:string;items:{seat:SeatId;requestId:string;resultId:string;card?:import('./types').CardInstance;playable:boolean}[]};
  waiting?:boolean;
  guided?:boolean;
  owner:SeatId; scenario:string; running:boolean; serial:number;
  frames:ResolutionFrame[]; windows:TriggerWindow[];
  stack:({kind:'frame';id:string}|{kind:'window';id:string}|{kind:'scoreBatch';id:string})[];
  events:ResolutionEvent[]; rules:TriggerRule[];
  choice:ChoiceRequest | null; trace:string[];
  fired:string[]; turnUses:Record<string,number>;
}

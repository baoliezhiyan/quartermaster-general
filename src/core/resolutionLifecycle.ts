import type {Effect,ResolutionFrame,TriggerRule,TriggerWindow} from './resolutionTypes';

const bookkeeping=new Set(['CARD_PLAYED','STANDARD_CARD_PLAYED','CARD_EFFECT_DONE']);
/** Completion belongs to this card's effects, not to descendants in the stack. */
export function isLastOwnEffect(frame:ResolutionFrame) {
 return !frame.effects.slice(frame.nextEffectIndex+1).some(e=>e.kind!=='signal'||!bookkeeping.has(e.tag));
}
export function inWindowLane(rule:TriggerRule,window:TriggerWindow) {
 return !window.lane || (window.lane==='immediate')===!!rule.placementPriority;
}
/** Deliberately narrow: no fees, choices, board changes or optional scoring. */
export function isBatchScore(rule:TriggerRule,effect?:Effect) {
 return effect?.kind==='signal'&&['PHASE:SCORE','PHASE:SCORE_STATUS'].includes(effect.tag)&&rule.source==='active'&&rule.mandatory&&!rule.cost&&!rule.minHand&&rule.effects.length>0&&rule.effects.every(e=>e.kind==='score'&&!e.fee&&!e.optional);
}
export function closeWindow(window:TriggerWindow,reason:NonNullable<TriggerWindow['closeReason']>='exhausted') {
 window.closed=true;window.closeReason=reason;
}

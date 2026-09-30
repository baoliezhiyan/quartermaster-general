import {preludeCatalog} from '../core/cardCatalog';
import { createGame, PHASE_NAMES, SEATS, transition } from '../core';
import type { Command, GameState, SeatId } from '../core';
import { COUNTRY_NAMES, UNIT_TOTALS } from '../core/basic';
import { REGION_BY_ID } from '../core/map';

export const ZONES = ['drawPile','hand','discardPile','faceDown','active','resolving','removed'] as const;
export type RecoveryStep = {kind:'command';command:Command}|{kind:'restore';reason:string;state:GameState};
export interface RecoveryRecord { initial:GameState; fromCreation:boolean; steps:RecoveryStep[] }
export function recoverRecord(record:RecoveryRecord):GameState {
  let state=structuredClone(record.initial);
  for(const step of record.steps){
    if(step.kind==='restore')state=structuredClone(step.state);
    else {const result=transition(state,step.command);if(!result.ok)throw new Error('对局记录无法恢复：'+result.error);state=result.state;}
  }
  return state;
}
export interface Checkpoint { id:string; round:number; seat:SeatId; createdAt:string; state:GameState; stage?:'prelude' }
export interface SaveSession {
  matchRecording?:import('../matchLog/recorder').Recording;
  format:'quartermaster-save'; version:1; updatedAt:string;
  state:GameState; rounds:Checkpoint[]; nations:Checkpoint[]; undo:GameState[];
  replayBase:GameState; commands:Command[];
  recovery?: RecoveryRecord;
  playback?:{file:import('./replay').ReplayFile;cursor:number};
}
function demand(value:unknown, message='存档结构损坏或不完整。'):asserts value { if(!value)throw new Error(message); }
const object=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown)=>Number.isSafeInteger(v);
const strings=(v:unknown)=>Array.isArray(v)&&v.every(x=>typeof x==='string');
const seat=(v:unknown)=>SEATS.includes(v as SeatId);
function validateEffects(value:unknown,depth=0):void {
  demand(depth<100&&Array.isArray(value));
  const kinds=['balance','copyStatus','prelude','trace','score','draw','deckTop','forceHand','cancel','signal','reallocate','choose','rebuild','remove','flag','frameChange','countChange','randomReturn','randomPlay','cards','extraPlay','action'];
  for(const e of value) {
    demand(object(e)&&kinds.includes(String(e.kind))&&typeof e.label==='string');
    if(e.kind==='prelude')demand(seat(e.seat)&&integer(e.count)&&['spanish-burn','spanish-pay','spanish-settle','unplayed-from-discard','play-discard','bottom-seven','purge-double','picnic-uk','picnic-pay','play-hand-required','play-hand-or-top','tension','discard','shuffle','shuffle-normal','arm-from-deck','arm-from-discard','install-deck','install-discard','play-hand','play-top','play-selected','purge','inspect-status','play-status','wartime-hand','draw-to-seven','draw-if-installed','draw-bottomed'].includes(String(e.op)));
    if(e.kind==='balance')demand(seat(e.seat)&&['armament-rebuild','shuffle-deck','italian-ambition','italian-ambition-deck','discard-to-seven','draw-to-seven','bomber-economy','draw-bottomed','end-neutrality','return-source','scry','scry-top','exile-government','relocate-industry','inspect-response','inspect-take','reveal-response','build-battle-region','two-basic-plays','play-vichy'].includes(String(e.op)));
    if(e.kind==='copyStatus')demand(seat(e.seat)&&typeof e.eventId==='string'&&['Before','After'].includes(String(e.timing)));
    if(e.publicDiscard!==undefined)demand(e.kind==='cards'&&typeof e.publicDiscard==='boolean');
    if(e.destroyedType!==undefined)demand(e.kind==='action'&&['army','navy','air'].includes(String(e.destroyedType)));
    if(e.strictFee!==undefined)demand(typeof e.strictFee==='boolean');
    if(e.airMode!==undefined)demand(e.kind==='action'&&e.action==='air_power'&&['deploy','supremacy'].includes(String(e.airMode)));
    if(e.decisionSeat!==undefined)demand(e.kind==='action'&&seat(e.decisionSeat));
    if(e.handCostAuthorized!==undefined)demand(typeof e.handCostAuthorized==='boolean');
    if(e.kind==='choose') {demand(Array.isArray(e.options));for(const o of e.options){demand(object(o)&&typeof o.id==='string'&&typeof o.label==='string');validateEffects(o.effects,depth+1);}}
    if(e.kind==='action') demand(Object.hasOwn(COUNTRY_NAMES,String(e.country))&&['build_army','build_navy','recruit_army','recruit_navy','land_battle','sea_battle','air_power','air_deploy','air_move','destroy'].includes(String(e.action)));
    if(e.kind==='flag') demand(strings(e.ids));
    if(e.kind==='remove') demand(object(e.unit)&&typeof e.unit.id==='string');
    if(e.group!==undefined)demand(e.kind==='randomPlay'&&Array.isArray(e.group)&&e.group.length===3&&e.group.every(seat)&&new Set(e.group).size===3);
    if(e.seat!==undefined)demand(seat(e.seat));
    for(const k of ['selectedIds','regions','targetIds','ids','onlyCardIds','targets','allowedIds','requirements','destroyTypes'])if(e[k]!==undefined)demand(strings(e[k]));
  }
}

export function validateState(value:unknown,depth=0):asserts value is GameState {
  demand(depth<=16,'结算快照嵌套过深。');
  demand(object(value)); const s=value;
  demand(s.resolutionVersion===undefined||s.resolutionVersion===2||s.resolutionVersion===3);
  demand(s.schemaVersion===1 && s.rulesVersion==='1.4.0','存档规则版本不兼容；当前仅支持 1.4.0。');
  demand(typeof s.gameId==='string' && s.gameId.length>0 && integer(s.seed) && integer(s.randomState) && integer(s.revision));
  demand(integer(s.round) && Number(s.round)>=0 && Number(s.round)<=20 && Number(s.revision)>=0);
  demand(['FULL','REPRESENTATIVE','BASIC_DEBUG'].includes(String(s.mode)) && ['SETUP','PLAYING','FINISHED'].includes(String(s.status)) && Object.hasOwn(PHASE_NAMES,String(s.phase)));
  demand(seat(s.activeSeat)&&seat(s.viewSeat)&&seat(s.operatorSeat));
  demand(strings(s.setupCompleted)&&s.setupCompleted.every(seat) && new Set(s.setupCompleted).size===s.setupCompleted.length);
  demand(object(s.settings)&&typeof s.settings.ignoreOtherPlayerInterrupts==='boolean' && typeof s.redistributed==='boolean');
  demand(object(s.scores)&&SEATS.every(k=>typeof s.scores==='object'&&Number.isFinite((s.scores as Record<string,unknown>)[k])));
  demand(Array.isArray(s.events)&&s.events.every(e=>object(e)&&['GAME_CREATED','UNIT_PLACED','VIEW_CHANGED','RULE_EVENT'].includes(String(e.type))&&integer(e.revision)));
  if(s.publicCardIds!==undefined)demand(Array.isArray(s.publicCardIds)&&s.publicCardIds.every((id:unknown)=>typeof id==='string'));
  if(s.faceUpResponseIds!==undefined)demand(strings(s.faceUpResponseIds)&&new Set(s.faceUpResponseIds).size===s.faceUpResponseIds.length);
  if(s.balanceResolutionSerial!==undefined)demand(integer(s.balanceResolutionSerial)&&Number(s.balanceResolutionSerial)>=0);
  if(s.balanceFirstAttacks!==undefined)demand(object(s.balanceFirstAttacks)&&Object.values(s.balanceFirstAttacks).every(v=>typeof v==='string'));
  if(s.roundUses!==undefined)demand(object(s.roundUses)&&Object.values(s.roundUses).every(v=>integer(v)&&Number(v)>=0));
  if(s.airAction!==undefined)demand(['move','deploy','supremacy'].includes(String(s.airAction)));
  if(s.basicPlaysRemaining!==undefined)demand(integer(s.basicPlaysRemaining)&&Number(s.basicPlaysRemaining)>=0&&Number(s.basicPlaysRemaining)<=2);
  if(s.publicLog!==undefined)demand(Array.isArray(s.publicLog)&&s.publicLog.every((e:any)=>e&&Number.isInteger(e.round)&&SEATS.includes(e.seat)&&typeof e.text==='string'));
  if(s.disabledResponseIds!==undefined)demand(Array.isArray(s.disabledResponseIds)&&s.disabledResponseIds.every((id:unknown)=>typeof id==='string')&&new Set(s.disabledResponseIds).size===s.disabledResponseIds.length);
  if(s.responseNotices!==undefined){
    demand(Array.isArray(s.responseNotices));const noticeIds=new Set<string>();
    for(const n of s.responseNotices){
      demand(n.title===undefined||typeof n.title==='string');
      demand(object(n)&&typeof n.id==='string'&&!noticeIds.has(n.id)&&typeof n.text==='string');noticeIds.add(n.id);
      demand(strings(n.recipients)&&n.recipients.every(seat)&&strings(n.readBy)&&n.readBy.every(v=>(n.recipients as string[]).includes(v)));
      demand(Array.isArray(n.cards)&&n.cards.every(c=>object(c)&&typeof c.id==='string'&&typeof c.definitionId==='string'&&seat(c.deckOwner)&&Object.hasOwn(COUNTRY_NAMES,String(c.country))));
    }
  }
  for(const e of s.events) {
    if(e.type==='RULE_EVENT') demand(typeof e.text==='string'&&typeof e.code==='string');
    if(e.type==='VIEW_CHANGED') demand(seat(e.seat));
    if(e.type==='UNIT_PLACED') demand(Object.hasOwn(REGION_BY_ID,String(e.regionId))&&Object.hasOwn(COUNTRY_NAMES,String(e.country)));
  }
  demand(strings(s.pendingAir)&&Array.isArray(s.units)&&object(s.decks));
  demand(s.winner===null||['axis','allies'].includes(String(s.winner)));
  demand(s.victoryReason===null||['TWENTY_ROUNDS','AXIS_LEAD','ALLIES_LEAD'].includes(String(s.victoryReason)));
  demand(Number.isFinite(s.axisBonus) && (s.resumePhase===null||['AIR','SUPPLY'].includes(String(s.resumePhase))));
  demand(s.resolutionResume===null||object(s.resolutionResume)&&Object.hasOwn(PHASE_NAMES,String(s.resolutionResume.phase))&&typeof s.resolutionResume.apply==='boolean');
  demand(s.pendingDiscard===null||object(s.pendingDiscard)&&seat(s.pendingDiscard.seat)&&seat(s.pendingDiscard.returnSeat)&&integer(s.pendingDiscard.count));
  const ids=new Set<string>(),placements=new Set<string>();
  for(const unit of s.units) {
    demand(object(unit)&&typeof unit.id==='string'&&Object.hasOwn(COUNTRY_NAMES,String(unit.country))&&['army','navy','air'].includes(String(unit.type))&&Object.hasOwn(REGION_BY_ID,String(unit.regionId)));
    demand(!ids.has(unit.id),'兵模 ID 重复。');ids.add(unit.id);
    const key=`${unit.country}:${unit.type}:${unit.regionId}`;demand(!placements.has(key),'同地区出现重复的同国同类兵模。');placements.add(key);
    demand(unit.type==='air'||REGION_BY_ID[String(unit.regionId)].type===(unit.type==='army'?'LAND':'SEA'),'兵模的地区类型不匹配。');
  }
  demand(s.pendingAir.every(id=>s.units instanceof Array && s.units.some(u=>u.id===id&&u.type==='air')));
  for(const [country,limits] of Object.entries(UNIT_TOTALS))for(const [type,total] of Object.entries(limits)) demand(s.units.filter(u=>u.country===country&&u.type===type).length<=total+(object(s.rules)&&s.rules.balanceEnabled&&country==='italy'&&type==='army'?1:0),'兵模超过储备总数。');
  ids.clear();
  if(s.rules!==undefined)demand(object(s.rules)&&typeof s.rules.preludeEnabled==='boolean'&&typeof s.rules.neutralityEnabled==='boolean'&&s.rules.preludeEnabled===!!s.prelude);
  if(object(s.rules)&&s.rules.balanceEnabled!==undefined)demand(typeof s.rules.balanceEnabled==='boolean');
  if(s.neutrality!==undefined){
    demand(object(s.neutrality)&&object(s.rules)&&s.rules.neutralityEnabled===true);
    for(const key of ['soviet_union','united_states']){
      const n=s.neutrality[key];demand(object(n)&&typeof n.neutral==='boolean');
      if(!n.neutral)demand(typeof n.reason==='string'&&n.eventId===`${s.gameId}:neutrality:${key}`&&integer(n.round)&&Number(n.round)>=0);
    }
    demand(Array.isArray(s.neutralityNotices)&&s.neutralityNotices.length<=2);
    const seen=new Set<string>();
    for(const n of s.neutralityNotices){demand(object(n)&&['soviet_union','united_states'].includes(String(n.seat))&&typeof n.id==='string'&&typeof n.reason==='string'&&!seen.has(n.id));seen.add(n.id);const entry=s.neutrality[String(n.seat)];demand(object(entry)&&entry.neutral===false&&entry.eventId===n.id&&entry.reason===n.reason);}
    for(const key of ['soviet_union','united_states']){const n=s.neutrality[key] as Record<string,unknown>;demand(n.neutral||seen.has(String(n.eventId)));}
  }else demand(!(object(s.rules)&&s.rules.neutralityEnabled===true)&&s.neutralityNotices===undefined&&s.neutralityStatusPending===undefined);
  if(s.neutralityStatusPending!==undefined)demand(typeof s.neutralityStatusPending==='boolean'&&(!s.neutralityStatusPending||object(s.neutrality)&&object(s.neutrality.soviet_union)&&s.neutrality.soviet_union.neutral===false));
  const canonical=createGame(String(s.gameId),Number(s.seed),s.mode as GameState['mode'],false,s.neutrality?true:undefined,object(s.rules)?s.rules.balanceEnabled as boolean|undefined:undefined);
  const expected=new Map(SEATS.flatMap(k=>ZONES.flatMap(z=>canonical.decks[k][z])).map(c=>[c.id,c]));
  if(s.prelude!==undefined){
    const p=s.prelude;demand(object(p)&&typeof p.active==='boolean'&&integer(p.turn)&&integer(p.tension)&&typeof p.played==='boolean'&&integer(p.discarded)&&object(p.decks)&&object(p.installed)&&Array.isArray(p.wars));
    if(p.historyDiscard!==undefined)demand(typeof p.historyDiscard==='boolean');
    if(p.round!==undefined)demand(integer(p.round)&&Number(p.round)>=1);
    demand(Number(p.turn)>=1&&Number(p.discarded)>=0&&(!p.active||s.phase==='PRELUDE'));
    for(const w of p.wars)demand(object(w)&&integer(w.revision)&&seat(w.attacker)&&seat(w.defender));
    for(const key of ['installed','installedWar','installedEvent'])if(p[key]!==undefined)demand(object(p[key])&&Object.values(p[key]).every(v=>integer(v)&&Number(v)>=0));
    for(const c of preludeCatalog(!!(object(s.rules)&&s.rules.balanceEnabled)))expected.set(`${c.deckOwner}:${c.id}`,{id:`${c.deckOwner}:${c.id}`,definitionId:c.id,country:c.country,deckOwner:c.deckOwner,...(object(s.rules)&&s.rules.balanceEnabled?{balance:true}:{})});
    for(const owner of SEATS){const d=p.decks[owner];demand(object(d));for(const zone of ['hand','drawPile','discardPile']){demand(Array.isArray(d[zone]));for(const c of d[zone]){demand(object(c)&&typeof c.id==='string'&&!ids.has(c.id));const original=expected.get(c.id);demand(typeof c.definitionId==='string'&&c.definitionId.startsWith('prelude_')&&original&&original.definitionId===c.definitionId&&original.country===c.country&&original.deckOwner===owner,'序章卡牌实例不合法。');ids.add(c.id);}}}
  }
  for(const owner of SEATS) {
    const deck=s.decks[owner];demand(object(deck));
    for(const zone of ZONES) {
      demand(Array.isArray(deck[zone]));
      for(const card of deck[zone]) {
        demand(object(card)&&typeof card.id==='string'&&typeof card.definitionId==='string'&&card.deckOwner===owner&&Object.hasOwn(COUNTRY_NAMES,String(card.country)));
        demand(!ids.has(card.id),'卡牌实例重复。');ids.add(card.id);
        const original=expected.get(card.id);
        demand(original ? original.definitionId===card.definitionId&&(original.country===card.country||(card.definitionId==='special_5'&&card.balance===true&&card.country==='united_kingdom'&&original.country==='france'))&&original.deckOwner===owner&&!!original.balance===!!card.balance : s.mode==='BASIC_DEBUG','卡牌实例不属于本局牌组。');
      }
    }
  }
  demand([...expected.keys()].every(id=>ids.has(id)),'存档缺少卡牌实例。');
  if(s.turnFlags!==undefined) {demand(object(s.turnFlags));for(const k of ['protected','battleProtected','supplied','supplyCountries','supplyRegions','suppressed'])demand(strings(s.turnFlags[k]));demand(typeof s.turnFlags.noAirDefense==='boolean');}
  if(s.resolution!==null) {
    const r=s.resolution;demand(object(r)&&seat(r.owner)&&typeof r.running==='boolean'&&integer(r.serial)&&typeof r.scenario==='string');
    for(const k of ['frames','windows','stack','events','rules']) demand(Array.isArray(r[k])&&(r[k] as unknown[]).every(object));
    for(const k of ['trace','fired']) demand(strings(r[k]));demand(object(r.turnUses));
    for(const f of r.frames as Record<string,unknown>[]) {
      demand(typeof f.id==='string'&&seat(f.owner)&&Array.isArray(f.effects)&&integer(f.nextEffectIndex)&&strings(f.ancestorIds)&&strings(f.sourceAncestors)&&typeof f.source==='string');
      demand(['Validate','Apply','After','AfterImmediate','Resume'].includes(String(f.stage))&&['RUNNING','WAITING_CHOICE','WAITING_RESPONSE','COMPLETE'].includes(String(f.status)));
      demand(Number(f.nextEffectIndex)>=0&&Number(f.nextEffectIndex)<=f.effects.length);validateEffects(f.effects);
      if(f.rollback!==undefined){validateState(f.rollback,depth+1);demand(f.rollback.gameId===s.gameId,'结算快照不属于本对局。');}
      if(f.extraRollback!==undefined){validateState(f.extraRollback,depth+1);demand(f.extraRollback.gameId===s.gameId,'额外出牌快照不属于本对局。');}
    }
    if(r.revealGroup!==undefined){
      const g=r.revealGroup;demand(object(g)&&typeof g.frameId==='string'&&(r.frames as Record<string,unknown>[]).some(f=>f.id===g.frameId)&&Array.isArray(g.items)&&g.items.length===3);
      demand(new Set(g.items.map(i=>object(i)?i.seat:null)).size===3);
      for(const i of g.items){demand(object(i)&&['germany','italy','japan'].includes(String(i.seat))&&typeof i.requestId==='string'&&typeof i.resultId==='string'&&typeof i.playable==='boolean');if(i.card!==undefined)demand(object(i.card)&&typeof i.card.id==='string'&&typeof i.card.definitionId==='string'&&i.card.deckOwner===i.seat);}
    }
    const frames=r.frames as Record<string,unknown>[],events=r.events as Record<string,unknown>[],windows=r.windows as Record<string,unknown>[];
    for(const e of events){demand(typeof e.id==='string'&&typeof e.label==='string'&&frames.some(f=>f.id===e.frameId)&&strings(e.ancestorIds));if(e.effect!==undefined)validateEffects([e.effect]);}
    for(const w of windows) demand((w.declinedSeats===undefined||Array.isArray(w.declinedSeats)&&w.declinedSeats.every(seat))&&typeof w.id==='string'&&strings(w.remaining)&&strings(w.initialCandidates)&&typeof w.closed==='boolean'&&events.some(e=>e.id===w.originEventId)&&(w.mandatoryOrder===null||strings(w.mandatoryOrder)));
    for(const rule of r.rules as Record<string,unknown>[]) {demand(typeof rule.id==='string'&&typeof rule.label==='string'&&typeof rule.sourceInstanceId==='string'&&seat(rule.owner));validateEffects(rule.effects);}
    demand(r.schedulerVersion===undefined||r.schedulerVersion===1);
    const batches=r.scoreBatches??[];demand(Array.isArray(batches));
    const batchIds=new Set<string>();
    for(const b of batches){demand(object(b)&&typeof b.id==='string'&&!batchIds.has(b.id)&&strings(b.frameIds)&&new Set(b.frameIds).size===b.frameIds.length&&b.frameIds.every(id=>frames.some(f=>f.id===id&&f.scoreBatchId===b.id))&&windows.some(w=>w.id===b.windowId)&&['before','run','after','finish'].includes(String(b.phase))&&integer(b.index)&&Number(b.index)>=0&&Number(b.index)<=b.frameIds.length);batchIds.add(b.id);}
    for(const f of frames)if(f.scoreBatchId!==undefined)demand(batchIds.has(String(f.scoreBatchId)));
    for(const entry of r.stack as Record<string,unknown>[])demand(entry.kind==='frame'?frames.some(f=>f.id===entry.id):entry.kind==='window'?windows.some(w=>w.id===entry.id):entry.kind==='scoreBatch'&&batchIds.has(String(entry.id)));
    if(r.choice!==null) {
      const c=r.choice;if(object(c)){if(c.preselect!==undefined)demand(typeof c.preselect==='boolean');if(c.requirements!==undefined)demand(strings(c.requirements));}demand(object(c)&&typeof c.id==='string'&&typeof c.prompt==='string'&&seat(c.seat)&&integer(c.min)&&integer(c.max)&&Number(c.min)>=0&&Number(c.max)>=Number(c.min)&&Array.isArray(c.options)&&c.options.every(o=>object(o)&&typeof o.id==='string'&&typeof o.label==='string'));
      demand(['BUILD_ORDER','EFFECT_DECISION','AIR_DEFENSE','AIR_INTERCEPT','TRIGGER','ORDER_MANDATORY_TRIGGERS','FORCE_HAND','PAY_COST','ACTION','RELOCATE','REALLOCATE','EFFECTS','SELECT','CARDS','EXTRA_CARD','EXTRA_TARGET','EXTRA_EFFECTS'].includes(String(c.kind)));
      const validRef=(ref:unknown)=>object(ref)&&windows.some(w=>w.id===ref.windowId)&&(r.rules as Record<string,unknown>[]).some(rule=>rule.id===ref.ruleId&&rule.owner===c.seat);
      if(c.mergedTriggers!==undefined)demand(object(c.mergedTriggers)&&Object.values(c.mergedTriggers).every(refs=>Array.isArray(refs)&&refs.length>0&&refs.every(validRef)));
      if(c.triggerTargets!==undefined)demand(object(c.triggerTargets)&&Object.entries(c.triggerTargets).every(([id,ref])=>Object.hasOwn(REGION_BY_ID,id)&&validRef(ref)));
      if(c.kind==='TRIGGER')for(const o of c.options)demand(windows.some(w=>w.id===o.windowId));
    }
  }
}
export function validateSession(value:unknown):SaveSession {
  demand(object(value)&&value.format==='quartermaster-save'&&value.version===1,'不是受支持的军需官存档。');
  demand(typeof value.updatedAt==='string');validateState(value.state);validateState(value.replayBase);
  demand(Array.isArray(value.rounds)&&Array.isArray(value.nations)&&value.nations.length<=6&&Array.isArray(value.undo)&&Array.isArray(value.commands));
  for(const list of [value.rounds,value.nations])for(const cp of list) {demand(object(cp)&&typeof cp.id==='string'&&typeof cp.createdAt==='string');validateState(cp.state);demand(cp.stage===undefined||cp.stage==='prelude');const prelude=cp.stage==='prelude';demand(cp.round===(prelude?cp.state.prelude?.round??Math.floor(((cp.state.prelude?.turn??1)-1)/6)+1:cp.state.round)&&cp.seat===cp.state.activeSeat&&cp.state.gameId===value.state.gameId&&Number(cp.round)>=1&&(!prelude||cp.state.prelude?.active));}
  demand(new Set(value.rounds.map(c=>`${c.stage??'formal'}:${c.round}`)).size===value.rounds.length&&value.rounds.every(c=>c.seat==='germany'));
  demand(new Set(value.nations.map(c=>c.seat)).size===value.nations.length);
  for(const state of value.undo){validateState(state);demand(state.gameId===value.state.gameId&&state.round===value.state.round&&state.activeSeat===value.state.activeSeat&&state.phase!=='SETUP','回退记录超出当前国家的行动范围。');}
  for(const command of value.commands)demand(object(command)&&typeof command.type==='string');
  if(value.recovery!==undefined){
    const r=value.recovery;demand(object(r)&&typeof r.fromCreation==='boolean'&&Array.isArray(r.steps));validateState(r.initial);
    demand(r.initial.gameId===value.state.gameId);
    for(const step of r.steps){demand(object(step));if(step.kind==='restore'){demand(typeof step.reason==='string');validateState(step.state);demand(step.state.gameId===value.state.gameId);}else demand(step.kind==='command'&&object(step.command)&&typeof step.command.type==='string');}
    demand(JSON.stringify(recoverRecord(r as unknown as RecoveryRecord))===JSON.stringify(value.state),'对局记录回放与当前局面不一致。');
  }
  const session=value as unknown as SaveSession;
  demand(verifyReplay(session),'存档命令回放与当前局面不一致。');return structuredClone(session);
}
export function verifyReplay(session:SaveSession) {
  try {let state=structuredClone(session.replayBase);for(const command of session.commands){const result=transition(state,command);if(!result.ok)return false;state=result.state;}return JSON.stringify(state)===JSON.stringify(session.state);}catch{return false;}
}


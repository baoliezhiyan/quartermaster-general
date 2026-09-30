import {fact} from './factObserver';
import {nextUnitId,replayBoundary} from './replayHooks';
import {airActionOptions,hasStandardPlay} from './phaseAvailability';
import {initializePrelude,finishPreludeTurn,takePreludeCard,preludeCardEffects} from './prelude';
import {neutralityDiscardPenalty,initializeNeutrality,checkNeutralitySupply,checkNeutralityTurn,checkNeutralityAttack,neutralityIndiaPenalty,mayReallocate} from './neutrality';
import {concealPublic,publicRecord} from './publicHistory';
import { startScenario } from './resolutionScenarios';
import { acknowledgeReveal, resolveChoice, runResolution, startResolution, canExecuteEffects } from './resolution';
import { cardEffects } from './specialCards';
import { specialCard } from './cardCatalog';
import { hasStatus, homeRegion } from './modifiers';
import { statusActionEffects } from './statusActions';
import type { Effect } from './resolutionTypes';
import { discardHandCards as discard, validHandSelection as validCards, payDiscardCost, forceDiscardHand, discardPhase, drawCards, discardDeckTop } from './decks';
import { placementPlans } from './placement';
import type { PlacementPlan } from './placement';
import { SEATS } from './types';
import type { Command, GameState, Phase, SeatId, Transition } from './types';
import { REGIONS, REGION_BY_ID } from './map';
import { COUNTRY_NAMES, allianceOf, canReallocateCard, cardName, makeDecks, phaseCountries, seatOf, shuffle } from './basic';
import { allianceScores, countryScore, unsuppliedForPhase } from './supply';
import { airDestinations, seatAirMoveOptions, cardOptions } from './actions';
import type { BasicOption } from './actions';

export const PHASE_NAMES: Record<Phase,string> = {
  PRELUDE:'序章', SETUP:'起手选择', TURN_START_WINDOW:'回合开始', PLAY:'出牌', AIR:'空军', SUPPLY:'补给', SCORE:'计分', DISCARD:'弃牌', DRAW:'摸牌',
};
export const TURN_PHASES: Phase[] = ['TURN_START_WINDOW','PLAY','AIR','SUPPLY','SCORE','DISCARD','DRAW'];
export function createGame(gameId: string, seed: number, mode:GameState['mode']='BASIC_DEBUG',prelude=false,neutrality?:boolean,balance?:boolean): GameState {
  const random = { randomState:seed };
  const decks = makeDecks(random,mode,balance,neutrality,false);
  const state:GameState = {
    resolutionVersion:3, schemaVersion:1, rulesVersion:'1.4.0', gameId, seed, revision:0,
    mode, resolutionResume:null, randomState:random.randomState, setupCompleted:[], redistributed:false,
    pendingAir:[], resolution:null, pendingDiscard:null, resumePhase:null, winner:null, victoryReason:null, axisBonus:0,
    status:'SETUP', round:0, phase:'SETUP', activeSeat:'germany', viewSeat:'germany', operatorSeat:'germany',
    settings:{ ignoreOtherPlayerInterrupts:mode==='BASIC_DEBUG' },
    scores:Object.fromEntries(SEATS.map(seat => [seat,0])) as Record<SeatId,number>, decks,
    units:[],
    events:[{ type:'GAME_CREATED', revision:0, gameId, seed }],
  };
  if(neutrality!==undefined||balance!==undefined)state.rules={preludeEnabled:prelude,neutralityEnabled:!!neutrality,...(balance!==undefined?{balanceEnabled:balance}:{})};
  fact(state,'recording_start','初始化前');
  for(const seat of SEATS){const d=state.decks[seat];shuffle(d.drawPile,state);d.hand=d.drawPile.splice(0,12);fact(state,'card_moved','发放十二张起手牌',{seat,from:'regular_deck',to:'regular_hand',cardIds:d.hand.map(c=>c.id)});}
  state.units=REGIONS.filter(r => r.initialArmyCountry).map(r => ({ id:`initial:${r.initialArmyCountry}`, country:r.initialArmyCountry!, type:'army', regionId:r.id }));fact(state,'unit_built','初始部署');
  if(neutrality)initializeNeutrality(state);
  if(neutrality)fact(state,'card_installed','初始化中立状态');
  if(prelude)initializePrelude(state);
  return state;
}
function log(state: GameState, code: string, text: string) {
  state.events.push({ type:'RULE_EVENT', revision:state.revision, code, text });
  fact(state,code,text);
}
function finish(state: GameState, reason: 'TWENTY_ROUNDS' | 'AXIS_LEAD' | 'ALLIES_LEAD') {
  state.status = 'FINISHED'; state.victoryReason = reason;
  if (reason === 'TWENTY_ROUNDS') state.axisBonus = .5;
  const total = allianceScores(state);
  state.winner = total.axis > total.allies ? 'axis' : 'allies';
  log(state,'GAME_FINISHED',`${state.winner === 'axis' ? '轴心国' : '同盟国'}获胜：${reason !== 'TWENTY_ROUNDS' ? '美国回合结束时领先至少 30 分' : '完成 20 轮，轴心国结算加 0.5 分'}。总分 ${total.axis} : ${total.allies}。`);
}
function applyPhase(state: GameState, phase: Phase) {
  state.phase = phase;
  log(state,'PHASE_ENTERED',`第 ${state.round} 轮 · ${COUNTRY_NAMES[state.activeSeat]} · ${PHASE_NAMES[phase]}阶段。`);
  if (phase === 'SUPPLY') {
    const removed = unsuppliedForPhase(state,state.activeSeat);
    const details = state.units.filter(u => removed.includes(u.id)).map(u => `${COUNTRY_NAMES[u.country]}（${REGION_BY_ID[u.regionId].name}）`);
    if(state.mode!=='BASIC_DEBUG'&&removed.length) {
      startResolution(state,'补给清除',state.activeSeat,state.units.filter(u=>removed.includes(u.id)).map(unit=>({kind:'remove',unit:{...unit},supplied:false,cause:'supply',label:`补给清除：${COUNTRY_NAMES[unit.country]} · ${REGION_BY_ID[unit.regionId].name}`})),[]);
    }else state.units = state.units.filter(u => !removed.includes(u.id));
    log(state,'SUPPLY_CLEARED',`${phaseCountries(state.activeSeat).map(c => COUNTRY_NAMES[c]).join('、')}统一补给检查：${removed.length ? `移除 ${details.join('、')}` : '全部部队有补给'}。`);
  }
  if (phase === 'SCORE') {
    const before=state.scoringStart??state.scores[state.activeSeat];
    for (const country of phaseCountries(state.activeSeat)) {
      const points = countryScore(state,country);
      state.scores[state.activeSeat] += points;
      log(state,'COUNTRY_SCORED',`${COUNTRY_NAMES[country]}计分 +${points}，计入${COUNTRY_NAMES[state.activeSeat]}分数。`);
    }
    if(state.resolutionVersion===3){publicRecord(state,state.activeSeat,`${COUNTRY_NAMES[state.activeSeat]}计分阶段获得 ${state.scores[state.activeSeat]-before} 分。`);delete state.scoringStart;}
  }
  if (phase === 'DRAW') {
    const deck = state.decks[state.activeSeat], count = Math.max(0,7-deck.hand.length);
    const drawn = drawCards(state,state.activeSeat,count);
    log(state,'CARDS_DRAWN',`${COUNTRY_NAMES[state.activeSeat]}摸 ${drawn} 张，手牌 ${deck.hand.length} 张${drawn < count ? '；牌库不足，停止摸牌，不扣分' : ''}。`);
    if(state.mode!=='BASIC_DEBUG')nextTurn(state);
    return;
  }
  if(phase==='SUPPLY'&&state.resolution?.running)state.resolutionResume={phase:'SCORE',apply:false};
  else autoAdvancePhase(state);
}
export function refreshSceneResolution(state:GameState) {
  checkNeutralitySupply(state);
  if(state.neutralityStatusPending&&!state.resolution?.running)startResolution(state,'中立规则参战结算',state.activeSeat,[{kind:'trace',label:'参战状态牌结算完成'}],[]);
  if(state.resolution?.running&&state.resolution.choice){state.resolution.choice=null;runResolution(state);settleResolution(state);}
}
function settleResolution(state:GameState) {
  if(state.prelude?.active){finishPreludeTurn(state);return;}
  if(state.resolution?.running)return;
  if(!state.resolutionResume){autoAdvancePhase(state);return;}
  const resume=state.resolutionResume; state.resolutionResume=null;
  if(state.mode!=='BASIC_DEBUG' && resume.apply && resume.phase==='TURN_START_WINDOW') {
    enterPhase(state,'PLAY');
    return;
  }
  if(resume.continuePlay){state.phase='PLAY';autoAdvancePhase(state);return;}
  if(resume.apply) applyPhase(state,resume.phase); else enterPhase(state,resume.phase);
}
/** Called only after phase-start windows and phase work have completed. */
function autoAdvancePhase(state:GameState){
 if(state.mode==='BASIC_DEBUG'||state.status!=='PLAYING'||state.resolution?.running||state.pendingDiscard||state.pendingAir.length)return;
 if(state.phase==='AIR'&&!airActionOptions(state).some(o=>o.enabled))enterPhase(state,'SUPPLY');
 else if(state.phase==='SUPPLY')enterPhase(state,'SCORE');
 else if(state.phase==='SCORE')enterPhase(state,'DISCARD');
 else if(state.phase==='PLAY'&&!hasStandardPlay(state)){
  if(state.basicPlaysRemaining!==1){state.scores[state.activeSeat]--;log(state,'PLAY_PHASE_POINT_LOSS',`${COUNTRY_NAMES[state.activeSeat]}没有可用的出牌行动，扣 1 分。`);}enterPhase(state,'AIR');
 }
}
function enterPhase(state:GameState,phase:Phase) {
  delete state.airAction;
  if(phase==='TURN_START_WINDOW')checkNeutralityTurn(state);
  if(phase==='SCORE'&&state.resolutionVersion===3){
    if(state.units.some(u=>u.type==='army'&&u.regionId===homeRegion(state,state.activeSeat)&&allianceOf(u.country)!==allianceOf(state.activeSeat))){
      publicRecord(state,state.activeSeat,`${COUNTRY_NAMES[state.activeSeat]}大本营被占领，跳过计分阶段。`);
      enterPhase(state,'DISCARD');return;
    }
    state.scoringStart=state.scores[state.activeSeat];
    if(state.activeSeat==='united_kingdom'){
      const penalty=neutralityIndiaPenalty(state);
      if(penalty){state.scores.united_kingdom-=penalty;publicRecord(state,'united_kingdom',`苏联中立期间，${penalty} 支苏联陆海军位于印度或相邻地区，英国扣 ${penalty} 分。`);}
    }
  }
  if(state.mode==='BASIC_DEBUG') {applyPhase(state,phase);return;}
  state.phase=phase; state.resolutionResume={phase,apply:true};
  startResolution(state,`阶段开始：${PHASE_NAMES[phase]}`,state.activeSeat,[{kind:'signal',tag:`PHASE:${phase}`,label:`${COUNTRY_NAMES[state.activeSeat]}${PHASE_NAMES[phase]}阶段开始`}],[]);
  settleResolution(state);
}
function resolveCard(state:GameState,cardId:string,effects:Effect[],guided=false,rollback?:GameState):boolean {
  const card=state.decks[state.activeSeat].hand.find(c=>c.id===cardId);
  if(!card || (!guided && !canExecuteEffects(state,effects)))return false;
  const d=specialCard(card.definitionId,card.balance);
  if(state.rules?.balanceEnabled&&state.phase==='PLAY'&&state.basicPlaysRemaining){if(d)return false;state.basicPlaysRemaining--;state.resolutionResume=state.basicPlaysRemaining?{phase:'PLAY',apply:false,continuePlay:true}:{phase:'AIR',apply:false};}
  else state.resolutionResume={phase:state.phase==='PLAY'?'AIR':'SUPPLY',apply:false};
  const standard:Effect[] = state.phase==='PLAY'&&card.definitionId!=='air_power'&&d?.type!=='增强'?[{kind:'signal',tag:'STANDARD_CARD_PLAYED',label:`标准出牌【${cardName(card)}】后`}]:[];
  if(!startResolution(state,d?.name??cardName(card),state.activeSeat,[...effects,...standard,{kind:'signal',tag:'CARD_PLAYED',label:`打出【${cardName(card)}】后`}],[],card.id,d?.type==='状态'?'active':d?.type==='响应'?'faceDown':'discardPile',guided,rollback))return false;
  settleResolution(state);return true;
}
function nextTurn(state: GameState,skipReplayBoundary=false) {
  if(state.prelude&&state.activeSeat==='italy'&&state.round===1){const d=state.decks.united_kingdom;const expired=d.active.filter(c=>c.definitionId==='prelude_UK-17');d.active=d.active.filter(c=>c.definitionId!=='prelude_UK-17');d.removed.push(...expired);}
  const index = SEATS.indexOf(state.activeSeat);
  if(index===5){const totals=allianceScores(state);if(Math.abs(totals.axis-totals.allies)>=30){finish(state,totals.axis>totals.allies?'AXIS_LEAD':'ALLIES_LEAD');replayBoundary(state,'round_end',state.round);return;}}
  if (index === 5 && state.round === 20) { finish(state,'TWENTY_ROUNDS'); replayBoundary(state,'round_end',state.round);return; }
  if(index===5&&!skipReplayBoundary&&replayBoundary(state,'round_end',state.round))return;
  if (index === 5) state.round++;
  state.activeSeat = SEATS[(index+1)%6];
  state.operatorSeat = state.viewSeat = state.activeSeat;
  state.redistributed = false;
  delete state.basicPlaysRemaining;
  state.turnFlags=undefined;
  enterPhase(state,'TURN_START_WINDOW');
}
/** Resume only the stable boundary emitted by replayBoundary; no UI command. */
export function resumeReplayBoundary(state:GameState,boundary:'formal_start'|'round_end') {
 if(state.status==='FINISHED')return;
 if(boundary==='formal_start')enterPhase(state,'TURN_START_WINDOW');
  else nextTurn(state,true);
 checkNeutralitySupply(state);
}
function removeUnit(state: GameState, id: string) {
  const unit = state.units.find(u => u.id === id);
  if (!unit) return;
  state.units = state.units.filter(u => u.id !== id);
  if (unit.type !== 'air' && !state.units.some(u => u.country === unit.country && u.type !== 'air' && u.regionId === unit.regionId)) {
    state.pendingAir.push(...state.units.filter(u => u.type === 'air' && u.country === unit.country && u.regionId === unit.regionId).map(u => u.id));
  }
}
function prepareAirChoice(state: GameState) {
  while (state.pendingAir.length) {
    const id = state.pendingAir[0], air = state.units.find(u => u.id === id);
    if (!air) { state.pendingAir.shift(); continue; }
    if (airDestinations(state,id).length) {
      state.viewSeat = state.operatorSeat = seatOf(air.country);
      return;
    }
    removeUnit(state,id); state.pendingAir.shift();
    log(state,'AIR_REMOVED','空军无合法强制调度目的地，移回储备。');
  }
  state.viewSeat = state.operatorSeat = state.activeSeat;
}
function applyOption(state: GameState, option: BasicOption, country = state.activeSeat as import('./types').CountryId) {
  if(option.mode==='battle'||option.mode==='supremacy')checkNeutralityAttack(state,country,state.units.find(u=>u.id===option.defenderId)?.country);
  if (option.mode === 'build' || option.mode === 'deploy') {
    if (option.mode === 'build') { applyPlacement(state, option as PlacementPlan); return; }
    if (option.recycleId) removeUnit(state,option.recycleId);
    const type = option.mode === 'deploy' ? 'air' : option.unitType!;
    if (!state.units.some(u => u.country === country && u.type === type && u.regionId === option.regionId)) {
      state.units.push({ id:nextUnitId(state), country, type, regionId:option.regionId });
    }
  } else if (option.mode === 'move') {
    state.units.find(u => u.id === option.airId)!.regionId = option.regionId;
  } else if (option.mode === 'supremacy') {
    removeUnit(state,option.defenderId!);
  } else if (option.mode === 'battle' && option.defenderId) {
    const defender = state.units.find(u => u.id === option.defenderId)!;
    const defense = state.units.find(u => u.type === 'air' && u.country === defender.country && u.regionId === defender.regionId);
    if (defense) {
      removeUnit(state,defense.id);
      if (!option.intercept) { log(state,'AIR_DEFENDED','防御方空军被移除，成功保住被攻击部队。'); return; }
      const attacker = state.units.find(u => u.id === option.attackerId)!;
      const interception = state.units.find(u => u.type === 'air' && u.country === country && u.regionId === attacker.regionId)!;
      removeUnit(state,interception.id);
      log(state,'AIR_INTERCEPTED','移除双方空军，攻击继续。');
    }
    removeUnit(state,defender.id);
  }
}

function applyPlacement(state: GameState, plan: PlacementPlan) {
  if (plan.recycleId) removeUnit(state,plan.recycleId);
  const unitId = plan.existingId ?? nextUnitId(state);
  if (!plan.existingId) state.units.push({ id:unitId, country:plan.country, type:plan.unitType, regionId:plan.regionId });
  state.events.push({ type:'UNIT_PLACED', revision:state.revision, mode:plan.mode, country:plan.country, unitId, regionId:plan.regionId, repeated:!!plan.existingId });
  log(state,plan.mode === 'build' ? 'UNIT_BUILT' : 'UNIT_RECRUITED',`${COUNTRY_NAMES[plan.country]}${plan.mode === 'build' ? '建设' : '征召'}：${plan.label}。`);
}

/** Validates an entire command before committing a cloned state. UI never writes rules. */
export function transition(state: GameState | null, command: Command): Transition {
  const result=transitionInternal(state,command);
  if(result.ok&&result.state!==state&&!['SET_VIEW','ACK_RESPONSE_NOTICE','SET_CARD_RESPONSE'].includes(command.type))checkNeutralitySupply(result.state);
  if(result.ok&&result.state.neutralityStatusPending&&!result.state.resolution?.running)startResolution(result.state,'中立规则参战结算',result.state.activeSeat,[{kind:'trace',label:'参战状态牌结算完成'}],[]);
  if(result.ok&&result.state!==state){const s=result.state;concealPublic(s,Object.values(s.decks).flatMap(d=>[...d.hand,...d.drawPile,...d.faceDown.filter(c=>!s.faceUpResponseIds?.includes(c.id)),...d.removed]).map(c=>c.id));}
  return result;
}
function transitionInternal(state: GameState | null, command: Command): Transition {
  if (!command || !['SELECT_AIR_ACTION','ARMAMENT_WINDOW','DISCARD_PRELUDE_TOP','PLAY_PRELUDE','SET_CARD_RESPONSE','ACK_RESPONSE_NOTICE','CREATE_GAME','SET_VIEW','SET_INTERRUPTS','KEEP_OPENING','ADVANCE_PHASE','DISCARD_HAND','REDISTRIBUTE','PLAY_BASIC','MOVE_AIR','RELOCATE_AIR','RESOLVE_FORCED_DISCARD','DEBUG_DECK','DEBUG_PLACEMENT','START_RESOLUTION_SCENARIO','RESOLVE_ENGINE_CHOICE','PLAY_CARD','STATUS_ACTION'].includes(command.type)) return { ok:false,error:'INVALID_COMMAND' };
  if (command.type === 'CREATE_GAME') {
    if (typeof command.gameId !== 'string' || !command.gameId.trim() || !Number.isSafeInteger(command.seed) || command.seed < 0 || command.seed > 0xffffffff) return { ok:false,error:'INVALID_COMMAND' };
    if(command.mode && !['BASIC_DEBUG','REPRESENTATIVE','FULL'].includes(command.mode)) return {ok:false,error:'INVALID_COMMAND'};
    if(command.balance!==undefined&&typeof command.balance!=='boolean'||command.prelude!==undefined&&typeof command.prelude!=='boolean'||command.neutrality!==undefined&&typeof command.neutrality!=='boolean')return {ok:false,error:'INVALID_COMMAND'};
    return { ok:true,state:createGame(command.gameId,command.seed,command.mode,command.prelude,command.neutrality,command.balance) };
  }
  if (!state) return { ok:false,error:'GAME_NOT_CREATED' };
  if (!SEATS.includes(command.seat)) return { ok:false,error:'INVALID_COMMAND' };
  if (command.expectedRevision !== state.revision) return { ok:false,error:'STALE_REVISION' };
  if (command.type === 'SET_CARD_RESPONSE') {
    const card=Object.values(state.decks[command.seat]).flat().find(c=>c.id===command.cardId);
    if(command.seat!==state.viewSeat||typeof command.enabled!=='boolean'||!card||!['响应','增强','军备'].includes(specialCard(card.definitionId,card.balance)?.type??''))return {ok:false,error:'ILLEGAL_ACTION'};
    const next=structuredClone(state);
    next.disabledResponseIds=[...new Set([...(next.disabledResponseIds??[]).filter(id=>id!==card.id),...(!command.enabled?[card.id]:[])])];
    if(!command.enabled&&next.resolution?.choice?.kind==='TRIGGER') {
      next.resolution.choice=null;next.revision++;runResolution(next);settleResolution(next);
    }
    return {ok:true,state:next};
  }
  if (command.type === 'ACK_RESPONSE_NOTICE') {
    const notice=state.responseNotices?.find(n=>n.id===command.noticeId);
    if(command.seat!==state.viewSeat||!notice?.recipients.includes(command.seat))return {ok:false,error:'ILLEGAL_ACTION'};
    if(notice.readBy.includes(command.seat))return {ok:true,state};
    const next=structuredClone(state);
    next.responseNotices!.find(n=>n.id===command.noticeId)!.readBy.push(command.seat);
    if(next.resolution?.revealGroup){next.revision++;acknowledgeReveal(next,command.noticeId,command.seat);settleResolution(next);}
    return {ok:true,state:next};
  }
  if (command.type === 'SET_VIEW') {
    if (command.seat === state.viewSeat) return { ok:true,state };
    return { ok:true,state:{ ...state, revision:state.revision+1, viewSeat:command.seat, operatorSeat:command.seat,
      events:[...state.events,{ type:'VIEW_CHANGED',revision:state.revision+1,seat:command.seat }] } };
  }
  if(command.type==='SET_INTERRUPTS') {
    if(state.resolution?.running || typeof command.enabled!=='boolean')return {ok:false,error:'ILLEGAL_ACTION'};
    return {ok:true,state:{...state,revision:state.revision+1,settings:{ignoreOtherPlayerInterrupts:!command.enabled}}};
  }
  if (state.status === 'FINISHED') return { ok:false,error:'ILLEGAL_ACTION' };
  if (command.seat !== state.operatorSeat) return { ok:false,error:'WRONG_OPERATOR' };
  const next = structuredClone(state); next.revision++;
  const illegal: Transition = { ok:false,error:'ILLEGAL_ACTION' };
  if(state.prelude?.active&&!state.resolution?.running){
    if(command.seat!==state.activeSeat||state.prelude.played)return illegal;
    const p=next.prelude!,d=p.decks[command.seat];
    if(command.type==='DISCARD_PRELUDE_TOP'){
      if(!d.drawPile.length)return illegal;d.discardPile.push(...d.drawPile.splice(0,1));p.discarded++;if(!d.drawPile.length&&(next.rules?.balanceEnabled||!d.hand.length)){publicRecord(next,command.seat,`${COUNTRY_NAMES[command.seat]}序章出牌前弃置 ${p.discarded} 张序章牌库顶牌，已无牌，跳过。`);p.played=true;finishPreludeTurn(next);}return {ok:true,state:next};
    }
    if(command.type==='PLAY_PRELUDE'){
      if(next.rules?.balanceEnabled&&p.discarded>0&&d.drawPile[0]?.id!==command.cardId)return illegal;
      if(!d.hand.some(c=>c.id===command.cardId)&&d.drawPile[0]?.id!==command.cardId)return illegal;
      if(p.discarded)publicRecord(next,command.seat,`${COUNTRY_NAMES[command.seat]}序章出牌前弃置 ${p.discarded} 张序章牌库顶牌。`);
      const card=takePreludeCard(next,command.seat,command.cardId)!;p.played=true;
      const v=preludeCardEffects(next,card);startResolution(next,cardName(card),command.seat,v.effects,[],card.id,v.zone);
      finishPreludeTurn(next);return {ok:true,state:next};
    }
    return illegal;
  }
  if (command.type === 'KEEP_OPENING') {
    if (state.phase !== 'SETUP' || state.setupCompleted.includes(command.seat) || !validCards(state,command.seat,command.cardIds) || command.cardIds.length !== Math.min(7,state.decks[command.seat].hand.length)) return illegal;
    discard(next,command.seat,next.decks[command.seat].hand.filter(c => !command.cardIds.includes(c.id)).map(c => c.id));
    next.setupCompleted.push(command.seat);
    log(next,'OPENING_KEPT',`${COUNTRY_NAMES[command.seat]}保留 ${command.cardIds.length} 张、弃置 ${state.decks[command.seat].hand.length-command.cardIds.length} 张；起手不扣分。`);
    const waiting = SEATS.find(seat => !next.setupCompleted.includes(seat));
    if (waiting) next.operatorSeat = next.viewSeat = waiting;
    else {
      next.status = 'PLAYING'; next.round = 1; next.operatorSeat = next.viewSeat = 'germany';
      if(replayBoundary(next,'formal_start',0))return {ok:true,state:next};
      enterPhase(next,'TURN_START_WINDOW');
    }
    return { ok:true,state:next };
  }
  if (state.status !== 'PLAYING') return illegal;
  if (state.resolution?.running) {
    if (command.type !== 'RESOLVE_ENGINE_CHOICE' || !resolveChoice(next,command.seat,command.choiceId,command.ids,command.guided)) return illegal;
    settleResolution(next);
    return { ok:true,state:next };
  }
  if (state.pendingDiscard) {
    const choice = state.pendingDiscard;
    if (command.type !== 'RESOLVE_FORCED_DISCARD' || command.seat !== choice.seat || !forceDiscardHand(next,choice.seat,choice.count,command.cardIds)) return illegal;
    next.pendingDiscard = null; next.viewSeat = next.operatorSeat = choice.returnSeat;
    log(next,'HAND_FORCED_DISCARDED',`${COUNTRY_NAMES[choice.seat]}被迫弃置 ${command.cardIds.length} 张，缺额不扣分。`);
    return { ok:true,state:next };
  }
  if (state.pendingAir.length) {
    const air = state.units.find(u => u.id === state.pendingAir[0])!;
    if (command.type !== 'RELOCATE_AIR' || command.seat !== seatOf(air.country) || !airDestinations(state,air.id).includes(command.regionId)) return illegal;
    next.units.find(u => u.id === air.id)!.regionId = command.regionId;
    next.pendingAir.shift();
    log(next,'AIR_RELOCATED',`${COUNTRY_NAMES[air.country]}空军免费调度至${REGION_BY_ID[command.regionId].name}。`);
    prepareAirChoice(next);
    if (!next.pendingAir.length && next.resumePhase) {
      const phase = next.resumePhase; next.resumePhase = null; enterPhase(next,phase);
    }
    return { ok:true,state:next };
  }
  if (command.seat !== state.activeSeat) return { ok:false,error:'WRONG_OPERATOR' };
  switch (command.type) {
    case 'SELECT_AIR_ACTION': {
      if(state.phase!=='AIR'||state.mode==='BASIC_DEBUG'||command.action!==null&&!airActionOptions(state).some(o=>o.id===command.action&&o.enabled))return illegal;
      if(command.action===null)delete next.airAction;else next.airAction=command.action;
      break;
    }
    case 'ARMAMENT_WINDOW': {
      if(!next.prelude||next.prelude.active)return illegal;
      startResolution(next,'本国回合军备',command.seat,[{kind:'signal',tag:'ARMAMENT_ANYTIME',label:'本国回合军备窗口'}],[]);settleResolution(next);break;
    }
    case 'STATUS_ACTION': {
      if(state.mode==='BASIC_DEBUG'||!['PLAY','AIR'].includes(state.phase))return illegal;
      const card=state.decks[command.seat].active.find(c=>c.id===command.cardId);
      if(!card)return illegal;
      const effects=statusActionEffects(state,card);
      if(!canExecuteEffects(state,effects))return illegal;
      next.resolutionResume={phase:state.phase==='AIR'?'SUPPLY':'AIR',apply:false};
      if(!startResolution(next,`代替出牌：${cardName(card)}`,command.seat,effects,[],card.id,'active',command.guided,command.guided?structuredClone(state):undefined))return illegal;
      settleResolution(next);break;
    }
    case 'PLAY_CARD': {
      if(state.mode==='BASIC_DEBUG' || !['PLAY','AIR'].includes(state.phase)) return illegal;
      const card=state.decks[command.seat].hand.find(c=>c.id===command.cardId);
      if(!card || state.phase==='AIR' && card.definitionId!=='air_power' || state.phase==='PLAY' && card.definitionId==='air_power')return illegal;
      if(!Array.isArray(command.targetIds) || new Set(command.targetIds).size!==command.targetIds.length)return illegal;
      const effects=cardEffects(state,card,command.targetIds).map(e=>e.kind==='action'&&e.action==='air_power'&&state.airAction&&state.airAction!=='move'?{...e,airMode:state.airAction}:e);
      if(state.phase==='AIR'&&state.airAction==='move')return illegal;
      const ids=command.effectIndices;
      if(!Array.isArray(ids) || !ids.length || new Set(ids).size!==ids.length || ids.some(i=>!Number.isInteger(i) || i<0 || i>=effects.length))return illegal;
      if(!resolveCard(next,card.id,effects.filter((e,i)=>e.fee || ids.includes(i)),command.guided,command.guided?structuredClone(state):undefined))return illegal;
      break;
    }
    case 'START_RESOLUTION_SCENARIO': {
      if (state.mode !== 'BASIC_DEBUG' || !startScenario(next,command.scenarioId)) return illegal;
      break;
    }
    case 'DEBUG_DECK': {
      if (state.mode !== 'BASIC_DEBUG' || !SEATS.includes(command.target) || !Number.isSafeInteger(command.count) || command.count < 0 || command.count > 100) return illegal;
      const { target, count } = command;
      if (command.operation === 'pay') {
        if (target !== command.seat || !payDiscardCost(next,target,count,command.cardIds)) return illegal;
        log(next,'DISCARD_COST_PAID',`规则试验：${COUNTRY_NAMES[target]}完整支付 ${count} 张手牌。`);
      } else if (command.operation === 'force') {
        const actual = Math.min(count,next.decks[target].hand.length);
        if (actual && actual < next.decks[target].hand.length) {
          next.pendingDiscard = { seat:target,count,returnSeat:state.operatorSeat };
          next.operatorSeat = next.viewSeat = target;
          log(next,'FORCED_DISCARD_REQUESTED',`规则试验：请${COUNTRY_NAMES[target]}选择 ${actual} 张手牌强制弃置。`);
        } else {
          forceDiscardHand(next,target,count,next.decks[target].hand.slice(0,actual).map(c=>c.id));
          log(next,'HAND_FORCED_DISCARDED',`规则试验：${COUNTRY_NAMES[target]}被迫弃 ${actual}/${count} 张，缺额不扣分。`);
        }
      } else if (command.operation === 'top') {
        const result = discardDeckTop(next,target,count);
        log(next,'DECK_TOP_RESULT',`规则试验：${COUNTRY_NAMES[target]}弃牌库顶 ${result.discarded} 张，缺额扣 ${result.lost} 分。`);
      } else if (command.operation === 'draw') {
        const actual = drawCards(next,target,count);
        log(next,'CARDS_DRAWN',`规则试验：${COUNTRY_NAMES[target]}摸 ${actual}/${count} 张，缺额不扣分。`);
      } else return illegal;
      break;
    }
    case 'DEBUG_PLACEMENT': {
      if (state.mode !== 'BASIC_DEBUG' || !Object.hasOwn(COUNTRY_NAMES,command.country) || !['army','navy'].includes(command.unitType) || !['build','recruit'].includes(command.mode) || !REGION_BY_ID[command.regionId]) return illegal;
      const plan = placementPlans(state,{ country:command.country,unitType:command.unitType,mode:command.mode,regionIds:[command.regionId] }).find(p=>p.id === command.optionId);
      if (!plan || !payDiscardCost(next,command.seat,command.cost,command.cardIds)) return illegal;
      applyPlacement(next,plan);
      log(next,'PLACEMENT_COST_PAID',`规则试验：行动席位支付 ${command.cost} 张，兵模使用${COUNTRY_NAMES[command.country]}储备。`);
      prepareAirChoice(next);
      break;
    }
    case 'REDISTRIBUTE': {
      if(!mayReallocate(state,command.seat))return illegal;
      if (state.phase !== 'TURN_START_WINDOW' || state.redistributed || !validCards(state,command.seat,command.cardIds) || command.cardIds.length !== Math.min(3,state.decks[command.seat].hand.length)) return illegal;
      const deck = next.decks[command.seat], card = deck.drawPile.find(c => c.id === command.takeCardId);
      if (!card || !canReallocateCard(card)) return illegal;
      if (!payDiscardCost(next,command.seat,3,command.cardIds)) return illegal;
      if (!deck.drawPile.some(c=>c.id===card.id)) return illegal;
      deck.drawPile = deck.drawPile.filter(c => c.id !== card.id); deck.hand.push(card); shuffle(deck.drawPile,next);
      next.redistributed = true;
      log(next,'RESOURCES_REDISTRIBUTED',`${COUNTRY_NAMES[command.seat]}支付 3 张弃牌费用，取得【${cardName(card)}】并洗牌。`);
      break;
    }
    case 'ADVANCE_PHASE': {
      if (state.phase === 'DISCARD' || state.phase === 'SETUP') return illegal;
      if (state.phase === 'PLAY') {
        next.scores[command.seat]--;
        log(next,'PLAY_PHASE_POINT_LOSS',`${COUNTRY_NAMES[command.seat]}出牌阶段不出牌，扣 1 分。`);
      }
      if (state.phase === 'DRAW') nextTurn(next);
      else enterPhase(next,TURN_PHASES[TURN_PHASES.indexOf(state.phase)+1]);
      break;
    }
    case 'DISCARD_HAND': {
      if (state.phase !== 'DISCARD' || !validCards(state,command.seat,command.cardIds)) return illegal;
      const attrition=command.cardIds.filter(id=>state.decks[command.seat].hand.some(c=>c.id===id&&c.definitionId==='build_army')).length;
      const neutralPenalty=!command.cardIds.length&&neutralityDiscardPenalty(next,command.seat);
      discardPhase(next,command.seat,command.cardIds);
      if(next.resolutionVersion===3)publicRecord(next,command.seat,`${COUNTRY_NAMES[command.seat]}弃牌阶段弃置 ${command.cardIds.length} 张牌${neutralPenalty?'（中立期间不弃牌，扣1分）':''}。`);
      if(!state.rules?.balanceEnabled&&hasStatus(state,49)&&command.seat==='soviet_union'){if(attrition)publicRecord(next,'soviet_union','苏联发动状态【消耗战】，获得 '+attrition+' 分。');next.scores.soviet_union+=attrition;log(next,'ATTRITION_SCORED',`消耗战：弃牌阶段弃置建设陆军，获得 ${attrition} 分。`);}
      log(next,'HAND_DISCARDED',`${COUNTRY_NAMES[command.seat]}弃置 ${command.cardIds.length} 张手牌。`);
      enterPhase(next,'DRAW');
      break;
    }
    case 'PLAY_BASIC': case 'MOVE_AIR': {
      const card = state.decks[command.seat].hand.find(c => c.id === command.cardId);
      if (!card || command.type === 'MOVE_AIR' && (state.phase !== 'AIR'||state.airAction&&state.airAction!=='move')) return illegal;
      const options = command.type === 'PLAY_BASIC' ? cardOptions(state,card.id) : seatAirMoveOptions(state,command.seat);
      const option = options.find(o => o.id === command.optionId);
      if (!option) return illegal;
      if(state.mode!=='BASIC_DEBUG') {
        if(command.type==='MOVE_AIR') {
          if(!payDiscardCost(next,command.seat,1,[card.id]))return illegal;
          next.resolutionResume={phase:'SUPPLY',apply:false};
          startResolution(next,'主动空军调度',command.seat,[{kind:'action',action:'air_move',country:state.units.find(u=>u.id===option.airId)!.country,option,label:'主动空军调度'}],[]);settleResolution(next);
        } else {
          let effect=cardEffects(state,card)[0];
          if(state.phase==='AIR'&&state.airAction){if(state.airAction==='move'||option.mode!==state.airAction)return illegal;if(effect?.kind==='action')effect={...effect,airMode:state.airAction};}
          if(!effect || effect.kind!=='action' || !resolveCard(next,card.id,[{...effect,option}]))return illegal;
        }
        break;
      }
      if (command.type === 'MOVE_AIR') { if (!payDiscardCost(next,command.seat,1,[card.id])) return illegal; }
      else discard(next,command.seat,[card.id]);
      applyOption(next,option,card.country);
      log(next,command.type === 'PLAY_BASIC' ? 'BASIC_CARD_PLAYED' : 'AIR_MOVED',`${COUNTRY_NAMES[command.seat]}${command.type === 'PLAY_BASIC' ? '打出' : '弃置'}【${cardName(card)}】：${option.label}。`);
      // Complete relocation choices before applying the following phase's rules.
      prepareAirChoice(next);
      if (next.pendingAir.length) {
        next.resumePhase = state.phase === 'PLAY' ? 'AIR' : 'SUPPLY';
      } else enterPhase(next,state.phase === 'PLAY' ? 'AIR' : 'SUPPLY');
      break;
    }
    default: return illegal;
  }
  return { ok:true,state:next };
}

import {airDestinations,cardOptions} from '../core/actions';
import {boardOptions} from '../core/boardEffects';
import {extraEffects} from '../core/extraCards';
import {observeFacts} from '../core/factObserver';
import {BASIC_COUNTS,BASIC_NAMES,COUNTRY_NAMES,allianceOf,reserve,seatOf} from '../core/basic';
import {regularCatalog,specialCard} from '../core/cardCatalog';
import {canExecuteEffects,canPayEffectFees} from '../core/resolution';
import {statusActionEffects} from '../core/statusActions';
import {coversCost} from '../core/cardCosts';
import {barbarossaTargets,cardEffects} from '../core/specialCards';
import {createGame,transition} from '../core/game';
import {MAP} from '../core/map';
import {homeRegion,supplySource} from '../core/modifiers';
import {adjacent,allianceScores,suppliedUnits} from '../core/supply';
import {TRAINING_COURSE_VERSION,TRAINING_EVENT_IDS,TRAINING_EVENT_IDS_BY_SEAT,
  TRAINING_OVERRIDES_VERSION,TRAINING_A2S1_COURSE_VERSION,TRAINING_A2S1_OVERRIDES_VERSION,
  TRAINING_A2S1_IDS_BY_SEAT,TRAINING_A2S1_IDS,TRAINING_SIGNAL_IDS_BY_SEAT,
  basicOpenProbability,openSpecialCount} from '../core/trainingCourse';
import {SEATS,type CardInstance,type Command,type CountryId,type GameState,type SeatId,type Unit} from '../core/types';
import type {Effect,ChoiceRequest} from '../core/resolutionTypes';
import {BASIC_ACTIONS,type BasicAction,type DecisionContext,type TraceLevel} from './basicArena';

export const PPO_ARENA_FORMAT='quartermaster-ppo-arena-v2';
export const PPO_OBSERVATION_SCHEMA_VERSION='ppo-observation-v6-effective-straits';
export const PPO_ACTION_SCHEMA_VERSION='ppo-actions-v5-action-ledger';
export const PPO_STATIC_SCHEMA={observationSchemaVersion:PPO_OBSERVATION_SCHEMA_VERSION,
  actionSchemaVersion:PPO_ACTION_SCHEMA_VERSION,
  courseVersion:TRAINING_COURSE_VERSION,overridesVersion:TRAINING_OVERRIDES_VERSION,
  regions:MAP.regions,baseEdges:MAP.baseEdges,
  straits:MAP.straits,seats:SEATS,countries:Object.keys(COUNTRY_NAMES),
  basicActions:BASIC_ACTIONS,eventIds:Object.values(TRAINING_EVENT_IDS_BY_SEAT).flat(),
  bindingKeys:['built-navy','new-china','xiangxi-battle'],maxEffectTokens:32};
/** Historical A2S1 observations remain identifiable by their schema version. */
export const PPO_A2S1_STATIC_SCHEMA={...PPO_STATIC_SCHEMA,
  observationSchemaVersion:'ppo-observation-a2s1-v2',actionSchemaVersion:'ppo-actions-a2s1-v2',
  courseVersion:TRAINING_A2S1_COURSE_VERSION,overridesVersion:TRAINING_A2S1_OVERRIDES_VERSION,
  eventIds:[...Object.values(TRAINING_EVENT_IDS_BY_SEAT).flat(),
    ...Object.values(TRAINING_SIGNAL_IDS_BY_SEAT).flat()],maxEffectTokens:32,maxActionSlots:12,
  cardTypes:Object.fromEntries([...TRAINING_A2S1_IDS].map(id=>[id,
    specialCard(id,true)?.type??'未知']))};
export type CourseMode='A'|'B';
export type CardSet='basics'|'events'|'signals';
export type PpoArenaOptions={mode:CourseMode;buildFingerprint:string;trace?:TraceLevel;cardSet?:CardSet;captureReplay?:boolean};
export type UnitFact={country:CountryId;type:Unit['type'];regionId:string};
export type EffectFeature={kind:string;action?:string;country?:CountryId;seat?:SeatId;
  fee:boolean;optional:boolean;min?:number;max?:number;count?:number;amount?:number;
  regions:string[];targetIds:string[];targetFacts:UnitFact[];bindAs?:string;fromBinding?:string;
  selectedIds?:string[];selectedFacts?:UnitFact[];selectionRegion?:string;
  precommitTargets?:boolean;
  filter?:string;from?:string;to?:string;tag?:string;newOnly?:boolean;
  children:EffectFeature[][]};
export type PpoCandidate={id:string;kind:'source'|'pass'|'choice'|'targets';label:string;
  cardId?:string;definitionId?:string;cardType?:string;optionId?:string;statusAction?:boolean;
  randomDiscardCount?:number;
  choiceIds?:string[];targetIds?:string[];effects?:EffectFeature[];
  choices?:ChoiceFeature[]};
export type ChoiceFeature={kind:string;action?:string;nextAction?:string;country?:CountryId;
  regionId?:string;unitType?:Unit['type'];source?:UnitFact;target?:UnitFact;
  definitionId?:string;repeated?:boolean;intercept?:boolean;effects?:EffectFeature[]};
export type PpoObservation={decision:DecisionContext;mode:CourseMode;cardSet:CardSet;courseVersion:string;
  node:'SOURCE'|'TARGETS'|'ENGINE_CHOICE'|'AIR_RELOCATE';round:number;phase:GameState['phase'];
  activeSeat:SeatId;decisionSeat:SeatId;sourceSeat:SeatId;unitCountry:CountryId|null;
  scores:GameState['scores'];allianceScores:ReturnType<typeof allianceScores>;
  units:Unit[];suppliedUnitIds:string[];
  /** Historical, engine-derived adjacency for each acting country; never recompute from a later state. */
  effectiveStraits:Record<CountryId,boolean[]>;
  reserves:Record<CountryId,Record<Unit['type'],number>>;
  ownResources:{remaining:Record<string,number>;open:Record<string,number>;discard:Record<string,number>};
  publicResources:Record<SeatId,{remainingTotal:number;discardTotal:number}>;
  visibleCards?:{active:Record<SeatId,string[]>;ownFaceDown:string[];
    otherFaceDownCount:Record<SeatId,number>};
  effectiveHomes?:Record<CountryId,string>;
  effectiveSupply?:Record<CountryId,boolean[]>;
  originAction?:{action:string;country:CountryId;regionId?:string;sourceRegionId?:string};
  currentSourceDefinition?:string|null;
  visibleUseCounts?:Record<string,number>;
  visibleRoundUseCounts?:Record<string,number>;
  activeEffects:EffectFeature[];currentEffectIndex:number;selectedTargets:string[];
  selectedTargetFacts:UnitFact[];bindingFacts:Record<string,UnitFact[]>;
  priorResults:{applied:boolean;cancelled:boolean;action?:string;regionId?:string}[];
  choiceKind?:ChoiceRequest['kind'];choiceField?:ChoiceRequest['field'];
  choiceMin?:number;choiceMax?:number;canSkip?:boolean;
  candidates:PpoCandidate[]};
export type PpoSubmission=DecisionContext&{actionId:string};
export type PpoEnd={termination:'natural'|'truncated';reason?:string;winner:GameState['winner'];
  round:number;decisions:number;scores:GameState['scores'];allianceScores:ReturnType<typeof allianceScores>;
  finalObservation?:PpoObservation};
export type PpoStepInfo={decision:DecisionContext;nextDecision:DecisionContext|null;
  scoreDelta:{axis:number;allies:number;bySeat:GameState['scores']};turnsAdvanced:number;
  submittedCardDefinitions:string[];resolvedCardDefinitions:string[];cancelledCardDefinitions:string[];
  wasteCheck?:{seat:SeatId;definitionId:string;regionId:string;repeated:boolean;
    penalty:boolean;reason:string};
  wasteOpportunity?:{candidateCount:number;chosen:boolean};
  rewardAdjustments?:{decisionId:number;seat:SeatId;cardId:string;reason:string;
    penalty:number;beforeCap:number;afterCap:number;effects:string[];exemption?:string}[];
  feeCardsSpent?:number;triggerDepth?:number;
  wasteAssessments?:{decisionId:number;seat:SeatId;cardId:string;reason:string;
    actualEffects:string[];newUnitIds:string[];alternative:boolean;penalized:boolean}[];
  termination:'ongoing'|'natural'|'truncated';winner:GameState['winner']};
export type PpoSnapshot={format:typeof PPO_ARENA_FORMAT;header:PpoTrainingArena['header'];state:GameState;
  decisionCount:number;pendingCardId:string|null;terminationReason:string|null;
  finalObservation:PpoObservation|null;knownUnits:Record<string,UnitFact>;
  pendingSubmissions:Record<string,string>;actionLedgers:Record<string,ActionLedger>;
  resolutionEventOutcomes:Record<string,string>;
  pendingTriggers:PendingTrigger[];triggerLedgers:Record<string,TriggerLedger>;
  pendingTargetChecks:PendingTargetCheck[];penalizedEffectFrames:string[]};

type ActionLedger={cardId:string;definitionId:string;seat:SeatId;originDecisionId:number;
  alternative:boolean;supported:boolean;positive:string[];newUnitIds:string[];
  usedUnitIds:string[];penalized:boolean;extraCard:boolean;supplyEligible:boolean;
  supplyCandidates:string[]};
type PendingTrigger={ruleId:string;label:string;cardId:string;seat:SeatId;decisionId:number;
  definitionId:string;supported:boolean};
type TriggerLedger=PendingTrigger&{frameId:string;positive:string[];penalized:boolean};
type PendingTargetCheck={decisionId:number;seat:SeatId;cardId:string;frameId?:string;
  effectIndex:number;action:string;regionId:string;relatedAttempt?:boolean};

type Benefit='yes'|'no'|'unknown';
const combineBenefits=(items:Benefit[]):Benefit=>items.includes('yes')?'yes':
  items.includes('unknown')?'unknown':'no';
/** Only facts guaranteed by the current, visible position count as an alternative. */
function effectBenefit(s:GameState,e:Effect):Benefit {
  if(e.fee)return 'no';
  if(e.kind==='choose')return combineBenefits(e.options.map(option=>
    combineBenefits(option.effects.map(child=>effectBenefit(s,child)))));
  if(e.kind==='action'){
    if(e.fromBinding||e.bindAttacker)return 'unknown';
    const plans=boardOptions(s,e);
    if(['build_army','build_navy','recruit_army','recruit_navy'].includes(e.action))
      return plans.some(plan=>!plan.existingId&&!plan.recycleId)?'yes':
        plans.some(plan=>!!plan.recycleId)?'unknown':'no';
    if(['land_battle','sea_battle','destroy','air_power'].includes(e.action))
      return plans.some(plan=>!!plan.defenderId)?'yes':plans.some(plan=>
        plan.mode==='deploy')?'yes':'no';
    if(e.action==='air_deploy')return plans.some(plan=>plan.mode==='deploy')?'yes':'no';
    return 'unknown';
  }
  if(e.kind==='score')return e.amount>0&&allianceOf(e.seat)===allianceOf(s.activeSeat)?'yes':'no';
  if(e.kind==='deckTop'||e.kind==='forceHand')return allianceOf(e.seat)!==
    allianceOf(s.activeSeat)&&
    (e.kind==='deckTop'?s.decks[e.seat].drawPile.length+s.decks[e.seat].hand.length:
      s.decks[e.seat].hand.length)>0&&e.count>0?'yes':'no';
  if(e.kind==='signal')return e.tag==='INSTALL'?'yes':'no';
  if(e.kind==='trace'||e.kind==='cancel'||e.kind==='frameChange'||e.kind==='countChange')return 'no';
  if(e.kind==='cards'&&e.from==='hand'&&e.to==='discardPile'&&e.seat===s.activeSeat)return 'no';
  return 'unknown';
}
function candidateBenefit(s:GameState,c:PpoCandidate):Benefit {
  if(c.kind!=='source')return 'no';
  if(c.optionId&&basicType(c.definitionId??'')){
    const plan=cardOptions(s,c.cardId!).find(option=>option.id===c.optionId);
    if(!plan)return 'unknown';
    if(['build_army','build_navy'].includes(c.definitionId!))return !plan.existingId&&!plan.recycleId?'yes':
      plan.recycleId?'unknown':'no';
    return plan.defenderId?'yes':'no';
  }
  const card=[...s.decks[s.activeSeat].hand,...s.decks[s.activeSeat].active]
    .find(item=>item.id===c.cardId);
  if(!card)return 'unknown';
  const effects=c.statusAction?statusActionEffects(s,card):cardEffects(s,card);
  return combineBenefits(effects.map(effect=>effectBenefit(s,effect)));
}
function knownWasteStructure(effect:Effect):boolean {
  if(effect.kind==='choose')return effect.options.every(option=>
    option.effects.every(knownWasteStructure));
  if(effect.kind==='signal'&&effect.tag==='INSTALL')return false;
  return ['action','score','deckTop','forceHand','trace','signal'].includes(effect.kind);
}
function resolvedEventBenefit(event:NonNullable<GameState['resolution']>['events'][number],seat:SeatId):Benefit {
  const effect=event.effect;
  if(!effect||effect.fee)return 'no';
  if(effect.kind==='action'){
    if(['land_battle','sea_battle','destroy'].includes(effect.action))
      return effect.option?.defenderId?'yes':'no';
    if(['build_army','build_navy','recruit_army','recruit_navy','air_deploy'].includes(effect.action))
      return event.outcome==='succeeded'&&!!effect.resultUnitId&&
        !effect.option?.existingId?'yes':'no';
    return 'unknown';
  }
  if(effect.kind==='score')return event.outcome==='succeeded'&&effect.amount>0?'yes':'no';
  if(effect.kind==='remove')return event.outcome==='succeeded'&&
    allianceOf(effect.unit.country)!==allianceOf(seat)?'yes':'no';
  if(effect.kind==='signal'||effect.kind==='trace'||effect.kind==='deckTop')return 'no';
  return 'unknown';
}

const countryIds=Object.keys(COUNTRY_NAMES) as CountryId[];
const basicType=(id:string):id is BasicAction=>BASIC_ACTIONS.some(type=>type===id);
const isSha=(value:string)=>/^[0-9a-f]{64}$/i.test(value);
const fnv=(value:unknown)=>{let n=2166136261;for(const c of JSON.stringify(value))n=Math.imul(n^c.charCodeAt(0),16777619);
  return(n>>>0).toString(16).padStart(8,'0');};
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const scoreCopy=(s:GameState)=>({...s.scores});
const turnClock=(s:GameState)=>s.status==='FINISHED'?s.round*SEATS.length:
  (s.round-1)*SEATS.length+SEATS.indexOf(s.activeSeat);
function nextRandom(course:NonNullable<GameState['trainingCourse']>,which:'openRandomState'|'discardRandomState'){
  course[which]=(Math.imul(course[which],1664525)+1013904223)>>>0;return course[which];
}
function randomIndex(course:NonNullable<GameState['trainingCourse']>,which:'openRandomState'|'discardRandomState',n:number){
  const limit=0x100000000-(0x100000000%n);let value:number;
  do value=nextRandom(course,which);while(value>=limit);
  return value%n;
}
function sampleWithoutReplacement<T>(items:readonly T[],count:number,course:NonNullable<GameState['trainingCourse']>,
  which:'openRandomState'|'discardRandomState'):T[]{
  const pool=[...items],selected:T[]=[];
  for(let i=0;i<count;i++)selected.push(pool.splice(randomIndex(course,which,pool.length),1)[0]);
  return selected;
}
const structure=(effect:Effect,fact:(id:string)=>UnitFact|undefined):EffectFeature=>({kind:effect.kind,
  ...(effect.kind==='action'?{action:effect.action,country:effect.country}:{}),
  ...('seat'in effect?{seat:effect.seat}:{}),fee:!!effect.fee,optional:!!effect.optional,
  ...('min'in effect?{min:effect.min}:{}),...('max'in effect?{max:effect.max}:{}),
  ...('count'in effect?{count:effect.count}:{}),...('amount'in effect?{amount:effect.amount}:{}),
  regions:effect.kind==='action'?[...(effect.regions??[])]:[],
  targetIds:effect.kind==='action'?[...(effect.targetIds??[])]:effect.kind==='remove'?[effect.unit.id]:[],
  targetFacts:effect.kind==='action'?(effect.targetIds??[]).flatMap(id=>fact(id)??[]):
    effect.kind==='remove'?[{country:effect.unit.country,type:effect.unit.type,regionId:effect.unit.regionId}]:[],
  // Card-instance IDs encode their definitions in this arena. Resource and
  // hidden-response selections must never enter an opponent observation.
  ...('selectedIds'in effect?{selectedIds:(effect.selectedIds??[]).filter(id=>!!fact(id)),
    selectedFacts:(effect.selectedIds??[]).flatMap(id=>fact(id)??[])}:{}),
  ...(effect.kind==='action'&&effect.selection?.regionId?{selectionRegion:effect.selection.regionId}:{}),
  ...(effect.kind==='action'?{bindAs:effect.bindAs,fromBinding:effect.fromBinding,
    newOnly:effect.newOnly}:{}),
  ...('filter'in effect?{filter:effect.filter}:{}),
  ...('from'in effect?{from:effect.from}:{}),...('to'in effect?{to:effect.to}:{}),
  ...(effect.kind==='signal'?{tag:effect.tag}:{}),
  children:effect.kind==='choose'?effect.options.map(o=>o.effects.map(e=>structure(e,fact))):[],
});
const effectSequence=(s:GameState,card:CardInstance,fact:(id:string)=>UnitFact|undefined,
  targets:string[]=[]):EffectFeature[]=>{
  if(card.definitionId==='special_162'&&!targets.length)return [{kind:'action',action:'land_battle',country:'germany',
    fee:false,optional:false,min:1,max:3,count:3,precommitTargets:true,regions:[],targetIds:[],targetFacts:[],
    children:[]}];
  return cardEffects(s,card,targets).map(e=>structure(e,fact));
};
const combinations=(ids:string[],min:number,max:number,ordered=false):string[][]=>{
  const out:string[][]=[];
  const visit=(selected:string[],remaining:string[])=>{
    if(selected.length>=min)out.push(selected);
    if(selected.length>=max)return;
    for(let i=0;i<remaining.length;i++)visit([...selected,remaining[i]],
      ordered?remaining.filter((_,j)=>j!==i):remaining.slice(i+1));
  };
  visit([],ids);return out;
};

/** Event curriculum adapter over the production engine; no alternative combat rules. */
export class PpoTrainingArena {
  private state:GameState;
  private decisionCount=0;
  private pendingCardId:string|null=null;
  private terminationReason:string|null=null;
  private finalObservation:PpoObservation|null=null;
  private cached:PpoObservation|null|undefined;
  private knownUnits:Record<string,UnitFact>={};
  private submittedThisStep:{id:string;definitionId:string}[]=[];
  private completedThisStep:{id:string;outcome:'resolved'|'cancelled';appliedEffects:number}[]=[];
  private pendingSubmissions:Record<string,string>={};
  private actionLedgers:Record<string,ActionLedger>={};
  private resolutionEventOutcomes:Record<string,string>={};
  private pendingTriggers:PendingTrigger[]=[];
  private triggerLedgers:Record<string,TriggerLedger>={};
  private pendingTargetChecks:PendingTargetCheck[]=[];
  private penalizedEffectFrames=new Set<string>();
  private rewardAdjustments:NonNullable<PpoStepInfo['rewardAdjustments']>=[];
  private wasteAssessments:NonNullable<PpoStepInfo['wasteAssessments']>=[];
  private feeCardsSpent=0;
  private readonly captureReplay:boolean;
  private replayCommits:unknown[]=[];
  readonly records:unknown[]=[];
  readonly header:{format:typeof PPO_ARENA_FORMAT;gameId:string;episodeId:string;seed:number;
    mode:CourseMode;cardSet:CardSet;courseVersion:string;overridesVersion:string;mapVersion:string;
    eventIds:string[];configHash:string;buildFingerprint:string};
  readonly trace:TraceLevel;

  constructor(seed:number,gameId=`ppo-${seed}`,options:PpoArenaOptions){
    if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff||!gameId.trim()||
      !['A','B'].includes(options.mode)||!isSha(options.buildFingerprint))throw new Error('Invalid PPO arena configuration');
    const cardSet=options.cardSet??'events';
    if(!['basics','events','signals'].includes(cardSet))throw new Error('Invalid PPO card set');
    if(TRAINING_EVENT_IDS.size!==58||TRAINING_EVENT_IDS.has('special_227'))throw new Error('Event whitelist is invalid');
    this.trace=options.trace??'none';
    this.captureReplay=!!options.captureReplay;
    const s=createGame(gameId,seed,'FULL',false,false,true);
    const catalog=regularCatalog(true,false);
    for(const seat of SEATS){
      const basic:CardInstance[]=BASIC_ACTIONS.flatMap((type,index)=>Array.from({length:BASIC_COUNTS[seat][index]+(
        seat==='italy'&&['build_navy','sea_battle'].includes(type)?1:0)},(_,i)=>({
        id:`${seat}:${type}:${i+1}`,definitionId:type,country:seat,deckOwner:seat,balance:true,
      })));
      const allowed=cardSet==='signals'?TRAINING_A2S1_IDS_BY_SEAT[seat]:
        cardSet==='events'?TRAINING_EVENT_IDS_BY_SEAT[seat]:[];
      const specials=catalog.filter(d=>allowed.includes(d.id));
      if(specials.length!==allowed.length||specials.some(d=>
        cardSet==='events'&&d.type!=='事件'||cardSet==='signals'&&
        !['事件','状态','响应'].includes(d.type)))
        throw new Error(`Training catalog mismatch for ${seat}`);
      s.decks[seat]={hand:[...basic,...specials.map(d=>({id:`${seat}:${d.id}`,definitionId:d.id,
        country:d.country,deckOwner:seat,balance:true}))],drawPile:[],discardPile:[],
        active:[],faceDown:[],resolving:[],removed:[]};
    }
    s.status='PLAYING';s.round=1;s.phase='TURN_START_WINDOW';s.setupCompleted=[...SEATS];
    s.viewSeat=s.operatorSeat=s.activeSeat='germany';s.settings.ignoreOtherPlayerInterrupts=false;
    s.events=[];s.publicLog=[];s.trainingBasicOnly=false;
    s.trainingCourse={version:cardSet==='signals'?TRAINING_A2S1_COURSE_VERSION:TRAINING_COURSE_VERSION,
      mode:options.mode,openIds:Object.fromEntries(
      SEATS.map(seat=>[seat,[] as string[]])) as Record<SeatId,string[]>,
      openRandomState:(seed^0x7f4a7c15)>>>0,discardRandomState:(seed^0xd1b54a32)>>>0,
      ...(this.captureReplay?{captureReplay:true}:{})};
    this.state=s;
    for(const seat of SEATS)this.refreshOpen(seat);
    const eventIds=cardSet==='signals'?SEATS.flatMap(seat=>TRAINING_A2S1_IDS_BY_SEAT[seat]):
      cardSet==='events'?SEATS.flatMap(seat=>TRAINING_EVENT_IDS_BY_SEAT[seat]):[];
    const courseVersion=cardSet==='signals'?TRAINING_A2S1_COURSE_VERSION:TRAINING_COURSE_VERSION;
    const overridesVersion=cardSet==='signals'?TRAINING_A2S1_OVERRIDES_VERSION:TRAINING_OVERRIDES_VERSION;
    this.header={format:PPO_ARENA_FORMAT,gameId,episodeId:globalThis.crypto.randomUUID(),seed,
      mode:options.mode,cardSet,courseVersion,overridesVersion,
      mapVersion:MAP.version,eventIds,configHash:fnv({mode:options.mode,course:courseVersion,
        cardSet,observation:cardSet==='signals'?PPO_A2S1_STATIC_SCHEMA.observationSchemaVersion:
          PPO_OBSERVATION_SCHEMA_VERSION,
        action:cardSet==='signals'?PPO_A2S1_STATIC_SCHEMA.actionSchemaVersion:PPO_ACTION_SCHEMA_VERSION,
        overrides:overridesVersion,map:MAP.version,eventIds,basic:BASIC_COUNTS,balance:true}),
      buildFingerprint:options.buildFingerprint};
    this.advance();
  }

  get done(){return this.state.status==='FINISHED'||this.terminationReason!==null;}
  get decisions(){return this.decisionCount;}
  get result():PpoEnd|null{if(!this.done)return null;
    const truncated=this.terminationReason!==null;
    return {termination:truncated?'truncated':'natural',...(truncated?{
      reason:this.terminationReason!,finalObservation:this.finalObservation!}:{}),
      winner:truncated?null:this.state.winner,round:this.state.round,decisions:this.decisionCount,
      scores:scoreCopy(this.state),allianceScores:allianceScores(this.state)};}

  private refreshOpen(seat:SeatId){
    const s=this.state,course=s.trainingCourse!,hand=s.decks[seat].hand;
    if(course.mode==='A'){course.openIds[seat]=hand.map(c=>c.id);return;}
    const specials=hand.filter(c=>!basicType(c.definitionId));
    const open=sampleWithoutReplacement(specials,openSpecialCount(specials.length),course,'openRandomState').map(c=>c.id);
    for(const type of BASIC_ACTIONS){const cards=hand.filter(c=>c.definitionId===type);
      if(cards.length&&nextRandom(course,'openRandomState')/0x100000000<basicOpenProbability(cards.length))
        open.push(...cards.map(c=>c.id));}
    course.openIds[seat]=open;
  }
  private pruneOpen(){const course=this.state.trainingCourse!;
    for(const seat of SEATS){const ids=new Set(this.state.decks[seat].hand.map(c=>c.id));
      course.openIds[seat]=course.mode==='A'?[...ids]:course.openIds[seat].filter(id=>ids.has(id));}
  }
  private replayState(s:GameState){return structuredClone({round:s.round,phase:s.phase,activeSeat:s.activeSeat,
    units:s.units,scores:s.scores,unitSerial:s.unitSerial??0,turnFlags:s.turnFlags??null,
    activeCards:Object.fromEntries(SEATS.map(seat=>[seat,s.decks[seat].active.map(c=>c.id)])),
    resources:Object.fromEntries(SEATS.map(seat=>{const d=s.decks[seat];return [seat,{hand:[],
      drawPile:[...d.hand,...d.drawPile].map(c=>c.id),
      discardPile:[...d.discardPile,...d.resolving,...d.removed,...d.active,...d.faceDown].map(c=>c.id),
      resourcePool:s.trainingCourse?.mode==='B'?s.trainingCourse.openIds[seat]:[]}] as const;
    })) as unknown as Record<SeatId,Record<string,string[]>>,
    resolutionEvents:s.resolution?.events??[],resolutionScenario:s.resolution?.scenario??null});}
  private beginAction(cardId:string,definitionId:string,seat:SeatId,alternative:boolean,
    extraCard=false){
    const card=Object.values(this.state.decks).flatMap(deck=>[...deck.hand,...deck.active,
      ...deck.discardPile]).find(item=>item.id===cardId);
    const actual=card?(this.state.decks[seat].active.some(item=>item.id===cardId)?
      statusActionEffects(this.state,card):cardEffects(this.state,card)):[];
    // INSTALL is a durable benefit, not an empty action. Unknown structures
    // remain exempt until their settlement can be classified safely.
    const supported=!!card&&actual.every(effect=>knownWasteStructure(effect)||
      definitionId==='special_150'&&effect.kind==='extraPlay')&&
      !actual.some(effect=>effect.kind==='signal'&&effect.tag==='INSTALL');
    const guaranteedScore=actual.length===1&&actual[0].kind==='score'&&
      actual[0].amount>0&&allianceOf(actual[0].seat)===allianceOf(seat);
    this.actionLedgers[cardId]={cardId,definitionId,seat,originDecisionId:this.decisionCount,
      alternative,supported,positive:guaranteedScore?['direct_score_effect']:[],
      newUnitIds:[],usedUnitIds:[],penalized:false,extraCard,
      supplyEligible:supported,
      supplyCandidates:[]};
  }
  private penalize(action:ActionLedger,reason:string,effects:string[],decisionId=action.originDecisionId,
    independentlyChosen=false,seat=action.seat){
    if(action.penalized||!action.alternative||!independentlyChosen&&action.positive.length)return;
    action.penalized=true;
    this.rewardAdjustments.push({decisionId,seat,
      cardId:action.cardId,reason,penalty:-0.01,beforeCap:-0.01,afterCap:-0.01,effects});
  }
  private recordActionEffects(before:GameState,after:GameState,command:Command,
    supplyRemovedIds:readonly string[]){
    const beforeIds=new Set(before.units.map(u=>u.id));
    const newEvents=after.events.slice(before.events.length);
    const commandCardId='cardId'in command?command.cardId:
      before.resolution?.frames.at(-1)?.cardId;
    const directlyActing=commandCardId?this.actionLedgers[commandCardId]:undefined;
    if(directlyActing){
      for(const event of newEvents)if(event.type==='UNIT_PLACED'&&
        !event.repeated&&!beforeIds.has(event.unitId)&&
        !directlyActing.newUnitIds.includes(event.unitId))directlyActing.newUnitIds.push(event.unitId);
      if(['PLAY_CARD','RESOLVE_ENGINE_CHOICE'].includes(command.type)&&
        before.phase==='PLAY'&&after.phase==='PLAY'&&
        after.scores[directlyActing.seat]>before.scores[directlyActing.seat])
        directlyActing.positive.push('direct_score');
    }
    const frames=new Map(after.resolution?.frames.map(f=>[f.id,f.cardId])??[]);
    for(const event of after.resolution?.events??[]){
      if(this.resolutionEventOutcomes[event.id]===event.outcome)continue;
      this.resolutionEventOutcomes[event.id]=event.outcome??'unknown';
      if(event.outcome!=='succeeded'||!event.effect)continue;
      const effect=event.effect;
      if(effect.fee) this.feeCardsSpent+=effect.kind==='cards'?
        effect.selectedIds?.length??effect.min:effect.kind==='deckTop'?effect.count:0;
      if(effect.kind==='action'&&effect.option?.attackerId)
        for(const placement of Object.values(this.actionLedgers))if(effect.option.defenderId&&
          placement.newUnitIds.includes(effect.option.attackerId))
          placement.usedUnitIds.push(effect.option.attackerId);
      const cardId=frames.get(event.frameId),action=cardId?this.actionLedgers[cardId]:undefined;
      const activation=this.triggerLedgers[event.frameId];
      if(activation){
        if(effect.kind==='action'){
          const id=effect.resultUnitId;
          if(id&&!beforeIds.has(id)&&after.units.some(unit=>unit.id===id))
            activation.positive.push(`new_unit:${event.id}`);
          else if(['land_battle','sea_battle','destroy'].includes(effect.action)&&
            effect.option?.defenderId)activation.positive.push(`attack:${event.id}`);
        }else if(effect.kind==='remove'&&
          allianceOf(effect.unit.country)!==allianceOf(activation.seat)||
          effect.kind==='score'&&effect.amount>0&&
          allianceOf(effect.seat)===allianceOf(activation.seat))
          activation.positive.push(`effect:${event.id}`);
      }
      if(!action)continue;
      if(effect.kind==='action'){
        const id=effect.resultUnitId;
        if(id&&!beforeIds.has(id)&&after.units.some(u=>u.id===id)){
          if(!action.newUnitIds.includes(id))action.newUnitIds.push(id);
          const prior=suppliedUnits(before),current=suppliedUnits(after);
          if(before.units.some(unit=>unit.id!==id&&!prior.has(unit.id)&&current.has(unit.id)))
            action.positive.push(`supplied_other:${event.id}`);
        }else if(['land_battle','sea_battle','destroy'].includes(effect.action)&&effect.option?.defenderId){
          action.positive.push(`attack:${event.id}`);
        }
        if(effect.option?.attackerId&&effect.option.defenderId)
          action.usedUnitIds.push(effect.option.attackerId);
      }else if(effect.kind==='score'&&effect.amount>0&&
        allianceOf(effect.seat)===allianceOf(action.seat))action.positive.push(`score:${event.id}`);
      else if(effect.kind==='cards'&&allianceOf(effect.seat)!==allianceOf(action.seat)&&
        effect.to==='discardPile'&&(effect.selectedIds?.length??0)>0)
        action.positive.push(`enemy_resource:${event.id}`);
    }
    for(const id of supplyRemovedIds)
      for(const action of Object.values(this.actionLedgers))if(action.supplyEligible&&
        action.newUnitIds.includes(id)&&!action.supplyCandidates.includes(id))
        action.supplyCandidates.push(id);
    if(newEvents.some(event=>event.type==='RULE_EVENT'&&event.code==='COUNTRY_SCORED'))
      for(const [id,action] of Object.entries(this.actionLedgers))if(action.newUnitIds.length){
        const allLostToSupply=action.supplyEligible&&
          action.supplyCandidates.length===action.newUnitIds.length&&
          action.supplyCandidates.every(unitId=>!after.units.some(u=>u.id===unitId))&&
          !action.usedUnitIds.some(unitId=>action.newUnitIds.includes(unitId))&&
          !action.positive.length;
        if(allLostToSupply)
          this.penalize(action,'same_turn_supply_loss',
            action.supplyCandidates.map(unitId=>`supply_removed:${unitId}`));
        this.wasteAssessments.push({decisionId:action.originDecisionId,seat:action.seat,
          cardId:action.cardId,reason:action.penalized?'same_turn_supply_loss':
            action.positive.length?'actual_benefit':
            action.newUnitIds.some(unitId=>after.units.some(u=>u.id===unitId))?
              'new_unit_survived':!action.alternative?'no_confirmed_alternative':
              action.usedUnitIds.length?'unit_contributed':'uncertain_supply_causality',
          actualEffects:[...action.positive],newUnitIds:[...action.newUnitIds],
          alternative:action.alternative,penalized:action.penalized});
        delete this.actionLedgers[id];
      }
  }
  private assessTriggerFrames(before:GameState,after:GameState){
    for(const [frameId,activation] of Object.entries(this.triggerLedgers)){
      const frame=after.resolution?.frames.find(frame=>frame.id===frameId);
      const prior=before.resolution?.frames.find(frame=>frame.id===frameId);
      if(frame?.status!=='COMPLETE'&&!(prior&&!frame))continue;
      const history=frame?after:before;
      const ownEvents=history.resolution?.events.filter(event=>event.frameId===frameId)??[];
      const related=(history.resolution?.events??[]).filter(event=>event.frameId===frameId||
        event.ancestorIds.some(id=>ownEvents.some(parent=>parent.id===id)));
      const benefit=combineBenefits(related.map(event=>resolvedEventBenefit(event,activation.seat)));
      const cancelled=!!(frame??prior)?.cancelled||related.some(event=>event.cancelled&&
        event.effect?.kind==='action'&&!!event.effect.option?.defenderId);
      if(activation.supported&&!cancelled&&!activation.positive.length&&benefit==='no'){
        activation.penalized=true;
        this.penalizedEffectFrames.add(frameId);
        this.rewardAdjustments.push({decisionId:activation.decisionId,seat:activation.seat,
          cardId:activation.cardId,reason:'optional_trigger_no_effect',penalty:-0.01,
          beforeCap:-0.01,afterCap:-0.01,effects:[activation.label]});
      }
      this.wasteAssessments.push({decisionId:activation.decisionId,seat:activation.seat,
        cardId:activation.cardId,reason:activation.penalized?'optional_trigger_no_effect':
          cancelled?'rule_cancelled':activation.positive.length||benefit==='yes'?
            'actual_benefit':benefit==='unknown'?'uncertain_effect_structure':
            !activation.supported?'uncertain_effect_structure':'no_effect_exempt',
        actualEffects:[...activation.positive],newUnitIds:[],alternative:true,
        penalized:activation.penalized});
      delete this.triggerLedgers[frameId];
    }
  }
  private assessRepeatedTargets(history:GameState,settled:boolean){
    if(!settled||!this.pendingTargetChecks.length)return;
    const checks=this.pendingTargetChecks.splice(0),events=history.resolution?.events??[],
      frames=history.resolution?.frames??[];
    for(const check of checks){
      const frame=frames.find(item=>item.id===check.frameId)||
        frames.find(item=>item.cardId===check.cardId&&
          (check.effectIndex<0||item.effects[check.effectIndex]?.kind==='action'));
      const root=events.find(event=>event.frameId===frame?.id&&
        (check.effectIndex<0||event.effectIndex===check.effectIndex)&&event.effect?.kind==='action'&&
        event.effect.action===check.action&&
        (event.effect.option?.regionId??event.effect.selection?.regionId)===check.regionId);
      const descendants=root?events.filter(event=>event.ancestorIds.includes(root.id)):[];
      // Cancellation, failed application, and effects whose benefit cannot be
      // classified safely are exemptions. Only this event's descendants count.
      const uncertain=!root||root.outcome!=='succeeded'||!root.applied||
        descendants.some(event=>event.cancelled||event.outcome==='cancelled'||
          event.outcome==='invalid'||event.outcome==='declared');
      const related=uncertain?[]:[root,...descendants].filter(event=>event.applied&&
        event.outcome==='succeeded'&&event.effect&&
        (event.id===root?.id||frames.find(item=>item.id===event.frameId)?.owner===check.seat));
      const beneficial=!!check.relatedAttempt||related.some(event=>{
        const effect=event.effect!;
        if(effect.kind==='action')return event.id!==root?.id&&!!effect.resultUnitId&&
          !effect.option?.existingId||
          ['land_battle','sea_battle','destroy'].includes(effect.action)&&
          !!effect.option?.defenderId;
        if(effect.kind==='score')return effect.amount>0&&
          allianceOf(effect.seat)===allianceOf(check.seat);
        if(effect.kind==='cards')return effect.to==='discardPile'&&
          allianceOf(effect.seat)!==allianceOf(check.seat)&&
          !!effect.selectedIds?.length;
        if(effect.kind==='remove')return allianceOf(effect.unit.country)!==allianceOf(check.seat);
        return false;
      });
      const unknownBenefit=related.some(event=>{
        const effect=event.effect!;
        return !effect.fee&&!['action','score','cards','remove','signal','trace'].includes(effect.kind);
      });
      const ledger=this.actionLedgers[check.cardId];
      const alreadyPenalized=!!ledger?.penalized||!!frame&&this.penalizedEffectFrames.has(frame.id);
      const reason=alreadyPenalized?'penalized':uncertain?'rule_cancelled_or_unresolved':
        beneficial?'related_benefit':unknownBenefit?'uncertain_effect_structure':
        !ledger&&!frame?'missing_effect_identity':'avoidable_repeated_target';
      if(reason==='avoidable_repeated_target'){
        if(ledger)this.penalize(ledger,reason,[`repeated:${check.action}:${check.regionId}`],
          check.decisionId,true,check.seat);
        else if(frame){this.penalizedEffectFrames.add(frame.id);
          this.rewardAdjustments.push({decisionId:check.decisionId,seat:check.seat,
            cardId:check.cardId,reason,penalty:-0.01,beforeCap:-0.01,afterCap:-0.01,
            effects:[`repeated:${check.action}:${check.regionId}`]});}
      }
      this.wasteAssessments.push({decisionId:check.decisionId,seat:check.seat,
        cardId:check.cardId,reason,actualEffects:beneficial?['related_benefit']:[],
        newUnitIds:[],alternative:true,penalized:reason==='avoidable_repeated_target'});
    }
    this.penalizedEffectFrames.clear();
  }
  private commit(command:Command){const before=this.state;
    if(command.type==='RESOLVE_ENGINE_CHOICE'&&before.resolution?.choice?.kind==='ACTION'){
      const choice=before.resolution.choice,activation=this.triggerLedgers[choice.frameId??''];
      const frame=before.resolution.frames.find(item=>item.id===choice.frameId);
      const effect=frame?.effects[frame.nextEffectIndex];
      if(activation&&effect?.kind==='action'&&command.ids.length){
        const plans=boardOptions(before,effect).filter(plan=>command.ids.includes(
          choice.field==='option'?plan.id:choice.field==='regionId'?plan.regionId:
            choice.field==='defenderId'?plan.defenderId??'empty':plan.attackerId??''));
        if(plans.some(plan=>!!plan.defenderId||
          ['build_army','build_navy','recruit_army','recruit_navy','air_deploy'].includes(
            effect.action)&&!plan.existingId))activation.positive.push('valid_action_attempt');
      }
    }
    if(command.type==='RESOLVE_ENGINE_CHOICE'&&before.resolution?.choice?.kind==='TRIGGER'&&
      command.ids.length){
      const option=command.ids[0];
      const rule=before.resolution.rules.find(rule=>option.endsWith('/'+rule.id));
      if(rule&&rule.sourceInstanceId.startsWith(rule.owner+':special_')){
        const nonfee=rule.effects.filter(effect=>!effect.fee);
        const supported=nonfee.length>0&&nonfee.every(knownWasteStructure);
        this.pendingTriggers.push({ruleId:rule.id,label:rule.label,cardId:rule.sourceInstanceId,
          seat:rule.owner,decisionId:this.decisionCount,
          definitionId:rule.sourceInstanceId.split(':')[1],supported});
      }
    }
    const extraSubmitted=command.type==='RESOLVE_ENGINE_CHOICE'&&
      before.resolution?.choice?.kind==='EXTRA_CARD'?command.ids.flatMap(id=>{
        const card=Object.values(before.decks).flatMap(deck=>
          [...deck.hand,...deck.drawPile,...deck.discardPile]).find(card=>card.id===id);
        return card?[{id:card.id,definitionId:card.definitionId}]:[];
      }):[];
    if(extraSubmitted.length){
      const choice=before.resolution?.choice;
      for(const card of extraSubmitted){
        const instance=Object.values(before.decks).flatMap(deck=>
          [...deck.hand,...deck.drawPile,...deck.discardPile]).find(item=>item.id===card.id);
        if(instance){
          const alternatives=choice?.options.filter(option=>option.id!==card.id).some(option=>{
            const other=Object.values(before.decks).flatMap(deck=>
              [...deck.hand,...deck.drawPile,...deck.discardPile]).find(item=>item.id===option.id);
            return other&&combineBenefits(cardEffects(before,other).map(effect=>
              effectBenefit(before,effect)))==='yes';
          })??false;
          this.beginAction(card.id,card.definitionId,choice?.seat??before.activeSeat,
            alternatives,true);
        }
      }
    }
    const responseCardId=command.type==='RESOLVE_ENGINE_CHOICE'&&
      before.resolution?.choice?.kind==='TRIGGER'&&command.ids.length?
      before.resolution.rules.find(rule=>command.ids.some(id=>id===rule.id||id.endsWith('/'+rule.id)))
        ?.sourceInstanceId:undefined;
    const relatedChoices:PendingTargetCheck[]=[];
    if(command.type==='RESOLVE_ENGINE_CHOICE'&&before.resolution?.choice?.kind==='ACTION'&&
      command.ids.length){
      const choice=before.resolution.choice,frame=before.resolution.frames.find(f=>f.id===choice.frameId),
        effect=frame?.effects[frame.nextEffectIndex];
      if(frame&&effect?.kind==='action')for(const check of this.pendingTargetChecks){
        const origin=before.resolution.events.find(event=>
          event.frameId===(check.frameId??before.resolution?.frames.find(f=>f.cardId===check.cardId)?.id)&&
          (check.effectIndex<0||event.effectIndex===check.effectIndex)&&
          event.effect?.kind==='action'&&
          event.effect.action===check.action);
        if(!origin||frame.owner!==check.seat||!frame.ancestorIds.includes(origin.id))continue;
        const plans=boardOptions(before,effect).filter(plan=>plan.regionId===command.ids[0]||
          plan.id===command.ids[0]);
        if(['land_battle','sea_battle','destroy'].includes(effect.action)&&
          plans.some(plan=>!!plan.defenderId)||
          ['build_army','build_navy','recruit_army','recruit_navy'].includes(effect.action)&&
          plans.some(plan=>!plan.existingId))relatedChoices.push(check);
      }
    }
    for(const unit of before.units)this.knownUnits[unit.id]={country:unit.country,type:unit.type,regionId:unit.regionId};
    const supplyRemovedIds:string[]=[];
    const outcome=observeFacts((_state,boundary)=>{
      if(boundary.code==='unit_removed'){
        const details=boundary.details as {cause?:string;unit?:Unit}|undefined;
        if(details?.cause==='supply'&&details.unit)supplyRemovedIds.push(details.unit.id);
      }
    },()=>transition(before,command));
    if(!outcome.ok)throw new Error(`Core rejected ${command.type}: ${outcome.error}`);
    for(const check of relatedChoices)check.relatedAttempt=true;
    this.state=outcome.state;
    const oldFrames=new Set(before.resolution?.frames.map(frame=>frame.id)??[]);
    for(const frame of this.state.resolution?.frames??[]){
      if(oldFrames.has(frame.id)||frame.noticeKind!=='trigger')continue;
      const index=this.pendingTriggers.findIndex(p=>p.cardId===frame.cardId&&p.label===frame.source);
      if(index<0)continue;
      const [pending]=this.pendingTriggers.splice(index,1);
      this.triggerLedgers[frame.id]={...pending,frameId:frame.id,positive:[],penalized:false};
    }
    if(!before.resolution?.running&&this.state.resolution?.running)this.resolutionEventOutcomes={};
    this.recordActionEffects(before,this.state,command,supplyRemovedIds);
    this.assessTriggerFrames(before,this.state);
    const previousEvents=before.resolution?.events??[],currentEvents=this.state.resolution?.events??[];
    const resolutionSwitched=!!before.resolution?.running&&(
      before.phase!==this.state.phase||currentEvents.length<previousEvents.length||
      before.resolution.scenario!==this.state.resolution?.scenario);
    this.assessRepeatedTargets(resolutionSwitched?before:this.state,
      resolutionSwitched||!this.state.resolution?.running);
    this.submittedThisStep.push(...extraSubmitted);
    this.completedThisStep.push(...(this.state.trainingCourse?.cardOutcomes??[]).slice(
      before.trainingCourse?.cardOutcomes?.length??0));
    for(const unit of this.state.units)this.knownUnits[unit.id]={country:unit.country,type:unit.type,regionId:unit.regionId};
    this.pruneOpen();
    if((before.activeSeat!==this.state.activeSeat||before.round!==this.state.round)&&this.state.round>1)
      this.refreshOpen(this.state.activeSeat);
    if(this.captureReplay)this.replayCommits.push({commandType:command.type,
      seat:'seat'in command?command.seat:before.activeSeat,
      cardId:'cardId'in command?command.cardId:undefined,
      responseCardId,
      before:this.replayState(before),after:this.replayState(this.state),
      cardOutcomes:(this.state.trainingCourse?.cardOutcomes??[]).slice(
        before.trainingCourse?.cardOutcomes?.length??0),
      boardEvents:this.state.events.slice(before.events.length).filter(e=>e.type==='TRAINING_BOARD_APPLIED')});
    this.cached=undefined;
  }
  private unitFact=(id:string):UnitFact|undefined=>{
    const unit=this.state.units.find(u=>u.id===id);
    return unit?{country:unit.country,type:unit.type,regionId:unit.regionId}:this.knownUnits[id];
  };
  private autoChoice(choice:ChoiceRequest):string[]|null{
    const s=this.state;
    const frame=s.resolution?.frames.find(f=>f.id===choice.frameId);
    const effect=frame?.effects[frame.nextEffectIndex];
    const typed=(choice.requirements??(effect?.kind==='cards'?effect.requirements:undefined)??[])
      .some(requirement=>requirement!=='*');
    const randomPayment=choice.kind==='FORCE_HAND'||choice.min===choice.max&&!typed&&
      (choice.kind==='PAY_COST'||choice.kind==='CARDS'&&effect?.kind==='cards'&&
      (effect.fee||effect.from==='hand'&&effect.to==='discardPile'));
    if(randomPayment){
      const options=choice.options.map(o=>o.id);
      const count=Math.min(choice.min,options.length);
      for(let attempt=0;attempt<100;attempt++){
        const selected=sampleWithoutReplacement(options,count,s.trainingCourse!,'discardRandomState');
        if(transition(s,{type:'RESOLVE_ENGINE_CHOICE',seat:choice.seat,expectedRevision:s.revision,
          choiceId:choice.id,ids:selected,guided:true}).ok)return selected;
      }
      throw new Error(`No valid random payment for ${choice.kind}`);
    }
    if(choice.min===0&&choice.options.length===0)return [];
    if(choice.min===1&&choice.max===1&&choice.options.length===1&&!choice.canSkip)return [choice.options[0].id];
    return null;
  }
  private advance(){for(let i=0;i<200;i++){
    const s=this.state;
    if(s.status==='FINISHED')return;
    if(s.resolution?.running){const choice=s.resolution.choice;
      if(!choice)throw new Error('Resolution running without a choice');
      const selected=this.autoChoice(choice);
      if(selected===null)return;
      this.commit({type:'RESOLVE_ENGINE_CHOICE',seat:choice.seat,expectedRevision:s.revision,
        choiceId:choice.id,ids:selected,guided:true});continue;
    }
    if(s.pendingDiscard){const choice=s.pendingDiscard;
      const ids=sampleWithoutReplacement(s.decks[choice.seat].hand,
        Math.min(choice.count,s.decks[choice.seat].hand.length),s.trainingCourse!,'discardRandomState').map(c=>c.id);
      this.commit({type:'RESOLVE_FORCED_DISCARD',seat:choice.seat,expectedRevision:s.revision,cardIds:ids});continue;
    }
    if(s.pendingAir.length){if(this.header.cardSet!=='signals')throw new Error('Air choice in no-air curriculum');
      return;}
    if(s.phase==='PLAY'){
      if(!this.pendingCardId&&this.sourceCandidates().length===1){
        this.commit({type:'ADVANCE_PHASE',seat:s.activeSeat,expectedRevision:s.revision});continue;
      }
      if(this.pendingCardId){const targets=barbarossaTargets(s);
        if(targets.length===1){const cardId=this.pendingCardId;this.pendingCardId=null;
          this.playCard(cardId,targets);continue;}}
      return;
    }
    if(['TURN_START_WINDOW','AIR','SUPPLY','SCORE','DRAW'].includes(s.phase)){
      this.commit({type:'ADVANCE_PHASE',seat:s.activeSeat,expectedRevision:s.revision});continue;
    }
    if(s.phase==='DISCARD'){
      this.commit({type:'DISCARD_HAND',seat:s.activeSeat,expectedRevision:s.revision,cardIds:[]});continue;
    }
    throw new Error(`Unexpected PPO arena phase: ${s.phase}`);
  }throw new Error('PPO arena failed to reach a decision');}

  private sourceCandidates():PpoCandidate[]{const s=this.state,seat=s.activeSeat,
    open=new Set(s.trainingCourse!.openIds[seat]),seen=new Set<string>(),candidates:PpoCandidate[]=[];
    if(this.header.cardSet==='signals')for(const card of s.decks[seat].active){
      const effects=statusActionEffects(s,card);
      if(!effects.length||!canExecuteEffects(s,effects))continue;
      candidates.push({id:`status-action:${card.id}`,kind:'source',cardId:card.id,
        definitionId:card.definitionId,cardType:'状态',statusAction:true,
        label:`发动：${specialCard(card.definitionId,card.balance)?.name??card.definitionId}`,
        effects:effects.map(e=>structure(e,this.unitFact))});
    }
    for(const card of s.decks[seat].hand){
      if(!open.has(card.id)||seen.has(card.definitionId))continue;
      if(basicType(card.definitionId)){
        const options=cardOptions(s,card.id);
        if(!options.length)continue;
        seen.add(card.definitionId);
        for(const option of options)candidates.push({id:`source:${card.definitionId}:${option.id}`,
          kind:'source',cardId:card.id,definitionId:card.definitionId,optionId:option.id,
          cardType:'基本牌',
          label:`${BASIC_NAMES[card.definitionId]} · ${option.label}`,
          choices:[{kind:'action_plan',action:option.replacement??card.definitionId,
            country:card.country,regionId:option.regionId,unitType:option.unitType,
            source:option.attackerId?this.unitFact(option.attackerId):undefined,
            target:option.defenderId?this.unitFact(option.defenderId):undefined,
            repeated:!!option.existingId,intercept:!!option.intercept}],
          effects:effectSequence(s,card,this.unitFact)});
        continue;
      }
      if(!basicType(card.definitionId)){
        if(card.definitionId!=='special_162'){
          const deck=s.decks[seat],probe={...s,decks:{...s.decks,[seat]:{...deck,
            hand:deck.hand.filter(c=>c.id!==card.id)}}};
          const effects=cardEffects(s,card);
          if(!canPayEffectFees(probe,effects))continue;
        }
      }
      seen.add(card.definitionId);
      candidates.push({id:`source:${card.definitionId}`,kind:'source',cardId:card.id,
        definitionId:card.definitionId,cardType:specialCard(card.definitionId,card.balance)?.type,
        label:specialCard(card.definitionId,card.balance)?.name??
          BASIC_NAMES[card.definitionId as keyof typeof BASIC_NAMES]??card.definitionId,
        effects:effectSequence(s,card,this.unitFact)});
    }
    candidates.push({id:'pass',kind:'pass',label:'不出牌，扣1分'});
    return candidates;
  }
  private choiceCandidates(choice:ChoiceRequest):PpoCandidate[]{
    const ids=choice.options.map(o=>o.id);
    const ordered=['SELECT','ORDER_MANDATORY_TRIGGERS','EXTRA_TARGET'].includes(choice.kind)&&choice.max>1;
    const cards=this.state.decks[choice.seat];
    const lookup=(id:string)=>[...cards.hand,...cards.drawPile,...cards.discardPile].find(c=>c.id===id);
    const semanticIds=choice.kind==='EXTRA_CARD'&&choice.max===1?ids.filter((id,index)=>{
      const card=lookup(id);
      return !card||!basicType(card.definitionId)||ids.findIndex(previous=>{
        const other=lookup(previous);
        return other&&other.definitionId===card.definitionId&&other.country===card.country&&
          other.deckOwner===card.deckOwner&&other.balance===card.balance;
      })===index;
    }):ids;
    const frame=this.state.resolution?.frames.find(f=>f.id===choice.frameId);
    const effect=frame?.effects[frame.nextEffectIndex];
    const requirements=choice.requirements??(effect?.kind==='cards'?effect.requirements:undefined);
    const typedPayment=!!requirements?.some(requirement=>requirement!=='*')&&
      ['PAY_COST','CARDS'].includes(choice.kind);
    // A flexible arbitrary discard is a decision about quantity, not a
    // combinatorial choice among individual resource instances. The selected
    // identities are sampled only after the model submits the count.
    if(this.header.cardSet==='signals'&&choice.kind==='CARDS'&&effect?.kind==='cards'&&
      effect.from==='hand'&&effect.to==='discardPile'&&!typedPayment&&choice.min<choice.max)
      return Array.from({length:choice.max-choice.min+1},(_,index)=>{
        const count=choice.min+index;
        return {id:`random-discard-count:${count}`,kind:'choice' as const,
          choiceIds:count?[`__random_discard__:${count}`]:[],randomDiscardCount:count,
          label:`随机弃置 ${count} 张可用资源`,choices:count?[{kind:'cards'}]:[],
          effects:[{...structure(effect,this.unitFact),min:count,max:count}]};
      });
    const picks=typedPayment?this.paymentChoices(choice,requirements!):
      combinations(semanticIds,choice.min,choice.max,ordered);
    if(choice.canSkip&&!picks.some(p=>p.length===0))picks.unshift([]);
    const resolution=this.state.resolution;
    const cardById=(id:string)=>Object.values(this.state.decks).flatMap(deck=>
      [...deck.hand,...deck.drawPile,...deck.discardPile,...deck.active,...deck.faceDown,...deck.resolving,...deck.removed])
      .find(card=>card.id===id);
    const requireFact=(id:string)=>{const fact=this.unitFact(id);
      if(!fact)throw new Error(`PPO choice has no unit fact: ${choice.kind}/${choice.field}/${id}`);
      return fact;};
    const requireCard=(id:string)=>{const card=cardById(id);
      if(!card)throw new Error(`PPO choice has no card fact: ${choice.kind}/${id}`);
      return card;};
    const ruleById=(id:string)=>{const rule=resolution?.rules.find(rule=>rule.id===id);
      if(!rule)throw new Error(`PPO choice has no trigger rule: ${choice.kind}/${id}`);
      return rule;};
    const choiceFeature=(id:string):ChoiceFeature=>{
      switch(choice.kind){
        case 'BUILD_ORDER':{
          if(effect?.kind!=='action')throw new Error('BUILD_ORDER missing action effect');
          const [action,regionId,...rest]=id.split('|');
          if(rest.length||!['build_army','build_navy'].includes(action)||!MAP.regions.some(r=>r.id===regionId))
            throw new Error(`Unknown BUILD_ORDER option: ${id}`);
          return {kind:'build_order',action,nextAction:action==='build_army'?'build_navy':'build_army',
            country:effect.country,regionId,unitType:action==='build_army'?'army':'navy'};
        }
        case 'ACTION':{
          // A merged trigger target is selected before its source rule is activated,
          // so it has no frameId. Resolve the action from the selected window/rule.
          const ref=choice.triggerTargets?.[id];
          const selectedRule=ref?resolution?.rules.find(rule=>rule.id===ref.ruleId):undefined;
          const selectedEffect=ref?selectedRule?.effects.find(item=>item.kind==='action'):effect;
          if(selectedEffect?.kind!=='action')throw new Error('ACTION missing action effect');
          if(choice.field==='regionId'){
            if(!MAP.regions.some(r=>r.id===id))throw new Error(`Unknown ACTION region: ${id}`);
            if(ref&&(!resolution?.windows.some(window=>window.id===ref.windowId)||
              !boardOptions(this.state,selectedEffect).some(option=>option.regionId===id)))
              throw new Error(`Stale merged ACTION target: ${id}`);
            return {kind:'action_region',action:selectedEffect.action,country:selectedEffect.country,regionId:id,
              ...(ref?{effects:selectedRule!.effects.map(item=>structure(item,this.unitFact))}:{})};
          }
          if(choice.field==='defenderId'||choice.field==='attackerId'){
            if(id==='empty'&&choice.field==='defenderId')return {kind:'empty_defender',action:selectedEffect.action,country:selectedEffect.country};
            return {kind:choice.field,action:selectedEffect.action,country:selectedEffect.country,target:requireFact(id)};
          }
          if(choice.field==='option'){
            const option=boardOptions(this.state,selectedEffect).find(o=>o.id===id);
            if(!option)throw new Error(`Unknown ACTION plan: ${id}`);
            const source=option.recycleId??option.attackerId??option.airId;
            return {kind:'action_plan',action:option.replacement??selectedEffect.action,country:selectedEffect.country,
              regionId:option.regionId,unitType:option.unitType,source:source?requireFact(source):undefined,
              target:option.defenderId?requireFact(option.defenderId):undefined,
              repeated:!!option.existingId,intercept:!!option.intercept};
          }
          throw new Error(`Unknown ACTION field: ${choice.field}`);
        }
        case 'SELECT':{
          if(effect?.kind!=='choose')throw new Error('SELECT missing choose effect');
          const option=effect.options.find(option=>option.id===id);
          if(!option)throw new Error(`Unknown SELECT option: ${id}`);
          return {kind:'effect_choice',effects:option.effects.map(e=>structure(e,this.unitFact))};
        }
        case 'EXTRA_CARD':case 'REALLOCATE':case 'CARDS':case 'FORCE_HAND':case 'PAY_COST':{
          const card=requireCard(id);
          return {kind:choice.kind.toLowerCase(),definitionId:card.definitionId,country:card.country};
        }
        case 'EXTRA_TARGET':{
          if(MAP.regions.some(r=>r.id===id))return {kind:'region_target',regionId:id};
          if(countryIds.includes(id as CountryId))return {kind:'country_target',country:id as CountryId};
          return {kind:'unit_target',target:requireFact(id)};
        }
        case 'RELOCATE':{
          if(!MAP.regions.some(r=>r.id===id)||!choice.airId)throw new Error(`Unknown RELOCATE option: ${id}`);
          return {kind:'relocate',action:'air_move',regionId:id,source:requireFact(choice.airId)};
        }
        case 'TRIGGER':case 'ORDER_MANDATORY_TRIGGERS':{
          const option=choice.options.find(option=>option.id===id);
          if(!option)throw new Error(`Unknown trigger option: ${id}`);
          const ruleId=choice.kind==='TRIGGER'?id.slice(id.indexOf('/')+1):id;
          const rule=ruleById(ruleId);
          const window=resolution?.windows.find(window=>window.id===(option.windowId??choice.windowId));
          const origin=resolution?.events.find(event=>event.id===window?.originEventId)?.effect;
          const originRegion=origin?.kind==='action'?(origin.option?.regionId??origin.selection?.regionId):undefined;
          return {kind:choice.kind.toLowerCase(),country:rule.owner,
            regionId:originRegion,
            definitionId:cardById(rule.sourceInstanceId)?.definitionId,
            effects:rule.effects.map(e=>structure(e,this.unitFact))};
        }
        case 'EFFECTS':case 'EXTRA_EFFECTS':{
          const index=Number(id);
          if(!Number.isSafeInteger(index)||index<0)throw new Error(`Unknown effect index: ${id}`);
          const list=choice.kind==='EFFECTS'?ruleById(choice.triggerId??'').effects:
            effect?.kind==='extraPlay'&&effect.selectedCardId?
              extraEffects(this.state,requireCard(effect.selectedCardId),effect.targets??[]):undefined;
          const selected=list?.[index];
          if(!selected)throw new Error(`Unknown ${choice.kind} option: ${id}`);
          return {kind:'effect_choice',effects:[structure(selected,this.unitFact)]};
        }
        case 'AIR_DEFENSE':case 'AIR_INTERCEPT':
          if(id!=='yes'&&id!=='no')throw new Error(`Unknown air decision: ${id}`);
          return {kind:id==='yes'?'accept':'decline'};
        case 'EFFECT_DECISION':
          if(id!=='execute')throw new Error(`Unknown effect decision: ${id}`);
          return {kind:'execute',effects:effect?[structure(effect,this.unitFact)]:[]};
        default:throw new Error(`Unsupported PPO choice kind: ${choice.kind}`);
      }
    };
    return picks.map(selected=>({id:`choose:${JSON.stringify(selected)}`,kind:'choice',choiceIds:selected,
      label:selected.length?selected.map(id=>choice.options.find(o=>o.id===id)?.label??id).join(' → '):'跳过',
      choices:selected.map(choiceFeature),
      effects:choice.kind==='EXTRA_CARD'?selected.flatMap(id=>{
          const card=lookup(id);return card?effectSequence(this.state,card,this.unitFact):[];
        }):selected.flatMap(id=>choiceFeature(id).effects??[])}));
  }
  private paymentChoices(choice:ChoiceRequest,requirements:string[]):string[][]{
    const deck=this.state.decks[choice.seat];
    const cards=[...deck.hand,...deck.faceDown,...deck.active,...deck.drawPile,...deck.discardPile];
    const byId=new Map(cards.map(card=>[card.id,card]));
    const groups=new Map<string,string[]>();
    for(const option of choice.options){const card=byId.get(option.id);
      if(!card)throw new Error(`Unknown payment card ${option.id}`);
      const group=groups.get(card.definitionId)??[];group.push(card.id);groups.set(card.definitionId,group);}
    const entries=[...groups.values()],out:string[][]=[];
    const visit=(index:number,selected:string[])=>{
      if(selected.length>choice.max)return;
      if(index===entries.length){if(selected.length>=choice.min&&selected.length<=choice.max&&
        coversCost(selected.map(id=>byId.get(id)!),requirements))out.push(selected);return;}
      for(let count=0;count<=Math.min(entries[index].length,choice.max-selected.length);count++)
        visit(index+1,[...selected,...entries[index].slice(0,count)]);
    };
    visit(0,[]);
    return out;
  }
  observe():PpoObservation|null{
    if(this.cached!==undefined)return this.cached;
    if(this.done)return null;
    const s=this.state,choice=s.resolution?.choice,air=s.pendingAir.length?
      s.units.find(unit=>unit.id===s.pendingAir[0]):undefined,card=this.pendingCardId?
      s.decks[s.activeSeat].hand.find(c=>c.id===this.pendingCardId):undefined;
    const node=choice?'ENGINE_CHOICE':air?'AIR_RELOCATE':card?'TARGETS':'SOURCE';
    const targets=card&&node==='TARGETS'?[...barbarossaTargets(s)].sort():[];
    const candidates=choice?this.choiceCandidates(choice):air?airDestinations(s,air.id).map(regionId=>({
      id:`air-relocate:${air.id}:${regionId}`,kind:'choice' as const,choiceIds:[regionId],
      label:regionId,choices:[{kind:'relocate',action:'air_move',regionId,
        source:this.unitFact(air.id)}]})):card?combinations(targets,1,Math.min(3,targets.length),true)
      .map(ids=>({id:`targets:${JSON.stringify(ids)}`,kind:'targets' as const,targetIds:ids,
        label:ids.join('、'),effects:effectSequence(s,card,this.unitFact,ids)})):this.sourceCandidates();
    const decisionSeat=choice?.seat??(air?seatOf(air.country):s.activeSeat);
    const frame=s.resolution?.frames.find(f=>f.id===choice?.frameId)??s.resolution?.frames.at(-1);
    const current=frame?.effects[frame.nextEffectIndex];
    const selectedTargets=frame?.effects.flatMap(effect=>effect.kind==='action'?[...(effect.targetIds??[]),
      ...(effect.selectedIds??[]).filter(id=>!!this.unitFact(id))]:
      (effect.selectedIds??[]).filter(id=>!!this.unitFact(id)))??[];
    const bindingFacts=Object.fromEntries(Object.entries(frame?.memory??{}).map(([key,ids])=>[
      key,ids.flatMap(id=>this.unitFact(id)??[])]));
    const priorResults=s.resolution?.events.filter(event=>event.applied||event.cancelled).slice(-8).map(event=>({
      applied:event.applied,cancelled:event.cancelled,
      ...(event.effect?.kind==='action'?{action:event.effect.action,
        regionId:event.effect.option?.regionId??event.effect.selection?.regionId}:{}),
    }))??[];
    const origin=s.resolution?.events.at(-1)?.effect;
    const originAction=origin?.kind==='action'?{action:origin.action,country:origin.country,
      regionId:origin.option?.regionId??origin.selection?.regionId,
      sourceRegionId:s.units.find(u=>u.id===origin.option?.attackerId)?.regionId}:undefined;
    const own=s.decks[decisionSeat],open=new Set(s.trainingCourse!.openIds[decisionSeat]);
    const visibleInstalled=SEATS.flatMap(seat=>[
      ...s.decks[seat].active,...(seat===decisionSeat?s.decks[seat].faceDown:[])]);
    const visibleUseCounts:Record<string,number>={},visibleRoundUseCounts:Record<string,number>={};
    for(const card of visibleInstalled){
      const scopePrefix=`${s.round}:${s.activeSeat}:${card.id}:`;
      const used=Object.entries(s.resolution?.turnUses??{}).reduce((total,[key,count])=>
        total+(key.startsWith(scopePrefix)?count:0),0);
      visibleUseCounts[card.definitionId]=(visibleUseCounts[card.definitionId]??0)+used;
      visibleRoundUseCounts[card.definitionId]=(visibleRoundUseCounts[card.definitionId]??0)+
        Number(s.roundUses?.[card.id]===s.round);
    }
    const sourceCard=frame?.cardId?Object.values(s.decks).flatMap(deck=>[
      ...deck.resolving,...deck.active,...deck.discardPile,...deck.hand,...deck.faceDown])
      .find(card=>card.id===frame.cardId):undefined;
    const counts=(cards:CardInstance[])=>Object.fromEntries(
      [...new Set([...BASIC_ACTIONS,...(this.header.cardSet==='signals'?
        TRAINING_A2S1_IDS_BY_SEAT[decisionSeat]:TRAINING_EVENT_IDS_BY_SEAT[decisionSeat])])].map(id=>
        [id,cards.filter(c=>c.definitionId===id).length]));
    const observation:PpoObservation={decision:{episodeId:this.header.episodeId,gameId:this.header.gameId,
      decisionId:this.decisionCount,revision:s.revision},mode:this.header.mode,
      cardSet:this.header.cardSet,courseVersion:this.header.courseVersion,node,round:s.round,phase:s.phase,
      activeSeat:s.activeSeat,decisionSeat,sourceSeat:frame?.owner??s.activeSeat,
      unitCountry:current?.kind==='action'?current.country:null,
      scores:scoreCopy(s),allianceScores:allianceScores(s),units:s.units.map(u=>({...u})),
      suppliedUnitIds:[...suppliedUnits(s)],reserves:Object.fromEntries(countryIds.map(country=>[
        country,Object.fromEntries((['army','navy','air'] as const).map(type=>[type,reserve(s,country,type)]))
      ])) as PpoObservation['reserves'],
      effectiveStraits:Object.fromEntries(countryIds.map(country=>[country,
        MAP.straits.map(strait=>adjacent(s,country,strait.seaA,strait.seaB))])) as
        PpoObservation['effectiveStraits'],
      ownResources:{remaining:counts(own.hand),open:counts(own.hand.filter(c=>open.has(c.id))),
        discard:counts(own.discardPile)},
      publicResources:Object.fromEntries(SEATS.map(seat=>[seat,{remainingTotal:s.decks[seat].hand.length,
        discardTotal:s.decks[seat].discardPile.length}])) as PpoObservation['publicResources'],
      ...(this.header.cardSet==='signals'?{
        visibleCards:{active:Object.fromEntries(SEATS.map(seat=>[seat,
          s.decks[seat].active.map(card=>card.definitionId)])) as Record<SeatId,string[]>,
          ownFaceDown:own.faceDown.map(card=>card.definitionId),
          otherFaceDownCount:Object.fromEntries(SEATS.map(seat=>[seat,
            seat===decisionSeat?0:s.decks[seat].faceDown.length])) as Record<SeatId,number>},
        effectiveHomes:Object.fromEntries(countryIds.map(country=>[country,
          homeRegion(s,country)])) as Record<CountryId,string>,
        effectiveSupply:Object.fromEntries(countryIds.map(country=>[country,
          MAP.regions.map(region=>supplySource(s,country,region.id,region.supply))])) as
          Record<CountryId,boolean[]>,
        visibleUseCounts,visibleRoundUseCounts,
        currentSourceDefinition:frame?.publicDeclared||frame?.owner===decisionSeat?
          sourceCard?.definitionId??null:null,
        ...(originAction?{originAction}:{})}:{}),
      activeEffects:card?effectSequence(s,card,this.unitFact):frame?.effects.map(e=>structure(e,this.unitFact))??[],
      currentEffectIndex:frame?.nextEffectIndex??0,selectedTargets,
      selectedTargetFacts:selectedTargets.flatMap(id=>this.unitFact(id)??[]),bindingFacts,priorResults,
      ...(choice?{choiceKind:choice.kind,choiceField:choice.field,
        choiceMin:choice.min,choiceMax:choice.max,canSkip:!!choice.canSkip}:{}),
      candidates};
    return this.cached=freeze(observation);
  }

  step(request:PpoSubmission):{observation:PpoObservation|null;info:PpoStepInfo;result:PpoEnd|null;record:unknown|null}{
    const obs=this.observe();if(!obs)throw new Error('Game ended');
    if(!request||request.episodeId!==obs.decision.episodeId||request.gameId!==obs.decision.gameId||
      request.decisionId!==obs.decision.decisionId||request.revision!==obs.decision.revision)
      throw new Error('Stale PPO decision');
    const selected=obs.candidates.find(c=>c.id===request.actionId);
    if(!selected)throw new Error('Invalid PPO candidate');
    const s=this.state,beforeScore=scoreCopy(s),beforeTotals=allianceScores(s),beforeT=turnClock(s),
      beforeEventCount=s.events.length;
    const basicBuild=selected.kind==='source'&&!!selected.optionId&&
      (selected.definitionId==='build_army'||selected.definitionId==='build_navy');
    const buildPlan=basicBuild?selected.choices?.[0]:undefined;
    const validAlternative=basicBuild&&obs.candidates.some(candidate=>candidate.kind==='source'&&
      (candidate.definitionId==='build_army'||candidate.definitionId==='build_navy')&&
      candidate.choices?.[0]?.kind==='action_plan'&&!candidate.choices[0].repeated&&
      candidate.optionId?.endsWith(':'));
    const hasStockAlternative=obs.candidates.some(candidate=>candidate.kind==='source'&&
      candidate.id!==selected.id&&candidateBenefit(s,candidate)==='yes');
    const noInstalledEffects=Object.values(s.decks).every(deck=>!deck.active.length&&!deck.faceDown.length);
    const opportunityIds=hasStockAlternative&&noInstalledEffects?obs.candidates.filter(candidate=>
      candidate.kind==='source'&&!!candidate.optionId&&
      (candidate.definitionId==='build_army'||candidate.definitionId==='build_navy')&&
      !!candidate.choices?.[0]?.repeated&&candidate.effects?.length===1&&
      candidate.effects[0].kind==='action'&&candidate.effects[0].action===candidate.definitionId)
      .map(candidate=>candidate.id):[];
    let wasteCheck:PpoStepInfo['wasteCheck'];
    this.rewardAdjustments=[];
    this.wasteAssessments=[];
    this.feeCardsSpent=0;
    this.submittedThisStep=[];
    this.completedThisStep=[];
    this.replayCommits=[];
    if(selected.kind==='pass')this.commit({type:'ADVANCE_PHASE',seat:s.activeSeat,expectedRevision:s.revision});
    else if(selected.kind==='source'){
      if(selected.statusAction){
        this.beginAction(selected.cardId!,selected.definitionId!,s.activeSeat,
          !!hasStockAlternative);
        this.commit({type:'STATUS_ACTION',seat:s.activeSeat,expectedRevision:s.revision,
          cardId:selected.cardId!,guided:true});
      }else {
      if(selected.optionId&&['land_battle','sea_battle'].includes(selected.definitionId??'')){
        const used=cardOptions(s,selected.cardId!).find(option=>option.id===selected.optionId)?.attackerId;
        if(used)for(const action of Object.values(this.actionLedgers))if(action.newUnitIds.includes(used))
          action.usedUnitIds.push(used);
      }
      this.beginAction(selected.cardId!,selected.definitionId!,s.activeSeat,
        !!hasStockAlternative);
      if(selected.definitionId==='special_162'&&barbarossaTargets(s).length)this.pendingCardId=selected.cardId!;
      else if(selected.optionId){
        if(this.header.cardSet==='signals'&&basicBuild&&buildPlan?.repeated&&validAlternative)
          this.pendingTargetChecks.push({decisionId:this.decisionCount,seat:s.activeSeat,
            cardId:selected.cardId!,effectIndex:-1,action:selected.definitionId!,
            regionId:buildPlan.regionId!});
        this.commit({type:'PLAY_BASIC',seat:s.activeSeat,
        expectedRevision:s.revision,cardId:selected.cardId!,optionId:selected.optionId});
        this.submittedThisStep.push({id:selected.cardId!,definitionId:selected.definitionId!});
        if(basicBuild){
          const repeated=!!buildPlan?.repeated,now=this.state;
          const placed=now.events.slice(s.events.length).some(event=>event.type==='UNIT_PLACED'&&
            event.repeated&&event.country===s.activeSeat&&event.regionId===buildPlan?.regionId);
          const resolved=this.completedThisStep.some(outcome=>outcome.id===selected.cardId&&
            outcome.outcome==='resolved');
          const plain=selected.effects?.length===1&&selected.effects[0].kind==='action'&&
            selected.effects[0].action===selected.definitionId&&
            Object.values(s.decks).every(deck=>!deck.active.length&&!deck.faceDown.length);
          // The basic play may enter SCORE before returning; routine scoring
          // must not make an otherwise empty construction look productive.
          const changed=JSON.stringify(s.units)!==JSON.stringify(now.units)||
            Object.keys(s.decks).some(seat=>s.decks[seat as SeatId].drawPile.length!==
              now.decks[seat as SeatId].drawPile.length);
          const plainWaste=repeated&&validAlternative&&plain&&resolved&&
            !now.resolution?.running&&placed&&!changed;
          if(this.header.cardSet==='signals'&&plainWaste){
            const ledger=this.actionLedgers[selected.cardId!];
            if(ledger)this.penalize(ledger,'avoidable_repeated_target',
              [`repeated:${selected.definitionId}:${buildPlan?.regionId}`],this.decisionCount,true);
          }
          const reason=!repeated?'not_repeated':!validAlternative?'no_valid_alternative':
            this.header.cardSet==='signals'?'deferred_target_assessment':
            !plain?'additional_effect_uncertain':!resolved||now.resolution?.running?'not_resolved':
            !placed||changed?'other_effect_uncertain':'repeated_basic_build';
          wasteCheck={seat:s.activeSeat,definitionId:selected.definitionId!,
            regionId:buildPlan?.regionId??'',repeated,penalty:reason==='repeated_basic_build',reason};
        }}
      else this.playCard(selected.cardId!,[]);
      }
    }else if(obs.node==='AIR_RELOCATE'){
      this.commit({type:'RELOCATE_AIR',seat:obs.decisionSeat,expectedRevision:s.revision,
        regionId:selected.choiceIds![0]});
    }else if(selected.kind==='targets'){
      const cardId=this.pendingCardId!;this.pendingCardId=null;this.playCard(cardId,selected.targetIds!);
    }else{
      const choice=s.resolution?.choice;if(!choice)throw new Error('Missing core choice');
      if(choice.kind==='ACTION'&&choice.field==='regionId'&&selected.choiceIds?.length===1){
        const frame=s.resolution?.frames.find(f=>f.id===choice.frameId);
        const effect=frame?.effects[frame.nextEffectIndex];
        const ledger=frame?.cardId?this.actionLedgers[frame.cardId]:undefined;
        if(effect?.kind==='action'&&['build_army','build_navy','recruit_army','recruit_navy'].includes(effect.action)&&frame?.cardId){
          const plans=boardOptions(s,effect),region=selected.choiceIds[0];
          const chosen=plans.filter(plan=>plan.regionId===region);
          if(chosen.length&&chosen.every(plan=>!!plan.existingId)&&
            plans.some(plan=>!plan.existingId)){
            if(ledger)ledger.alternative=true;
            if(this.header.cardSet==='signals')
              this.pendingTargetChecks.push({decisionId:this.decisionCount,seat:choice.seat,
                cardId:frame.cardId,frameId:frame.id,effectIndex:frame.nextEffectIndex,
                action:effect.action,regionId:region});
            else if(ledger)this.penalize(ledger,'avoidable_repeated_target',
              [`repeated:${effect.action}:${region}`],this.decisionCount,true,choice.seat);
          }
        }
      }
      const ids=selected.randomDiscardCount===undefined?selected.choiceIds!:
        sampleWithoutReplacement(choice.options,selected.randomDiscardCount,
          s.trainingCourse!,'discardRandomState').map(option=>option.id);
      this.commit({type:'RESOLVE_ENGINE_CHOICE',seat:choice.seat,expectedRevision:s.revision,
        choiceId:choice.id,ids,guided:true});
    }
    this.advance();this.decisionCount++;this.cached=undefined;
    const after=this.state,next=this.observe(),totals=allianceScores(after),result=this.result;
    for(const card of this.submittedThisStep)this.pendingSubmissions[card.id]=card.definitionId;
    const resolved:string[]=[],cancelled:string[]=[];
    for(const outcome of this.completedThisStep){const definitionId=this.pendingSubmissions[outcome.id];
      if(!definitionId)continue;
      (outcome.outcome==='cancelled'?cancelled:resolved).push(definitionId);
      delete this.pendingSubmissions[outcome.id];}
    for(const outcome of this.completedThisStep){
      const ledger=this.actionLedgers[outcome.id];if(!ledger)continue;
      if(outcome.outcome==='resolved'&&!basicType(ledger.definitionId)&&
        !ledger.positive.length&&!ledger.newUnitIds.length&&ledger.supported)
        this.penalize(ledger,ledger.definitionId==='special_150'?'white_plan_empty_recruit':
          'whole_action_no_effect',[`resolved:${ledger.definitionId}`]);
      const reason=outcome.outcome==='cancelled'?'rule_cancelled':ledger.penalized?'penalized':
        ledger.positive.length?'actual_benefit':ledger.newUnitIds.length?'new_unit_pending_supply':
        !ledger.alternative?'no_confirmed_alternative':!ledger.supported?'uncertain_effect_structure':
        'no_effect_exempt';
      this.wasteAssessments.push({decisionId:ledger.originDecisionId,seat:ledger.seat,
        cardId:ledger.cardId,reason,actualEffects:[...ledger.positive],
        newUnitIds:[...ledger.newUnitIds],alternative:ledger.alternative,
        penalized:ledger.penalized});
      if(!ledger.newUnitIds.length||outcome.outcome==='cancelled')delete this.actionLedgers[outcome.id];
    }
    const info:PpoStepInfo={decision:obs.decision,nextDecision:next?.decision??null,
      scoreDelta:{axis:totals.axis-beforeTotals.axis,allies:totals.allies-beforeTotals.allies,
        bySeat:Object.fromEntries(SEATS.map(seat=>[seat,after.scores[seat]-beforeScore[seat]])) as GameState['scores']},
      turnsAdvanced:Math.max(0,turnClock(after)-beforeT),termination:result?.termination??'ongoing',
      submittedCardDefinitions:this.submittedThisStep.map(card=>card.definitionId),
      resolvedCardDefinitions:resolved,
      cancelledCardDefinitions:cancelled,
      ...(wasteCheck?{wasteCheck}:{}),
      ...(this.rewardAdjustments.length?{rewardAdjustments:[...this.rewardAdjustments]}:{}),
      ...(this.wasteAssessments.length?{wasteAssessments:[...this.wasteAssessments]}:{}),
      feeCardsSpent:this.feeCardsSpent,
      ...(obs.choiceKind==='TRIGGER'&&selected.choiceIds?.length?{triggerDepth:(()=>{
        const option=s.resolution?.choice?.options.find(option=>option.id===selected.choiceIds![0]);
        const window=s.resolution?.windows.find(window=>window.id===option?.windowId);
        return 1+(s.resolution?.events.find(event=>event.id===window?.originEventId)?.ancestorIds.length??0);
      })()}:{}),
      wasteOpportunity:{candidateCount:opportunityIds.length,chosen:opportunityIds.includes(selected.id)},
      winner:result?.winner??null};
    const record=this.trace==='none'?null:{type:'ppo-decision',decision:obs.decision,
      seat:obs.decisionSeat,activeSeat:obs.activeSeat,round:obs.round,choiceKind:obs.choiceKind,
      action:selected,info,
      ...(this.trace==='full'?{before:{scores:beforeScore,units:obs.units},
        after:{scores:scoreCopy(after),units:after.units.map(u=>({...u}))},
        events:after.events.slice(beforeEventCount),publicLog:[...(after.publicLog??[])],
        ...(this.captureReplay?{replayCommits:this.replayCommits}:{})}:{})};
    if(record)this.records.push(record);
    // Trigger handlers can recheck UNIT_PLACED across an AI decision boundary.
    // Only discard transient board facts once the whole resolution has closed.
    if(!after.resolution?.running)after.events=[];
    after.publicLog=[];
    return {observation:next,info,result,record};
  }
  private playCard(cardId:string,targets:string[]){const s=this.state,card=s.decks[s.activeSeat].hand.find(c=>c.id===cardId);
    if(!card)throw new Error('Source card no longer available');
    const effects=cardEffects(s,card,targets);
    this.commit({type:'PLAY_CARD',seat:s.activeSeat,expectedRevision:s.revision,cardId,
      targetIds:targets,effectIndices:effects.map((_,i)=>i),guided:true});
    this.submittedThisStep.push({id:card.id,definitionId:card.definitionId});
  }
  truncate(reason='max_decisions'){if(this.done||!reason.trim())throw new Error('Invalid truncation');
    this.finalObservation=this.observe();this.terminationReason=reason;this.cached=null;return this.result!;}
  exportSnapshot():PpoSnapshot{return structuredClone({format:PPO_ARENA_FORMAT,header:this.header,state:this.state,
    decisionCount:this.decisionCount,pendingCardId:this.pendingCardId,terminationReason:this.terminationReason,
    finalObservation:this.finalObservation,knownUnits:this.knownUnits,
    pendingSubmissions:this.pendingSubmissions,actionLedgers:this.actionLedgers,
    resolutionEventOutcomes:this.resolutionEventOutcomes,
    pendingTriggers:this.pendingTriggers,triggerLedgers:this.triggerLedgers,
    pendingTargetChecks:this.pendingTargetChecks,
    penalizedEffectFrames:[...this.penalizedEffectFrames]});}
  static fromSnapshot(input:PpoSnapshot,options:PpoArenaOptions){const saved=structuredClone(input);
    if(saved?.format!==PPO_ARENA_FORMAT||saved.header?.mode!==options.mode||
      saved.header.cardSet!==(options.cardSet??'events')||
      saved.header.buildFingerprint!==options.buildFingerprint||!isSha(options.buildFingerprint)||
      saved.state?.trainingCourse?.version!==(saved.header.cardSet==='signals'?
        TRAINING_A2S1_COURSE_VERSION:TRAINING_COURSE_VERSION)||
      saved.state.trainingCourse.mode!==options.mode||saved.state.trainingBasicOnly!==false||
      saved.header.eventIds.length!==(saved.header.cardSet==='signals'?TRAINING_A2S1_IDS.size:
        saved.header.cardSet==='events'?58:0)||
      saved.header.overridesVersion!==(saved.header.cardSet==='signals'?
        TRAINING_A2S1_OVERRIDES_VERSION:TRAINING_OVERRIDES_VERSION)||!saved.knownUnits||
      !saved.pendingSubmissions||!saved.actionLedgers||!saved.resolutionEventOutcomes||
      !saved.pendingTriggers||!saved.triggerLedgers||!saved.pendingTargetChecks||
      !saved.penalizedEffectFrames)
      throw new Error('Incompatible PPO snapshot');
    const arena=new PpoTrainingArena(saved.header.seed,saved.header.gameId,options);
    if(arena.header.configHash!==saved.header.configHash)throw new Error('PPO configuration mismatch');
    Object.assign(arena.header,saved.header);
    arena.state=saved.state;arena.decisionCount=saved.decisionCount;
    arena.pendingCardId=saved.pendingCardId;arena.terminationReason=saved.terminationReason;
    arena.finalObservation=saved.finalObservation;arena.knownUnits=saved.knownUnits;
    arena.pendingSubmissions=saved.pendingSubmissions;arena.actionLedgers=saved.actionLedgers;
    arena.resolutionEventOutcomes=saved.resolutionEventOutcomes;arena.cached=undefined;
    arena.pendingTriggers=saved.pendingTriggers;arena.triggerLedgers=saved.triggerLedgers;
    arena.pendingTargetChecks=saved.pendingTargetChecks;
    arena.penalizedEffectFrames=new Set(saved.penalizedEffectFrames);
    return arena;
  }
}

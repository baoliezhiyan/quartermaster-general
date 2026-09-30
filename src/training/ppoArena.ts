import {cardOptions} from '../core/actions';
import {boardOptions} from '../core/boardEffects';
import {extraEffects} from '../core/extraCards';
import {BASIC_COUNTS,BASIC_NAMES,COUNTRY_NAMES,reserve} from '../core/basic';
import {regularCatalog,specialCard} from '../core/cardCatalog';
import {canExecuteEffects} from '../core/resolution';
import {barbarossaTargets,cardEffects} from '../core/specialCards';
import {createGame,transition} from '../core/game';
import {MAP} from '../core/map';
import {allianceScores,suppliedUnits} from '../core/supply';
import {TRAINING_COURSE_VERSION,TRAINING_EVENT_IDS,TRAINING_EVENT_IDS_BY_SEAT,
  TRAINING_OVERRIDES_VERSION,basicOpenProbability,openSpecialCount} from '../core/trainingCourse';
import {SEATS,type CardInstance,type Command,type CountryId,type GameState,type SeatId,type Unit} from '../core/types';
import type {Effect,ChoiceRequest} from '../core/resolutionTypes';
import {BASIC_ACTIONS,type BasicAction,type DecisionContext,type TraceLevel} from './basicArena';

export const PPO_ARENA_FORMAT='quartermaster-ppo-arena-v2';
export const PPO_OBSERVATION_SCHEMA_VERSION='ppo-observation-v3';
export const PPO_ACTION_SCHEMA_VERSION='ppo-actions-v3';
export const PPO_STATIC_SCHEMA={observationSchemaVersion:PPO_OBSERVATION_SCHEMA_VERSION,
  actionSchemaVersion:PPO_ACTION_SCHEMA_VERSION,
  courseVersion:TRAINING_COURSE_VERSION,overridesVersion:TRAINING_OVERRIDES_VERSION,
  regions:MAP.regions,baseEdges:MAP.baseEdges,
  straits:MAP.straits,seats:SEATS,countries:Object.keys(COUNTRY_NAMES),
  basicActions:BASIC_ACTIONS,eventIds:Object.values(TRAINING_EVENT_IDS_BY_SEAT).flat(),
  bindingKeys:['built-navy','new-china','xiangxi-battle'],maxEffectTokens:32};
export type CourseMode='A'|'B';
export type CardSet='basics'|'events';
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
  cardId?:string;definitionId?:string;choiceIds?:string[];targetIds?:string[];effects?:EffectFeature[];
  choices?:ChoiceFeature[]};
export type ChoiceFeature={kind:string;action?:string;nextAction?:string;country?:CountryId;
  regionId?:string;unitType?:Unit['type'];source?:UnitFact;target?:UnitFact;
  definitionId?:string;repeated?:boolean;intercept?:boolean;effects?:EffectFeature[]};
export type PpoObservation={decision:DecisionContext;mode:CourseMode;cardSet:CardSet;courseVersion:string;
  node:'SOURCE'|'TARGETS'|'ENGINE_CHOICE';round:number;phase:GameState['phase'];
  activeSeat:SeatId;decisionSeat:SeatId;sourceSeat:SeatId;unitCountry:CountryId|null;
  scores:GameState['scores'];allianceScores:ReturnType<typeof allianceScores>;
  units:Unit[];suppliedUnitIds:string[];
  reserves:Record<CountryId,Record<Unit['type'],number>>;
  ownResources:{remaining:Record<string,number>;open:Record<string,number>;discard:Record<string,number>};
  publicResources:Record<SeatId,{remainingTotal:number;discardTotal:number}>;
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
  submittedCardDefinitions:string[];resolvedCardDefinitions:string[];
  termination:'ongoing'|'natural'|'truncated';winner:GameState['winner']};
export type PpoSnapshot={format:typeof PPO_ARENA_FORMAT;header:PpoTrainingArena['header'];state:GameState;
  decisionCount:number;pendingCardId:string|null;terminationReason:string|null;
  finalObservation:PpoObservation|null;knownUnits:Record<string,UnitFact>;
  pendingSubmissions:Record<string,string>};

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
  ...('selectedIds'in effect?{selectedIds:[...(effect.selectedIds??[])],
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
  private pendingSubmissions:Record<string,string>={};
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
    if(!['basics','events'].includes(cardSet))throw new Error('Invalid PPO card set');
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
      const events=cardSet==='events'?catalog.filter(d=>TRAINING_EVENT_IDS_BY_SEAT[seat].includes(d.id)):[];
      if(events.length!==(cardSet==='events'?TRAINING_EVENT_IDS_BY_SEAT[seat].length:0)||
        events.some(e=>e.type!=='事件'))
        throw new Error(`Event catalog mismatch for ${seat}`);
      s.decks[seat]={hand:[...basic,...events.map(d=>({id:`${seat}:${d.id}`,definitionId:d.id,
        country:d.country,deckOwner:seat,balance:true}))],drawPile:[],discardPile:[],
        active:[],faceDown:[],resolving:[],removed:[]};
    }
    s.status='PLAYING';s.round=1;s.phase='TURN_START_WINDOW';s.setupCompleted=[...SEATS];
    s.viewSeat=s.operatorSeat=s.activeSeat='germany';s.settings.ignoreOtherPlayerInterrupts=false;
    s.events=[];s.publicLog=[];s.trainingBasicOnly=false;
    s.trainingCourse={version:'ppo-events-v1',mode:options.mode,openIds:Object.fromEntries(
      SEATS.map(seat=>[seat,[] as string[]])) as Record<SeatId,string[]>,
      openRandomState:(seed^0x7f4a7c15)>>>0,discardRandomState:(seed^0xd1b54a32)>>>0,
      ...(this.captureReplay?{captureReplay:true}:{})};
    this.state=s;
    for(const seat of SEATS)this.refreshOpen(seat);
    const eventIds=cardSet==='events'?SEATS.flatMap(seat=>TRAINING_EVENT_IDS_BY_SEAT[seat]):[];
    this.header={format:PPO_ARENA_FORMAT,gameId,episodeId:globalThis.crypto.randomUUID(),seed,
      mode:options.mode,cardSet,courseVersion:TRAINING_COURSE_VERSION,overridesVersion:TRAINING_OVERRIDES_VERSION,
      mapVersion:MAP.version,eventIds,configHash:fnv({mode:options.mode,course:TRAINING_COURSE_VERSION,
        cardSet,observation:PPO_OBSERVATION_SCHEMA_VERSION,action:PPO_ACTION_SCHEMA_VERSION,
        overrides:TRAINING_OVERRIDES_VERSION,map:MAP.version,eventIds,basic:BASIC_COUNTS,balance:true}),
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
  private commit(command:Command){const before=this.state;
    for(const unit of before.units)this.knownUnits[unit.id]={country:unit.country,type:unit.type,regionId:unit.regionId};
    const outcome=transition(before,command);
    if(!outcome.ok)throw new Error(`Core rejected ${command.type}: ${outcome.error}`);
    this.state=outcome.state;
    for(const unit of this.state.units)this.knownUnits[unit.id]={country:unit.country,type:unit.type,regionId:unit.regionId};
    this.pruneOpen();
    if((before.activeSeat!==this.state.activeSeat||before.round!==this.state.round)&&this.state.round>1)
      this.refreshOpen(this.state.activeSeat);
    if(this.captureReplay)this.replayCommits.push({commandType:command.type,
      seat:'seat'in command?command.seat:before.activeSeat,
      cardId:'cardId'in command?command.cardId:undefined,
      before:this.replayState(before),after:this.replayState(this.state),
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
    const randomPayment=choice.kind==='PAY_COST'||choice.kind==='FORCE_HAND'||choice.kind==='CARDS'&&
      effect?.kind==='cards'&&(!!effect.fee||effect.from==='hand'&&effect.to==='discardPile');
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
    if(s.pendingAir.length)throw new Error('Air choice in no-air curriculum');
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
    for(const card of s.decks[seat].hand){
      if(!open.has(card.id)||seen.has(card.definitionId))continue;
      if(basicType(card.definitionId)&&!cardOptions(s,card.id).length)continue;
      if(!basicType(card.definitionId)){
        const targets=card.definitionId==='special_162'?barbarossaTargets(s):[];
        if(card.definitionId==='special_162'&&!targets.length)continue;
        if(card.definitionId!=='special_162'){
          const deck=s.decks[seat],probe={...s,decks:{...s.decks,[seat]:{...deck,
            hand:deck.hand.filter(c=>c.id!==card.id)}}};
          if(!canExecuteEffects(probe,cardEffects(s,card)))continue;
        }
      }
      seen.add(card.definitionId);
      candidates.push({id:`source:${card.definitionId}`,kind:'source',cardId:card.id,
        definitionId:card.definitionId,label:specialCard(card.definitionId,card.balance)?.name??
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
    const picks=combinations(semanticIds,choice.min,choice.max,ordered);
    if(choice.canSkip&&!picks.some(p=>p.length===0))picks.unshift([]);
    const frame=this.state.resolution?.frames.find(f=>f.id===choice.frameId);
    const effect=frame?.effects[frame.nextEffectIndex];
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
          if(effect?.kind!=='action')throw new Error('ACTION missing action effect');
          if(choice.field==='regionId'){
            if(!MAP.regions.some(r=>r.id===id))throw new Error(`Unknown ACTION region: ${id}`);
            return {kind:'action_region',action:effect.action,country:effect.country,regionId:id};
          }
          if(choice.field==='defenderId'||choice.field==='attackerId'){
            if(id==='empty'&&choice.field==='defenderId')return {kind:'empty_defender',action:effect.action,country:effect.country};
            return {kind:choice.field,action:effect.action,country:effect.country,target:requireFact(id)};
          }
          if(choice.field==='option'){
            const option=boardOptions(this.state,effect).find(o=>o.id===id);
            if(!option)throw new Error(`Unknown ACTION plan: ${id}`);
            const source=option.recycleId??option.attackerId??option.airId;
            return {kind:'action_plan',action:option.replacement??effect.action,country:effect.country,
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
  observe():PpoObservation|null{
    if(this.cached!==undefined)return this.cached;
    if(this.done)return null;
    const s=this.state,choice=s.resolution?.choice,card=this.pendingCardId?
      s.decks[s.activeSeat].hand.find(c=>c.id===this.pendingCardId):undefined;
    const node=choice?'ENGINE_CHOICE':card?'TARGETS':'SOURCE';
    const targets=card&&node==='TARGETS'?[...barbarossaTargets(s)].sort():[];
    const candidates=choice?this.choiceCandidates(choice):card?combinations(targets,1,Math.min(3,targets.length),true)
      .map(ids=>({id:`targets:${JSON.stringify(ids)}`,kind:'targets' as const,targetIds:ids,
        label:ids.join('、'),effects:effectSequence(s,card,this.unitFact,ids)})):this.sourceCandidates();
    const decisionSeat=choice?.seat??s.activeSeat;
    const frame=s.resolution?.frames.find(f=>f.id===choice?.frameId)??s.resolution?.frames.at(-1);
    const current=frame?.effects[frame.nextEffectIndex];
    const selectedTargets=frame?.effects.flatMap(effect=>effect.kind==='action'?[...(effect.targetIds??[]),
      ...(effect.selectedIds??[])]:effect.selectedIds??[])??[];
    const bindingFacts=Object.fromEntries(Object.entries(frame?.memory??{}).map(([key,ids])=>[
      key,ids.flatMap(id=>this.unitFact(id)??[])]));
    const priorResults=s.resolution?.events.filter(event=>event.applied||event.cancelled).slice(-8).map(event=>({
      applied:event.applied,cancelled:event.cancelled,
      ...(event.effect?.kind==='action'?{action:event.effect.action,
        regionId:event.effect.option?.regionId??event.effect.selection?.regionId}:{}),
    }))??[];
    const own=s.decks[decisionSeat],open=new Set(s.trainingCourse!.openIds[decisionSeat]);
    const counts=(cards:CardInstance[])=>Object.fromEntries(
      [...new Set([...BASIC_ACTIONS,...TRAINING_EVENT_IDS_BY_SEAT[decisionSeat]])].map(id=>
        [id,cards.filter(c=>c.definitionId===id).length]));
    const observation:PpoObservation={decision:{episodeId:this.header.episodeId,gameId:this.header.gameId,
      decisionId:this.decisionCount,revision:s.revision},mode:this.header.mode,
      cardSet:this.header.cardSet,courseVersion:TRAINING_COURSE_VERSION,node,round:s.round,phase:s.phase,
      activeSeat:s.activeSeat,decisionSeat,sourceSeat:frame?.owner??s.activeSeat,
      unitCountry:current?.kind==='action'?current.country:null,
      scores:scoreCopy(s),allianceScores:allianceScores(s),units:s.units.map(u=>({...u})),
      suppliedUnitIds:[...suppliedUnits(s)],reserves:Object.fromEntries(countryIds.map(country=>[
        country,Object.fromEntries((['army','navy','air'] as const).map(type=>[type,reserve(s,country,type)]))
      ])) as PpoObservation['reserves'],
      ownResources:{remaining:counts(own.hand),open:counts(own.hand.filter(c=>open.has(c.id))),
        discard:counts(own.discardPile)},
      publicResources:Object.fromEntries(SEATS.map(seat=>[seat,{remainingTotal:s.decks[seat].hand.length,
        discardTotal:s.decks[seat].discardPile.length}])) as PpoObservation['publicResources'],
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
    const s=this.state,beforeScore=scoreCopy(s),beforeTotals=allianceScores(s),beforeT=turnClock(s);
    this.submittedThisStep=[];
    this.replayCommits=[];
    if(selected.kind==='pass')this.commit({type:'ADVANCE_PHASE',seat:s.activeSeat,expectedRevision:s.revision});
    else if(selected.kind==='source'){
      if(selected.definitionId==='special_162')this.pendingCardId=selected.cardId!;
      else this.playCard(selected.cardId!,[]);
    }else if(selected.kind==='targets'){
      const cardId=this.pendingCardId!;this.pendingCardId=null;this.playCard(cardId,selected.targetIds!);
    }else{
      const choice=s.resolution?.choice;if(!choice)throw new Error('Missing core choice');
      this.commit({type:'RESOLVE_ENGINE_CHOICE',seat:choice.seat,expectedRevision:s.revision,
        choiceId:choice.id,ids:selected.choiceIds!,guided:true});
      if(choice.kind==='EXTRA_CARD')for(const id of selected.choiceIds??[]){
        const card=Object.values(s.decks).flatMap(deck=>[
          ...deck.hand,...deck.drawPile,...deck.discardPile]).find(card=>card.id===id);
        if(card)this.submittedThisStep.push({id:card.id,definitionId:card.definitionId});
      }
    }
    this.advance();this.decisionCount++;this.cached=undefined;
    const after=this.state,next=this.observe(),totals=allianceScores(after),result=this.result;
    for(const card of this.submittedThisStep)this.pendingSubmissions[card.id]=card.definitionId;
    const resolved:string[]=[];
    for(const [id,definitionId] of Object.entries(this.pendingSubmissions)){
      const pending=Object.values(after.decks).some(deck=>deck.resolving.some(card=>card.id===id))||
        after.resolution?.frames.some(frame=>frame.cardId===id&&frame.status!=='COMPLETE');
      if(!pending){resolved.push(definitionId);delete this.pendingSubmissions[id];}
    }
    const info:PpoStepInfo={decision:obs.decision,nextDecision:next?.decision??null,
      scoreDelta:{axis:totals.axis-beforeTotals.axis,allies:totals.allies-beforeTotals.allies,
        bySeat:Object.fromEntries(SEATS.map(seat=>[seat,after.scores[seat]-beforeScore[seat]])) as GameState['scores']},
      turnsAdvanced:Math.max(0,turnClock(after)-beforeT),termination:result?.termination??'ongoing',
      submittedCardDefinitions:this.submittedThisStep.map(card=>card.definitionId),
      resolvedCardDefinitions:resolved,
      winner:result?.winner??null};
    const record=this.trace==='none'?null:{type:'ppo-decision',decision:obs.decision,
      seat:obs.decisionSeat,activeSeat:obs.activeSeat,action:selected,info,
      ...(this.trace==='full'?{before:{scores:beforeScore,units:obs.units},
        after:{scores:scoreCopy(after),units:after.units.map(u=>({...u}))},
        events:[...after.events],publicLog:[...(after.publicLog??[])],
        ...(this.captureReplay?{replayCommits:this.replayCommits}:{})}:{})};
    if(record)this.records.push(record);
    after.events=[];after.publicLog=[];
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
    pendingSubmissions:this.pendingSubmissions});}
  static fromSnapshot(input:PpoSnapshot,options:PpoArenaOptions){const saved=structuredClone(input);
    if(saved?.format!==PPO_ARENA_FORMAT||saved.header?.mode!==options.mode||
      saved.header.cardSet!==(options.cardSet??'events')||
      saved.header.buildFingerprint!==options.buildFingerprint||!isSha(options.buildFingerprint)||
      saved.state?.trainingCourse?.version!=='ppo-events-v1'||
      saved.state.trainingCourse.mode!==options.mode||saved.state.trainingBasicOnly!==false||
      saved.header.eventIds.length!==(saved.header.cardSet==='events'?58:0)||
      saved.header.overridesVersion!==TRAINING_OVERRIDES_VERSION||!saved.knownUnits||!saved.pendingSubmissions)
      throw new Error('Incompatible PPO snapshot');
    const arena=new PpoTrainingArena(saved.header.seed,saved.header.gameId,options);
    if(arena.header.configHash!==saved.header.configHash)throw new Error('PPO configuration mismatch');
    Object.assign(arena.header,saved.header);
    arena.state=saved.state;arena.decisionCount=saved.decisionCount;
    arena.pendingCardId=saved.pendingCardId;arena.terminationReason=saved.terminationReason;
    arena.finalObservation=saved.finalObservation;arena.knownUnits=saved.knownUnits;
    arena.pendingSubmissions=saved.pendingSubmissions;arena.cached=undefined;
    return arena;
  }
}

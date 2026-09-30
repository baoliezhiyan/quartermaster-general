import { cardOptions, type BasicOption } from '../core/actions';
import { allianceOf, BASIC_COUNTS, BASIC_NAMES, COUNTRY_NAMES, reserve, seatOf, UNIT_TOTALS } from '../core/basic';
import { createGame, transition } from '../core/game';
import { MAP, REGION_BY_ID, REGIONS } from '../core/map';
import { allianceScores, suppliedUnits } from '../core/supply';
import { SEATS, type CardInstance, type Command, type CountryId, type GameEvent, type GameState, type SeatId, type Unit } from '../core/types';

export const TRAINING_FORMAT = 'quartermaster-basic-training-v3';
export const TRAINING_CURRICULUM = 'four-basics-finite-pool-v1';
export const BASIC_ACTIONS = ['build_army', 'land_battle', 'build_navy', 'sea_battle'] as const;
export type BasicAction = typeof BASIC_ACTIONS[number];
export type ArenaAction = { id: string; kind: 'play'; cardType: BasicAction; option: BasicOption } | { id: 'pass'; kind: 'pass' };
export type DecisionContext = { episodeId: string; gameId: string; decisionId: number; revision: number };
export type ActionSubmission = DecisionContext & { actionId: string };
export type TraceLevel = 'none' | 'summary' | 'full';
export type ArenaOptions = { trace?: TraceLevel; keepRecords?: boolean; buildFingerprint?: string;
  requireBuildFingerprint?: boolean; policyId?: string; policySeed?: number };
export type ArenaObservation = {
  decision: DecisionContext;
  round: number; phase: 'PLAY'; activeSeat: SeatId; alliance: 'axis' | 'allies';
  scores: GameState['scores']; allianceScores: ReturnType<typeof allianceScores>;
  units: Unit[]; suppliedUnitIds: string[];
  resources: Record<SeatId, Record<BasicAction, number>>;
  availableUnitReserve: Record<CountryId, Record<Unit['type'], number>>;
  candidates: ArenaAction[];
};
export type TrainingRecord = {
  recordType: 'decision'; index: number; round: number; seat: SeatId; alliance: 'axis' | 'allies';
  phase: 'PLAY'; action: { id: string; kind: ArenaAction['kind']; cardType?: BasicAction; optionId?: string; label: string };
  candidateCount: number; before: { scores: GameState['scores']; resources: ArenaObservation['resources']; units: Unit[] };
  after: { scores: GameState['scores']; resources: ArenaObservation['resources']; units: Unit[] };
  engineEvents: GameEvent[]; publicRecords: NonNullable<GameState['publicLog']>;
  decision: DecisionContext; nextDecision: DecisionContext | null;
  scoreDelta: { axis: number; allies: number; bySeat: GameState['scores'] };
  turnsAdvanced: number;
};
export type TrainingSummary = Pick<TrainingRecord,'index'|'round'|'seat'|'alliance'|'decision'|'nextDecision'|'scoreDelta'|'turnsAdvanced'|'candidateCount'> &
  { recordType: 'decision-summary'; actionId: string; cardType?: BasicAction };
export type TrainingTransitionInfo = {
  decision: DecisionContext; nextDecision: DecisionContext | null;
  scoreDelta: TrainingRecord['scoreDelta']; turnsAdvanced: number;
  termination: 'ongoing' | 'natural' | 'truncated'; winner: GameState['winner'];
};
export type TrainingHeader = {
  recordType: 'AI训练记录'; format: typeof TRAINING_FORMAT; curriculum: typeof TRAINING_CURRICULUM;
  gameId: string; episodeId: string; seed: number; configHash: string; buildFingerprint: string;
  policyId: string | null; policySeed: number | null; informationModel: 'public-finite-resource-pool';
  rules: { prelude: false; neutrality: false; balance: true; resourceMode: 'finite-pool'; basicCards: typeof BASIC_ACTIONS };
  basicCardCounts: ArenaObservation['resources']; mapVersion: string;
};
export type TrainingEnd = { recordType: 'result'; termination: 'natural' | 'truncated'; truncationReason?: string;
  decisions: number; round: number; winner: GameState['winner']; victoryReason: GameState['victoryReason'];
  scores: GameState['scores']; allianceScores: ReturnType<typeof allianceScores>;
  finalObservation?: ArenaObservation };
export type ArenaSnapshot = { format: typeof TRAINING_FORMAT; header: TrainingHeader; decisionCount: number;
  terminationReason: string | null; finalObservation: ArenaObservation | null;
  state: GameState; records: TrainingRecord[] };

const available = (s: GameState): ArenaObservation['resources'] => Object.fromEntries(SEATS.map(seat => [seat,
  Object.fromEntries(BASIC_ACTIONS.map(type => [type,s.decks[seat].hand.filter(c => c.definitionId === type).length]))
])) as ArenaObservation['resources'];

const snapshot = (s: GameState) => ({ scores: { ...s.scores }, resources: available(s), units: s.units.map(u => ({ ...u })) });
const unitReserve = (s: GameState): ArenaObservation['availableUnitReserve'] => Object.fromEntries(
  (Object.keys(COUNTRY_NAMES) as CountryId[]).map(country => [country, Object.fromEntries(
    (['army','navy','air'] as const).map(type => [type,reserve(s,country,type)]))]),
) as ArenaObservation['availableUnitReserve'];
export const effectiveUnitTotal = (country: CountryId, balance = true) => ({
  ...UNIT_TOTALS[country], army: UNIT_TOTALS[country].army + (balance && country === 'italy' ? 1 : 0),
});
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const hash = (value: unknown) => {
  const str=JSON.stringify(value); let n=2166136261;
  for(let i=0;i<str.length;i++) n=Math.imul(n^str.charCodeAt(i),16777619);
  return (n>>>0).toString(16).padStart(8,'0');
};
const isBuildFingerprint=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/i.test(value);
let episodeSequence=0;
const newEpisodeId=()=>`${globalThis.crypto.randomUUID()}-${++episodeSequence}`;
const internalEvents=new Set(['FRAME_STARTED','EFFECT_DECLARED','EFFECT_APPLIED','EFFECT_ENDED',
  'CARD_OWN_EFFECTS_COMPLETE','FINISH_CARD_RESOLUTION','RESOLUTION_COMPLETE']);

/** Uses the production engine for map, supply, placement, battles, scoring and victory. */
export class BasicTrainingArena {
  private state: GameState;
  header: TrainingHeader;
  readonly records: TrainingRecord[] = [];
  private decisionCount=0;
  private observationCache: ArenaObservation | null | undefined;
  private terminationReason: string | null = null;
  private finalObservation: ArenaObservation | null = null;
  private readonly trace: TraceLevel;
  private readonly keepRecords: boolean;

  constructor(seed: number, gameId = `training-${seed}`, options: ArenaOptions | boolean = {}) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !gameId.trim()) throw new Error('Invalid training game seed or ID');
    const config=typeof options==='boolean' ? {keepRecords:options,trace:'full' as const} : options;
    if(config.requireBuildFingerprint && !isBuildFingerprint(config.buildFingerprint))
      throw new Error('A SHA-256 build fingerprint is required for an identified training run');
    this.trace=config.trace??'none';this.keepRecords=config.keepRecords??false;
    const s = createGame(gameId,seed,'FULL',false,false,true);
    // Finite pool: every remaining basic card is available. There is no opening draft,
    // seven-card limit, draw pile, air card or special card in this curriculum.
    for (const seat of SEATS) {
      const cards: CardInstance[] = BASIC_ACTIONS.flatMap((type,index) => Array.from(
        { length: BASIC_COUNTS[seat][index] + (seat === 'italy' && (type === 'build_navy' || type === 'sea_battle') ? 1 : 0) },
        (_,i) => ({ id:`${seat}:${type}:${i+1}`, definitionId:type, country:seat, deckOwner:seat, balance:true }),
      ));
      s.decks[seat] = { hand:cards, drawPile:[], discardPile:[], active:[], faceDown:[], resolving:[], removed:[] };
    }
    s.status='PLAYING'; s.round=1; s.phase='TURN_START_WINDOW'; s.setupCompleted=[...SEATS];
    s.trainingBasicOnly=true;
    s.viewSeat=s.operatorSeat=s.activeSeat='germany';
    s.settings.ignoreOtherPlayerInterrupts=false;
    s.events=[]; s.publicLog=[];
    this.state=s;
    const rules={prelude:false,neutrality:false,balance:true,resourceMode:'finite-pool',basicCards:BASIC_ACTIONS} as const;
    this.header={recordType:'AI训练记录',format:TRAINING_FORMAT,curriculum:TRAINING_CURRICULUM,
      gameId,episodeId:newEpisodeId(),seed,configHash:hash({curriculum:TRAINING_CURRICULUM,rules,mapVersion:MAP.version,
        counts:available(s),unitTotals:TRAINING_COUNTRIES.map(c=>c.effectiveUnitTotal)}),
      buildFingerprint:config.buildFingerprint??'unspecified',policyId:config.policyId??null,policySeed:config.policySeed??null,
      informationModel:'public-finite-resource-pool',
      rules,
      basicCardCounts:available(s),mapVersion:MAP.version};
    this.advanceToDecision();
  }

  get done() { return this.state.status === 'FINISHED' || this.terminationReason!==null; }
  get decisions() { return this.decisionCount; }
  get result(): TrainingEnd | null {
    if (!this.done) return null;
    const truncated=this.terminationReason!==null;
    return {recordType:'result',termination:truncated?'truncated':'natural',
      ...(truncated?{truncationReason:this.terminationReason!,finalObservation:this.finalObservation!}:{}),decisions:this.decisionCount,
      round:this.state.round,winner:truncated?null:this.state.winner,
      victoryReason:this.state.victoryReason,scores:{...this.state.scores},allianceScores:allianceScores(this.state)};
  }

  observe(): ArenaObservation | null {
    if(this.observationCache!==undefined)return this.observationCache;
    if (this.done) return null;
    const s=this.state;
    if (s.phase!=='PLAY' || s.resolution?.running || s.pendingAir.length || s.pendingDiscard) throw new Error(`Training arena stopped outside PLAY: ${s.phase}`);
    const hand=s.decks[s.activeSeat].hand;
    const candidates: ArenaAction[]=[];
    for (const type of BASIC_ACTIONS) {
      const card=hand.find(c=>c.definitionId===type);
      if (!card) continue;
      for (const option of cardOptions(s,card.id)) candidates.push({id:`${type}|${option.id}`,kind:'play',cardType:type,option});
    }
    candidates.push({id:'pass',kind:'pass'});
    const observation: ArenaObservation={decision:{episodeId:this.header.episodeId,gameId:this.header.gameId,
      decisionId:this.decisionCount,revision:s.revision},
      round:s.round,phase:'PLAY',activeSeat:s.activeSeat,alliance:allianceOf(s.activeSeat),
      scores:{...s.scores},allianceScores:allianceScores(s),units:s.units.map(u=>({...u})),
      suppliedUnitIds:[...suppliedUnits(s)],resources:available(s),availableUnitReserve:unitReserve(s),candidates};
    return this.observationCache=frozen(observation);
  }

  step(request: ActionSubmission): { observation: ArenaObservation | null; result: TrainingEnd | null;
    info: TrainingTransitionInfo; record: TrainingRecord | TrainingSummary | null } {
    const obs=this.observe();
    if (!obs) throw new Error('Game has finished');
    const context=obs.decision;
    if(!request || request.episodeId!==context.episodeId || request.gameId!==context.gameId ||
      request.decisionId!==context.decisionId || request.revision!==context.revision)
      throw new Error('Stale decision context');
    const action=obs.candidates.find(a=>a.id===request.actionId);
    if (!action) throw new Error(`Unknown candidate: ${request.actionId}`);
    const s=this.state, before=this.trace==='full'?snapshot(s):null;
    const startScores={...s.scores},startAlliances=allianceScores(s);
    const startTurns=(s.round-1)*SEATS.length+SEATS.indexOf(s.activeSeat);
    const coreCommand: Command = action.kind==='pass'
      ? {type:'ADVANCE_PHASE',seat:s.activeSeat,expectedRevision:s.revision}
      : {type:'PLAY_BASIC',seat:s.activeSeat,expectedRevision:s.revision,
          cardId:s.decks[s.activeSeat].hand.find(c=>c.definitionId===action.cardType)!.id,optionId:action.option.id};
    this.commit(coreCommand);
    this.advanceToDecision();
    const next=this.state;
    this.decisionCount++;
    this.observationCache=undefined;
    const nextObservation=this.observe();
    const endAlliances=allianceScores(next);
    const scoreDelta={axis:endAlliances.axis-startAlliances.axis,allies:endAlliances.allies-startAlliances.allies,
      bySeat:Object.fromEntries(SEATS.map(seat=>[seat,next.scores[seat]-startScores[seat]])) as GameState['scores']};
    const endTurns=next.status==='FINISHED'?(next.round-1)*SEATS.length+SEATS.length:
      (next.round-1)*SEATS.length+SEATS.indexOf(next.activeSeat);
    const shared={index:this.decisionCount,round:obs.round,seat:obs.activeSeat,alliance:obs.alliance,
      decision:context,nextDecision:nextObservation?.decision??null,scoreDelta,turnsAdvanced:Math.max(0,endTurns-startTurns),
      candidateCount:obs.candidates.length};
    const result=this.result;
    const info:TrainingTransitionInfo={decision:context,nextDecision:shared.nextDecision,
      scoreDelta,turnsAdvanced:shared.turnsAdvanced,termination:result?.termination??'ongoing',
      winner:result?.winner??null};
    let record: TrainingRecord | TrainingSummary | null=null;
    if(this.trace==='summary')record={recordType:'decision-summary',...shared,actionId:action.id,
      ...(action.kind==='play'?{cardType:action.cardType}:{})};
    if(this.trace==='full')record={recordType:'decision',...shared,phase:'PLAY',
      action:action.kind==='pass'?{id:'pass',kind:'pass',label:'不出牌，扣1分并结束出牌阶段'}
        :{id:action.id,kind:'play',cardType:action.cardType,optionId:action.option.id,
          label:`打出【${BASIC_NAMES[action.cardType]}】：${action.option.label}`},
      before:before!,after:snapshot(next),engineEvents:next.events.filter(e=>e.type!=='RULE_EVENT'||!internalEvents.has(e.code)).map(e=>({...e})),
      publicRecords:(next.publicLog??[]).map(e=>({...e}))};
    if(this.keepRecords&&record?.recordType==='decision')this.records.push(record);
    // Core transitions clone their input. Keep per-decision diagnostics outside
    // the mutable engine state so long games do not repeatedly clone full logs.
    next.events=[];next.publicLog=[];
    return {observation:nextObservation,result,info,record};
  }

  truncate(reason='max_decisions'): TrainingEnd {
    if(this.done)throw new Error('Game has already ended');
    if(!reason.trim())throw new Error('Truncation reason must not be empty');
    this.finalObservation=this.observe();
    this.terminationReason=reason;this.observationCache=null;
    return this.result!;
  }

  exportSnapshot(): ArenaSnapshot {
    return structuredClone({format:TRAINING_FORMAT,header:this.header,decisionCount:this.decisionCount,
      terminationReason:this.terminationReason,finalObservation:this.finalObservation,
      state:this.state,records:this.records});
  }

  static fromSnapshot(input:ArenaSnapshot, options:ArenaOptions={}): BasicTrainingArena {
    const saved=structuredClone(input);
    if(saved?.format!==TRAINING_FORMAT || saved.header?.format!==TRAINING_FORMAT ||
      saved.header.curriculum!==TRAINING_CURRICULUM || !Number.isSafeInteger(saved.decisionCount) ||
      saved.decisionCount<0 || !saved.state || saved.state.gameId!==saved.header.gameId ||
      saved.state.seed!==saved.header.seed || saved.state.mode!=='FULL' ||
      saved.state.rules?.balanceEnabled!==true || saved.state.rules?.preludeEnabled!==false ||
      saved.state.rules?.neutralityEnabled!==false || !SEATS.includes(saved.state.activeSeat) ||
      saved.state.trainingBasicOnly!==true ||
      !saved.header.episodeId || !saved.header.configHash || saved.header.mapVersion!==MAP.version ||
      saved.header.rules?.prelude!==false || saved.header.rules?.neutrality!==false ||
      saved.header.rules?.balance!==true || saved.header.rules?.resourceMode!=='finite-pool' ||
      !Number.isSafeInteger(saved.state.revision) || saved.state.revision<0 ||
      !Array.isArray(saved.records) || saved.records.length>saved.decisionCount ||
      !(saved.terminationReason===null || typeof saved.terminationReason==='string' && !!saved.terminationReason.trim()) ||
      (saved.terminationReason!==null && !saved.finalObservation) ||
      (saved.state.status!=='FINISHED' && saved.terminationReason===null &&
        (saved.state.phase!=='PLAY' || saved.state.resolution?.running ||
          saved.state.pendingDiscard || saved.state.pendingAir?.length)) ||
      SEATS.some(seat=>!saved.state.decks?.[seat] || Object.values(saved.state.decks[seat]).some(zone=>
        Array.isArray(zone)&&zone.some(card=>card&&typeof card==='object'&&'definitionId' in card&&
          !BASIC_ACTIONS.includes(card.definitionId as BasicAction)))))
      throw new Error('Invalid or incompatible training snapshot');
    if(!isBuildFingerprint(saved.header.buildFingerprint) || !isBuildFingerprint(options.buildFingerprint) ||
      saved.header.buildFingerprint.toLowerCase()!==options.buildFingerprint.toLowerCase())
      throw new Error('Training snapshot build fingerprint does not match the current build');
    const arena=new BasicTrainingArena(saved.header.seed,saved.header.gameId,options);
    if(arena.header.configHash!==saved.header.configHash)throw new Error('Training configuration differs from snapshot');
    arena.state=saved.state;arena.header=saved.header;arena.decisionCount=saved.decisionCount;
    arena.terminationReason=saved.terminationReason;arena.finalObservation=saved.finalObservation;
    arena.records.splice(0,0,...saved.records);
    arena.observationCache=undefined;
    return arena;
  }

  private commit(command: Command) {
    const result=transition(this.state,command);
    if (!result.ok) throw new Error(`Core rejected ${command.type}: ${result.error}`);
    this.state=result.state;
  }

  private advanceToDecision() {
    for (let i=0;i<100;i++) {
      const s=this.state;
      if (s.status==='FINISHED' || s.phase==='PLAY' && !s.resolution?.running && !s.pendingDiscard && !s.pendingAir.length) return;
      if (s.resolution?.running || s.pendingDiscard || s.pendingAir.length) throw new Error('Unexpected special-card or air choice in basic arena');
      if (s.phase==='TURN_START_WINDOW'||s.phase==='AIR'||s.phase==='SUPPLY'||s.phase==='SCORE'||s.phase==='DRAW') {
        this.commit({type:'ADVANCE_PHASE',seat:s.activeSeat,expectedRevision:s.revision});continue;
      }
      if (s.phase==='DISCARD') {
        this.commit({type:'DISCARD_HAND',seat:s.activeSeat,expectedRevision:s.revision,cardIds:[]});continue;
      }
      throw new Error(`Unexpected basic arena phase: ${s.phase}`);
    }
    throw new Error('Basic arena did not reach a decision or terminal state');
  }
}

export type TrainingPolicy = (observation: ArenaObservation) => string;

export function playTrainingGame(seed:number,policy:TrainingPolicy,maxDecisions=2000) {
  const arena=new BasicTrainingArena(seed);
  while (!arena.done) {
    if (arena.decisions>=maxDecisions) { arena.truncate();break; }
    const observation=arena.observe()!;
    arena.step({...observation.decision,actionId:policy(observation)});
  }
  return arena;
}

export function trainingLogLines(arena:BasicTrainingArena):string[] {
  return [arena.header,...arena.records,...(arena.result?[arena.result]:[])].map(item=>JSON.stringify(item));
}

export const TRAINING_REGIONS = REGIONS.map(r=>({id:r.id,name:r.name,type:r.type,supply:r.supply,
  homeCountry:r.homeCountry,initialArmyCountry:r.initialArmyCountry}));
export const TRAINING_MAP_TOPOLOGY={baseEdges:MAP.baseEdges,straits:MAP.straits};
export const TRAINING_COUNTRIES = (Object.keys(COUNTRY_NAMES) as CountryId[]).map(country=>({
  id:country,name:COUNTRY_NAMES[country],alliance:allianceOf(country),seat:seatOf(country),
  effectiveUnitTotal:effectiveUnitTotal(country,true),
}));
export const regionName=(id:string)=>REGION_BY_ID[id]?.name??id;

/** A cheap legal-action opponent; scores are sampling weights, never legality filters. */
export function basicActionWeight(observation:ArenaObservation, action:ArenaAction):number {
  if(action.kind==='pass')return 0.3;
  const region=REGION_BY_ID[action.option.regionId];
  const remaining=observation.resources[observation.activeSeat][action.cardType];
  const scarce=remaining<=1?0.4:remaining<=2?0.7:1;
  if(action.cardType==='land_battle'||action.cardType==='sea_battle')
    return (action.option.defenderId?7:0.35)*scarce;
  const own=observation.units.some(unit=>unit.country===observation.activeSeat&&
    unit.type===(action.cardType==='build_army'?'army':'navy')&&unit.regionId===action.option.regionId);
  const supply=region?.supply?2.5:1;
  const hostileHome=region?.homeCountry&&allianceOf(region.homeCountry)!==observation.alliance?1.8:1;
  return (own?0.4:2)*supply*hostileHome*scarce;
}

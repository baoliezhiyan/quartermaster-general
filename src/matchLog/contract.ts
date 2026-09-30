/** Normative exchange types, NOT a replay implementation.
 * Companion: 对局记录与回放交换规范-v1.1.md
 * Document v1.1; wire formatVersion=2. Supersedes v1.0 contract.
 * Undo truncates the active file and increments recordingRevision.
 * Runtime validation must additionally check references, counts, scopes and hashes.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Seat = 'germany' | 'united_kingdom' | 'japan' | 'soviet_union' | 'italy' | 'united_states';
export type Country = Seat | 'france' | 'china';
export type Alliance = 'axis' | 'allies';
export type Ref = string;
export type Scope = { public: boolean; seats: Seat[] };
export type Scores = {
  bySeat: Record<Seat, number>;
  byAlliance: Record<Alliance, number>;
  adjustments: { id: Ref; alliance: Alliance; amount: number; reason: string }[];
};
export type Controller = { controllerId: Ref; kind: 'human' | 'ai' | 'system'; displayName: string };
export type ControllerMap = Record<Seat, { controllerId: Ref | null; bound: boolean }>;
export type RulesPackage = {
  packageId: Ref; version: string; fingerprint: string;
  balancePatch: Json; preludeEnabled: boolean; neutralityEnabled: boolean;
  turnOrder: Seat[]; scoring: Json; victory: Json;
};
/** Structured policy data only; never executable expressions. */
export type PolicyDefinition = { kind: string; version: string; parameters: { [key: string]: Json } };
/** Required parameters for the current stage1 definitions:
 * stage1.open_all: {}.
 * stage1.open_sampled: { nonBasicFraction:0.6, nonBasicMinimum:6,
 *   rounding:'ceil', capAtRemaining:true, sampleBy:'instance', replacement:false,
 *   basicProbabilities:[{minimumCount:4,probability:1},{minimumCount:3,probability:0.9},
 *     {minimumCount:2,probability:0.7},{minimumCount:1,probability:0.4},
 *     {minimumCount:0,probability:0}], independentPerBasicType:true,
 *   openAllInstancesOnBasicSuccess:true }.
 * stage1.refresh: { initializeAllSeats:true, skipFirstOwnTurn:true,
 *   refreshAt:'own_turn_start_before_choices', refreshOnExtraPlay:false,
 *   refreshOnObserveOrRestore:false, refreshOnCountChange:false }.
 * stage1.random_payment: { source:'remaining_pool_including_closed',
 *   replacement:false, excludeResolvingAndInstalled:true,
 *   constrainedCosts:'eligible_instances', activeHandCostRequiresFull:true }.
 * version='1' for these definitions. shortfallPolicy MUST additionally enumerate
 * the frozen forced-discard/deck-shortfall behavior; no shared invented default.
 */
export type ResourceConfig =
  | { mode: 'standard'; deckComposition: Record<Seat, Record<Ref, number>>;
      openingDraw: number; openingKeep: number; handLimit: number | null; configuration: Json }
  | { mode: 'resource_pool'; courseId: Ref; courseVersion: string; cardSet: 'basics' | 'events' | 'custom'; availabilityMode: string;
      composition: Record<Seat, Record<Ref, number>>; whitelist: Ref[];
      openingPolicy: PolicyDefinition; refreshPolicy: PolicyDefinition; paymentPolicy: PolicyDefinition;
      shortfallPolicy: PolicyDefinition; overrides: { definitionId: Ref; description: string; rule: Json }[] };
export type CatalogCard = {
  catalogEntryId: Ref; definitionId: Ref; name: string; text: string; cardType: string;
  printedCountry: Country; deckOwner: Seat; instanceCount: number;
  overrides: Json; art: { assetId: Ref; fingerprint: string | null } | null;
  /** Ordered semantic rule data; no executable scripts. */
  effectDefinition: Json;
};
export type Header = {
  recordType: 'header'; seq: 0; format: 'quartermaster-match-log'; formatVersion: 2;
  recordingId: Ref; recordingRevision: number; historyPolicy: 'truncate_on_undo';
  matchId: Ref; createdAt: string;
  gameVersion: string;
  /** Must agree with mode: standard=exact_game_version; resource_pool=declared_schema.
   * requiredFeatures must include qm.fact_state.v1, qm.knowledge.v1 and exactly
   * qm.standard_areas.v1 or qm.resource_pool_areas.v1 as appropriate.
   * Unknown required feature => reject; optional diagnostic extensions may be ignored.
   */
  compatibility: { policy: 'exact_game_version' | 'declared_schema'; requiredFeatures: string[] };
  producer: { name: string; version: string; buildFingerprint: string };
  mode: 'standard' | 'resource_pool'; capture: 'full_fidelity';
  stateSchemaVersion: 1; decisionSchemaVersion: 1; eventSchemaVersion: 1;
  origin: { kind: 'creation' | 'snapshot'; description: string;
    parentRecordingId: Ref | null; parentRecordingRevision: number | null; parentSeq: number | null; round: number; phase: string };
  rules: RulesPackage; resourceConfig: ResourceConfig;
  participants: Controller[]; controllers: ControllerMap;
  catalog: CatalogCard[];
  map: { version: string; fingerprint: string; regions: {
    regionId: Ref; name: string; terrain: string; homeCountry: Country | null;
    baseSupply: Json; displayPosition: { x: number; y: number } | null;
  }[]; adjacency: Json; straits: Json; artAssetId: Ref | null };
  seed: number | string | null;
  rngDefinitions: { streamId: Ref; algorithmId: Ref; algorithmVersion: string; purpose: string }[];
  capabilities: { privateViews: true; nativeVerification: boolean; aiDiagnostics: boolean };
};
export type CardInstance = {
  instanceId: Ref; definitionId: Ref; deckOwner: Seat; printedCountry: Country;
  effectiveDefinitionRef: Ref;
};
export type AreaKind = 'regular_hand' | 'regular_deck' | 'regular_discard'
  | 'prelude_hand' | 'prelude_deck' | 'prelude_discard'
  | 'resource_pool' | 'resource_discard' | 'active' | 'face_down_response'
  | 'face_down_armament' | 'resolving' | 'removed';
export type Area = { areaId: Ref; seat: Seat; kind: AreaKind; ordered: boolean;
  cardIds: Ref[]; displayOrder: Ref[] | null };
export type EntityRef = { kind: 'card' | 'unit' | 'region' | 'country' | 'seat' | 'area'; id: Ref };
export type Cause = {
  transactionId: Ref | null; rootActionId: Ref | null; parentEventId: Ref | null;
  resolutionFrameId: Ref | null; effectId: Ref | null; sourceCardInstanceId: Ref | null;
};
export type Option = {
  optionId: Ref; label: string;
  semanticType: string; entities: EntityRef[];
  /** Ordered targets, amounts, action kind and other concrete choice parameters. */
  payload: Json;
};
export type Decision = {
  decisionId: Ref; activeSeat: Seat; decisionSeat: Seat; controllerId: Ref | null;
  sourceSeat: Seat | null; unitCountry: Country | null;
  kind: 'play_source' | 'target' | 'ordered_targets' | 'branch' | 'response'
    | 'air_defense' | 'pay_cost' | 'discard' | 'keep_opening' | 'extra_play'
    | 'end_phase' | 'confirm_effect';
  prompt: string; cause: Cause; triggerEventId: Ref | null;
  /** Must identify attack/source/region when relevant; not just a generic prompt. */
  triggerContext: Json; visibility: Scope; options: Option[];
  constraints: { min: number; max: number; ordered: boolean; allowSkip: boolean;
    allowCancel: boolean; allowDecline: boolean; dependencies: Json };
  selectedSoFar: Ref[];
};
export type EffectState = {
  effectId: Ref; kind: string; definition: Json;
  outcome: 'pending' | 'declared' | 'applied' | 'finished' | 'cancelled' | 'skipped';
  boundEntities: Record<string, EntityRef[]>; selectedTargetsOrdered: EntityRef[];
  result: Json; visibility: Scope;
};
export type ResolutionFrame = {
  frameId: Ref; parentFrameId: Ref | null; sourceCardInstanceId: Ref | null;
  sourceSeat: Seat | null; currentEffectId: Ref | null; effectsOrdered: EffectState[];
  windows: { windowId: Ref; triggerEventId: Ref; status: 'open' | 'closed';
    eligibleSeats: Seat[]; decisions: Ref[] }[];
};
export type AreaKnowledge = {
  areaId: Ref; visibleCount: number | null;
  knownCards: { instanceId: Ref; definitionId: Ref }[];
  /** Null unless order is actually known to this perspective. Index zero is top. */
  knownOrder: Ref[] | null; knownTopPrefix: Ref[];
  /** Face-down types can be public even though identity is not. */
  visibleTypeCounts: Record<string, number>;
};
export type KnowledgeView = {
  areas: AreaKnowledge[];
  visibleDecisionIds: Ref[];
  /** Explicit overrides prevent a visible decision from leaking private options. */
  decisions: Decision[];
  notificationIds: Ref[];
  knownOpenInstanceIds: Partial<Record<Seat, Ref[]>>;
  visibleFlagIds: Ref[]; visibleEffectIds: Ref[];
};
export type State = {
  stateSchemaVersion: 1; gameStatus: 'setup' | 'playing' | 'finished';
  result: null | { winner: Alliance | null; victoryReason: string };
  round: number; phase: string; activeSeat: Seat; completedCountryTurns: number;
  scores: Scores;
  units: { unitId: Ref; country: Country; type: 'army' | 'navy' | 'air';
    regionId: Ref; supplied: boolean; properties: Json }[];
  reserves: Record<Country, Record<'army' | 'navy' | 'air', number>>;
  regions: { regionId: Ref; controllers: Country[]; effectiveHomeFor: Country[];
    effectiveSupplyFor: Alliance[]; properties: Json }[];
  prelude: null | { active: boolean; round: number; turn: number; activeSeat: Seat;
    tension: number; initialization: string; cleanup: string };
  neutrality: null | Record<'soviet_union' | 'united_states', {
    neutral: boolean; reason: string | null; eventId: Ref | null }>;
  cards: Record<Ref, CardInstance>; areas: Area[];
  availability: null | Record<Seat, { cycleId: Ref; refreshAt: number;
    openInstanceIds: Ref[]; remainingCount: number; openCount: number }>;
  installed: { instanceId: Ref; kind: string; properties: Json }[];
  flags: { flagId: Ref; kind: string; data: Json; visibility: Scope }[];
  controllers: ControllerMap;
  pendingDecisions: Decision[];
  resolution: { frames: ResolutionFrame[]; executionOrder: Ref[] };
  notifications: { notificationId: Ref; eventId: Ref; recipients: Seat[];
    acknowledgedBy: Seat[]; title: string; text: string; entities: EntityRef[] }[];
  knowledge: { public: KnowledgeView; seats: Record<Seat, KnowledgeView> };
  /** Current state only. No accumulated event/log/recovery history. */
  extensions?: Record<string, Json>;
};
export type NativeCheckpoint = { engineId: Ref; buildFingerprint: string;
  stateSchemaVersion: string; state: Json; rngState: Json };
export type Start = { recordType: 'start'; seq: 1; timelineId: Ref;
  state: State; engineCheckpoint?: NativeCheckpoint };
export type EventType = 'decision_opened' | 'decision_submitted' | 'decision_skipped'
  | 'decision_declined' | 'decision_cancelled' | 'card_declared' | 'cost_paid'
  | 'card_moved' | 'card_installed' | 'card_effects_completed' | 'card_finalized'
  | 'effect_declared' | 'effect_applied' | 'effect_finished' | 'effect_skipped' | 'effect_cancelled'
  | 'window_opened' | 'window_closed' | 'battle_declared' | 'battle_defended' | 'battle_finished'
  | 'unit_built' | 'unit_recruited' | 'unit_moved' | 'unit_removed' | 'supply_changed'
  | 'control_changed' | 'home_changed' | 'phase_started' | 'phase_ended'
  | 'turn_started' | 'turn_ended' | 'round_started' | 'round_ended'
  | 'prelude_tension_changed' | 'prelude_ended' | 'neutrality_ended' | 'score_changed'
  | 'game_finished' | 'random_resolved' | 'availability_refreshed' | 'availability_pruned'
  | 'notification_changed' | 'control_restored' | 'gm_edited' | 'controller_changed';
export type Event = {
  eventId: Ref; eventType: EventType; actorSeat: Seat | null; sourceSeat: Seat | null;
  entities: EntityRef[]; cause: Cause; visibility: Scope;
  outcome: 'occurred' | 'cancelled' | 'skipped'; before: Json; after: Json;
  details: Json; text: string;
};
export type Action = {
  actionId: Ref; decisionId: Ref; actorSeat: Seat; controllerId: Ref | null;
  optionIdsOrdered: Ref[]; selection: Json;
  disposition: 'submit' | 'skip' | 'decline' | 'cancel';
  origin: 'user' | 'ai' | 'timeout' | 'autopolicy' | 'forced_single_option';
};
export type RandomResult = {
  randomId: Ref; streamId: Ref; purpose: string; effectId: Ref | null; decisionId: Ref | null;
  samplingRule: Json;
  domain: { stateSeq: number; areaId: Ref | null; orderedIds: Ref[] | null };
  /** Entire actual permutation for shuffle, actual selected IDs for sampling. */
  result: Json; visibility: Scope; rngBefore?: Json; rngAfter?: Json;
};
export type Control = {
  kind: 'gm_edit' | 'controller_change';
  reason: string; actorControllerId: Ref | null;
};
export type FrameBase = {
  recordType: 'frame'; seq: number; beforeStateSeq: number; timelineId: Ref;
  cause: Cause; events: Event[]; state: State;
  /** Only once at transaction origin; never replay again for each automatic child. */
  nativeCommand?: { engineId: Ref; schemaVersion: string; command: Json };
  engineCheckpoint?: NativeCheckpoint;
  aiDiagnostics?: { policyId: Ref; policyVersion: string; decisionId: Ref;
    candidates: { optionIdsOrdered: Ref[]; probability: number; logit: number | null }[];
    selectedProbability: number; value: number | null };
};
/** decisionBeforeStateSeq equals beforeStateSeq and references a state containing
 * the full matching pendingDecision. UI defaults to this PRE-decision state.
 * For after-view use this frame.state. Automatic actions obey the same rule.
 */
export type Frame = FrameBase & (
  | { kind: 'decision'; action: Action; decisionBeforeStateSeq: number }
  | { kind: 'random'; randomResult: RandomResult }
  | ({ kind: 'automatic'; automationReason: string } & (
      { action: Action; decisionBeforeStateSeq: number } |
      { action?: never; decisionBeforeStateSeq?: never }))
  | { kind: 'control'; control: Control }
);
export type End = {
  recordType: 'end'; seq: number; lastStateSeq: number;
  recordingStatus: 'complete' | 'partial';
  stopReason: 'natural_game_end' | 'export_while_playing' | 'training_truncated'
    | 'interrupted' | 'snapshot_segment';
  gameStatus: 'setup' | 'playing' | 'finished'; winner: Alliance | null;
  victoryReason: string | null; finalScores: Scores;
  frameCount: number;
  /** Accepted Action objects, including recorded automatic choices; no rejected commands. */
  decisionCount: number;
  /** SHA256 of all original UTF8 bytes preceding this end line, including LF. */
  prefixSha256: string;
};
export type MatchLogRecord = Header | Start | Frame | End;

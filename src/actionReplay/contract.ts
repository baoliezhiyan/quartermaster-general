/** 运行时契约，2026-09-30。formatVersion=3；v1.7.1 使用此动作回放契约。
 * JSON对象字段必须由指定适配器schema严格校验，不能直接透传任意对象执行。
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectData = { [key: string]: Json };
export type Seat = 'germany' | 'united_kingdom' | 'japan' | 'soviet_union' | 'italy' | 'united_states';
// 与现有引擎座位ID一致；法国/中国是unitCountry，不是新增决策座位。
export interface Line { seq: number; type: string }
export interface Header extends Line {
  type: 'header'; seq: 0;
  format: 'quartermaster-match-log'; formatVersion: 3; recordingModel: 'action_replay';
  recordingId: string; recordingRevision: number; gameId: string;
  origin: 'creation' | 'snapshot'; mode: 'standard' | 'resource_pool';
  gameVersion: string; engineFingerprint: string;
  replayAdapter: { id: string; version: string };
  commandSchemaVersion: string; checkpointSchemaVersion: string;
  rulesFingerprint: string; catalogFingerprint: string; mapFingerprint: string;
  rulesConfig: ObjectData; // 序章/中立/平衡等，不嵌入卡表地图全文。
  producer: { name: string; version: string };
  training?: {
    courseId: string; courseVersion: string; configurationFingerprint: string;
    eventDefinitionIds: string[]; availability: 'A' | 'B';
    availabilityParameters: ObjectData; costSamplingRuleId: string;
    overrideRuleIds: string[]; // 对应本地已实现覆盖，不是可执行脚本。
  };
  digest: { algorithm: 'SHA-256'; canonicalization: string };
}
export interface Snapshot {
  // 匹配适配器定义的完整规则状态，含卡实例/牌序/知识/随机流/ID计数器。
  // 禁止含累计日志、Session、旧快照、旧回放及UI缓存。
  ruleState: ObjectData;
}
export interface Start extends Line {
  type: 'start'; checkpointId: string; state: Snapshot; stateHash: string;
}
export interface Anchor {
  actionId: string; effectPath: string[]; timing: string; occurrence: number;
  // effectPath/timing由适配器稳定定义，不使用中文描述或易变窗口ID。
}
export interface Choice {
  at: Anchor; order: number; decisionSeat: Seat;
  kind: string; answer: Json; // schema限定目标/费用/分支等，可有显式“不支付”答案。
}
export interface Action {
  actionId: string;
  kind: 'play_card' | 'activate' | 'response' | 'opening_keep' | 'discard'
    | 'resource_reorganize' | 'phase_advance' | 'editor_change';
  decisionSeat: Seat; sourceSeat?: Seat; unitCountry?: string;
  cardInstanceId?: string; cardDefinitionId?: string;
  input: ObjectData; // 仅启动动作所需参数，不含已保存于choices中的重复答案。
  choices: Choice[];
  interventions: Array<{ at: Anchor; order: number; action: Action }>;
  summary?: string; // 只供显示，不驱动结算。
}
export interface GroupBase extends Line {
  type: 'action_group'; groupId: string; root: Action;
  stage: 'prelude' | 'opening' | 'formal'; round: number;
}
export type ActionGroup = GroupBase & (
  { status: 'complete'; afterHash?: string; frontier?: never }
  | { status: 'pending'; frontier: { at: Anchor; decisionSeat?: Seat; decisionKind: string } }
);
export interface Shuffle extends Line {
  type: 'shuffle'; shuffleId: string; groupId: string; at: Anchor; order: number;
  owner: Seat; zone: string; cardInstanceIds: string[]; // 全部洗后顺序，非部分差分。
  randomStreamAfter?: ObjectData; // 注入牌序仍必须正确推进对应随机流。
}
export interface RandomResult extends Line {
  type: 'random_result'; randomId: string; groupId: string; at: Anchor; order: number;
  kind: string; result: Json; randomStreamAfter?: ObjectData;
}
export interface CheckpointBase extends Line {
  type: 'checkpoint'; checkpointId: string;
  boundary: 'formal_start' | 'round_end'; completedRound: number; // formal_start=0
  afterGroupId: string | null; // 对应已完成的前缀，检查点不得切断一个组。
  stateHash: string;
}
export type Checkpoint = CheckpointBase & (
  { state: Snapshot; reuseCheckpointId?: never }
  | { reuseCheckpointId: string; state?: never } // 仅相同状态引用，不重复全量。
);
export interface End extends Line {
  type: 'end'; recordingRevision: number;
  status: 'finished' | 'ongoing'; lastCompleteGroupId: string | null;
  pendingGroupId?: string;
  winner?: 'axis' | 'allies' | 'draw';
  contentHash: string; // 前面所有行UTF-8原始字节（包含LF），不含本行。
}
export type RecordLine = Header | Start | ActionGroup | Shuffle | RandomResult | Checkpoint | End;

/** 必须另外实现的语义校验，TypeScript类型不足以保证：
 * 1 seq连续、ID唯一、1个header/start；end是导出稳定副本尾行。
 * 2 所有choice/intervention/random的order在同组唯一，实际重演顺序和锚点一致。
 * 3 子动作at指向父动作；无循环/孤立引用；shuffle可先于所属组物理写入。
 * 4 每条随机记录被消费恰好一次，洗牌前后实例多重集合一致。
 * 5 complete组没有待解答frontier；pending最多一个且是执行顺序末组。
 * 6 未记载可选响应自动跳过，必选答案缺失报错，pending在frontier停止。
 * 7 开局/轮末检查点数量与位置符合正文；引用仅向前且状态真的相同。
 * 8 正式版本与指纹严格匹配；训练由本地适配器白名单明确接纳。
 * 9 解析大小/深度有界；不执行文件内容；哈希按规范化规则计算。
 * 10 保存全局真值不等于向普通国家视角或PPO输入泄露真值。
 */

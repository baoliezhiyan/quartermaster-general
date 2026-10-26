import {COUNTRY_NAMES,cardName} from '../core/basic';
import {validateState} from '../controller/saveFormat';
import {specialCard} from '../core/cardCatalog';
/** Read-only training replay for real-hand games. Full states are audit data;
 * projectState, rather than this archive, defines each viewer's visibility. */
import type {GameState,Command,SeatId} from '../core/types';
import {SEATS} from '../core/types';
import type {GameController,RoomAccess,SessionInfo,DispatchResult} from '../controller/GameController';
import {projectState} from '../network/project';
import {ENGINE,hashText} from './state';
import type {Entry,Detail} from './player';
import type {Phrase} from './narrative';

export type HandReplayHeader={type:'header';seq:0;format:'quartermaster-match-log';formatVersion:4;
  recordingModel:'full_state';mode:'real_hand';recordingId:string;gameId:string;
  sceneEngineFingerprint:string;sourceBuildFingerprint:string;courseVersion:string;
  producer:{name:string;version:string};visibility:'gm-audit';};
export type HandReplaySelection={kind:'opening'|'discard'|'forced'|'choice';seat:SeatId;ids:string[]};
export type HandReplayStart={type:'start';seq:1;state:GameState;stateHash:string;
  selection?:HandReplaySelection|null};
export type HandReplayStep={type:'training_action';seq:number;id:string;seat:SeatId;round:number;
  summary:string;cardId?:string;state:GameState;stateHash:string;
  selection?:HandReplaySelection|null};
export type HandReplayEnd={type:'end';seq:number;contentHash:string};
export type HandReplayArchive={header:HandReplayHeader;start:HandReplayStart;
  steps:HandReplayStep[];end:HandReplayEnd};

const stateHash=(s:GameState)=>hashText(JSON.stringify(s));
function validateHandState(state:GameState,gameId?:string){
  if(!state||state.trainingHand?.version!=='ppo-real-hand-v1'||
      typeof state.gameId!=='string'||gameId&&state.gameId!==gameId||
      !Number.isSafeInteger(state.randomState)||!Number.isSafeInteger(state.round)||
      !SEATS.includes(state.activeSeat)||!state.decks)throw Error('真实手牌训练状态身份非法');
  // Validate the renderable scene with production invariants. Training audit events
  // are never passed to rules, so omit only those events for this structural check.
  const checked=structuredClone(state);
  checked.events=checked.events.filter(e=>['GAME_CREATED','UNIT_PLACED','VIEW_CHANGED','RULE_EVENT'].includes(e.type));
  // H exporter annotates basic cards with balance=true; production basic instances
  // omit that marker. It does not affect their definition, owner or rendering.
  for(const deck of Object.values(checked.decks))for(const cards of Object.values(deck))for(const c of cards)if(['build_army','build_navy','land_battle','sea_battle','air_power'].includes(c.definitionId))delete c.balance;
  validateState(checked,0,true);
  const ids=new Set<string>();
  for(const seat of SEATS){
    const deck=state.decks[seat];
    if(!deck)throw Error('真实手牌训练状态缺少国家牌区');
    for(const zone of ['hand','drawPile','discardPile','active','faceDown','resolving','removed'] as const){
      if(!Array.isArray(deck[zone]))throw Error('真实手牌训练状态牌区非法');
      for(const card of deck[zone]){
        if(typeof card?.id!=='string'||typeof card.definitionId!=='string'||
            card.deckOwner!==seat||ids.has(card.id)||!['build_army','build_navy','land_battle','sea_battle','air_power'].includes(card.definitionId)&&!specialCard(card.definitionId,card.balance))throw Error('真实手牌训练状态卡牌身份重复或非法');
        ids.add(card.id);
      }
    }
  }
}
function validateSelection(selection:HandReplaySelection|null|undefined,state:GameState){
  if(!selection)return;
  if(!SEATS.includes(selection.seat)||!['opening','discard','forced','choice'].includes(selection.kind)||
      !Array.isArray(selection.ids)||new Set(selection.ids).size!==selection.ids.length||
      selection.ids.some(id=>!state.decks[selection.seat].hand.some(card=>card.id===id)))
    throw Error('真实手牌临时选择非法');
}
/** An explicitly audited prior build may be opened only by a read-only viewer.
 * Ordinary replay import keeps the current rule fingerprint requirement. */
export const AUDITED_HAND_IDENTITIES=[
 {sceneEngineFingerprint:'e36b1106b16e468288e94807653a520de6efd29d9d4450bb2c01601df24900ce',sourceBuildFingerprint:'dc98938313ca85ab7a72522a0acec9b34d300d6a5b79f878cfb9d2448f47b54f'},
 {sceneEngineFingerprint:'b9d4efe59b4a9ed456f4dfc490844db0344ef36870a2c7131ce3f34644607d19',sourceBuildFingerprint:'83d4ac7537321cbe19796beabf36f2b6e37259f6d6f83a19da9c179f0cf97c33'},
] as const;
export async function parseRealHandTrainingReplay(text:string):Promise<HandReplayArchive>{
  if(!text.endsWith('\n')||text.includes('\r'))throw Error('真实手牌回放大小或行尾错误');
  const lines=text.slice(0,-1).split('\n');
  if(lines.length<3||lines.length>200000||lines.some(line=>line.length>16*1024*1024))throw Error('真实手牌回放行数错误');
  const records=lines.map(line=>JSON.parse(line));
  const header=records[0] as HandReplayHeader;
  if(header.type!=='header'||header.seq!==0||header.mode!=='real_hand'||
      header.format!=='quartermaster-match-log'||header.formatVersion!==4||
      header.recordingModel!=='full_state'||header.courseVersion!=='ppo-real-hand-v1'||typeof header.recordingId!=='string'||typeof header.gameId!=='string'||header.visibility!=='gm-audit'||
      !(header.sceneEngineFingerprint===ENGINE&&!AUDITED_HAND_IDENTITIES.some(identity=>identity.sceneEngineFingerprint===ENGINE)&&/^[a-f0-9]{64}$/.test(header.sourceBuildFingerprint)||AUDITED_HAND_IDENTITIES.some(identity=>header.sceneEngineFingerprint===identity.sceneEngineFingerprint&&header.sourceBuildFingerprint===identity.sourceBuildFingerprint)))
    throw Error('真实手牌回放身份或规则指纹不匹配');
  const start=records[1] as HandReplayStart;
  if(start.type!=='start'||start.seq!==1)throw Error('真实手牌回放缺少起点');
  validateHandState(start.state,header.gameId);
  validateSelection(start.selection,start.state);
  if(start.state.trainingHand?.version!=='ppo-real-hand-v1'||
      await stateHash(start.state)!==start.stateHash)throw Error('真实手牌回放起点损坏');
  const steps=records.slice(2,-1) as HandReplayStep[];
  for(const [index,step] of steps.entries()){
    if(step.type!=='training_action'||step.seq!==index+2||step.id!==`hand-training-${index+1}`||
        !SEATS.includes(step.seat)||!Number.isSafeInteger(step.round)||
        typeof step.summary!=='string')throw Error('真实手牌回放决策序列损坏');
    validateHandState(step.state,header.gameId);
    validateSelection(step.selection,step.state);
    if(step.state.gameId!==start.state.gameId||step.state.trainingHand?.version!=='ppo-real-hand-v1'||
        await stateHash(step.state)!==step.stateHash)throw Error(`真实手牌回放状态损坏：${step.id}`);
  }
  const end=records.at(-1) as HandReplayEnd;
  if(end.type!=='end'||end.seq!==records.length-1||
      end.contentHash!==await hashText(lines.slice(0,-1).join('\n')+'\n'))throw Error('真实手牌回放未完整封存');
  return {header,start,steps,end};
}

const readonly=async():Promise<never>=>{throw Error('真实手牌训练回放是只读的。');};
export class RealHandTrainingController implements GameController {
  readonly entries:Entry[];readonly narratives=new Map<string,Phrase[]>();
  readonly player:{details:Detail[]}={details:[]};selectedId:string|null=null;after=false;
  private raw:GameState;private view:GameState;private access:RoomAccess={kind:'gm'};
  private selection:HandReplaySelection|null=null;
  private seat:SeatId='germany';private listeners=new Set<()=>void>();
  private info:SessionInfo={replayMode:true,replayCursor:0,replayEntries:[],ready:true,
    canUndo:false,undoCount:0,savedAt:null,storageError:'',rounds:[],nations:[]};
  constructor(readonly archive:HandReplayArchive){
    this.raw=structuredClone(archive.start.state);this.view=this.raw;
    this.selection=archive.start.selection??null;
    this.entries=archive.steps.map((step,index)=>{
      const before=index?archive.steps[index-1].state:archive.start.state,seat=step.seat;
      const kept=step.state.decks[seat].hand,prior=before.decks[seat].hand;
      const dropped=prior.filter(c=>!kept.some(k=>k.id===c.id));
      const opening=before.phase==='SETUP'&&!before.setupCompleted.includes(seat)&&step.state.setupCompleted.includes(seat);
      const verified=opening&&prior.length===12&&kept.length===7&&dropped.length===5&&kept.every(c=>prior.some(p=>p.id===c.id))&&dropped.every(c=>step.state.decks[seat].discardPile.some(d=>d.id===c.id));
      const names=(cards:typeof kept)=>{const counts=new Map<string,number>();for(const c of cards)counts.set(cardName(c),(counts.get(cardName(c))??0)+1);return [...counts].map(([name,n])=>'【'+name+'】'+(n>1?'×'+n:'')).join('、');};
      return {id:step.id,groupId:step.id,round:step.round,
        stage:opening||before.phase==='SETUP'?'opening' as const:'formal' as const,seat,kind:'play_card',
        summary:verified?`${COUNTRY_NAMES[seat]}完成起手留牌：保留7张（${names(kept)}）；弃置5张（${names(dropped)}）`:step.summary};
    });
    this.publish();
  }
  async describe(){for(const step of this.archive.steps)this.narratives.set(step.id,[]);}
  async seek(id:string|null,after=false){
    const base=id?.split('@')[0],index=base?this.archive.steps.findIndex(step=>step.id===base):-1;
    if(base&&index<0)throw Error('真实手牌回放动作不存在');
    this.raw=structuredClone(index<0?this.archive.start.state:
      after?this.archive.steps[index].state:index===0?this.archive.start.state:this.archive.steps[index-1].state);
    this.selection=index<0?this.archive.start.selection??null:
      after?this.archive.steps[index].selection??null:
      index===0?this.archive.start.selection??null:this.archive.steps[index-1].selection??null;
    this.selectedId=id;this.after=after;this.publish();
  }
  private publish(){
    this.view=projectState(this.raw,this.access,this.seat)!;
    if(this.access.kind!=='gm')delete this.view.trainingHand;
    const visible=SEATS.flatMap(seat=>{
      const own=this.access.kind==='gm'||'seat'in this.access&&this.access.seat===seat;
      return ['active','discardPile',...(own?['hand','drawPile','faceDown']:[])].map(zone=>seat+':'+zone);
    });
    Object.assign(this.view,{trainingReplay:{available:visible,mode:'real_hand',
      selection:this.access.kind==='gm'||'seat'in this.access&&this.access.seat===this.selection?.seat?
        this.selection:null}});
    this.info={...this.info,replayCursor:this.entries.findIndex(e=>e.id===this.selectedId?.split('@')[0])+1};
    this.listeners.forEach(listener=>listener());
  }
  getSnapshot=()=>this.view;getSessionInfo=()=>this.info;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  setRoomAccess=(access:RoomAccess)=>{this.access=access;if('seat'in access)this.seat=access.seat;this.publish();};
  dispatch=async(command:Command):Promise<DispatchResult>=>{
    if(command.type!=='SET_VIEW')return {ok:false,error:'WRONG_OPERATOR'};
    this.seat=command.seat;this.publish();return {ok:true};};
  seekReplay=async(index:number)=>this.seek(this.entries[index]?.id??null);
  checkReplay=async()=>true;
  undo=readonly;loadCheckpoint=readonly;exportSave=readonly;exportReplay=readonly;
  importReplay=readonly;exportReplayNodeSave=readonly;importSave=readonly;editScene=readonly;
  exportDiagnostics=()=>JSON.stringify({adapter:'real-hand-training',
    recordingId:this.archive.header.recordingId,selectedId:this.selectedId,
    visibility:'full-fidelity-audit; policy observations are separate'});
}

export async function sealRealHandTrainingReplay(records:Array<HandReplayHeader|HandReplayStart|HandReplayStep>){
  const body=records.map(record=>JSON.stringify(record)).join('\n')+'\n';
  return body+JSON.stringify({type:'end',seq:records.length,contentHash:await hashText(body)})+'\n';
}
export {stateHash as realHandReplayStateHash};

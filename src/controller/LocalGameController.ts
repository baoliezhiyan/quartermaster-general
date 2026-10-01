import {readHistorySave,restoreHistoryTail,turnPoint} from '../actionReplay/historySave';
import {stateHash} from '../actionReplay/state';
import {captureTransition,recordCommand,restoreRecording,recordingPrefix} from '../actionReplay/recorder';
import type {Capture} from '../actionReplay/recorder';
import {seal,validateRecords} from '../actionReplay/codec';
import {endNeutrality} from '../core/neutrality';
import {measure,measureAsync} from './performanceProbe';
import {specialCard} from '../core/cardCatalog';
import {persistentHistory,finishPrelude,isPrelude,markPreludeInstall} from '../core/prelude';
import {prepareReplay,replayStateAt} from './replay';
import type {ReplayEntry,ReplayFile} from './replay';
import {refreshSceneResolution} from '../core/game';
import {concealPublic,revealPublic} from '../core/publicHistory';
import { transition } from '../core';
import type { Command, GameState } from '../core';
import type { DispatchResult, GameController, SessionInfo, RoomAccess } from './GameController';
import { validateSession, validateState, verifyReplay } from './saveFormat';
import type { SaveSession, Checkpoint } from './saveFormat';
import type { SessionStore } from './SessionStore';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Committed snapshots are immutable; copy only containers changed by this operation. */
function copySession(s:SaveSession):SaveSession {
 return {...s,rounds:[...s.rounds],nations:[...s.nations],historyPoints:[...(s.historyPoints??[])],historyArchives:{...s.historyArchives},historyArchivePoints:{...s.historyArchivePoints},undo:[...s.undo],commands:[...s.commands],
  recovery:s.recovery?{...s.recovery,steps:[...s.recovery.steps]}:undefined};
}

export class LocalGameController implements GameController {
  setFactControllers=(_controllers:import('../matchLog/contract').ControllerMap,_participants:import('../matchLog/contract').Controller[])=>{};
  recordControllerChange=async()=>{};
  private playback:{file:ReplayFile;cursor:number;entries:ReplayEntry[]}|null=null;
  private access:RoomAccess={kind:'gm'};
  setRoomAccess=(access:RoomAccess)=>{if(this.playback&&access.kind==='player')return;this.access=structuredClone(access);};
  private get readOnly(){return !!this.playback||this.access.kind==='observer'||this.access.kind==='public';}
  private state:GameState|null=null;
  private session:SaveSession|null=null;
  private listeners=new Set<()=>void>();
  private queue:Promise<unknown>=Promise.resolve();
  private info:SessionInfo={replayMode:false,replayCursor:0,replayEntries:[],ready:true,canUndo:false,undoCount:0,savedAt:null,storageError:'',rounds:[],nations:[]};
  private persistedVersions=new Map<string,string>();
  private failures:{command:unknown;error:string}[]=[];
  constructor(private store?:SessionStore, private strictStorage=false) {
    if(store) {
      this.info={...this.info,ready:false};
      this.queue=this.initialize();
    }
  }
  private async initialize() {
    try {const saved=await this.store!.read();if(saved){this.session=validateSession(saved);this.persistedVersions.set(this.session.state.gameId,this.session.updatedAt);this.state=deepFreeze(structuredClone(this.session.state));if(this.session.playback){const {file,cursor}=this.session.playback,prepared=prepareReplay(file);const expected=replayStateAt(file,cursor);expected.viewSeat=this.session.state.viewSeat;if(JSON.stringify(expected)!==JSON.stringify(this.session.state))throw new Error('回放节点与保存的局面不一致。');this.playback={file:prepared.file,entries:prepared.entries,cursor};this.access={kind:'gm'};}}}
    catch(error){this.info={...this.info,storageError:`自动恢复失败：${String(error)}`};}
    if(!this.info.storageError&&this.session&&!this.playback&&this.session.state.prelude&&!this.session.state.prelude.historyDiscard){this.restore(this.session,this.session.state,'升级序章弃牌规则');this.state=deepFreeze(this.session.state);}
    this.info={...this.info,ready:true,savedAt:this.session?.updatedAt??null};this.publish();
  }
  getSnapshot=()=>this.state;
  getSessionInfo=()=>this.info;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish() {
    const meta=(c:Checkpoint)=>({id:c.id,round:c.round,seat:c.seat,createdAt:c.createdAt,...(c.stage?{stage:c.stage}:{})});
    this.info={...this.info,replayMode:!!this.playback,replayCursor:this.playback?.cursor??0,replayEntries:this.playback?.entries??[],savePoints:this.session?.historyPoints??[],canUndo:!this.playback&&!!this.session?.undo.length,undoCount:this.session?.undo.length??0,rounds:this.session?.rounds.map(meta)??[],nations:this.session?.nations.map(meta)??[]};
    this.listeners.forEach(l=>l());
  }
  private enqueue<T>(action:()=>Promise<T>):Promise<T> {
    const run=this.queue.then(action);this.queue=run.catch(()=>undefined);return run;
  }
  private fresh(state:GameState):SaveSession {
    return {format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state:structuredClone(state),rounds:[],nations:[],undo:[],replayBase:structuredClone(state),commands:[],recovery:{initial:structuredClone(state),fromCreation:true,steps:[]}};
  }
  private checkpoint(session:SaveSession,state:GameState){
    const prelude=!!state.prelude?.active,round=prelude?state.prelude!.round??Math.floor((state.prelude!.turn-1)/6)+1:state.round;
    const prefix=prelude?'prelude:':'';
    const cp:Checkpoint={id:`${prefix}nation:${round}:${state.activeSeat}`,round,seat:state.activeSeat,createdAt:new Date().toISOString(),state,...(prelude?{stage:'prelude' as const}:{})};
    session.nations=[...session.nations.filter(c=>c.seat!==state.activeSeat),cp];
    if(state.activeSeat==='germany'){const id=`${prefix}round:${round}`;session.rounds=[...session.rounds.filter(c=>c.id!==id),{...cp,id}];}
    session.undo=[];
  }
  private async commit(session:SaveSession,replaceExisting=false) {
    if((this.access.kind==='player'||this.access.kind==='observer')&&session.state.viewSeat!==this.access.seat){
      const command:Command={type:'SET_VIEW',seat:this.access.seat,expectedRevision:session.state.revision};const result=transition(session.state,command);
      if(result.ok){this.ensureRecovery(session);session.commands.push(command);session.recovery!.steps.push({kind:'command',command});session.state=result.state;}
    }
    const expected=this.persistedVersions.get(session.state.gameId);
    session.updatedAt=new Date(Math.max(Date.now(),Date.parse(expected??'')+1||0)).toISOString();
    try {if(this.store){await measureAsync('save_write',()=>this.store!.write(session,expected,replaceExisting));if(replaceExisting)this.persistedVersions.clear();this.persistedVersions.set(session.state.gameId,session.updatedAt);}this.info={...this.info,savedAt:this.store?session.updatedAt:null,storageError:''};}
    catch(error){this.info={...this.info,storageError:`保存失败：${String(error)}`};if(this.strictStorage)throw new Error('服务端保存失败，操作未提交。');}
    this.session=measure('snapshot_freeze',()=>deepFreeze(session));this.state=session.state;measure('publish_listeners',()=>this.publish());
  }
  dispatch=(command:Command):Promise<DispatchResult>=>this.dispatchCommand(command,false);
  /** Room authorizes the seat; prepare view selection and the action atomically. */
  dispatchFromRoom=(command:Command):Promise<DispatchResult>=>this.dispatchCommand(command,true);
  private dispatchCommand=(command:Command,alignRoomView:boolean):Promise<DispatchResult>=>{
    const input=structuredClone(command);
    return this.enqueue(async()=>{
      if(this.playback&&input.type==='SET_VIEW'){
        if(!this.state||input.expectedRevision!==this.state.revision)return {ok:false,error:'STALE_REVISION'} as DispatchResult;
        const result=measure('engine_transition',()=>transition(this.state,input));if(!result.ok)return result;
        await this.showReplay(this.playback.cursor,result.state.viewSeat);return {ok:true};
      }
      if(this.readOnly&&input.type!=='SET_VIEW'&&!(this.playback&&input.type==='CREATE_GAME'))return {ok:false,error:'WRONG_OPERATOR'} as DispatchResult;
      if(this.access.kind==='player'&&input.type!=='CREATE_GAME'&&input.seat!==this.access.seat)return {ok:false,error:'WRONG_OPERATOR'} as DispatchResult;
      let base=this.state,viewCommand:Command|undefined;
      if(alignRoomView&&input.type!=='CREATE_GAME'&&base){
        if(input.expectedRevision!==base.revision)return {ok:false,error:'STALE_REVISION'};
        if(base.viewSeat!==input.seat){
          viewCommand={type:'SET_VIEW',seat:input.seat,expectedRevision:base.revision};
          const selected=transition(base,viewCommand);if(!selected.ok)return selected;
          base=selected.state;input.expectedRevision=base.revision;
        }
      }
      const captures:Capture[]=[];
      const result=measure('engine_transition',()=>captureTransition(captures,()=>transition(base,input)));
      if(!result.ok){this.failures.push({command:input,error:result.error});this.failures=this.failures.slice(-20);return result;}
      if(result.state===this.state)return {ok:true};
      const next=result.state,old=base;
      if(input.type==='CREATE_GAME'){this.playback=null;this.failures=[];if(this.access.kind!=='player')this.access={kind:'gm'};}
      const session=input.type==='CREATE_GAME'||!this.session?this.fresh(next):measure('clone_session',()=>copySession(this.session!));
      if(input.type==='CREATE_GAME'&&next.prelude?.active)this.checkpoint(session,next);
      if(input.type!=='CREATE_GAME'&&old) {
        this.ensureRecovery(session);
        if(viewCommand){session.recovery!.steps.push({kind:'command',command:viewCommand});session.commands.push(viewCommand);}
        session.recovery!.steps.push({kind:'command',command:input});
        session.commands.push(input);
        if(old.prelude?.active&&(next.activeSeat!==old.activeSeat||next.prelude?.turn!==old.prelude.turn||!next.prelude?.active))session.undo=[];
        const start=next.prelude?.active?(old.prelude?.turn!==next.prelude.turn||old.activeSeat!==next.activeSeat):next.status==='PLAYING'&&next.round>0&&(old.phase==='SETUP'||old.round!==next.round||old.activeSeat!==next.activeSeat);
        if(start) {
          this.checkpoint(session,next);
        } else if(input.type!=='SET_VIEW'&&input.type!=='ACK_RESPONSE_NOTICE'&&input.type!=='SET_CARD_RESPONSE'&&old.phase!=='SETUP'&&(!old.prelude?.active||next.prelude?.active&&old.activeSeat===next.activeSeat&&old.prelude.turn===next.prelude.turn))session.undo.push(old);
      }
      session.state=next;
      delete session.matchRecording;
      if(input.type!=='SET_VIEW')session.actionRecording=await recordCommand(this.session?.actionRecording,base,next,input,captures);
      if(session.nations.some(c=>c.state===next)){const point={...turnPoint(next),hash:await stateHash(next)};session.historyPoints=[...(session.historyPoints??[]).filter(p=>p.id!==point.id),point];}
      await this.commit(session,input.type==='CREATE_GAME');return {ok:true};
    });
  };
  private ensureRecovery(session:SaveSession) {
    session.recovery??={initial:structuredClone(session.replayBase),fromCreation:false,steps:session.commands.map(command=>({kind:'command',command:structuredClone(command)}))};
  }
  private restore(session:SaveSession,state:GameState,reason='载入存档') {
    this.ensureRecovery(session);
    const restored=structuredClone(state);
    const upgrade=(s:GameState)=>{
      s.resolutionVersion=3;
      if(s.prelude&&!s.prelude.historyDiscard){
        s.prelude.historyDiscard=true;s.prelude.round??=Math.floor((s.prelude.turn-1)/6)+1;
        for(const seat of Object.keys(s.decks) as GameState['activeSeat'][]){const d=s.decks[seat],played=d.removed.filter(c=>c.definitionId.startsWith('prelude_')&&specialCard(c.definitionId,c.balance)?.type==='历史'&&!persistentHistory(c.definitionId,!!c.balance));d.removed=d.removed.filter(c=>!played.some(v=>v.id===c.id));s.prelude.decks[seat].discardPile.push(...played);}
        for(const f of s.resolution?.frames??[])if(f.status!=='COMPLETE'&&f.finalZone==='removed'&&f.cardId&&s.decks[f.owner].resolving.some(c=>c.id===f.cardId&&c.definitionId.startsWith('prelude_')&&specialCard(c.definitionId,c.balance)?.type==='历史'&&!persistentHistory(c.definitionId,!!c.balance)))f.finalZone='discardPile';
      }
      for(const f of s.resolution?.frames??[]){if(f.rollback)upgrade(f.rollback);if(f.extraRollback)upgrade(f.extraRollback);}
    };upgrade(restored);
    restored.revision=Math.max(this.state?.revision??0,restored.revision)+1;
    session.recovery!.steps.push({kind:'restore',reason,state:structuredClone(restored)});
    session.state=restored;session.replayBase=structuredClone(restored);session.commands=[];
  }
  undo=()=>this.enqueue(async()=>{
    if(this.readOnly)throw new Error('观察者或回放模式不能操作对局。');
    if(!this.session?.undo.length)throw new Error('已到达本国本次行动开始，不能继续回退。');
    const session=copySession(this.session),previous=session.undo.pop()!;
    session.actionRecording=await restoreRecording(session.actionRecording,previous);delete session.matchRecording;
    this.restore(session,previous,'回退一步');await this.commit(session);
  });
  private preserveSlotHistories(session:SaveSession){
    if(session.actionRecording&&[...session.rounds,...session.nations].some(c=>!c.historyKey)){
      const key=crypto.randomUUID();session.historyArchives={...session.historyArchives,[key]:session.actionRecording};session.historyArchivePoints={...session.historyArchivePoints,[key]:session.historyPoints??[]};
      session.rounds=session.rounds.map(c=>c.historyKey?c:{...c,historyKey:key});session.nations=session.nations.map(c=>c.historyKey?c:{...c,historyKey:key});
    }
    const used=new Set([...session.rounds,...session.nations].map(c=>c.historyKey));
    session.historyArchives=Object.fromEntries(Object.entries(session.historyArchives??{}).filter(([k])=>used.has(k)));
    session.historyArchivePoints=Object.fromEntries(Object.entries(session.historyArchivePoints??{}).filter(([k])=>used.has(k)));
  }
  loadCheckpoint=(id:string)=>this.enqueue(async()=>{
    if(!this.session)throw new Error('没有对局。');
    const session=copySession(this.session),checkpoint=[...session.rounds,...session.nations].find(c=>c.id===id);
    if(!checkpoint)throw new Error('存档不存在。');
    if(this.playback){this.playback=null;delete session.playback;this.access={kind:'gm'};}
    const source=checkpoint.historyKey?session.historyArchives?.[checkpoint.historyKey]:session.actionRecording;
    const points=checkpoint.historyKey?session.historyArchivePoints?.[checkpoint.historyKey]:session.historyPoints;
    this.preserveSlotHistories(session);
    session.actionRecording=await restoreRecording(source,checkpoint.state);delete session.matchRecording;
    session.historyPoints=(points??[]).filter(p=>!!session.actionRecording?.cursors[p.hash]);
    const restored=await restoreHistoryTail(session.actionRecording);if(await stateHash(restored)!==await stateHash(checkpoint.state))throw Error('存档槽与历史不一致。');
    session.undo=[];this.restore(session,restored,'读取行动起点');await this.commit(session);
  });
  exportSave=(pointId?:string)=>this.enqueue(async()=>{
    if(!this.session)throw Error('没有可导出的对局。');
    let r=this.session.actionRecording??await restoreRecording(undefined,this.session.state);
    if(pointId){const p=this.session.historyPoints?.find(p=>p.id===pointId);if(!p)throw Error('该行动前存档不存在。');
      r=recordingPrefix(r,p.hash);
    }
    return seal(r.records,!pointId&&this.session.state.status==='FINISHED',!pointId?this.session.state.winner??undefined:undefined);
  });
  exportReplay=()=>this.enqueue(async()=>{
    if(!this.session)throw new Error('没有可导出的对局。');
    const recording=this.session.actionRecording??await restoreRecording(undefined,this.session.state);
    return seal(recording.records,this.session.state.status==='FINISHED',this.session.state.winner??undefined);
  });
  importReplay=async(_json:string):Promise<void>=>{throw new Error('请使用独立只读回放界面导入新格式记录；不会替换当前对局。');};
  private async showReplay(index:number,viewSeat:GameState['viewSeat'],replaceExisting=false){
    if(!this.playback)throw new Error('没有正在查看的回放。');
    const state=replayStateAt(this.playback.file,index);state.viewSeat=viewSeat;
    const session=this.fresh(state);session.recovery!.fromCreation=false;
    this.playback.cursor=index;session.playback={file:this.playback.file,cursor:index};
    await this.commit(session,replaceExisting);
  }
  seekReplay=(index:number)=>this.enqueue(async()=>{
    if(!this.playback||this.access.kind!=='gm')throw new Error('仅 GM 可查看详细回放。');
    if(!this.playback.entries.some(e=>e.index===index))throw new Error('回放节点不存在。');
    await this.showReplay(index,this.state!.viewSeat);
  });
  exportReplayNodeSave=()=>{
    if(!this.playback||this.access.kind!=='gm')throw new Error('仅回放中的 GM 可导出节点存档。');
    const state=replayStateAt(this.playback.file,this.playback.cursor),session=this.fresh(state);
    session.recovery={...structuredClone(this.playback.file.record),steps:structuredClone(this.playback.file.record.steps.slice(0,this.playback.cursor))};
    return JSON.stringify(session,null,2);
  };
  /** Trusted journal recovery retains the host archive; browser saves never supply it. */
  restoreHostSession=(text:string)=>this.enqueue(async()=>{
    const session=validateSession(JSON.parse(text));
    if(session.actionRecording)await validateRecords(session.actionRecording.records,false);
    this.persistedVersions.set(session.state.gameId,session.updatedAt);
    this.restore(session,session.state,'恢复主机保存的对局');
    if(!session.actionRecording)session.actionRecording=await restoreRecording(undefined,session.state);delete session.matchRecording;
    await this.commit(session);
  });
  importSave=(json:string)=>this.enqueue(async()=>{
    if(json.trimStart().startsWith('{')&&json.split('\n',1)[0].includes('quartermaster-match-log')){
      const loaded=await readHistorySave(json),session=this.fresh(loaded.state);
      session.actionRecording=loaded.recording;session.rounds=loaded.rounds;session.nations=loaded.nations;session.historyPoints=loaded.points;
      this.playback=null;this.access={kind:'gm'};this.restore(session,loaded.state);await this.commit(session,true);return;
    }
    const session=validateSession(JSON.parse(json));
    if(session.playback)throw new Error('请通过导入回放查看该文件，或导出节点存档后再读档。');
    delete session.historyArchives;delete session.historyArchivePoints;session.historyPoints=[];
    session.rounds=session.rounds.map(({historyKey:_key,...cp})=>cp);session.nations=session.nations.map(({historyKey:_key,...cp})=>cp);
    try {
      const existing=await this.store?.read(session.state.gameId);
      if(existing&&typeof existing==='object'&&'updatedAt' in existing&&typeof existing.updatedAt==='string')this.persistedVersions.set(session.state.gameId,existing.updatedAt);
    } catch { /* Import remains usable in memory; commit reports the storage failure. */ }
    session.actionRecording=await restoreRecording(this.session?.actionRecording,session.state);delete session.matchRecording;
    this.playback=null;this.access={kind:'gm'};this.restore(session,session.state);if(!session.actionRecording?.cursors[await stateHash(session.state)])session.actionRecording=await restoreRecording(undefined,session.state);await this.commit(session,true);
  });
  checkReplay=()=>!!this.session&&verifyReplay(this.session);
  exportDiagnostics=(note:string)=>JSON.stringify({format:'quartermaster-diagnostic',appVersion:'1.6.1',note,failures:this.failures,session:this.session},null,2);
  editScene=(input:unknown,options?:{endPrelude?:boolean;endNeutrality?:'soviet_union'|'united_states'})=>{
    const value=structuredClone(input);
    return this.enqueue(async()=>{
      if(!this.state||!this.session||this.state.status==='FINISHED')throw new Error('请在进行中的对局调整局面。');
      if(this.readOnly)throw new Error('观察者不能操作对局。');
      validateState(value);
      if(value.gameId!==this.state.gameId||value.revision!==this.state.revision)throw new Error('局面已更新，请重新编辑。');
      // The editor exposes scores, unit positions and card zones only; timing stays authoritative.
      const next=structuredClone(this.state);next.scores=value.scores;next.units=value.units;next.decks=value.decks;next.randomState=value.randomState;next.pendingAir=next.pendingAir.filter(id=>next.units.some(u=>u.id===id&&u.type==='air'));
      if(next.prelude&&value.prelude){next.prelude.tension=value.prelude.tension;next.prelude.decks=value.prelude.decks;}
      for(const seat of Object.keys(next.decks) as (keyof typeof next.decks)[]){
        if(JSON.stringify(next.decks[seat].resolving)!==JSON.stringify(this.state.decks[seat].resolving))throw new Error('正在结算的卡牌不能直接移动。');
        revealPublic(next,this.state.decks[seat].active.filter(c=>next.decks[seat].discardPile.some(v=>v.id===c.id)));
        for(const zone of ['active','faceDown'] as const)for(const card of next.decks[seat][zone]){
          if(isPrelude(card)&&!this.state.decks[seat][zone].some(c=>c.id===card.id))markPreludeInstall(next,card.id);
        }
      }
      concealPublic(next,Object.values(next.decks).flatMap(d=>[...d.hand,...d.drawPile,...d.faceDown.filter(c=>!next.faceUpResponseIds?.includes(c.id)),...d.removed]).map(c=>c.id));
      if(options?.endNeutrality){
        const seat=options.endNeutrality;
        if(seat!=='soviet_union'&&seat!=='united_states')throw new Error('无效的中立国家。');
        if(next.prelude?.active||next.status!=='PLAYING'||next.phase==='SETUP')throw new Error('只能在正式游戏中结束中立。');
        if(next.resolution?.running)throw new Error('请先完成当前结算，再结束中立。');
        endNeutrality(next,seat,'场景编辑器结束中立');
      }
      refreshSceneResolution(next);
      if(options?.endPrelude)finishPrelude(next);
      validateState(next);
      const session=measure('clone_session',()=>copySession(this.session!));session.undo.push(structuredClone(this.state));
      this.preserveSlotHistories(session);session.historyPoints=[];session.actionRecording=await restoreRecording(session.actionRecording,next,true);delete session.matchRecording;
      this.restore(session,next,'GM 编辑局面');await this.commit(session);
    });
  };
}

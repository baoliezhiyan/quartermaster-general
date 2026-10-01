import {pendingResponseSeats} from '../core/resolution';
export {diffValue,applyPatch} from './jsonPatch';
import {recordPerformance,measure,measureAsync} from '../controller/performanceProbe';
export {setPerformanceSink} from '../controller/performanceProbe';
import {LocalGameController} from '../controller/LocalGameController';
import {SEATS} from '../core';
import {COUNTRY_NAMES} from '../core/basic';
import type {Command,SeatId,ReadState,GameState} from '../core';
import type {RoomAccess} from '../controller/GameController';
import type {SessionStore} from '../controller/SessionStore';
import type {Identity,Member,RoomRequest,RoomSnapshot,ChatMessage,ChatStore} from './protocol';
import {seatKey} from './protocol';
import {randomIndex} from './random';
import {createViewProjector} from './viewProjector';

interface User extends Member {projection?:{source:ReadState|null;key:string;state:GameState|null};token:string;connection:string;view:SeatId;decision?:string;decisionSignature?:string;send?:(data:RoomSnapshot|{replaced:true})=>void;results:Map<string,{fingerprint:string;value:unknown}>}
export class Room {
 private projectView=createViewProjector();
 private responseCache?:{state:ReadState;seats:SeatId[]};
 private responses(state:ReadState){if(this.responseCache?.state!==state)this.responseCache={state,seats:pendingResponseSeats(state)};return this.responseCache.seats;}
 private chat:ChatMessage[]=[];
 private chatReady:Promise<void>;
 private nextChatTone:0|1=0;
 private sceneLocked=false;
 private engine:LocalGameController;
 private users=new Map<string,User>();
 private queue:Promise<unknown>=Promise.resolve();
 private epoch=crypto.randomUUID();
 private serverId=crypto.randomUUID();private sequence=0;
 private recoveryExists:Promise<boolean>;
 constructor(store:SessionStore,identities:Identity[],private saveIdentities:(ids:Identity[])=>Promise<void>,private recovery:()=>Promise<string|null>,private chatStore?:ChatStore){
  this.chatReady=(chatStore?.read()??Promise.resolve([])).then(messages=>{this.chat=messages.map((m,i)=>({...m,tone:m.tone??(i%2 as 0|1)}));this.nextChatTone=this.chat.length?(this.chat.at(-1)!.tone===0?1:0):0;});
  // Do not automatically load a saved game when opening a server.
  this.engine=new LocalGameController({...store,read:async()=>null,write:store.write.bind(store),list:store.list.bind(store)},true);
  this.recoveryExists=recovery().then(value=>!!value);
  for(const i of identities){const bindings=SEATS.filter(seat=>i.bindings?.includes(seat)&&!this.occupant(seat));this.users.set(i.token,{...i,bindings,access:bindings.length?{kind:'player',seat:bindings[0]}:{kind:'public'},online:false,connection:'',view:bindings[0]??'germany',results:new Map()});}
 }
 private occupant(seat:SeatId){return [...this.users.values()].find(u=>u.bindings?.includes(seat)||u.access.kind==='player'&&u.access.seat===seat);}
 private identities():Identity[]{return [...this.users.values()].map(({id,name,token,bindings})=>({id,name,token,bindings}));}
 private updateFactControllers(){this.engine.setFactControllers(Object.fromEntries(SEATS.map(seat=>{const user=[...this.users.values()].find(u=>(u.bindings??[]).includes(seat)||u.access.kind==='player'&&u.access.seat===seat);return [seat,{controllerId:user?.id??null,bound:!!user}];})) as import('../matchLog/contract').ControllerMap,[...this.users.values()].map(u=>({controllerId:u.id,kind:'human' as const,displayName:u.name})));}
 private async saveSeats(change:()=>void){const previous=[...this.users.values()].map(u=>({u,access:u.access,bindings:u.bindings,view:u.view}));change();try{await this.saveIdentities(this.identities());this.updateFactControllers();await this.engine.recordControllerChange();}catch(e){for(const p of previous){p.u.access=p.access;p.u.bindings=p.bindings;p.u.view=p.view;}throw e;}}
 private unbind(u:User,seat:SeatId){u.bindings=(u.bindings??[]).filter(s=>s!==seat);if(u.access.kind==='player'&&u.access.seat===seat){if(u.bindings.length){u.access={kind:'player',seat:u.bindings[0]};u.view=u.bindings[0];}else if(!u.online)u.access={kind:'public'};}}
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const next=this.queue.then(fn);this.queue=next.catch(()=>undefined);return next;}
 identityStatus(tokens:unknown){if(!Array.isArray(tokens)||tokens.length>500||tokens.some(t=>typeof t!=='string'))throw Error('身份列表无效。');return tokens.map(token=>{const u=this.users.get(token);return {token,valid:!!u,online:!!u?.online};});}
 createIdentity(name:string){return this.serial(async()=>{
  if(typeof name!=='string'||!name.trim()||name.trim().length>32)throw new Error('用户名需为1至32个字符。');
  const i={id:crypto.randomUUID(),name:name.trim(),token:crypto.randomUUID()+crypto.randomUUID()};
  const identities=this.identities();await this.saveIdentities([...identities,i]);
  this.users.set(i.token,{...i,access:{kind:'public'},online:false,connection:'',view:'germany',results:new Map()});return i;
 });}
 authorizeHistoryImport(token:string){const u=this.user(token);if(u.access.kind!=='gm'||!u.online)throw Error('仅在线 GM 可导入存档。');}
 private user(token:string){const u=this.users.get(token);if(!u)throw new Error('身份链接无效，请从房间入口创建用户。');return u;}
 connect(token:string,connection:string,send:User['send']) {return this.serial(async()=>{
  const u=this.user(token);u.send?.({replaced:true});u.connection=connection;u.send=send;u.online=true;if(u.bindings?.length){u.access={kind:'player',seat:u.bindings[0]};u.view=u.bindings[0];}await this.broadcast();
 });}
 disconnect(token:string,connection:string){return this.serial(async()=>{const u=this.users.get(token);if(u?.connection===connection){u.online=false;u.send=undefined;if(u.access.kind==='gm')this.sceneLocked=false;await this.broadcast();}});}
 private async snapshot(u:User):Promise<RoomSnapshot>{
  await this.chatReady;
  this.refreshDecision(u);
  const source=this.engine.getSnapshot(),view=u.access.kind==='player'||u.access.kind==='observer'?u.access.seat:u.view,key=JSON.stringify([u.access,view]);
  if(!u.projection||u.projection.source!==source||u.projection.key!==key)u.projection={source,key,state:measure('project_view',()=>this.projectView(source,u.access,view))};
  const info=structuredClone({...this.engine.getSessionInfo(),replayEntries:[]});
  if(u.access.kind!=='gm'){info.rounds=[];info.nations=[];info.savePoints=[];info.replayEntries=[];info.canUndo=info.canUndo&&u.access.kind==='player'&&u.access.seat===this.engine.getSnapshot()?.activeSeat;}
  return {state:u.projection.state,info,room:{chat:this.chat,sceneLocked:this.sceneLocked,userId:u.id,name:u.name,access:u.access,bindings:u.bindings??[],bindingAttention:u.access.kind==='player'&&source?(u.bindings??[]).flatMap(seat=>{const result:{seat:SeatId;key:string;kind:'response'|'turn'|'attack';text?:string}[]=[];if(this.responses(source).includes(seat))result.push({seat,key:`${this.epoch}:${source.gameId}:response:${seat}:${source.balanceResolutionSerial??0}:${source.resolution?.choice?.id??source.responseNotices?.filter(n=>n.recipients.includes(seat)&&!n.readBy.includes(seat)).map(n=>n.id).join(',')}`,kind:'response',text:source.resolution?.choice?.seat===seat?source.resolution.choice.prompt:undefined});if(source.activeSeat===seat&&source.phase!=='SETUP')result.push({seat,key:`${source.gameId}:turn:${seat}:${source.round}:${source.prelude?.active?source.prelude.turn:0}`,kind:'turn'});for(const n of source.responseNotices??[])if(n.title==='受到攻击'&&n.recipients.includes(seat)&&!n.readBy.includes(seat))result.push({seat,key:`${source.gameId}:attack:${seat}:${n.id}`,kind:'attack',text:n.text});return result;}):[],members:[...this.users.values()].filter(x=>x.online||seatKey(x.access)).map(({id,name,access,online,bindings})=>({id,name,access,online,bindings})),connected:true,recoveryAvailable:!!this.engine.getSnapshot()||await this.recoveryExists,epoch:this.epoch,decision:u.decision,serverId:this.serverId,sequence:this.sequence}};
 }
 private refreshDecision(u:User){
  const s=this.engine.getSnapshot(),seat='seat' in u.access?u.access.seat:u.view,r=s?.resolution;
  // This opaque token is private to its recipient. Presence, other opening
  // hands, log growth and response preferences do not invalidate a decision.
  const context=!s?null:s.phase==='SETUP'?[s.gameId,s.status,s.phase,s.setupCompleted.includes(seat),s.decks[seat].hand]:
   [s.gameId,s.status,s.round,s.activeSeat,s.phase,s.decks[seat],s.prelude,s.neutrality,s.units,s.scores,s.redistributed,s.pendingAir,s.pendingDiscard,r?.running?[r.owner,r.choice,r.frames.map(f=>[f.id,f.cardId,f.nextEffectIndex,f.stage,f.status])]:null];
  const signature=measure('decision_signature',()=>JSON.stringify([this.epoch,u.access,seat,context]));
  if(signature!==u.decisionSignature){u.decisionSignature=signature;u.decision=crypto.randomUUID();}
 }
 private async broadcast(){this.sequence++;for(const u of this.users.values())if(u.online)u.send?.(await this.snapshot(u));}
 exportHistory(token:string,pointId?:string){return this.serial(async()=>{
  const u=this.user(token);if(u.access.kind!=='gm')throw Error('此功能仅GM可用。');
  if(pointId!==undefined&&(typeof pointId!=='string'||pointId.length>100))throw Error('存档位置无效。');
  // Take an immutable export inside the authority queue; HTTP transmission happens outside.
  return this.engine.exportSave(pointId);
 });}
 request(token:string,r:RoomRequest){const queuedAt=performance.now();return measureAsync('request_total',()=>this.serial(async()=>{recordPerformance({name:'request_queue',ms:performance.now()-queuedAt});
  const u=this.user(token);if(!u.online||r.connection!==u.connection)throw new Error('此页面已断开或在另一页面接管。');
  if(typeof r.id!=='string'||r.id.length>100||!Array.isArray(r.args))throw new Error('请求格式无效。');
  const fingerprint=JSON.stringify([r.epoch,r.revision,r.decision,r.method,r.args]);const old=u.results.get(r.id);
  if(old){if(old.fingerprint!==fingerprint)throw new Error('请求编号重复。');return old.value;}
  let value:unknown;
  if(['chatSend','chatDelete','chatClear'].includes(r.method)){
   await this.chatReady;let next:ChatMessage[];
   if(r.method==='chatSend'){
    const text=r.args[0];if(typeof text!=='string'||!text.trim()||Array.from(text).length>300)throw Error('消息不能为空或超过300字。');
    const seats=u.access.kind==='gm'?['GM']:u.access.kind==='public'?['通用观察者']:u.access.kind==='observer'?[COUNTRY_NAMES[u.access.seat]+'观察者']:(u.bindings?.length?u.bindings:[u.access.seat]).map(seat=>COUNTRY_NAMES[seat]);
    next=[...this.chat,{id:crypto.randomUUID(),userId:u.id,name:u.name,seats,text:text.trim(),sentAt:new Date().toISOString(),tone:this.nextChatTone}];
   }else{
    if(u.access.kind!=='gm')throw Error('只有GM可以删除聊天记录。');
    if(r.method==='chatDelete'&&(typeof r.args[0]!=='string'||!this.chat.some(m=>m.id===r.args[0])))throw Error('消息不存在。');
    next=r.method==='chatClear'?[]:this.chat.filter(m=>m.id!==r.args[0]);
   }
   await this.chatStore?.write(next);this.chat=next;if(r.method==='chatSend')this.nextChatTone=this.nextChatTone===0?1:0;else if(r.method==='chatClear')this.nextChatTone=0;value=null;
  }else if(r.method==='sceneLock'){

   if(u.access.kind!=='gm'||typeof r.args[0]!=='boolean')throw Error('只有GM可以锁定或解锁场景。');
   this.sceneLocked=r.args[0];value=null;
  }else if(r.method==='binding'){
   const seat=r.args[0] as SeatId,bind=r.args[1];if(!SEATS.includes(seat)||typeof bind!=='boolean')throw Error('无效绑定请求。');
   if(this.engine.getSessionInfo().replayMode)throw Error('回放模式不能绑定座位。');
   const owner=this.occupant(seat),gm=u.access.kind==='gm';
   if(bind){if(gm||u.access.kind!=='player'||!u.bindings?.length&&u.access.seat!==seat)throw Error('请先绑定当前国家。');if(owner&&owner!==u)throw Error('该国家已有人。');await this.saveSeats(()=>{u.bindings=SEATS.filter(s=>s===seat||u.bindings?.includes(s));});}
   else {if(!owner?.bindings?.includes(seat)||!gm&&owner!==u)throw Error('不能解绑此国家。');await this.saveSeats(()=>this.unbind(owner,seat));}value=null;
  }else if(r.method==='drawCountry'){
   if(u.access.kind!=='public')throw Error('只有通用观察者可以抽取国家。');
   if(this.engine.getSessionInfo().replayMode)throw Error('回放模式不能入座操作位。');
   const available=SEATS.filter(seat=>!this.occupant(seat));
   if(!available.length)throw Error('六个国家席位已经满了。');
   const seat=available[randomIndex(available.length)];u.access={kind:'player',seat};u.view=seat;
   await measureAsync('broadcast',()=>this.broadcast());const value=await this.snapshot(u);u.results.set(r.id,{fingerprint,value});return value;
  }else if(r.method==='seat'){
   const a=r.args[0] as RoomAccess;
   if(!a||!['gm','player','observer','public'].includes(a.kind)||('seat' in a&&!SEATS.includes(a.seat)))throw new Error('无效座位。');
   if((a.kind==='player'||a.kind==='observer')&&!('seat' in a))throw new Error('无效国家。');
   if(a.kind==='player'&&this.engine.getSessionInfo().replayMode)throw new Error('回放模式不能入座操作位。');
   if(u.bindings?.length&&a.kind!=='gm'&&!(a.kind==='player'&&u.bindings.includes(a.seat)))throw Error('绑定期间只能切换已绑定国家或GM。');
   const key=seatKey(a);if(key&&(a.kind==='player'?!!this.occupant(a.seat)&&this.occupant(a.seat)!==u:[...this.users.values()].some(x=>x!==u&&seatKey(x.access)===key)))throw new Error('该座位已有人，请选择其他位置。');
   await this.saveSeats(()=>{if(a.kind==='gm')u.bindings=[];u.access=a;if('seat' in a)u.view=a.seat;});if(a.kind!=='gm'&&![...this.users.values()].some(x=>x.access.kind==='gm'&&x.online))this.sceneLocked=false;value=null;
  }else if(r.method==='view'){
   if(u.access.kind!=='gm'||!SEATS.includes(r.args[0] as SeatId))throw new Error('仅GM可切换操作视角。');u.view=r.args[0] as SeatId;value=null;
  }else {
   const gm=u.access.kind==='gm',state=this.engine.getSnapshot();
   const ack=r.method==='dispatch'?r.args[0] as Extract<Command,{type:'ACK_RESPONSE_NOTICE'}>:null;
   const independentAck=ack?.type==='ACK_RESPONSE_NOTICE'&&state?.responseNotices?.some(n=>n.id===ack.noticeId&&n.recipients.includes(ack.seat));
   const read=['sync','metrics','replayEntries','exportSave','exportReplay','exportReplayNodeSave','exportDiagnostics','checkReplay'].includes(r.method);
   if(this.sceneLocked&&!gm&&!read)throw Error('GM已锁定场景，请等待GM完成编辑并解锁。');
   this.refreshDecision(u);
   const sameDecision=r.method==='dispatch'&&!!r.decision&&r.decision===u.decision&&['SELECT_AIR_ACTION','ARMAMENT_WINDOW','PLAY_PRELUDE','DISCARD_PRELUDE_TOP','KEEP_OPENING','RESOLVE_ENGINE_CHOICE','ADVANCE_PHASE','DISCARD_HAND','PLAY_CARD','PLAY_BASIC','MOVE_AIR','RELOCATE_AIR','RESOLVE_FORCED_DISCARD','STATUS_ACTION','SET_CARD_RESPONSE'].includes(ack?.type??'');
   if(!read&&(r.epoch!==this.epoch||!independentAck&&!sameDecision&&r.revision!==(state?.revision??null)))throw new Error('局面已更新，当前操作已失效；仍有效的选择会保留。');
   if(r.method==='sync')return this.snapshot(u);
   if(r.method==='metrics')return null;
   if(r.method==='replayEntries'){if(!gm)throw Error('此功能仅GM可用。');return this.engine.getSessionInfo().replayEntries;}
   if(r.method==='dispatch'){
    const c=structuredClone(r.args[0]) as Command;if(!c||typeof c.type!=='string')throw new Error('无效操作。');
    if(c.type==='CREATE_GAME'){if(!gm)throw new Error('只有GM可以新建对局。');c.mode='FULL';}
    else {
     if(!gm&&(u.access.kind!=='player'||c.seat!==u.access.seat))throw new Error('不能操作其他国家。');
     if(!gm&&['SET_INTERRUPTS','DEBUG_DECK','DEBUG_PLACEMENT','START_RESOLUTION_SCENARIO','SET_VIEW'].includes(c.type))throw new Error('仅GM可执行管理操作。');
     if(c.type==='SET_VIEW')throw new Error('视角必须通过个人视角接口切换。');
     if(independentAck||sameDecision)c.expectedRevision=state!.revision;
     if(c.expectedRevision!==state?.revision)throw new Error('局面已更新，请重新选择。');
     if(this.engine.getSessionInfo().replayMode)throw new Error('回放模式不能操作。');
    }
    this.updateFactControllers();
    this.engine.setRoomAccess({kind:'gm'});value=await this.engine.dispatchFromRoom(c);
    if((value as {ok:boolean}).ok&&!['ACK_RESPONSE_NOTICE','SET_CARD_RESPONSE'].includes(c.type))u.decisionSignature=undefined;
    if(c.type==='CREATE_GAME'&&(value as {ok:boolean}).ok)this.epoch=crypto.randomUUID();
    if((value as {ok:boolean}).ok&&r.decision)value={...value as object,appliedRevision:this.engine.getSnapshot()?.revision,epoch:this.epoch};
   }else if(r.method==='undo'){
    if(!gm&&(u.access.kind!=='player'||u.access.seat!==state?.activeSeat))throw new Error('只有当前国家或GM可回退。');await this.engine.undo();this.epoch=crypto.randomUUID();
   }else {
    if(!gm)throw new Error('此功能仅GM可用。');
    switch(r.method){
     case 'release':{const target=[...this.users.values()].find(x=>x.id===r.args[0]);if(!target||target.online||target.access.kind!=='player')throw new Error('只能释放离线国家席位。');await this.saveSeats(()=>{target.bindings=[];target.access={kind:'public'};});break;}
     case 'restore':{const json=await this.recovery();if(!json)throw new Error('没有可恢复的对局。');await this.engine.restoreHostSession(json);this.epoch=crypto.randomUUID();break;}
     case 'importSave':await this.engine.importSave(r.args[0] as string);this.epoch=crypto.randomUUID();break;
     case 'importReplay':throw new Error('回放只能在本机独立只读窗口打开，不允许替换房间对局。');
     case 'seekReplay':await this.engine.seekReplay(r.args[0] as number);break;
     case 'loadCheckpoint':await this.engine.loadCheckpoint(r.args[0] as string);this.epoch=crypto.randomUUID();break;
     case 'editScene':await this.engine.editScene(r.args[0],r.args[1] as {endPrelude?:boolean;endNeutrality?:'soviet_union'|'united_states'}|undefined);this.epoch=crypto.randomUUID();break;
     case 'exportSave':value=await this.engine.exportSave(r.args[0] as string|undefined);break;
     case 'exportReplay':value=await this.engine.exportReplay();break;
     case 'exportReplayNodeSave':value=this.engine.exportReplayNodeSave();break;
     case 'exportDiagnostics':value=this.engine.exportDiagnostics(r.args[0] as string);break;
     case 'checkReplay':value=this.engine.checkReplay();break;
     default:throw new Error('未知操作。');
    }
   }
   if(!read&&r.method!=='release'){const next=this.engine.getSnapshot();for(const other of this.users.values())if(other.access.kind==='gm'&&next)other.view=next.viewSeat;}
  }
  if(['exportSave','exportReplay','exportReplayNodeSave','exportDiagnostics','checkReplay'].includes(r.method))return value??null;
  value??=null;u.results.set(r.id,{fingerprint,value});await measureAsync('broadcast',()=>this.broadcast());return value;
 }));}
}

export {parseReplay,validateRecords,seal} from '../actionReplay/codec';
export {Player as ReplayPlayer} from '../actionReplay/player';
export {VERSION as MATCH_LOG_GAME_VERSION} from '../actionReplay/state';

export {parseTrainingReplay,sealTraining} from '../actionReplay/trainingCodec';
export {TrainingController} from '../actionReplay/TrainingController';
export {createTrainingScene,applyScene,trainingSceneHash} from '../actionReplay/trainingScene';
export {TRAINING_CAPABILITIES} from '../actionReplay/trainingContract';
export {applyResource} from '../actionReplay/resources';
export {ENGINE as SCENE_ENGINE_FINGERPRINT} from '../actionReplay/state';

import {referenceData,referenceIdentity} from './reference';
import {hashText,canonical} from '../actionReplay/state';
import type {Room} from '../network/Room';
import {AiError,compileOffer,type Submission,type ActionRequest,type ReceiptStore} from './contract';
import {validateAction,continuation,visibleDelta,newInformation,decisionKey} from './action';
type Observation=Awaited<ReturnType<Room['localAiObserve']>>;
export class LocalAiAdapter {
 private sessions=new Map<string,{connection:string;wake:Set<()=>void>;alive:boolean}>();
 private results=new Map<string,{fingerprint:string;value:unknown}>();
 private tails=new Map<string,Promise<unknown>>();
 private receipts=new Map<string,any>();
 private activeActions=new Set<string>();
 private cancelled=new Set<string>();
 private waitScopes=new Map<string,{gameId:string|null;epoch:string;bindings:string[]}>();
 constructor(private room:Room,private store?:ReceiptStore){}
 private serial<T>(token:string,fn:()=>Promise<T>):Promise<T>{const next=(this.tails.get(token)??Promise.resolve()).then(fn);this.tails.set(token,next.catch(()=>{}));return next;}
 async connect(token:string){await this.room.localAiAuthorize(token);const previous=this.sessions.get(token);if(previous?.alive)return this.observe(token);
  const session={connection:crypto.randomUUID(),wake:new Set<()=>void>(),alive:true};this.sessions.set(token,session);
  try{await this.room.connect(token,session.connection,v=>{if('replaced' in v)session.alive=false;for(const wake of [...session.wake])wake();});return await this.observe(token);}catch(e){await this.room.disconnect(token,session.connection);this.sessions.delete(token);throw e;}}
 async disconnect(token:string){const s=this.sessions.get(token);if(s){s.alive=false;for(const wake of s.wake)wake();await this.room.disconnect(token,s.connection);this.sessions.delete(token);}return {disconnected:true};}
 private session(token:string){const s=this.sessions.get(token);if(!s?.alive)throw new AiError('DISCONNECTED','请先 connect；身份可能已被另一页面接管');return s;}
 async observe(token:string):Promise<Observation>{const s=this.session(token);return this.room.localAiObserve(token,s.connection);}
 async reference(token:string,expectedId:string){await this.observe(token);if(expectedId!==referenceIdentity.id)throw new AiError('REFERENCE_MISMATCH','资料版本不匹配');return referenceData();}
 async wait(token:string,after:number,timeout:number){
  if(!Number.isSafeInteger(after)||!Number.isFinite(timeout)||timeout<0||timeout>60000)throw new AiError('INVALID_REQUEST','等待超时范围 0..60000');
  const session=this.session(token);let notify:()=>void=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const changed=new Promise<void>(resolve=>{notify=resolve;session.wake.add(notify);timer=setTimeout(resolve,timeout);});
  try{const initial=await this.observe(token);if(initial.sequence===after)await changed;return await this.observe(token);}finally{if(timer)clearTimeout(timer);session.wake.delete(notify);}}
 private validate(r:Submission){if(!r||typeof r.requestId!=='string'||!r.requestId.length||r.requestId.length>100||typeof r.gameId!=='string'||typeof r.epoch!=='string'||!Number.isSafeInteger(r.revision))throw new AiError('INVALID_REQUEST','缺少有效请求编号/局面版本（requestId最长100字符）');}
 private async execute(token:string,r:Submission,namespace='single'){
  this.validate(r);const session=this.session(token),key=token+':'+namespace+':'+r.requestId,fingerprint=canonical({gameId:r.gameId,epoch:r.epoch,revision:r.revision,offerId:r.offerId,selections:r.selections??{}}),old=this.results.get(key);
  if(old){if(old.fingerprint!==fingerprint)throw new AiError('DUPLICATE_CONFLICT','同编号不同内容');return {...old.value as {result:unknown},duplicate:true,observation:await this.observe(token)};}
  const o=await this.observe(token);if(r.gameId!==o.gameId||r.epoch!==o.epoch)throw new AiError('WRONG_GAME','对局/世代改变');if(r.revision!==o.revision)throw new AiError('STALE','局面更新，请 observe');
  if(o.status==='unsupported'||o.locked||o.replay)throw new AiError('UNAVAILABLE','当前不可操作');
  const command=await this.room.localAiPrepare(token,session.connection,compileOffer(o.offers,r));
  await this.room.request(token,{id:'ai-seat:'+await hashText(namespace+':'+r.requestId),connection:session.connection,epoch:o.epoch,revision:o.revision,method:'seat',args:[{kind:'player',seat:command.seat}]});
  const result=await this.room.request(token,{id:'ai:'+await hashText(namespace+':'+r.requestId),connection:session.connection,epoch:r.epoch,revision:r.revision,method:'dispatch',args:[command]});
  const value={requestId:r.requestId,result,observation:await this.observe(token)};this.results.set(key,{fingerprint,value:{requestId:r.requestId,result}});return value;
 }
 submit(token:string,r:Submission){return this.serial(token,async()=>{this.validate(r);const key=await this.receiptKey(token,r.requestId);if(this.receipts.has(key)||await this.store?.read(key))throw new AiError('DUPLICATE_CONFLICT','该编号已用于合并请求，请查询 result');return this.execute(token,r);});}
 private async receiptKey(token:string,id:string){return hashText(token+'\n'+id);}
 async result(token:string,id:string){if(typeof id!=='string'||!id.length||id.length>80)throw new AiError('INVALID_REQUEST','需要 requestId');
  const o=await this.observe(token),key=await this.receiptKey(token,id),saved=this.receipts.get(key)??await this.store?.read(key);if(!saved)throw new AiError('NOT_FOUND','没有该请求回执');
  if(JSON.stringify(saved.receipt.bindings)!==JSON.stringify(o.bindings))throw new AiError('PERMISSIONS_CHANGED','绑定改变，需重新同步');
  return {latestFacts:'resolutionSerial'in o&&saved.receipt.epoch===o.epoch&&saved.receipt.resolutionSerial===o.resolutionSerial?o.resolutionFacts.filter(f=>!saved.receipt.rootFrameId||f.frameId===saved.receipt.rootFrameId):null,receipt:{...saved.receipt,...(saved.receipt.status==='executing'&&!this.activeActions.has(key)?{status:'uncertain',stopReason:'interrupted_do_not_reexecute'}:{})},observation:o};}
 submitAction(token:string,r:ActionRequest){return this.serial(token,async()=>{
  this.validate(r);const initial=await this.observe(token),key=await this.receiptKey(token,r.requestId),fingerprint=canonical({gameId:r.gameId,epoch:r.epoch,revision:r.revision,offerId:r.offerId,selections:r.selections??{},intent:r.intent}),old=this.receipts.get(key)??await this.store?.read(key);
  if(old){if(old.fingerprint!==fingerprint)throw new AiError('DUPLICATE_CONFLICT','同编号不同内容');return {...await this.result(token,r.requestId),duplicate:true};}
  if(this.results.has(token+':single:'+r.requestId))throw new AiError('DUPLICATE_CONFLICT','该编号已用于单步请求');
  let offer;
  try{
  offer=validateAction(r,initial);if(initial.gameId!==r.gameId||initial.epoch!==r.epoch)throw new AiError('WRONG_GAME','对局/世代改变');if(initial.revision!==r.revision)throw new AiError('STALE','局面已更新');
  await this.room.localAiCheckAction(token,this.session(token).connection,compileOffer(initial.offers,r),r.intent);
  }catch(error){const receipt={requestId:r.requestId,gameId:r.gameId,epoch:r.epoch,bindings:initial.bindings,beforeRevision:r.revision,afterRevision:initial.revision,status:'rejected',steps:[],remaining:r.intent,error:{code:(error as any).code??'REJECTED',message:(error as Error).message},statistics:{engineSteps:0}};const record={fingerprint,receipt};await this.store?.write(key,record);this.receipts.set(key,record);throw error;}
  const started=performance.now(),receipt:any={requestId:r.requestId,gameId:r.gameId,epoch:r.epoch,bindings:initial.bindings,beforeRevision:r.revision,afterRevision:r.revision,status:'executing',steps:[],remaining:r.intent,statistics:{interfaceRequests:1,engineSteps:0,executionMs:0}};
  const save=async()=>{const record={fingerprint,receipt:structuredClone(receipt)};await this.store?.write(key,record);this.receipts.set(key,record);};await save();
  this.activeActions.add(key);try{
  let o:Observation=initial,step:Submission={...r,requestId:r.requestId+'.0'},rootFrame:string|undefined,boardScope:string|undefined,feeUsed=false;const used=new Set<number>();let pendingUse:{answer?:number;fee?:boolean;scope?:string}|undefined;
  const stop=(reason:string)=>{receipt.stopReason=reason;receipt.status=reason==='execution_uncertain'?'uncertain':receipt.steps.length?(reason==='completed'?'completed':reason==='waiting_other'?'waiting_other':'partial'):'rejected';};
  try{for(let n=0;n<32;n++){
   receipt.inFlightStep=step.requestId;await save();const before=o;const value=await this.execute(token,step,'action');o=value.observation;
   if(!(value.result as any)?.ok){delete receipt.inFlightStep;stop('engine_rejected');receipt.error=value.result;break;}
   receipt.steps.push({stepId:step.requestId,offerId:step.offerId,selections:step.selections,beforeRevision:before.revision,afterRevision:o.revision,changes:visibleDelta(before,o),placements:'placements'in o?o.placements.filter(p=>p.revision>(before.revision??-1)):[]});if(pendingUse?.answer!==undefined)used.add(pendingUse.answer);if(pendingUse?.fee)feeUsed=true;if(pendingUse?.scope)boardScope=pendingUse.scope;pendingUse=undefined;receipt.statistics.engineSteps++;receipt.afterRevision=o.revision;delete receipt.inFlightStep;await save();
   if(o.gameId!==initial.gameId||o.epoch!==initial.epoch||JSON.stringify(o.bindings)!==JSON.stringify(initial.bindings)){stop('resync_required');break;}
   if(newInformation(before,o)){stop('new_information');break;}
   if(!('decisions'in o)){stop('resync_required');break;}
   if('phase'in initial&&o.phase!==initial.phase){stop('completed');receipt.stopBoundary='phase_changed';break;}
   if(offer.command.type==='SELECT_AIR_ACTION'&&n===0){
    const next=o.offers.filter(v=>v.seat===offer.seat&&(offer.command.action==='move'?v.command.type==='MOVE_AIR'&&v.details?.airId===r.intent.airId&&v.details?.regionId===r.intent.regionId:v.command.type==='PLAY_CARD'&&v.command.cardId===r.intent.cardId));
    if(next.length!==1){stop('missing_selection');break;}step={requestId:r.requestId+'.1',gameId:r.gameId,epoch:r.epoch,revision:o.revision!,offerId:next[0].id,...(offer.command.action==='move'?{selections:{cardId:[r.intent.cardId!]}}:{})};continue;
   }
   receipt.resolutionSerial??=o.resolutionSerial;
   if(receipt.resolutionSerial!==o.resolutionSerial){stop('new_decision');break;}
   const q=o.decisions[0];
   if(!q){stop(o.resolutionRunning?'waiting_other':'completed');break;}
   if(q.frameId){if(rootFrame&&q.frameId!==rootFrame){stop('new_decision');break;}rootFrame??=q.frameId;}
   const answer=continuation(o,r.intent,used,boardScope,feeUsed);if('reason'in answer){stop(answer.reason!);break;}
   const candidate=o.offers.find(v=>v.command.type==='RESOLVE_ENGINE_CHOICE'&&v.command.choiceId===q.id&&v.selections);
   if(!candidate){stop('missing_selection');break;}
   pendingUse={...('answer'in answer?{answer:answer.answer}:{}),...('fee'in answer?{fee:true}:{}),...('scope'in answer?{scope:answer.scope}:{})};
   step={requestId:r.requestId+'.'+(n+1),gameId:r.gameId,epoch:r.epoch,revision:o.revision!,offerId:candidate.id,selections:{ids:[...answer.ids]}};
   compileOffer(o.offers,step);
  }
  if(receipt.status==='executing')stop('step_limit');
  }catch(e){stop('inFlightStep'in receipt?'execution_uncertain':'selection_rejected');receipt.error={code:(e as any).code??'REJECTED',message:(e as Error).message};}
  receipt.statistics.executionMs=performance.now()-started;receipt.statistics.pauseReason=receipt.stopReason;receipt.remaining={intent:r.intent,usedAnswers:[...used],unusedAnswers:(r.intent.answers??[]).filter((_,i)=>!used.has(i)),feeUsed,boardScope,resumeAutomatically:false};
  receipt.rootFrameId=rootFrame;
  if('resolutionFacts'in o)receipt.facts=o.resolutionFacts.filter(f=>!rootFrame||f.frameId===rootFrame);receipt.currentDecision='decisions'in o?o.decisions:[];await save();return {receipt,observation:o};
  }finally{this.activeActions.delete(key);}
 });}
 cancelWait(token:string,id:string){this.session(token);this.cancelled.add(token+':'+id);for(const wake of this.session(token).wake)wake();return {cancelled:true,waitId:id};}
 async waitDecision(token:string,input:{waitId:string;after?:string|null;expected?:{gameId:string|null;epoch:string;bindings:string[]};leaseMs?:number}){
  if(input.leaseMs!==undefined&&(!Number.isFinite(input.leaseMs)||input.leaseMs<1||input.leaseMs>30000))throw new AiError('INVALID_REQUEST','leaseMs范围为1..30000；CLI默认25000');
  if(typeof input.waitId!=='string'||!input.waitId.length||input.waitId.length>100)throw new AiError('INVALID_REQUEST','需要 waitId');
  const waitStarted=performance.now();try{
  const current=await this.observe(token),scope=token+':'+input.waitId;const baseline=this.waitScopes.get(scope)??input.expected??{gameId:current.gameId,epoch:current.epoch,bindings:current.bindings};this.waitScopes.set(scope,baseline);
  const start=performance.now(),lease=Math.min(30000,Math.max(1,input.leaseMs??25000));let ignored=0;
  while(true){const o=await this.observe(token);const terminal=this.cancelled.has(token+':'+input.waitId)?'cancelled':(baseline.gameId!==o.gameId||baseline.epoch!==o.epoch||JSON.stringify(baseline.bindings)!==JSON.stringify(o.bindings))?'resync_required':o.status==='finished'?'finished':o.status==='unsupported'?'unsupported':null;
   const rawKey=decisionKey(o),key=rawKey?await hashText(rawKey):null;if(terminal||key&&key!==input.after)return {status:terminal??'decision',cursor:key,observation:o,statistics:{waitMs:performance.now()-start,eventsIgnored:ignored}};
   const remaining=lease-(performance.now()-start);if(remaining<=0)return {leaseExpired:true,statistics:{waitMs:performance.now()-start,eventsIgnored:ignored}};
   await this.wait(token,o.sequence,Math.ceil(remaining));ignored++;
  }
  }catch(error){return {status:'unavailable',error:{code:(error as any).code??'CONNECTION_OR_AUTH',message:(error as Error).message},statistics:{waitMs:performance.now()-waitStarted,eventsIgnored:0}};}
 }
}

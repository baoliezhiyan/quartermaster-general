import {shareView} from './shareView';
import {applyPatch} from './jsonPatch';
import type {GameController,RoomAccess,SessionInfo,DispatchResult} from '../controller/GameController';
import type {Command,GameState} from '../core';
import type {RoomSnapshot,RoomWireSnapshot,RoomRequest} from './protocol';
export class NetworkGameController implements GameController {
 private timings:{kind:string;ms:number;bytes?:number;serverMs?:number;requestId?:string}[]=[];
 private note(value:typeof this.timings[number]){this.timings.push(value);if(this.timings.length>100)this.timings.shift();}
 private timingTimer=setInterval(()=>void this.flushTimings(),30000);
 private async flushTimings(){if(this.stopped||!this.info.room?.connected||!this.timings.length)return;const batch=this.timings.splice(0,30);try{await fetch('/api/request',{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),connection:this.connection,method:'metrics',args:[],epoch:this.info.room.epoch,revision:this.state?.revision??null,clientTimings:batch}),signal:AbortSignal.timeout(10000)});}catch{this.timings=[...batch,...this.timings].slice(-100);}}
 private state:GameState|null=null;
 private info:SessionInfo={ready:true,canUndo:false,undoCount:0,savedAt:null,storageError:'',rounds:[],nations:[],replayMode:false,replayCursor:0,replayEntries:[],room:{userId:'',name:'',access:{kind:'public'},members:[],connected:false,recoveryAvailable:false,epoch:''}};
 private listeners=new Set<()=>void>();
 private contexts=new Map<number,{epoch:string;decision?:string}>();
 private inFlight=false;private uncertain?:RoomRequest;private recovering=false;
 private replayLoading?:{epoch:string;promise:Promise<void>};
 private replayCache?:{epoch:string;entries:SessionInfo['replayEntries']};
 private resyncing=false;
 private async resync(){if(this.resyncing||this.stopped)return;this.resyncing=true;try{this.accept(await this.transmit({id:crypto.randomUUID(),connection:this.connection,epoch:this.info.room!.epoch,revision:this.state?.revision??null,method:'sync',args:[]}) as RoomSnapshot);}catch(e){this.info={...this.info,room:{...this.info.room!,error:String(e)}};this.emit();}finally{this.resyncing=false;}}
 private accept(payload:RoomWireSnapshot,stream=false){
  if(payload.room.serverId&&this.info.room?.serverId){if(payload.room.serverId===this.info.room.serverId&&(payload.room.sequence??0)<(this.info.room.sequence??0))return;if(payload.room.serverId!==this.info.room.serverId&&!stream)return;}
  if(payload.statePatch){
   if(payload.room.serverId!==this.info.room?.serverId||(payload.baseEpoch??payload.room.epoch)!==this.info.room?.epoch||payload.baseSequence!==this.info.room?.sequence){void this.resync();return;}
   try{if(payload.chatPatch)payload={...payload,room:{...payload.room,chat:applyPatch(this.info.room?.chat??[],payload.chatPatch)}};payload={...payload,state:applyPatch(this.state,payload.statePatch!),info:payload.infoPatch?applyPatch({...this.info,replayEntries:[]},payload.infoPatch):payload.info};}catch{void this.resync();return;}
  }
  if(payload.state===undefined||!payload.info){void this.resync();return;}
  if(payload.room.epoch===this.info.room?.epoch&&payload.state&&this.state&&payload.state.revision<this.state.revision)return;
  if(payload.room.epoch!==this.info.room?.epoch)this.contexts.clear();
  if(payload.room.epoch!==this.info.room?.epoch||payload.room.access.kind!=='gm'||!payload.info.replayMode)this.replayCache=undefined;
  this.state=shareView(this.state,payload.state);this.info={...payload.info,replayEntries:this.replayCache?.entries??payload.info.replayEntries,room:payload.room};
  if(payload.state)this.contexts.set(payload.state.revision,{epoch:payload.room.epoch,decision:payload.room.decision});
  while(this.contexts.size>128)this.contexts.delete(this.contexts.keys().next().value!);
  this.emit();
 }
 private async transmit(request:RoomRequest):Promise<unknown>{
  let failure:unknown;
  for(let attempt=0;attempt<3;attempt++){
   const until=Date.now()+10000;
   while(!this.info.room?.connected&&!this.stopped&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
   if(!this.info.room?.connected){failure=new Error('连接尚未恢复');continue;}
   const started=performance.now();let body:{ok:boolean;result:unknown;error?:string;serverTiming?:{ms:number}};
   try{const response=await fetch('/api/request',{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',...(request.method==='importSave'?{'X-QM-History-Import':'1'}:{})},body:JSON.stringify({...request,connection:this.connection}),signal:AbortSignal.timeout(request.method==='importSave'?1800000:12000)});body=await response.json();this.note({kind:'http',ms:performance.now()-started,serverMs:body.serverTiming?.ms,requestId:request.id});}
   catch(e){this.note({kind:'http',ms:performance.now()-started,requestId:request.id});failure=e;continue;}
   if(!body.ok)throw new Error(body.error??'操作未被接受');
   return body.result;
  }
  throw Object.assign(new Error('网络暂时不稳定，提交结果待确认；请勿重复操作，连接恢复后会自动核对。'),{uncertain:true,cause:failure});
 }
 private async confirmSnapshot(value:unknown){
  if(value&&typeof value==='object'&&'room' in value&&'state' in value){this.accept(value as RoomSnapshot);return;}
  const receipt=value as {appliedRevision?:number;epoch?:string}|null;
  if(receipt?.appliedRevision===undefined)return;
  const until=Date.now()+1500;
  while(this.info.room?.epoch===receipt.epoch&&(this.state?.revision??-1)<receipt.appliedRevision&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
  if(this.info.room?.epoch!==receipt.epoch||(this.state?.revision??-1)<receipt.appliedRevision){
   const snapshot=await this.transmit({id:crypto.randomUUID(),connection:this.connection,epoch:this.info.room!.epoch,revision:this.state?.revision??null,method:'sync',args:[]});
   this.accept(snapshot as RoomSnapshot);
  }
 }
 private async recover(){
  if(this.stopped||!this.uncertain||this.recovering||this.inFlight)return;
  this.recovering=true;
  try{const value=await this.transmit(this.uncertain);await this.confirmSnapshot(value);this.uncertain=undefined;this.info={...this.info,room:{...this.info.room!,error:'上次提交已核对，请按当前局面继续。'}};}
  catch(e){if(!(e as {uncertain?:boolean}).uncertain)this.uncertain=undefined;this.info={...this.info,room:{...this.info.room!,error:String(e)}};}
  finally{this.recovering=false;this.emit();if(this.uncertain&&!this.stopped)setTimeout(()=>void this.recover(),2000);}
 }
 private connection=crypto.randomUUID();private stopped=false;private socket?:WebSocket;
 constructor(private token:string){this.stream();}
 getSnapshot=()=>this.state;
 getSessionInfo=()=>this.info;
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 private emit(){this.listeners.forEach(f=>f());}
 close(){this.stopped=true;clearInterval(this.timingTimer);this.socket?.close();}
 private stream(){
  if(this.stopped)return;
  this.connection=crypto.randomUUID();
  const ws=this.socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/socket`);
  ws.onopen=()=>ws.send(JSON.stringify({token:this.token,connection:this.connection}));
  ws.onmessage=event=>{
   const received=performance.now();const payload=JSON.parse(event.data) as RoomWireSnapshot&{replaced?:boolean;error?:string};
   if(payload.replaced||payload.error){this.stopped=true;clearInterval(this.timingTimer);this.state=null;this.info={...this.info,room:{...this.info.room!,connected:false,error:payload.error||'此身份已在另一页面连接。'}};this.emit();ws.close();return;}
   if(ws!==this.socket)return;this.accept(payload,true);this.note({kind:'decode',ms:performance.now()-received,bytes:new TextEncoder().encode(event.data).length});if(typeof document!=='undefined'&&document.visibilityState==='visible')requestAnimationFrame(()=>requestAnimationFrame(()=>{if(!this.stopped&&document.visibilityState==='visible')this.note({kind:'frames',ms:performance.now()-received});}));void this.recover();
  };
  ws.onclose=()=>{if(this.stopped||ws!==this.socket)return;this.info={...this.info,room:{...this.info.room!,connected:false,error:'连接中断，正在重新连接…'}};this.emit();setTimeout(()=>this.stream(),1500);};
 }
 async request<T=void>(method:string,...args:unknown[]):Promise<T>{
  if(!this.info.room?.connected)throw new Error('尚未连接，不能操作。');
  if(this.inFlight||this.recovering)throw new Error('上一项操作正在提交，请稍候。');
  if(this.uncertain){void this.recover();throw new Error('正在核对上次提交，请稍候再操作。');}
  const command=method==='dispatch'?args[0] as Command:null;
  const revision=command&&'expectedRevision' in command?command.expectedRevision:this.state?.revision??null;
  const context=revision===null?undefined:this.contexts.get(revision);
  const request:RoomRequest={id:crypto.randomUUID(),connection:this.connection,epoch:context?.epoch??this.info.room.epoch,revision,decision:context?.decision??(revision===this.state?.revision?this.info.room.decision:undefined),method,args};
  this.inFlight=true;
  try{const value=await this.transmit(request);const waitStarted=performance.now();await this.confirmSnapshot(value);this.note({kind:'snapshot_wait',ms:performance.now()-waitStarted,requestId:request.id});return value as T;}
  catch(e){if((e as {uncertain?:boolean}).uncertain){this.uncertain=request;setTimeout(()=>void this.recover(),2000);}throw e;}
  finally{this.inFlight=false;}

 }
 drawCountry=()=>this.request<RoomSnapshot>('drawCountry');
 setRoomAccess=(access:RoomAccess)=>{if(JSON.stringify(access)===JSON.stringify(this.info.room?.access))return;void this.request('seat',access).catch(e=>{this.info={...this.info,room:{...this.info.room!,error:String(e)}};this.emit();});};
 dispatch=async(command:Command):Promise<DispatchResult>=>{if(command.type==='SET_VIEW'){await this.request('view',command.seat);return {ok:true};}return this.request('dispatch',command);};
 undo=()=>this.request('undo');loadCheckpoint=(id:string)=>this.request('loadCheckpoint',id);
 exportSave=(pointId?:string)=>this.request<string>('exportSave',pointId);exportReplay=()=>this.request<string>('exportReplay');
 exportReplayNodeSave=()=>this.request<string>('exportReplayNodeSave');exportDiagnostics=async(note:string)=>{await this.flushTimings();return this.request<string>('exportDiagnostics',note);};
 checkReplay=()=>this.request<boolean>('checkReplay');
 importSave=(json:string)=>this.request('importSave',json);importReplay=(json:string)=>this.request('importReplay',json);
 loadReplayEntries=():Promise<void>=>{const epoch=this.info.room!.epoch;if(this.replayCache?.epoch===epoch)return Promise.resolve();if(this.replayLoading?.epoch===epoch)return this.replayLoading.promise;
  const promise=(async()=>{while((this.inFlight||this.recovering||this.uncertain||!this.info.room?.connected)&&!this.stopped&&this.info.room?.epoch===epoch)await new Promise(r=>setTimeout(r,25));if(this.stopped||this.info.room?.epoch!==epoch||this.info.room.access.kind!=='gm'||!this.info.replayMode)return;
   const entries=await this.request<SessionInfo['replayEntries']>('replayEntries');if(this.info.room?.epoch===epoch&&this.info.room.access.kind==='gm'&&this.info.replayMode){this.replayCache={epoch,entries};this.info={...this.info,replayEntries:entries};this.emit();}
  })().finally(()=>{if(this.replayLoading?.epoch===epoch)this.replayLoading=undefined;});this.replayLoading={epoch,promise};return promise;
 };

 seekReplay=(index:number)=>this.request('seekReplay',index);setSceneLocked=async(locked:boolean)=>{await this.request('sceneLock',locked);};editScene=(s:unknown,options?:{endPrelude?:boolean;endNeutrality?:'soviet_union'|'united_states'})=>this.request('editScene',s,options);
}

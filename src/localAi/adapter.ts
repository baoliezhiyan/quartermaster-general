import type {Room} from '../network/Room';
import {AiError,compileOffer,type Submission} from './contract';
type Observation=Awaited<ReturnType<Room['localAiObserve']>>;
/** Local transport adapter: no authority beyond the authenticated Room player. */
export class LocalAiAdapter {
 private sessions=new Map<string,{connection:string;wake:Set<()=>void>;alive:boolean}>();
 private results=new Map<string,{fingerprint:string;value:unknown}>();
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private room:Room){}
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}
 async connect(token:string){
  await this.room.localAiAuthorize(token);
  const previous=this.sessions.get(token);if(previous?.alive)return this.observe(token);
  const session={connection:crypto.randomUUID(),wake:new Set<()=>void>(),alive:true};this.sessions.set(token,session);
  try{await this.room.connect(token,session.connection,v=>{if('replaced' in v)session.alive=false;for(const wake of [...session.wake])wake();});return await this.observe(token);}catch(e){await this.room.disconnect(token,session.connection);this.sessions.delete(token);throw e;}
 }
 async disconnect(token:string){const s=this.sessions.get(token);if(s){s.alive=false;for(const wake of s.wake)wake();await this.room.disconnect(token,s.connection);this.sessions.delete(token);}return {disconnected:true};}
 private session(token:string){const s=this.sessions.get(token);if(!s?.alive)throw new AiError('DISCONNECTED','请先 connect；身份可能已被另一页面接管');return s;}
 async observe(token:string):Promise<Observation>{const s=this.session(token);return this.room.localAiObserve(token,s.connection);}
 async wait(token:string,after:number,timeout:number){
  if(!Number.isSafeInteger(after)||!Number.isFinite(timeout)||timeout<0||timeout>60000)throw new AiError('INVALID_REQUEST','等待超时范围为 0..60000 毫秒');
  const session=this.session(token);let timer:ReturnType<typeof setTimeout>|undefined,notify:()=>void=()=>{};
  const changed=new Promise<void>(resolve=>{notify=resolve;session.wake.add(notify);timer=setTimeout(resolve,timeout);});
  try{const initial=await this.observe(token);if(initial.sequence===after)await changed;return await this.observe(token);}finally{if(timer)clearTimeout(timer);session.wake.delete(notify);}
 }
 submit(token:string,r:Submission){return this.serial(async()=>{
  if(!r||typeof r.requestId!=='string'||!r.requestId.length||r.requestId.length>100||typeof r.gameId!=='string'||typeof r.epoch!=='string'||!Number.isSafeInteger(r.revision))throw new AiError('INVALID_REQUEST','缺少有效请求编号及局面版本');
  const s=this.session(token),key=token+':'+r.requestId,fingerprint=JSON.stringify(r),old=this.results.get(key);
  if(old){if(old.fingerprint!==fingerprint)throw new AiError('DUPLICATE_CONFLICT','同一请求编号不能更改内容');return {...old.value as {requestId:string;result:unknown},duplicate:true,observation:await this.observe(token)};}
  const o=await this.observe(token);if(r.gameId!==o.gameId||r.epoch!==o.epoch)throw new AiError('WRONG_GAME','对局或房间世代已改变');
  if(r.revision!==o.revision)throw new AiError('STALE','局面已更新，请重新 observe');
  if(o.status==='unsupported'||o.locked||o.replay)throw new AiError('UNAVAILABLE','当前节点不可操作');
  const command=await this.room.localAiPrepare(token,s.connection,compileOffer(o.offers,r));
  // Ordinary seat switch is binding-checked and the ordinary request handles lock,
  // revision, permissions, execution and the host match recorder.
  await this.room.request(token,{id:'ai-seat:'+r.requestId,connection:s.connection,epoch:o.epoch,revision:o.revision,method:'seat',args:[{kind:'player',seat:command.seat}]});
  const result=await this.room.request(token,{id:'ai:'+r.requestId,connection:s.connection,epoch:r.epoch,revision:r.revision,method:'dispatch',args:[command]});
  const value={requestId:r.requestId,result,observation:await this.observe(token)};this.results.set(key,{fingerprint,value:{requestId:r.requestId,result}});return value;
 });}
}

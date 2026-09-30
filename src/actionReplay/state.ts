import type {GameState} from '../core/types';
import {SEATS} from '../core/types';
import {validateState} from '../controller/saveFormat';
import type {Snapshot,ObjectData} from './contract';
import identity from '../matchLog/build-identity.json';
import pkg from '../../package.json';
import {diffValue,applyPatch} from '../network/jsonPatch';
import type {Patch} from '../network/jsonPatch';
export const VERSION=pkg.version;
export const ENGINE=identity.rulesFingerprint;
export const ADAPTER={id:'quartermaster-standard',version:'2.0.0'};
export function canonical(value:unknown):string {
 if(value===undefined)return 'null';
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>(value as any)[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical((value as any)[k])).join(',')+'}';
 return JSON.stringify(value);
}
export async function hash(value:unknown):Promise<string>{return hashText(canonical(value));}
export async function hashText(text:string):Promise<string>{const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');}
/** Only placement facts are rule history. Display logs and old sessions never enter checkpoints. */
export function ruleState(source:GameState):GameState {
 const s=structuredClone(source);
 delete (s as GameState&{resourcePool?:unknown}).resourcePool;
 const events=s.events;
 if(s.prelude){s.prelude.installedEvent=Object.fromEntries(Object.entries(s.prelude.installedEvent??{}).map(([id,n])=>[id,events.slice(0,n).filter(e=>e.type==='UNIT_PLACED').length]));s.prelude.installed=Object.fromEntries(Object.keys(s.prelude.installed).map(id=>[id,0]));s.prelude.wars=s.prelude.wars.map(w=>({...w,revision:0}));}
 s.events=events.filter(e=>e.type==='UNIT_PLACED').map(e=>({...e,revision:0}));
 s.revision=0;s.viewSeat=s.activeSeat;s.operatorSeat=s.resolution?.choice?.seat??s.pendingDiscard?.seat??s.activeSeat;
 delete s.publicLog;
 s.responseNotices=[];
 if(s.resolution){
  s.resolution.trace=[];
  for(const f of s.resolution.frames){delete f.rollback;delete f.extraRollback;}
  if(!s.resolution.running)s.resolution={...s.resolution,frames:[],windows:[],stack:[],events:[],rules:[],choice:null,trace:[],fired:[],serial:0};
 }
 return s;
}
function encode(s:GameState,depth=0):any {
 if(depth>32)throw Error('取消操作上下文嵌套过深');
 const value:any=ruleState(s),patches=[];
 for(const f of s.resolution?.frames??[])for(const key of ['rollback','extraRollback'] as const)if(f[key])patches.push({frameId:f.id,key,patch:diffValue(value,encode(f[key]!,depth+1))});
 const ids=new Set(s.resolution?.revealGroup?.items.flatMap(i=>[i.requestId,i.resultId])??[]);
 return {...value,...(patches.length?{rollbackPatches:patches}:{}),...(ids.size?{pendingRevealNotices:s.responseNotices?.filter(n=>ids.has(n.id))??[]}: {})};
}
export function snapshot(s:GameState):Snapshot {
 return {ruleState:{...encode(s),resourcePool:Object.fromEntries(SEATS.map(seat=>[seat,[]]))} as unknown as ObjectData};
}
export function restore(snapshot:Snapshot):GameState {
 const {resourcePool,...value}=snapshot.ruleState;
 if(!resourcePool||Array.isArray(resourcePool)||typeof resourcePool!=='object'||SEATS.some(seat=>!Array.isArray(resourcePool[seat])))throw Error('缺少资源池接口');
 function decode(v:any,depth=0):GameState {
  if(depth>32)throw Error('取消操作上下文嵌套过深');
  const {rollbackPatches=[],pendingRevealNotices,...plain}=v;
  if(!Array.isArray(rollbackPatches)||rollbackPatches.length>200)throw Error('取消操作增量无效');
  const state=structuredClone(plain);if(pendingRevealNotices)state.responseNotices=pendingRevealNotices;
  validateState(state);
  for(const item of rollbackPatches){const frame=state.resolution?.frames.find(f=>f.id===item.frameId);if(!frame||!['rollback','extraRollback'].includes(item.key)||!Array.isArray(item.patch)||item.patch.length>100000)throw Error('取消操作引用无效');frame[item.key as 'rollback']=decode(applyPatch(plain,item.patch as Patch[]),depth+1);}
  return state;
 }
 return Object.assign(decode(value),{resourcePool:structuredClone(resourcePool)});
}
export const stateHash=(s:GameState)=>hash(snapshot(s));

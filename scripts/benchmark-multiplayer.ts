import {createJournalStore} from '../scripts/journal-store.mjs';
import {encodeSnapshot} from '../scripts/wire-snapshot.mjs';
import {Room,setPerformanceSink,diffValue,applyPatch} from '../src/network/Room';
import {verifyReplay} from '../src/controller/saveFormat';
import {SEATS} from '../src/core';
import {mkdir,open,rename,writeFile} from 'node:fs/promises';
import type {RoomSnapshot,RoomRequest} from '../src/network/protocol';
import type {SaveSession} from '../src/controller/saveFormat';
const dir='outputs/multiplayer-performance-v0.25.5';await mkdir(dir,{recursive:true});
let saved:SaveSession;let round=0;const samples:{round:number;name:string;ms:number;bytes?:number}[]=[];
const record=(name:string,ms:number,bytes?:number)=>samples.push({round,name,ms,bytes});setPerformanceSink(s=>record(s.name,s.ms,s.bytes));
const store=createJournalStore(dir,{diff:diffValue,apply:applyPatch,onMetric:s=>record(s.name,s.ms,s.bytes),onWarning:console.warn});
const room=new Room({read:async()=>null,list:async()=>[],write:async(s,expected,replace)=>{await store.write(s,expected,replace);saved=s;}},[],async()=>{},async()=>null);

async function join(name:string){const user=await room.createIdentity(name),connection=crypto.randomUUID();let snapshot:RoomSnapshot;let previous:RoomSnapshot|undefined;await room.connect(user.token,connection,v=>{if('replaced'in v)return;snapshot=v;const t=performance.now(),json=encodeSnapshot(previous,v,diffValue);previous=v;record('wire_serialize',performance.now()-t,Buffer.byteLength(json));});return{get snapshot(){return snapshot;},call:(method:string,...args:unknown[])=>room.request(user.token,{id:crypto.randomUUID(),connection,epoch:snapshot.room.epoch,decision:snapshot.room.decision,revision:snapshot.state?.revision??null,method,args})};}
const gm=await join('GM');await gm.call('seat',{kind:'gm'});const players=[];for(const seat of SEATS){const p=await join(seat);await p.call('seat',{kind:'player',seat});players.push(p);}
await gm.call('dispatch',{type:'CREATE_GAME',gameId:'performance',seed:1940});
for(let i=0;i<6;i++){const p=players[i],s=p.snapshot.state!;await p.call('dispatch',{type:'KEEP_OPENING',seat:SEATS[i],expectedRevision:s.revision,cardIds:s.decks[SEATS[i]].hand.slice(0,7).map(c=>c.id)});}
let steps=0,last=0;while(gm.snapshot.state!.status!=='FINISHED'&&steps++<2500){const s=gm.snapshot.state!,c=s.resolution?.choice;round=s.round;
 if(round!==last){last=round;if([1,10,20].includes(round))await writeFile(dir+`/round-${round}.json`,JSON.stringify(saved));if(round%5===0)console.log('Round',round,'steps',steps);}
 const seat=c?.seat??s.activeSeat,p=players[SEATS.indexOf(seat)],command=c?{type:'RESOLVE_ENGINE_CHOICE',choiceId:c.id,ids:c.kind==='TRIGGER'||c.canSkip||c.min===0?[]:c.options.slice(0,c.min).map(o=>o.id),seat,expectedRevision:s.revision}:s.phase==='DISCARD'?{type:'DISCARD_HAND',cardIds:[],seat,expectedRevision:s.revision}:{type:'ADVANCE_PHASE',seat,expectedRevision:s.revision};
 const result=await p.call('dispatch',command) as {ok:boolean};if(!result.ok)throw Error(JSON.stringify(result));
}
if(steps>=2500)throw Error('did not finish');
const summary={steps,status:gm.snapshot.state!.status,memory:process.memoryUsage(),groups:{} as Record<string,unknown>};
for(const [name,min,max] of [['early',1,3],['middle',9,11],['late',18,20]] as const){const chosen=samples.filter(s=>s.round>=min&&s.round<=max);const stats:Record<string,unknown>={};for(const metric of new Set(chosen.map(s=>s.name))){const values=chosen.filter(s=>s.name===metric),v=values.map(s=>s.ms).sort((a,b)=>a-b);stats[metric]={n:v.length,meanMs:v.reduce((a,b)=>a+b,0)/v.length,p95Ms:v[Math.floor(v.length*.95)],meanBytes:values[0]?.bytes===undefined?undefined:values.reduce((n,s)=>n+(s.bytes??0),0)/values.length};}summary.groups[name]=stats;}
const recovered=await createJournalStore(dir,{diff:diffValue,apply:applyPatch}).read();
if(JSON.stringify(recovered)!==JSON.stringify(saved)||!verifyReplay(recovered))throw Error('Durable final state or replay mismatch');
await writeFile(dir+'/results.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));

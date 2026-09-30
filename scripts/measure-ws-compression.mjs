import {Room,diffValue} from '../dist-server/Room.js';
import {encodeSnapshot} from './wire-snapshot.mjs';
import {socketCompression,compressionThreshold} from './ws-compression.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {WebSocket,WebSocketServer} from 'ws';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const seats=['germany','united_kingdom','japan','soviet_union','italy','united_states'],messages=[];
for(const long of [false,true])for(const air of [false,true]){
 const room=new Room({read:async()=>null,list:async()=>[],write:async()=>{}},[],async()=>{},async()=>null),users=[],snapshots=new Map(),previous=new Map();let capture=false;
 for(const name of ['gm',...seats]){const user=await room.createIdentity(name);user.connection=name;users.push(user);await room.connect(user.token,name,s=>{snapshots.set(name,s);if(capture){messages.push(encodeSnapshot(previous.get(name),s,diffValue));previous.set(name,s);}});}
 async function request(u,method,...args){const s=snapshots.get(u.connection);return room.request(u.token,{id:crypto.randomUUID(),connection:u.connection,epoch:s.room.epoch,revision:s.state?.revision??null,method,args});}
 const gm=users[0];await request(gm,'seat',{kind:'gm'});await request(gm,'importSave',await readFile(`outputs/view-performance/fixture-${long}-${air}.json`,'utf8'));
 for(let i=0;i<seats.length;i++)await request(users[i+1],'seat',{kind:'player',seat:seats[i]});
 capture=true;await request(gm,'sceneLock',true);await request(gm,'sceneLock',false);
 async function dispatch(c){const result=await request(gm,'dispatch',{...c,expectedRevision:snapshots.get('gm').state.revision});assert.notEqual(result?.ok,false);}
 await dispatch({type:'PLAY_CARD',seat:'germany',cardId:snapshots.get('gm').state.decks.germany.hand[0].id,targetIds:[],effectIndices:[0],guided:true});
 for(let i=0;i<30;i++){const q=snapshots.get('gm').state.resolution?.choice;if(!q)break;await dispatch({type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,choiceId:q.id,ids:q.kind==='TRIGGER'?[]:q.options.slice(0,q.min).map(o=>o.id)});}
 await request(gm,'undo');
}
async function measure(level){
 const server=new WebSocketServer({port:0,host:'127.0.0.1',perMessageDeflate:level===null?false:{...socketCompression,zlibDeflateOptions:{level}}});await once(server,'listening');
 const connected=once(server,'connection'),client=new WebSocket(`ws://127.0.0.1:${server.address().port}`,{perMessageDeflate:true,maxPayload:70*1024*1024});const [peer]=await connected;await once(client,'open');
 let index=0;const done=new Promise((ok,fail)=>{client.on('message',data=>{try{assert.equal(data.toString(),messages[index++]);if(index===messages.length)ok();}catch(e){fail(e);}});});
 const before=peer._socket.bytesWritten,cpu=process.cpuUsage(),start=performance.now();
 for(const message of messages)await new Promise((ok,fail)=>peer.send(message,{compress:Buffer.byteLength(message)>=compressionThreshold},e=>e?fail(e):ok()));
 await done;const elapsedMs=performance.now()-start,used=process.cpuUsage(cpu),wireBytes=peer._socket.bytesWritten-before;
 client.terminate();peer.terminate();await new Promise(ok=>server.close(ok));
 return {level,wireBytes,elapsedMs,cpuMs:(used.user+used.system)/1000};
}
const rows=[];for(let trial=0;trial<7;trial++)for(const level of trial%2?[3,1,null]:[null,1,3])rows.push({trial,...await measure(level)});
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=[null,1,3].map(level=>{const samples=rows.filter(r=>r.level===level&&r.trial>0);return {level,messages:messages.length,wireBytes:median(samples.map(r=>r.wireBytes)),elapsedMs:median(samples.map(r=>r.elapsedMs)),cpuMs:median(samples.map(r=>r.cpuMs))};});
await mkdir('outputs/client-localization',{recursive:true});await writeFile('outputs/client-localization/compression.json',JSON.stringify({scope:'Four real scenarios, six players plus GM, initial snapshots, action deltas, undo. Loopback ws transport; CPU includes server compression and client decoding. Trial 0 warmup excluded.',summary,rows},null,2));console.log(JSON.stringify(summary,null,2));

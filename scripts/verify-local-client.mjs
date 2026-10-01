import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {once} from 'node:events';
import {resolve,join as pathJoin} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocket} from 'ws';
const packaged=process.argv.includes('--package');
const packageRoot=packaged?JSON.parse(await readFile('releases/multiplayer-latest.json','utf8')).folder:resolve('.');
const {startClient,hostAddress}=await import(pathToFileURL(pathJoin(packageRoot,'scripts/join-client.mjs')));
const {applyPatch}=await import(pathToFileURL(pathJoin(packageRoot,packaged?'dist-server/Room.mjs':'dist-server/Room.js')));
const output=resolve('outputs/client-localization');await mkdir(output,{recursive:true});
const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(ok=>probe.close(ok));
const data=await mkdtemp(output+'/host-');
const child=spawn(packaged?pathJoin(packageRoot,'runtime/node.exe'):process.execPath,[pathJoin(packageRoot,'scripts/multiplayer-server.mjs')],{cwd:packageRoot,env:{...process.env,...(packaged?{PATH:''}:{}),QM_PORT:String(port),QM_PUBLIC_ORIGIN:'',QM_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const host=`http://127.0.0.1:${port}`;let client;const peers=[];let count=0;
const check=(condition)=>{assert(condition);count++;};
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await new Promise(ok=>setTimeout(ok,25));}throw Error('timeout: '+logs);}
async function join(base,name){
 const identity=await fetch(base+'/api/identity',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({name})}).then(r=>r.json());check(identity.ok);
 const ws=new WebSocket(base.replace('http:','ws:')+'/api/socket',{origin:base});peers.push(ws);const connection=crypto.randomUUID();let snapshot;
 ws.on('message',raw=>{const next=JSON.parse(raw.toString());if(next.error)throw Error(next.error);if(next.replaced)return;snapshot={...next,state:'state' in next?next.state:applyPatch(snapshot.state,next.statePatch),info:'info' in next?next.info:next.infoPatch?applyPatch(snapshot.info,next.infoPatch):snapshot.info};});
 await once(ws,'open');ws.send(JSON.stringify({token:identity.result.token,connection}));await until(()=>snapshot);
 return {ws,identity:identity.result,get snapshot(){return snapshot;},async call(method,...args){const reply=await fetch(base+'/api/request',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Authorization:'Bearer '+identity.result.token},body:JSON.stringify({id:crypto.randomUUID(),connection,epoch:snapshot.room.epoch,revision:snapshot.state?.revision??null,method,args})}).then(r=>r.json());return reply;}};
}
try{
 await until(async()=>{try{return (await fetch(host+'/api/client-info')).ok;}catch{return false;}});
 client=await startClient(host,{port:0});const local=new URL(client.url).origin;
 const info=await fetch(host+'/api/client-info').then(r=>r.json());check(info.protocol===1);
 const html=await fetch(local);check(html.headers.get('cache-control')==='no-store');check((await html.text()).includes(info.roomId));
 const index=await fetch(host).then(r=>r.text()),js=new URL(index.match(/src="([^"]+\.js)"/)[1],host).pathname;
 for(const asset of [js,'/assets/final-map.png','/assets/brand-logo.png']){
  const direct=await fetch(host+asset),cached=await fetch(local+asset);check(direct.ok&&cached.ok);assert.deepEqual(Buffer.from(await cached.arrayBuffer()),Buffer.from(await direct.arrayBuffer()));count++;
  const tag=cached.headers.get('etag');check(!!tag);check((await fetch(local+asset,{headers:{'If-None-Match':tag}})).status===304);check((await fetch(host+asset,{headers:{'If-None-Match':tag}})).status===304);
 }
 check((await fetch(local+'/api/identity',{method:'POST',headers:{Origin:'https://untrusted.invalid','Content-Type':'application/json'},body:'{"name":"evil"}'})).status===403);
 check((await fetch(local+'/api/unknown',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status===400);
 check((await fetch(local+'/scripts/join-client.mjs')).status===404);
 for(const invalid of ['file:///etc/passwd','https://user:password@example.org/','https://example.org/path','https://example.org/?target=x']){assert.throws(()=>hostAddress(invalid));count++;}
 const gm=await join(host,'直连GM'),player=await join(local,'本地德国'),observer=await join(host,'直连观察者');
 const statuses=await fetch(local+'/api/identity-status',{method:'POST',headers:{'Content-Type':'application/json',Origin:local},body:JSON.stringify({tokens:[player.identity.token,'invalid']})}).then(r=>r.json());check(statuses.ok&&statuses.result[0].online&&statuses.result[0].valid&&!statuses.result[1].valid);
 check(gm.ws.extensions.includes('permessage-deflate'));check(player.ws.extensions==='');
 check((await gm.call('seat',{kind:'gm'})).ok);await until(()=>gm.snapshot.room.access.kind==='gm');
 check((await player.call('seat',{kind:'player',seat:'germany'})).ok);await until(()=>player.snapshot.room.access.kind==='player');
 check((await gm.call('dispatch',{type:'CREATE_GAME',gameId:'client-integration',seed:8,prelude:true,balance:true})).result.ok);await until(()=>player.snapshot.state?.gameId==='client-integration'&&gm.snapshot.state?.gameId==='client-integration');
 check(observer.snapshot.state.decks.germany.hand.every(c=>c.definitionId==='hidden'));check(player.snapshot.state.decks.germany.hand.some(c=>c.definitionId!=='hidden'));
 check((await gm.call('sceneLock',true)).ok);await until(()=>player.snapshot.room.sceneLocked);
 check(!(await player.call('dispatch',{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:player.snapshot.state.revision})).ok);
 const state=structuredClone(gm.snapshot.state);state.scores.germany=11;check((await gm.call('editScene',state)).ok);await until(()=>player.snapshot.state.scores.germany===11);
 check((await gm.call('sceneLock',false)).ok);await until(()=>!player.snapshot.room.sceneLocked);
 check((await player.call('dispatch',{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:player.snapshot.state.revision})).result.ok);
 // Disconnect/reconnect and use the same identity through the localized route.
 const connection=crypto.randomUUID(),reconnect=new WebSocket(local.replace('http:','ws:')+'/api/socket',{origin:local});peers.push(reconnect);await once(reconnect,'open');reconnect.send(JSON.stringify({token:player.identity.token,connection}));const [raw]=await once(reconnect,'message');check(JSON.parse(raw).room.name==='本地德国');
 // A GM using the localized route downloads raw, compressed host history.
 check((await gm.call('seat',{kind:'public'})).ok);
 const localGM=await join(local,'本地GM');check((await localGM.call('seat',{kind:'gm'})).ok);await until(()=>localGM.snapshot.room.access.kind==='gm');
 const full=await fetch(local+'/api/history-export',{method:'POST',headers:{'Content-Type':'application/json',Origin:local,Authorization:'Bearer '+localGM.identity.token},body:'{}'});
 check(full.ok);check(full.headers.get('content-encoding')==='gzip');const exported=await full.text();check(JSON.parse(exported.split('\n')[0]).format==='quartermaster-match-log');
 const denied=await fetch(local+'/api/history-export',{method:'POST',headers:{'Content-Type':'application/json',Origin:local,Authorization:'Bearer '+player.identity.token},body:'{}'});check(!denied.ok);
 check((await localGM.call('seat',{kind:'public'})).ok);
 check((await gm.call('seat',{kind:'gm'})).ok);await until(()=>gm.snapshot.room.access.kind==='gm');
 check((await gm.call('sceneLock',true)).ok);gm.ws.terminate();await until(()=>observer.snapshot.room.sceneLocked===false);
 const incompatible=http.createServer((req,res)=>res.end(JSON.stringify({protocol:1,fingerprint:'different',roomId:'wrong'})));incompatible.listen(0,'127.0.0.1');await once(incompatible,'listening');try{await assert.rejects(startClient(`http://127.0.0.1:${incompatible.address().port}`,{port:0}),/不一致/);count++;}finally{await new Promise(ok=>incompatible.close(ok));}
 // With host gone, local assets must remain available; no remote resource fallback.
 child.kill();await once(child,'exit');check((await fetch(local+js)).ok);check((await fetch(local+'/assets/final-map.png')).ok);
 const offline=new WebSocket(local.replace('http:','ws:')+'/api/socket',{origin:local});peers.push(offline);let fatal=false;offline.on('message',raw=>{fatal ||= !!JSON.parse(raw).error;});await once(offline,'close');check(!fatal); // temporary host loss must allow browser retry, not permanently stop it.

 await writeFile(output+(packaged?'/package-integration.json':'/integration.json'),JSON.stringify({checks:count,passed:true,coverage:['mixed direct/local players','compression negotiation','assets byte equality and 304','role privacy','GM lock/edit/unlock','GM disconnect unlock','identity reconnection','host mismatch','origin/path/URL validation','local resources without host']},null,2));console.log(`PASS ${count} integration checks`);
}finally{for(const ws of peers)ws.terminate();await client?.close();if(child.exitCode===null)child.kill();}

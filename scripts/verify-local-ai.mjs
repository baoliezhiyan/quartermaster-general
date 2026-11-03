import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
const run=promisify(execFile),root=process.cwd(),base='http://127.0.0.1:19383',ai='http://127.0.0.1:19385';
const area=root+'/outputs/local-ai-http/'+Date.now(),env={...process.env,QM_PORT:'19383',QM_AI_PORT:'19385',QM_LOCAL_AI:'1',QM_DATA_DIR:area+'/data',QM_AI_PRIVATE_DIR:area+'/private',QM_MATCH_LOG_DIR:area+'/records'};await mkdir(area,{recursive:true});
const child=spawn(process.execPath,['scripts/multiplayer-server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
let serverOutput='';child.stdout.on('data',b=>serverOutput+=b);child.stderr.on('data',b=>serverOutput+=b);
const sockets=[];
async function post(path,body,token){const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const value=await res.json();assert(value.ok);return value.result;}
async function user(name){const id=await post('/api/identity',{name}),connection=crypto.randomUUID(),ws=new WebSocket(base.replace('http','ws')+'/api/socket',{origin:base});sockets.push(ws);const first=await new Promise((resolve,reject)=>{ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({token:id.token,connection})));ws.once('message',data=>resolve(JSON.parse(data)));});return {...id,connection,epoch:first.room.epoch};}
async function call(u,method,...args){return post('/api/request',{id:crypto.randomUUID(),connection:u.connection,epoch:u.epoch,revision:null,method,args},u.token);}
try{
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('测试主机启动超时')),10000);const ready=()=>{if(serverOutput.includes('本机入口：'+base+'/')){clearTimeout(timeout);resolve();}};child.stdout.on('data',ready);child.once('exit',()=>{clearTimeout(timeout);reject(Error('测试主机启动失败'));});ready();});
 const gm=await user('constructed GM'),u=await user('constructed AI');await call(gm,'seat',{kind:'gm'});await call(u,'seat',{kind:'player',seat:'germany'});for(const s of ['germany','japan','italy'])await call(u,'binding',s,true);
 await call(gm,'dispatch',{type:'CREATE_GAME',gameId:'cli-constructed',seed:17,prelude:false,balance:true});
 const config=area+'/session.json';await writeFile(config,JSON.stringify({url:ai,token:u.token}));
 const cli=async(command,...args)=>{const {stdout}=await run(process.execPath,['scripts/local-ai-cli.mjs',command,'--config',config,...args],{cwd:root,env,timeout:10000,windowsHide:true});assert(!stdout.includes(u.token));return JSON.parse(stdout);};
 const initial=await cli('connect');assert.equal(initial.result.status,'needs_ai');assert.equal(initial.result.gameVersion,'1.8.4');
 assert.equal((await cli('status')).result.bindings.length,3);
 const before=await cli('observe');const after=await cli('wait','--timeout','25');assert.equal(before.result.revision,after.result.revision);
 const o=after.result,offer=o.offers.find(o=>o.seat==='italy'),request={requestId:crypto.randomUUID(),gameId:o.gameId,epoch:o.epoch,revision:o.revision,offerId:offer.id,selections:{cardIds:offer.selections.cardIds.ids.slice(0,7)}};
 const file=area+'/request.json';await writeFile(file,JSON.stringify(request));const submitted=await cli('submit','--request-file',file);assert.equal(submitted.result.result.ok,true);const duplicate=await cli('submit','--request-file',file);assert.equal(duplicate.result.duplicate,true);assert.equal(submitted.result.observation.revision,duplicate.result.observation.revision);
 const denied=await fetch(ai+'/api/local-ai/observe',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com',Authorization:'Bearer '+u.token},body:'{}'});assert.equal(denied.status,403);
 await cli('disconnect');await cli('connect');await cli('disconnect');
 const audit=await readFile(env.QM_AI_PRIVATE_DIR+'/audit/interface.jsonl','utf8');assert(!audit.includes(u.token));
 console.log('PASS actual server + independent CLI: connect, status, observe, timeout, UTF-8 submit, duplicate, disconnect/reconnect, browser-origin denial, secret-free audit');
}finally{for(const ws of sockets)ws.terminate();if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}}

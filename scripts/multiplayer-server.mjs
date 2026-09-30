import {withMatchLogs} from './match-log-store.mjs';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {loadStaticAssets} from './static-assets.mjs';
import {socketCompression,compressionThreshold} from './ws-compression.mjs';
import {createNetworkDiagnostics} from './network-diagnostics.mjs';
import {encodeSnapshot} from './wire-snapshot.mjs';
import {readRequestJson} from './request-json.mjs';
import {connectionPolicy} from './server-origin.mjs';
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Room,diffValue,applyPatch,setPerformanceSink} from '../dist-server/Room.js';
import {createJournalStore} from './journal-store.mjs';
import {WebSocketServer} from 'ws';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const port=Number(process.env.QM_PORT||4183),host='127.0.0.1';
const policy=connectionPolicy(port,process.env.QM_PUBLIC_ORIGIN||'');
const data=resolve(process.env.QM_DATA_DIR||join(root,'data'));
await mkdir(data,{recursive:true});
const lockPath=join(data,'server.lock');let lock;
try{lock=await open(lockPath,'wx');}catch(e){
 if(e.code!=='EEXIST')throw e;
 const previous=Number(await readFile(lockPath,'utf8'));let alive=true;
 if(Number.isSafeInteger(previous)&&previous>0){try{process.kill(previous,0);}catch(err){if(err.code==='ESRCH')alive=false;}}
 if(alive)throw new Error('此数据目录已有服务运行，请使用已打开的地址。');
 await unlink(lockPath);lock=await open(lockPath,'wx');
}
await lock.writeFile(String(process.pid));
async function read(name){try{return await readFile(join(data,name),'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function atomic(name,text){const temp=join(data,name+'.tmp');const f=await open(temp,'w');try{await f.writeFile(text);await f.sync();}finally{await f.close();}await rename(temp,join(data,name));}
const diagnostics=createNetworkDiagnostics();setPerformanceSink(diagnostics.sample);
const store=withMatchLogs(createJournalStore(data,{diff:diffValue,apply:applyPatch,onMetric:diagnostics.sample,onWarning:message=>console.warn(message)}),join(root,'对局记录'));
const room=new Room(store,JSON.parse(await read('identities.json')||'[]'),ids=>atomic('identities.json',JSON.stringify(ids)),async()=>{const session=await store.read();return session?JSON.stringify(session):null;},{read:async()=>JSON.parse(await read('chat.json')||'[]'),write:messages=>atomic('chat.json',JSON.stringify(messages))});
const assets=await loadStaticAssets(join(root,'dist'));
const roomId=await read('room-id.txt')||randomUUID();await atomic('room-id.txt',roomId);
const server=http.createServer(async(req,res)=>{
 try{
  if(!policy.hostAllowed(req.headers)){res.writeHead(403).end();return;}
  const url=new URL(req.url,`http://${host}:${port}`);
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  if(url.pathname==='/api/client-info'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({protocol:1,fingerprint:assets.fingerprint,roomId}));return;}
  if(url.pathname.startsWith('/api/')){
   if(!policy.originAllowed(req.headers))throw new Error('请求来源无效。');
   if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))throw new Error('请求必须使用 JSON 格式。');
   const token=(req.headers.authorization||'').replace(/^Bearer /,'');
   if(req.method!=='POST')throw new Error('请求方式无效。');
   const body=await readRequestJson(req);
   await diagnostics.run(body.id,body.method,async entry=>{
    const start=performance.now();let result=url.pathname==='/api/identity-status'?room.identityStatus(body.tokens):url.pathname==='/api/identity'?await room.createIdentity(body.name):url.pathname==='/api/request'?await room.request(token,body):(()=>{throw new Error('未知接口。');})();
    if(url.pathname==='/api/request')diagnostics.clients(body.connection,body.clientTimings);
    if(url.pathname==='/api/request'&&body.method==='exportDiagnostics'){result=JSON.stringify({...JSON.parse(result),networkTiming:diagnostics.snapshot()},null,2);}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,result,serverTiming:{ms:performance.now()-start}}));
   });return;
  }
  assets.serve(req,res,url);
 }catch(e){if(!res.headersSent)res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({ok:false,error:e.code==='ENOENT'?'文件不存在。':e.message}));else res.end();}
});
const sockets=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:socketCompression});
server.on('upgrade',(req,socket,head)=>{
 if(req.url!=='/api/socket'||!policy.hostAllowed(req.headers)||!policy.originAllowed(req.headers,true)){socket.destroy();return;}
 sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
});
sockets.on('connection',ws=>{
 ws.alive=true;ws.on('pong',()=>{ws.alive=true;});
 let token='',connection='',authed=false,previous;
 const timeout=setTimeout(()=>ws.close(),10000);
 ws.on('message',async raw=>{
  if(authed)return;
  try{const msg=JSON.parse(raw.toString());if(typeof msg.token!=='string'||typeof msg.connection!=='string')throw new Error('身份无效');
   if(msg.token.length>200||msg.connection.length>100)throw new Error('身份无效');token=msg.token;connection=msg.connection;authed=true;clearTimeout(timeout);
   await room.connect(token,connection,value=>{if(ws.readyState===1){const started=performance.now(),wire='replaced' in value?JSON.stringify(value):encodeSnapshot(previous,value,diffValue);diagnostics.sample({name:'wire_encode',ms:performance.now()-started,bytes:Buffer.byteLength(wire)});ws.send(wire,{compress:Buffer.byteLength(wire)>=compressionThreshold});if(!('replaced' in value))previous=value;}if('replaced' in value)ws.close();});
   if(ws.readyState!==1)await room.disconnect(token,connection);
  }catch(e){ws.send(JSON.stringify({error:e.message}));ws.close();}
 });
 ws.on('close',()=>{clearTimeout(timeout);if(authed)void room.disconnect(token,connection);});
 ws.on('error',()=>{});
});
const heartbeat=setInterval(()=>{for(const ws of sockets.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},15000);
let stopping=false;async function stop(){if(stopping)return;stopping=true;clearInterval(heartbeat);for(const ws of sockets.clients)ws.terminate();sockets.close();server.closeAllConnections();server.close();await lock.close();await unlink(lockPath).catch(()=>{});}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
server.on('error',async e=>{console.error(e.message);await stop();process.exitCode=1;});
server.listen(port,host,()=>{
 const url=policy.publicOrigin?`${policy.publicOrigin}/`:`${policy.localOrigin}/`;console.log(`战场军需官 v1.6.9\n${policy.publicOrigin?'公网入口：'+url+'\n':''}本机入口：${policy.localOrigin}/\n自动存档与身份：${data}\n保持此窗口开启。Ctrl+C 关闭服务。`);
 if(process.argv.includes('--open'))spawn('rundll32.exe',['url.dll,FileProtocolHandler',policy.localOrigin+'/'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
});

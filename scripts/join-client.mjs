import http from 'node:http';
import https from 'node:https';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {spawn} from 'node:child_process';
import {WebSocket,WebSocketServer} from 'ws';
import {loadStaticAssets} from './static-assets.mjs';
import {connectionPolicy} from './server-origin.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
export function hostAddress(input){
 const url=new URL(input.trim());
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search)throw Error('请填写房主的完整 http:// 或 https:// 入口网址（可包含个人返回链接）。');
 return {origin:url.origin,hash:url.hash};
}
export async function startClient(input,{port=4184,openBrowser=false}={}){
 const target=hostAddress(input),assets=await loadStaticAssets(join(root,'dist'));
 async function checkHost(){
  const reply=await fetch(target.origin+'/api/client-info',{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!reply.ok)throw Error('无法读取房主版本信息，请确认房主已更新客户端支持。');
  const info=await reply.json();
  if(info.protocol!==1||info.fingerprint!==assets.fingerprint||typeof info.roomId!=='string')throw Object.assign(Error('本机与房主的游戏文件不一致。请使用房主同一份压缩包，或直接用浏览器打开房主网址加入。'),{terminal:true});
  return info;
 }
 const info=await checkHost();let policy;
 const sockets=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
 const upstreams=new Set(),requests=new Set();
 const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  if(!policy.hostAllowed(req.headers)||!policy.originAllowed(req.headers)){res.writeHead(403).end();return;}
  const url=new URL(req.url,policy.localOrigin);
  if(url.pathname.startsWith('/api/')){
   if(!['/api/identity','/api/identity-status','/api/request'].includes(url.pathname)||req.method!=='POST'||!req.headers['content-type']?.toLowerCase().startsWith('application/json')){res.writeHead(400).end();return;}
   // Fixed destination and explicit headers: never a general proxy and never forwards browser cookies.
   const remote=new URL(url.pathname,target.origin),transport=remote.protocol==='https:'?https:http;
   const upstream=transport.request(remote,{method:'POST',headers:{'Content-Type':'application/json',Origin:target.origin,...(req.headers.authorization?{Authorization:req.headers.authorization}:{})}},response=>{
    res.writeHead(response.statusCode,{'Content-Type':'application/json'});response.pipe(res);
   });requests.add(upstream);upstream.on('close',()=>requests.delete(upstream));
   upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'连接房主失败，请检查网络和房主服务。'}));});
   upstream.setTimeout(120000,()=>upstream.destroy());
   let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>70*1024*1024){upstream.destroy();req.destroy();}});
   req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});req.pipe(upstream);return;
  }
  try{assets.serve(req,res,url,{origin:target.origin,roomId:info.roomId});}catch{res.writeHead(400).end();}
 });
 server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/api/socket'||!policy.hostAllowed(req.headers)||!policy.originAllowed(req.headers,true)){socket.destroy();return;}
  sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
 });
 sockets.on('connection',local=>{
  let remote,closed=false,queued=[];
  const close=()=>{closed=true;remote?.terminate();};
  local.on('close',close);local.on('error',close);
  local.on('message',(data,binary)=>{if(binary){local.close(1003);return;}if(remote?.readyState===1)remote.send(data,{binary:false});else if(queued.length<2)queued.push(data);else local.close(1008);});
  // Recheck on reconnect: a host can restart with another build under the same URL.
  void checkHost().then(fresh=>{
   if(closed)return;if(fresh.roomId!==info.roomId)throw Object.assign(Error('房主更换了房间，请重新启动加入脚本。'),{terminal:true});
   const url=new URL('/api/socket',target.origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';
   remote=new WebSocket(url,{origin:target.origin,perMessageDeflate:true,maxPayload:70*1024*1024,handshakeTimeout:15000});upstreams.add(remote);
   remote.on('open',()=>{for(const data of queued)remote.send(data,{binary:false});queued=[];});
   remote.on('message',(data,binary)=>{if(local.readyState===1){if(local.bufferedAmount>70*1024*1024){local.close(1013);return;}local.send(data,{binary});}});
   remote.on('close',()=>{upstreams.delete(remote);local.close();});remote.on('error',()=>local.close());
  }).catch(error=>{if(local.readyState===1){if(error.terminal)local.send(JSON.stringify({error:error.message}));local.close();}});
 });
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',()=>{server.off('error',fail);ok();});});
 policy=connectionPolicy(server.address().port);
 const url=policy.localOrigin+'/'+target.hash;
 console.log(`本地资源客户端已启动：${url}\n房主：${target.origin}\n网页、地图和卡图使用本机文件；游戏数据连接房主。\n保持此窗口开启。Ctrl+C 退出。`);
 if(openBrowser)spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
 return {url,close:async()=>{for(const r of requests)r.destroy();for(const ws of upstreams)ws.terminate();for(const ws of sockets.clients)ws.terminate();sockets.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const arg=process.argv[2];let input=arg;
  if(!input){const rl=createInterface({input:process.stdin,output:process.stdout});try{input=await rl.question('粘贴房主网址，然后回车：');}finally{rl.close();}}
  const client=await startClient(input,{port:Number(process.env.QM_CLIENT_PORT||4184),openBrowser:!process.argv.includes('--no-open')});
  let stopping=false;const stop=()=>{if(!stopping){stopping=true;void client.close();}};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 }catch(e){console.error(e.code==='EADDRINUSE'?'客户端端口已占用，请关闭之前的加入客户端窗口再试。':e.message);process.exitCode=1;}
}

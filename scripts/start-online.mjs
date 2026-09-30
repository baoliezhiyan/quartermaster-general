import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export function parseTunnelOutput(text){return{origin:text.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/i)?.[0]?.toLowerCase(),connected:/Registered tunnel connection|Connection [^\r\n]* registered connIndex=/i.test(text)};}
async function freePort(port){await new Promise((ok,no)=>{const probe=createServer();probe.once('error',()=>no(Error(`端口 ${port} 已被占用。请先关闭旧的游戏服务窗口，再重新启动；本程序不会关闭其他进程。`)));probe.listen(port,'127.0.0.1',()=>probe.close(ok));});}
export async function startOnline({root,port=4183,timeoutMs=120000,signal,cloudCommand,gameCommand,parseOutput=parseTunnelOutput,provider="Cloudflare",log=console.log,openBrowser=url=>spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'}).on('error',()=>{})}){
 await freePort(port);if(signal?.aborted)throw Error("启动已取消");
 const exe=['cloudflared.exe','cloudflared-windows-amd64.exe'].map(n=>join(root,'cloudflare',n)).find(existsSync);
 if(!cloudCommand&&!exe)throw Error('找不到 cloudflared.exe 或 cloudflared-windows-amd64.exe。请把它放在游戏目录内的 cloudflare 文件夹中。');
 log(`正在启动 ${provider} 隧道，成功后会自动启动游戏并打开网址。`);log('请保持此 CMD 窗口开启！关闭窗口或按 Ctrl+C 将结束本次联机。');
 let cloud,game,origin='',registered=false,ready=false,stopping=false,cloudText='',gameText='',resolveReady,rejectReady,resolveClosed;
 const readyPromise=new Promise((ok,no)=>{resolveReady=ok;rejectReady=no;}),closed=new Promise(ok=>resolveClosed=ok),children=[];
 function stop(error){if(stopping)return;stopping=true;signal?.removeEventListener("abort",abort);clearTimeout(timer);clearInterval(progress);for(const child of children)if(child.exitCode===null)child.kill();Promise.all(children.map(child=>child.exitCode!==null||!child.pid?Promise.resolve():new Promise(ok=>child.once('exit',ok)))).then(()=>resolveClosed(error));if(!ready)rejectReady(error??Error('启动已取消'));else if(error)log(error.message);}
 const abort=()=>stop();
 const timer=setTimeout(()=>stop(Error(`等待 ${provider} 隧道或游戏启动超时。请检查网络、账号配置和上面的客户端日志后重试。`)),timeoutMs);
 const progress=setInterval(()=>log(origin?'已取得网址，正在等待隧道连接和游戏启动…':`仍在等待 ${provider} 分配网址…`),20000);
 function child(command,env){const p=spawn(command[0],command.slice(1),{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);p.on('error',e=>stop(Error('无法启动程序：'+e.message)));p.once('exit',(code,signal)=>{if(!stopping)stop(Error(`联机进程已退出（${code??signal}），已停止本窗口启动的其他进程。请检查上面的错误后重新启动。`));});return p;}
 function startGame(){if(game||!origin||!registered||stopping)return;log('隧道连接已建立，启动游戏服务…');game=child(gameCommand??[join(root,'runtime/node.exe'),join(root,'scripts/multiplayer-server.mjs')],{...process.env,QM_PORT:String(port),QM_PUBLIC_ORIGIN:origin});for(const stream of [game.stdout,game.stderr]){stream.setEncoding('utf8');stream.on('data',text=>{log(text.trimEnd());gameText=(gameText+text).slice(-8192);if(!ready&&gameText.includes('本机入口：')&&!stopping){ready=true;clearTimeout(timer);clearInterval(progress);log(`联机已启动。发给朋友的房间网址：${origin}/`);log('请保持此 CMD 窗口开启。按 Ctrl+C 退出。');log(`房主使用本机入口：http://127.0.0.1:${port}/（卡图和游戏数据直接从本机读取）`);openBrowser(`http://127.0.0.1:${port}/`);resolveReady({origin,stop:()=>stop(),closed});}});}}
 signal?.addEventListener("abort",abort,{once:true});
 cloud=child(cloudCommand??[exe,'tunnel','--url',`http://127.0.0.1:${port}`],process.env);
 for(const stream of [cloud.stdout,cloud.stderr]){stream.setEncoding('utf8');stream.on('data',text=>{log(text.trimEnd());cloudText=(cloudText+text).slice(-16384);const parsed=parseOutput(cloudText);origin=parsed.origin??origin;registered||=parsed.connected;startGame();});}
 return readyPromise;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const abort=new AbortController();for(const signal of ['SIGINT','SIGTERM','SIGHUP','SIGBREAK'])process.on(signal,()=>abort.abort());
 try{const root=resolve(fileURLToPath(new URL('..',import.meta.url)));const running=await startOnline({root,signal:abort.signal});const error=await running.closed;if(error)throw error;}catch(e){console.error(e.message);process.exitCode=1;}
}

import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {startOnline} from './start-online.mjs';
export const configPath=()=>join(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'QuartermasterGeneral','cpolar','cpolar.yml');
export function parseCpolarOutput(text){
 const urls=[...text.matchAll(/Tunnel established at\s+(https:\/\/[^\s\x1b"<>]+)/gi)];
 const candidate=urls.at(-1)?.[1];
 if(!candidate)return {origin:undefined,connected:false};
 try{const u=new URL(candidate);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return {origin:undefined,connected:false};return {origin:u.origin,connected:true};}catch{return {origin:undefined,connected:false};}
}
export function cpolarArgs(config,settings,port=4183){
 if(!/^[a-z][a-z0-9_]*$/.test(settings.region))throw Error('cpolar 地区配置无效，请重新运行账号配置。');
 if(settings.subdomain&&!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(settings.subdomain))throw Error('保留子域名只填写名称，不要填写完整网址。');
 return ['http','-config='+config,'-log=stdout','-log-level=INFO','-daemon=off','-dashboard=off','-inspect-addr=false','-proto=https','-region='+settings.region,...(settings.subdomain?['-subdomain='+settings.subdomain]:[]),'127.0.0.1:'+port];
}
async function configure(root){await new Promise((ok,no)=>{const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/configure-cpolar.ps1')],{stdio:'inherit',windowsHide:true});p.on('error',no);p.on('exit',code=>code===0?ok():no(Error('cpolar 配置未完成。')));});}
export async function startCpolar({root,signal,mode='online',openBrowser,log=console.log}){
 const config=configPath();
 if(mode==='configure'||!existsSync(config)){await configure(root);if(mode==='configure')return;}
 const raw=await readFile(config,'utf8'),tokenLine=raw.match(/^authtoken:\s*(.+)$/m)?.[1];
 if(!tokenLine)throw Error('账号令牌缺失，请运行 cpolar 文件夹中的配置脚本。');
 let token;try{token=JSON.parse(tokenLine);}catch{throw Error('账号配置格式无效，请重新配置。');}
 const safeLog=text=>log(String(text).split(token).join('[令牌已隐藏]'));
 const settings=JSON.parse(await readFile(join(resolve(config,'..'),'settings.json'),'utf8'));
 const exe=join(root,'cpolar/cpolar.exe');if(!existsSync(exe))throw Error('发行包缺少 cpolar/cpolar.exe，请重新解压完整游戏包。');
 const command=[exe,...cpolarArgs(config,settings)];
 if(mode==='tunnel'){
  safeLog('出现 Tunnel established at https://... 后，复制网址，再运行第3步。关闭此窗口会结束隧道。');
  const p=spawn(command[0],command.slice(1),{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const out of [p.stdout,p.stderr])out.on('data',v=>safeLog(v.toString()));
  const abort=()=>p.kill();signal?.addEventListener('abort',abort,{once:true});
  await new Promise((ok,no)=>{p.on('error',no);p.on('exit',code=>code&&!signal?.aborted?no(Error('cpolar 已退出，请检查上述日志。')):ok());}).finally(()=>signal?.removeEventListener('abort',abort));return;
 }
 return startOnline({root,signal,cloudCommand:command,parseOutput:parseCpolarOutput,provider:'cpolar',log:safeLog,...(openBrowser?{openBrowser}:{})});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const abort=new AbortController();for(const name of ['SIGINT','SIGTERM','SIGHUP','SIGBREAK'])process.on(name,()=>abort.abort());
 try{const mode=process.argv.includes('--configure')?'configure':process.argv.includes('--tunnel')?'tunnel':'online';const running=await startCpolar({root:resolve(fileURLToPath(new URL('..',import.meta.url))),signal:abort.signal,mode});if(running){const error=await running.closed;if(error)throw error;}}
 catch(e){console.error(e.message);console.error('若提示在线进程数量超限，请退出其他 cpolar 客户端或已安装的 cpolar 服务后重试。');process.exitCode=1;}
}

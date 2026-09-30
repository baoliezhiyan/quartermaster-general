import {mkdir,cp,readFile,writeFile,readdir,stat,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),root=resolve('.');
let previousFolder;try{const previous=JSON.parse(await readFile('releases/multiplayer-latest.json','utf8'));previousFolder=previous.folder;if(previous.previousFolder&&!await stat(join(previous.folder,'data')).catch(()=>null))previousFolder=previous.previousFolder;}catch(e){if(e.code!=='ENOENT')throw e;}
const version=(JSON.parse(await readFile('package.json','utf8')).displayVersion??JSON.parse(await readFile('package.json','utf8')).version).replace(/^1\.0\.0$/, '1.0').replace(/^1\.0\.1$/, '1.01').replace(/^1\.1\.0$/, '1.1').replace(/^1\.2\.0$/, '1.2').replace(/^1\.3\.0$/, '1.3');
const name=`战场军需官-v${version}`;
// Refuse to merge into an existing release (it may contain player saves).
await mkdir(join(root,'releases'),{recursive:true});
const folder=join(root,'releases',name);await mkdir(folder);
for(const dir of ['dist','dist-server'])await cp(join(root,dir),join(folder,dir),{recursive:true});
await rename(join(folder,'dist-server/Room.js'),join(folder,'dist-server/Room.mjs'));
await mkdir(join(folder,'scripts'));await writeFile(join(folder,'scripts/multiplayer-server.mjs'),(await readFile('scripts/multiplayer-server.mjs','utf8')).replaceAll('../dist-server/Room.js','../dist-server/Room.mjs'));
for(const name of ['validate-match-log.mjs','match-log-store.mjs','join-client.mjs','static-assets.mjs','ws-compression.mjs','server-origin.mjs','request-json.mjs','journal-store.mjs','wire-snapshot.mjs','start-online.mjs','network-diagnostics.mjs','start-cloudflare.ps1','start-internet.ps1','start-cpolar.mjs','configure-cpolar.ps1','start-cpolar-game.ps1'])await cp(join('scripts',name),join(folder,'scripts',name));
await writeFile(join(folder,'加入联机版游戏.cmd'),'@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\join-client.mjs"\r\nif errorlevel 1 pause\r\n','ascii');
await cp('docs/local-client.md',join(folder,'本地资源客户端说明.md'));
await mkdir(join(folder,'对局记录'));
await mkdir(join(folder,'回放接口'));
await cp('src/actionReplay/contract.ts',join(folder,'回放接口/contract.ts'));
await cp('src/actionReplay/trainingContract.ts',join(folder,'回放接口/training-contract-v1.ts'));
await cp('docs/training-replay-output-v1.md',join(folder,'回放接口/训练端输出规范-v1.md'));
await cp('docs/action-replay-adapter.md',join(folder,'回放接口/adapter.md'));
await cp('docs/match-log-spec-v2.0.md',join(folder,'回放接口/spec-v2.0.md'));
await cp('outputs/match-log-samples',join(folder,'回放样例'),{recursive:true});
await cp('docs/match-log-guide.md',join(folder,'对局记录与回放说明.md'));
await cp('docs/match-log-validation.md',join(folder,'对局记录与回放验收.md'));
await mkdir(join(folder,'cloudflare'));
await cp('.tools/cloudflared/cloudflared-windows-amd64.exe',join(folder,'cloudflare/cloudflared-windows-amd64.exe'));
for(const [name,script] of [['1-启动Cloudflare隧道.cmd','start-cloudflare.ps1'],['2-启动联机游戏服务.cmd','start-internet.ps1']])await writeFile(join(folder,'cloudflare',name),'@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\\scripts\\'+script+'"\r\nif errorlevel 1 pause\r\n','ascii');
await writeFile(join(folder,'启动联机版游戏（cloudflared）.cmd'),'@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\start-online.mjs"\r\nif errorlevel 1 pause\r\n','ascii');

await mkdir(join(folder,'cpolar'));
for(const file of ['cpolar.exe','cpolar_amd64.msi'])await cp(join(root,'.tools/cpolar',file),join(folder,'cpolar',file));
const nodeCmd=(prefix,arg)=>'@echo off\r\nchcp 65001 >nul\r\n"%~dp0'+prefix+'runtime\\node.exe" "%~dp0'+prefix+'scripts\\start-cpolar.mjs" '+arg+'\r\nif errorlevel 1 pause\r\n';
await writeFile(join(folder,'启动联机版游戏（cpolar）.cmd'),nodeCmd('',''),'ascii');
await writeFile(join(folder,'cpolar/1-配置账号和网址.cmd'),nodeCmd('..\\','--configure'),'ascii');
await writeFile(join(folder,'cpolar/2-启动cpolar隧道.cmd'),nodeCmd('..\\','--tunnel'),'ascii');
await writeFile(join(folder,'cpolar/3-启动联机游戏服务.cmd'),'@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\\scripts\\start-cpolar-game.ps1"\r\nif errorlevel 1 pause\r\n','ascii');
await cp('docs/cpolar-start.md',join(folder,'cpolar/使用说明.md'));

await mkdir(join(folder,'runtime'));await cp(process.execPath,join(folder,'runtime/node.exe'));
await cp(dirname(require.resolve('ws/package.json')),join(folder,'node_modules/ws'),{recursive:true});
await mkdir(join(folder,'version'));
await writeFile(join(folder,'version/package.json'),JSON.stringify({type:'module',version,private:true}));
await cp('docs/v3-local-multiplayer.md',join(folder,'使用说明.md'));
await writeFile(join(folder,'启动本地版游戏.cmd'),'@echo off\r\nchcp 65001 >nul\r\nset QM_PUBLIC_ORIGIN=\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\multiplayer-server.mjs" --open\r\nif errorlevel 1 pause\r\n','ascii');
await mkdir(join(folder,'licenses'));for(const dep of ['react','react-dom','ws'])await cp(join(dirname(require.resolve(dep+'/package.json')),'LICENSE'),join(folder,'licenses',dep+'-LICENSE.txt'));
await cp('scripts/release/licenses/NODE-LICENSE.txt',join(folder,'licenses/NODE-LICENSE.txt'));
const hashes={};async function scan(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){const key=prefix+e.name;if(e.isDirectory())await scan(join(dir,e.name),key+'/');else hashes[key]=createHash('sha256').update(await readFile(join(dir,e.name))).digest('hex');}}
await scan(folder);await writeFile(join(folder,'version/SHA256.json'),JSON.stringify(hashes,null,2));
await writeFile('releases/multiplayer-latest.json',JSON.stringify({folder,previousFolder,version,url:'http://127.0.0.1:4183/'},null,2));console.log(folder);

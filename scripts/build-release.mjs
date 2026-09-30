import { readFile, writeFile, mkdir, cp, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This packager produces a Windows x64 portable release.');
const rulesVersion='1.4.0',createdAt=new Date().toISOString();
const name=`战场军需官-v${pkg.version}-windows-x64-${createdAt.replace(/[-:]/g,'').slice(0,15)}`;
const folder=join(root,'releases',name);
await mkdir(join(root,'releases'),{recursive:true});
await mkdir(folder); // Never overwrite an earlier release.
await cp(join(root,'dist'),join(folder,'dist'),{recursive:true});
await cp(join(root,'scripts/release/server.mjs'),join(folder,'server.mjs'));
await mkdir(join(folder,'runtime'));
await cp(process.execPath,join(folder,'runtime/node.exe'));
const launch=await readFile(join(root,'scripts/release/launch.cmd'),'utf8');
await writeFile(join(folder,'启动游戏.cmd'),launch.replace(/\r?\n/g,'\r\n'),'ascii');
await cp(join(root,'docs/local-release-guide.md'),join(folder,'使用说明.txt'));
await mkdir(join(folder,'licenses'));
await cp(join(root,'scripts/release/licenses/NODE-LICENSE.txt'),join(folder,'licenses/NODE-LICENSE.txt'));
for(const dep of ['react','react-dom','scheduler'])await cp(join(root,`node_modules/${dep}/LICENSE`),join(folder,`licenses/${dep}-LICENSE.txt`)).catch(async error=>{
  if(dep!=='scheduler')throw error;
  // pnpm places transitive packages alongside the real react-dom directory.
  const {realpath}=await import('node:fs/promises');
  const real=await realpath(join(root,'node_modules/react-dom'));
  await cp(join(dirname(real),'scheduler/LICENSE'),join(folder,'licenses/scheduler-LICENSE.txt'));
});
const hashes={};
async function hashFiles(dir,prefix='') {
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const key=prefix+entry.name,path=join(dir,entry.name);
    if(entry.isDirectory())await hashFiles(path,key+'/');
    else hashes[key]=createHash('sha256').update(await readFile(path)).digest('hex');
  }
}
await hashFiles(folder);
const buildId=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
const meta={appId:'quartermaster-general-local',version:pkg.version,rulesVersion,platform:'win32-x64',nodeVersion:process.version,createdAt,buildId,url:'http://127.0.0.1:4173/'};
await writeFile(join(folder,'release.json'),JSON.stringify(meta,null,2)+'\n');
await writeFile(join(folder,'SHA256.json'),JSON.stringify(hashes,null,2)+'\n');
const zip=folder+'.zip';
// Paths travel in environment values, never interpolated PowerShell source.
execFileSync('powershell.exe',['-NoProfile','-Command',"Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:QMG_RELEASE_FOLDER, $env:QMG_RELEASE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true, [System.Text.Encoding]::UTF8)"],{env:{...process.env,QMG_RELEASE_FOLDER:folder,QMG_RELEASE_ZIP:zip},windowsHide:true,stdio:'inherit'});
await writeFile(zip+'.sha256',createHash('sha256').update(await readFile(zip)).digest('hex')+'  '+name+'.zip\n');
await writeFile(join(root,'releases/latest.json'),JSON.stringify({folder,zip,...meta},null,2)+'\n');
console.log(`Release folder: ${folder}\nZIP: ${zip}\nSize: ${((await stat(zip)).size/1024/1024).toFixed(1)} MB`);

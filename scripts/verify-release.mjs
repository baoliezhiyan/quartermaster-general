import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=resolve(process.argv[2]);
const hashes=JSON.parse(await readFile(join(root,'SHA256.json'),'utf8'));
for(const [name,hash] of Object.entries(hashes))assert.equal(createHash('sha256').update(await readFile(join(root,name))).digest('hex'),hash,`Checksum mismatch: ${name}`);
const meta=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
function start(port) {
  const child=spawn(join(root,'runtime/node.exe'),[join(root,'server.mjs'),'--no-open',`--port=${port}`],{cwd:root,env:{...process.env,PATH:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
  const exited=new Promise((ok,fail)=>{child.on('error',fail);child.on('exit',code=>ok(code));});
  return {child,exited,output:()=>output};
}
async function deadline(promise) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,fail)=>timer=setTimeout(()=>fail(new Error('Release process timed out')),10000))]);}
  finally{clearTimeout(timer);}
}
const reserve=http.createServer((_,res)=>res.end('unrelated service'));
await new Promise(ok=>reserve.listen(0,'127.0.0.1',ok));
const port=reserve.address().port;
const conflict=start(port);
try {assert.equal(await deadline(conflict.exited),1);assert.match(conflict.output(),/Port .* is in use/);}
finally {if(conflict.child.exitCode===null)conflict.child.kill();await new Promise(ok=>reserve.close(ok));}
const game=start(port),url=`http://127.0.0.1:${port}`;
try {
  let ready=false;
  for(let i=0;i<100;i++) {
    try {const r=await fetch(url+'/__quartermaster__/status');if(r.ok){assert.equal((await r.json()).buildId,meta.buildId);ready=true;break;}}catch {}
    await new Promise(ok=>setTimeout(ok,100));
  }
  assert(ready,game.output());
  const html=await (await fetch(url)).text();assert.match(html,/<div id="root">/);
  for(const file of Object.keys(hashes).filter(p=>p.startsWith('dist/'))) {
    const r=await fetch(url+'/'+file.slice(5));assert.equal(r.status,200,file);
    assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hashes[file],file);
  }
  const duplicate=start(port);
  try {assert.equal(await deadline(duplicate.exited),0);assert.match(duplicate.output(),/already running/);}
  finally{if(duplicate.child.exitCode===null)duplicate.child.kill();}
  const report={version:meta.version,rulesVersion:meta.rulesVersion,buildId:meta.buildId,verifiedFiles:Object.keys(hashes).length,tests:['all package checksums','launch with empty PATH from extracted Unicode path','all static assets served byte-for-byte','port conflict rejected','duplicate launch reuses same release'],passed:true};
  await writeFile(join(root,'../verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally {game.child.kill();await deadline(game.exited);}

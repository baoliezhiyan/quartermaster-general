import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createLocalServer } from '../scripts/release/server.mjs';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'qmg-release-'));
  await mkdir(join(root,'dist/assets'),{recursive:true});
  await writeFile(join(root,'release.json'),JSON.stringify({appId:'quartermaster-general-local',version:'0.11.0',rulesVersion:'1.2.2'}));
  await writeFile(join(root,'dist/index.html'),'<html>local release</html>');
  await writeFile(join(root,'dist/assets/map.png'),Buffer.from([137,80,78,71]));
  await writeFile(join(root,'dist/assets/app.js'),'console.log("ready")');
  await writeFile(join(root,'secret.txt'),'must not be served');
  const server=await createLocalServer(root);
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try {await run(`http://127.0.0.1:${server.address().port}`,server.address().port);}
  finally {await new Promise(ok=>{server.close(ok);server.closeAllConnections();});}
}
describe('portable local release server',()=>{
  it('serves entry, scripts and binary assets with correct types and no stale caching',async()=>fixture(async(url)=>{
    const entry=await fetch(url);expect(await entry.text()).toContain('local release');
    expect(entry.headers.get('cache-control')).toBe('no-store');
    const script=await fetch(url+'/assets/app.js');expect(script.headers.get('content-type')).toContain('text/javascript');
    const map=await fetch(url+'/assets/map.png');expect([...new Uint8Array(await map.arrayBuffer())]).toEqual([137,80,78,71]);
    const head=await fetch(url,{method:'HEAD'});expect(head.status).toBe(200);expect(await head.text()).toBe('');
    const meta=await fetch(url+'/__quartermaster__/status');expect(await meta.json()).toMatchObject({version:'0.11.0',rulesVersion:'1.2.2'});
  }));
  it('does not expose package files or parent paths and rejects writes',async()=>fixture(async(url)=>{
    for(const path of ['/secret.txt','/server.mjs','/runtime/node.exe','/%2e%2e%2fsecret.txt','/%ZZ'])expect((await fetch(url+path)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(url,{method:'POST',body:'anything'})).status).toBe(405);
    expect((await fetch(url+'/missing.js')).status).toBe(404);
  }));
  it('rejects requests with a foreign host header',async()=>fixture(async(_,port)=>{
    const status=await new Promise((ok,fail)=>{const req=http.get({host:'127.0.0.1',port,headers:{Host:'foreign.example'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',fail);});
    expect(status).toBe(403);
  }));
});

import {it,expect} from 'vitest';
import {parseCpolarOutput,cpolarArgs} from '../scripts/start-cpolar.mjs';
import {startOnline} from '../scripts/start-online.mjs';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
it('recognizes only established HTTPS tunnel output, not account/help URLs',()=>{
 expect(parseCpolarOutput('Visit https://dashboard.cpolar.com')).toEqual({origin:undefined,connected:false});
 expect(parseCpolarOutput('Tunnel established at http://test.cpolar.top')).toEqual({origin:undefined,connected:false});
 expect(parseCpolarOutput('[INFO] Tunnel established at https://game.vip.cpolar.cn\n')).toEqual({origin:'https://game.vip.cpolar.cn',connected:true});
 expect(parseCpolarOutput('Tunnel established at https://u:p@bad.test')).toEqual({origin:undefined,connected:false});
});
it('builds portable HTTPS-only commands for free and reserved domains without exposing tokens',()=>{
 const a=cpolarArgs('C:/配置/cpolar.yml',{region:'cn',subdomain:''});expect(a).toContain('-config=C:/配置/cpolar.yml');expect(a).toContain('-proto=https');expect(a).toContain('-daemon=off');expect(a).toContain('-dashboard=off');expect(a).not.toContain('-subdomain=');
 expect(cpolarArgs('config',{region:'cn_vip',subdomain:'our-game'})).toContain('-subdomain=our-game');expect(()=>cpolarArgs('config',{region:'cn',subdomain:'https://bad.test'})).toThrow();
});
it('starts the game with cpolar origin, opens once, and closes only its child processes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qm-cpolar-')),cloud=join(root,'cloud.mjs'),game=join(root,'game.mjs');
 await writeFile(cloud,"console.log('[INFO] Tunnel established at https://test.cpolar.top');setInterval(()=>{},1000)");
 await writeFile(game,"if(process.env.QM_PUBLIC_ORIGIN!=='https://test.cpolar.top')process.exit(7);console.log('本机入口：http://127.0.0.1:4198');setInterval(()=>{},1000)");
 const urls=[];const run=await startOnline({root,port:4198,cloudCommand:[process.execPath,cloud],gameCommand:[process.execPath,game],parseOutput:parseCpolarOutput,provider:'cpolar',timeoutMs:2000,log:()=>{},openBrowser:u=>urls.push(u)});expect(urls).toEqual(['http://127.0.0.1:4198/']);run.stop();await run.closed;
});

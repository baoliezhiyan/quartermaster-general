import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const ids=JSON.parse(await readFile(join(process.argv[2],'identities.json'),'utf8'));const identity=ids.find(i=>i.name==='GM测试');if(!identity)throw new Error('Missing test identity');
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const p=await browser.newPage();
await p.addInitScript(()=>{const Original=window.WebSocket;window.WebSocket=class extends Original{constructor(...args){super(...args);window.testSocket=this;}};});
try{
 await p.goto('http://127.0.0.1:4187/#identity='+identity.token);await p.getByRole('region',{name:'房间座位',exact:true}).waitFor();
 assert.equal(await p.getByRole('region',{name:'阶段与推进'}).count(),0);await p.getByRole('button',{name:/07.*GM.*空位/}).click();await p.getByRole('button',{name:'恢复上一局',exact:true}).click();await p.getByRole('region',{name:'阶段与推进'}).filter({hasText:'第 1 轮'}).waitFor();
 await p.evaluate(()=>window.testSocket.close());await p.getByRole('region',{name:'房间座位',exact:true}).waitFor();await p.waitForTimeout(2300);assert.equal(await p.getByRole('button',{name:/07.*GM.*GM测试/}).getAttribute('aria-pressed'),'true');
 assert.equal(await p.getByRole('region',{name:'阶段与推进'}).count(),1);await writeFile('outputs/multiplayer-review/recovery.json',JSON.stringify({passed:true,checks:['server restart starts empty','identity retained with public seat','GM restores disk checkpoint','websocket reconnect preserves seat and state']},null,2));console.log('Recovery and reconnect passed');
}finally{await browser.close();}

import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const port=4319,root=resolve('.');
const server=spawn(process.execPath,['scripts/multiplayer-server.mjs'],{cwd:root,windowsHide:true,env:{...process.env,QM_PORT:String(port),QM_DATA_DIR:resolve('outputs/history-browser-'+Date.now())},stdio:'pipe'});
let output='',browser;server.stdout.on('data',s=>output+=s);server.stderr.on('data',s=>output+=s);
const assert=(v,m)=>{if(!v)throw Error(m);};
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/`)).ok)break;}catch{}if(server.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1500,height:1000},acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/`);await page.getByRole('textbox').first().fill('存档验收');await page.getByRole('button',{name:'创建用户并进入',exact:true}).click();
 await page.locator('button.seat').filter({hasText:'GM'}).click();
 await page.getByText('存档、读档与备份',{exact:true}).click();
 assert(await page.getByText('回放查看',{exact:true}).count()===0,'Old replay tab still exists');
 let largeUploadHeader=false;page.on('request',r=>{if(r.headers()['x-qm-history-import']==='1')largeUploadHeader=true;});
 await page.getByLabel('导入完整存档',{exact:true}).setInputFiles('outputs/match-log-samples/client-prelude-round1.jsonl');
 await page.getByText('已导入历史文件。',{exact:true}).first().waitFor({timeout:60000});
 assert(largeUploadHeader,'Missing authenticated history upload route');
 assert((await page.getByLabel('存档回合').locator('option').count())>0,'Missing rebuilt slots');
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'导出完整存档',exact:true}).click();const full=await pending;await mkdir('outputs/history-browser-downloads',{recursive:true});await full.saveAs('outputs/history-browser-downloads/full.jsonl');assert((await stat('outputs/history-browser-downloads/full.jsonl')).size>1000,'Empty full download');
 const part=page.waitForEvent('download');await page.getByRole('button',{name:'导出该存档',exact:true}).click();await (await part).saveAs('outputs/history-browser-downloads/partial.jsonl');
 let mutations=0;page.on('request',r=>{if(r.url().endsWith('/api/request')&&/"method":"(?:dispatch|undo|editScene|importSave|seekReplay)"/.test(r.postData()??''))mutations++;});
 await page.getByRole('button',{name:'进入回放模式',exact:true}).click();await page.getByRole('heading',{name:'回放记录',exact:true}).waitFor({timeout:60000});
 await page.locator('.replay-entry').first().focus();await page.locator('.replay-entry').first().press('Enter');await page.getByRole('button',{name:'结算后',exact:true}).click();
 await page.getByRole('button',{name:'退出回放模式',exact:true}).click();await page.getByRole('button',{name:'进入回放模式',exact:true}).waitFor();
 assert(mutations===0,'Replay sent a live mutation');assert((await page.title()).includes('1.7.5'),'Wrong tab version');assert(errors.length===0,errors.join('\n'));
 const unauthorized=await fetch(`http://127.0.0.1:${port}/api/request`,{method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json','X-QM-History-Import':'1'},body:'{}'});assert(unauthorized.status===400,'Unauthenticated large import accepted');
 await page.screenshot({path:'outputs/history-browser.png',fullPage:true});console.log('PASS: unified GM tools, full/partial downloads, import slots, read-only replay toggle, version and upload auth');
}finally{await browser?.close();server.kill();}

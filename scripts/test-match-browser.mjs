import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=resolve('.'),port='4297';
const server=spawn(process.execPath,['scripts/multiplayer-server.mjs'],{cwd:root,windowsHide:true,env:{...process.env,QM_PORT:port,QM_DATA_DIR:resolve('outputs/match-browser-data')},stdio:'pipe'});
let output='';server.stdout.on('data',s=>output+=s);server.stderr.on('data',s=>output+=s);
const assert=(v,m)=>{if(!v)throw Error(m);};
let browser;
try{
 for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}/`);if(r.ok)break;}catch{}if(server.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1500,height:1000},acceptDownloads:true}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/`);
 await page.getByRole('textbox').first().fill('后台回放验收');
 await page.getByRole('button',{name:'创建用户并进入',exact:true}).click();
 await page.locator('button.seat').filter({hasText:'GM'}).click();
 await page.getByRole('button',{name:'新建对局',exact:true}).click();
 await page.screenshot({path:'outputs/match-browser-before.png'});
 console.log('NEW_GAME_UI',await page.getByRole('button').allTextContents());
 // The exact create button is checked from rendered UI rather than screen interaction.
 const create=page.getByRole('button',{name:/创建新游戏/});
 if(await create.count())await create.first().click();
 await page.getByRole('button',{name:'导出对局记录',exact:true}).first().waitFor({state:'visible'});
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='导出对局记录'&&!b.disabled),{},{timeout:60000});
 // On the creation form the seed submit label may be shorter.
 if(!await page.getByRole('button',{name:'导出对局记录',exact:true}).first().isEnabled()){
   console.log('BODY',await page.locator('body').innerText());throw Error('Creation form needs a concrete submit button');
 }
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'导出对局记录',exact:true}).first().click();const download=await downloading;
 await mkdir('outputs/match-browser-downloads',{recursive:true});const saved='outputs/match-browser-downloads/browser-export.jsonl';await download.saveAs(saved);assert((await stat(saved)).size>1000,'Download is empty');
 const raw=await readFile('outputs/match-log-samples/client-standard.jsonl','utf8');
 let mutationCount=0;page.on('request',r=>{if(r.url().endsWith('/api/request')&&/"method":"(?:dispatch|undo|editScene|importSave|seekReplay)"/.test(r.postData()??''))mutationCount++;});
 await page.getByLabel('导入标准回放').setInputFiles('outputs/match-log-samples/client-standard.jsonl');
 await page.getByTestId('fact-replay').waitFor({timeout:60000});assert(await page.getByRole('heading',{name:'详细对局记录'}).count()===1,'Missing right timeline');
 const records=raw.trim().split('\n').map(JSON.parse),decision=records.find(r=>r.kind==='decision'),beforeSeq=decision.decisionBeforeStateSeq;
 await page.getByLabel('跳至节点').fill(String(decision.seq));await page.getByText(`当前快照 #${beforeSeq}`,{exact:false}).waitFor();
 await page.getByRole('button',{name:'选择后',exact:true}).click();await page.getByText(`当前快照 #${decision.seq}`,{exact:false}).waitFor();
 await page.getByLabel('回放视角').selectOption('japan');await page.locator('.fact-record-body > nav button').filter({hasText:'英国'}).click();
 assert(!await page.locator('.fact-cards .fact-card').count(),'Foreign card zones unexpectedly revealed');
 await page.screenshot({path:'outputs/match-browser-country.png',fullPage:false});
 await page.getByLabel('回放视角').selectOption('omniscient');await page.locator('.fact-record-body > nav button').filter({hasText:'德国'}).click();
 await page.screenshot({path:'outputs/match-browser-omniscient.png',fullPage:false});
 assert(mutationCount===0,'Replay issued room mutation');await page.getByRole('button',{name:'退出回放，返回对局'}).click();
 assert(await page.getByTestId('fact-replay').count()===0,'Replay did not exit');
 await page.getByLabel('导入标准回放').setInputFiles('outputs/match-log-samples/constructed-resource-B.jsonl');await page.getByTestId('fact-replay').waitFor({timeout:60000});
 assert((await page.locator('body').innerText()).includes('本周期可用'),'No pool display');assert(!(await page.locator('body').innerText()).includes('序章手牌'),'Fictitious hand panel');
 await page.screenshot({path:'outputs/match-browser-pool.png',fullPage:false});
 assert(errors.length===0,errors.join('\n'));console.log(JSON.stringify({passed:true,downloadBytes:(await stat(saved)).size,replayMutationRequests:mutationCount,consoleErrors:errors}));
}finally{await browser?.close();server.kill();}

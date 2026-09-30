import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const context=await browser.newContext({viewport:{width:1600,height:1000}}),errors=[];
async function user(name){const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:4188/');await p.getByLabel('用户名').fill(name);await p.getByRole('button',{name:'创建用户并进入'}).click();await p.getByRole('region',{name:'房间座位',exact:true}).waitFor();return p;}
try{
 const gm=await user('GM');await gm.getByRole('button',{name:/07.*GM.*空位/}).click();const pages=[];
 for(const name of ['德国','意大利','日本']){const p=await user(name);await p.getByRole('button',{name:new RegExp('0[1-6].*'+name+'.*空位')}).click();pages.push(p);}
 await gm.getByText('存档、读档与备份',{exact:true}).click();await gm.getByLabel('导入 JSON 存档',{exact:true}).setInputFiles('outputs/reveal-fixture.json');
 const italy=pages[1];await italy.getByRole('button',{name:'手牌',exact:true}).waitFor();if(!await italy.locator('.table-hand .hand-card').first().isVisible())await italy.getByRole('button',{name:'手牌',exact:true}).click();await italy.locator('.table-hand .hand-card').first().click();await italy.locator('.guided-prompt').getByRole('button',{name:'确认',exact:true}).click();
 await italy.locator('.guided-prompt').filter({hasText:'三国分别确认翻牌'}).getByRole('button',{name:'确认',exact:true}).click();
 for(const p of pages)await p.getByRole('button',{name:'确认翻牌',exact:true}).waitFor();
 await Promise.all(pages.map(p=>p.getByRole('button',{name:'确认翻牌',exact:true}).click()));
 for(const p of pages)await p.getByRole('button',{name:'确认，已看完',exact:true}).waitFor();assert.equal(await italy.getByText(/此牌不能打出，将置于牌库顶/).isVisible(),true);
 await mkdir('outputs/response-review',{recursive:true});await italy.screenshot({path:'outputs/response-review/unplayable.png'});
 await pages[2].getByRole('button',{name:'确认，已看完',exact:true}).click();await italy.getByRole('button',{name:'确认，已看完',exact:true}).click();assert.equal(await pages[0].getByRole('button',{name:'确认，已看完',exact:true}).isVisible(),true);
 await pages[0].getByRole('button',{name:'确认，已看完',exact:true}).click();await pages[2].getByText('等待其他玩家响应中',{exact:true}).waitFor();await pages[2].screenshot({path:'outputs/response-review/japan-waiting.png'});
 await pages[0].locator('.guided-prompt').getByRole('button',{name:/跳过|放弃/}).click();await pages[2].locator('.guided-prompt').waitFor();assert.equal(await pages[2].getByText('等待其他玩家响应中',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);await writeFile('outputs/response-review/result.json',JSON.stringify({passed:true,checks:['simultaneous reveal prompts','simultaneous click acknowledgement','unplayable result displayed','all-results barrier','Japan waits for Germany','Japan proceeds after Germany skips'],errors},null,2));console.log('Reveal browser checks passed');
}catch(e){await mkdir('outputs/response-review',{recursive:true});for(const [i,p] of context.pages().entries()){await p.screenshot({path:`outputs/response-review/failure-${i}.png`});await writeFile(`outputs/response-review/failure-${i}.txt`,await p.locator('body').innerText());}throw e;}finally{await browser.close();}

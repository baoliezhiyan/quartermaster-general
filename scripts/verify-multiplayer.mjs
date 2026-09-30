import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const context=await browser.newContext({ignoreHTTPSErrors:process.env.QM_TEST_HTTPS==='1',viewport:{width:1600,height:1000}}),errors=[];
const base=process.env.QM_TEST_URL||'http://127.0.0.1:4183/';
async function joinUser(name){const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.getByLabel('用户名').fill(name);await p.getByRole('button',{name:'创建用户并进入'}).click();await p.getByRole('region',{name:'房间座位',exact:true}).waitFor();return p;}
try{
 const gm=await joinUser('GM测试');await gm.getByRole('button',{name:/07.*GM.*空位/}).click();await gm.getByRole('button',{name:'创建新游戏 →',exact:true}).waitFor();
 const names=['德国','英国','日本','苏联','意大利','美国'],pages=[];
 for(const name of names){const p=await joinUser(name+'测试');await p.getByRole('button',{name:new RegExp('0[1-6].*'+name+'.*空位')}).click();await p.getByRole('button',{name:new RegExp('0[1-6].*'+name+'.*'+name+'测试')}).waitFor();pages.push(p);assert.equal(await p.getByRole('button',{name:'新建对局',exact:true}).isVisible(),false);}
 await gm.getByRole('button',{name:'创建新游戏 →',exact:true}).click();
 for(const p of pages){await p.locator('.table-hand .hand-card').first().waitFor();for(let i=0;i<7;i++)await p.locator('.table-hand .hand-card').nth(i).click();await p.locator('.hand-phase-prompt').getByRole('button',{name:'确认',exact:true}).click();await p.waitForTimeout(150);}
 await gm.getByRole('region',{name:'阶段与推进'}).filter({hasText:'第 1 轮'}).waitFor();
 const url=pages[0].url();await pages[0].reload();await pages[0].getByRole('button',{name:/01.*德国.*德国测试/}).waitFor();assert.equal(pages[0].url(),url);
 const duplicate=await context.newPage();await duplicate.goto(url);await duplicate.getByRole('region',{name:'房间座位',exact:true}).waitFor();await pages[0].getByText('此身份已在另一页面连接。',{exact:true}).first().waitFor();
 const observer=await joinUser('通用测试');assert.equal(await observer.getByRole('button',{name:'手牌',exact:true}).count(),0);assert.equal(await observer.getByRole('button',{name:'对局记录',exact:true}).count(),1);
 await observer.getByRole('button',{name:/01.*德国观察者/}).click();await observer.getByRole('button',{name:'手牌',exact:true}).waitFor();assert.equal(await observer.getByRole('button',{name:'不出牌，扣 1 分并继续',exact:true}).count(),0);
 assert.deepEqual(errors,[]);await mkdir('outputs/multiplayer-review',{recursive:true});await gm.screenshot({path:'outputs/multiplayer-review/gm.png',fullPage:true});await writeFile('outputs/multiplayer-review/result.json',JSON.stringify({passed:true,checks:['seven identities in one browser','six exclusive country seats','GM-only create','six opening selections synchronized','refresh retains user','duplicate connection takeover','public and country observers'],errors},null,2));console.log('Browser multiplayer checks passed');
}finally{await browser.close();}



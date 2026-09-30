import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:4174/');
 await page.getByText('场景编辑器',{exact:true}).click();
 await page.getByRole('button',{name:'载入：布莱切利园 · 取消德国增强',exact:true}).click();
 const bar=page.locator('.map-phase-panel'),left=page.locator('.map-hand-dock'),right=page.locator('.map-interaction');
 assert.equal(await bar.locator('p').count(),0);
 for(const name of ['手牌栏','兵模储备栏','弃牌堆栏','牌库栏','持续生效与暗置卡牌栏','对局记录栏']){
   const b=bar.getByRole('button',{name,exact:true});
   if(await b.getAttribute('aria-pressed')==='true')await b.click();
   await b.click();assert(await left.isVisible());
   await b.click();assert(!(await left.isVisible()));
 }
 await bar.getByRole('button',{name:'牌库栏',exact:true}).click();
 const names=await left.locator('section[aria-label="牌库栏"] .card-name').allTextContents();assert(names.length>10);
 await bar.getByRole('button',{name:'操作栏',exact:true}).click();assert(!(await right.isVisible()));
 await bar.getByRole('button',{name:'操作栏',exact:true}).click();assert(await right.isVisible());
 await right.getByRole('button').filter({hasText:'云量'}).click();
 assert(await right.getByRole('heading',{name:'等待其他玩家回应中'}).isVisible());
 await page.locator('.map-workspace').scrollIntoViewIfNeeded();
 await mkdir('outputs/map-panels',{recursive:true});await page.screenshot({path:'outputs/map-panels/panels.png'});
 await page.getByText('六国操作与结算查看',{exact:true}).click();
 await page.locator('details').filter({has:page.getByText('六国操作与结算查看',{exact:true})}).getByRole('button',{name:'英国',exact:true}).click();
 await right.getByRole('button',{name:'不响应',exact:true}).click();
 assert.equal((await right.innerText()).trim(),'');
 await bar.getByRole('button',{name:'操作栏',exact:true}).click();assert(!(await right.isVisible()));
 await bar.getByRole('button',{name:'操作栏',exact:true}).click();assert(await right.isVisible());
 assert.deepEqual(errors,[]);console.log('PASS: seven toggles, blank idle operation panel, country-specific deck, response popup and no phase hints.');
}finally{await browser.close();}

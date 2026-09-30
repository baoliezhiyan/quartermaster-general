import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:4174/');const prompt=page.locator('.guided-prompt'),hand=page.locator('.map-hand-dock'),bar=page.locator('.map-phase-panel');
 async function load(name){await page.getByText('场景编辑器',{exact:true}).evaluate(e=>e.parentElement.open=true);await page.getByRole('button',{name:`载入：地图交互 · ${name}`,exact:true}).click();}
 async function seat(name){await page.getByText('六国操作与结算查看',{exact:true}).evaluate(e=>e.parentElement.open=true);await page.locator('details').filter({has:page.getByText('六国操作与结算查看',{exact:true})}).getByRole('button',{name,exact:true}).click();}
 async function confirm(){await prompt.getByRole('button',{name:'确认',exact:true}).click();}
 await load('卓越规划与云量');assert.equal(await bar.locator('.panel-available').count(),2);
 if(await bar.getByRole('button',{name:'持续生效与暗置卡牌栏',exact:true}).getAttribute('aria-pressed')!=='true')await bar.getByRole('button',{name:'持续生效与暗置卡牌栏',exact:true}).click();await hand.getByRole('button').filter({hasText:'卓越规划'}).click();await confirm();
 const sort=page.locator('.guided-sort-window .hand-card');assert.equal(await sort.count(),4);for(let i=3;i>=0;i--)await sort.nth(i).click();await confirm();await page.locator('.guided-sort-window').waitFor({state:'detached'});
 await load('民主兵工厂');await hand.getByRole('button').filter({hasText:'民主兵工厂'}).click();await confirm();await page.locator('[data-region-id="sea_north_sea"]').dispatchEvent('click');await confirm();await prompt.getByRole('button',{name:'跳过',exact:true}).click();await prompt.getByText('是否进行空军调度？',{exact:true}).waitFor();
 await load('巴巴罗萨');await hand.getByRole('button').filter({hasText:'巴巴罗萨'}).click();assert.equal(await page.locator('.unit-available').count(),2);
 await page.locator('[data-unit-ids*="test:su-east"]').dispatchEvent('click');await page.locator('[data-unit-ids*="test:su-west"]').dispatchEvent('click');assert.equal(await page.locator('.unit-selected').count(),2);await confirm();assert.equal(await page.locator('[data-region-id="eastern_europe"].is-legal-target').count(),1);
 await load('双方空军');await hand.getByRole('button').filter({hasText:'发起陆战'}).click();await confirm();await page.locator('[data-region-id="western_europe"]').dispatchEvent('click');await confirm();
 assert.equal(await page.locator('.unit-available').count(),2);await page.locator('[data-unit-ids*="test:uk"]').dispatchEvent('click');await confirm();await page.getByText('等待其他玩家回应中',{exact:true}).waitFor();await seat('英国');await prompt.getByRole('button',{name:'是',exact:true}).click();await seat('德国');await prompt.getByRole('button',{name:'否',exact:true}).click();
 await prompt.getByText('是否进行空军调度？',{exact:true}).waitFor();assert.deepEqual(errors,[]);console.log('PASS: mixed source highlights, four-card ordering, Democracy sea first, Barbarossa unit order, defender unit selection and two-country air decisions.');
}finally{await browser.close();}

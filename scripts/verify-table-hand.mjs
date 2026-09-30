import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:4174/');await page.getByRole('button',{name:'创建新游戏 →',exact:true}).click();
 const hand=page.locator('.table-hand'),prompt=page.locator('.hand-phase-prompt'),bar=page.locator('.map-phase-panel');
 await hand.locator('.hand-card').nth(11).waitFor();
 const rects=await hand.locator('.hand-card').evaluateAll(es=>es.map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y})));
 assert.equal(rects.filter(r=>r.y===rects[0].y).length,7);assert.equal(rects.filter(r=>r.y!==rects[0].y).length,5);
 assert.equal(await hand.locator('.turn-notice').count(),0);assert(await prompt.getByRole('button',{name:'确认',exact:true}).isDisabled());
 await page.getByRole('button',{name:'全屏',exact:true}).click();await mkdir('outputs/table-hand-review',{recursive:true});await page.screenshot({path:'outputs/table-hand-review/opening.png'});
 for(let i=0;i<7;i++)await hand.locator('.hand-card').nth(i).click();await prompt.getByRole('button',{name:'确认',exact:true}).click();assert((await prompt.innerText()).includes('英国起手'));
 await page.getByRole('button',{name:'退出全屏',exact:true}).click();
 await page.getByText('场景编辑器',{exact:true}).click();await page.getByRole('button',{name:'载入：地图交互 · 双方空军',exact:true}).click();
 await bar.getByRole('button',{name:'不出牌，扣 1 分并继续',exact:true}).click();await prompt.getByText('是否进行空军调度？',{exact:true}).waitFor();await prompt.getByRole('button',{name:'是',exact:true}).click();
 const unit=page.locator('[data-unit-ids*="test:de-air"]');assert((await unit.getAttribute('class')).includes('unit-available'));await unit.dispatchEvent('click');await prompt.getByRole('button',{name:'确认',exact:true}).click();
 const region=page.locator('[data-region-id="germany"]');assert((await region.getAttribute('class')).includes('is-legal-target'));await region.dispatchEvent('click');await prompt.getByRole('button',{name:'确认',exact:true}).click();
 assert((await prompt.innerText()).includes('弃置 1 张手牌'));await hand.locator('.hand-card').first().click();await prompt.getByRole('button',{name:'确认',exact:true}).click();await prompt.waitFor({state:'detached'});
 await bar.getByRole('button',{name:'继续至计分阶段',exact:true}).click();await bar.getByRole('button',{name:'继续至弃牌阶段',exact:true}).click();
 assert((await prompt.innerText()).includes('弃牌阶段'));assert(await prompt.getByRole('button',{name:'确认',exact:true}).isDisabled());await hand.locator('.hand-card').first().click();assert(await prompt.getByRole('button',{name:'确认',exact:true}).isEnabled());
 await page.screenshot({path:'outputs/table-hand-review/discard.png'});await prompt.getByRole('button',{name:'确认',exact:true}).click();
 assert.deepEqual(errors,[]);console.log('PASS: 7+5 hand layout, floating opening/discard, source-to-destination air selection, in-place relocation and fee.');
} finally {await browser.close();}

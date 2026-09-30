import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const page=await browser.newPage({viewport:{width:1920,height:1080}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:4174/');await page.getByText('场景编辑器',{exact:true}).click();await page.getByRole('button',{name:'载入：布莱切利园 · 取消德国增强',exact:true}).click();
 const toggle=page.getByRole('checkbox',{name:'云量允许响应',exact:true});assert(await toggle.isChecked());assert.equal(await page.locator('.hand-caption').count(),0);
 await toggle.uncheck();assert(!await toggle.isChecked());assert.equal(await page.locator('.guided-prompt').count(),0);
 await page.reload();assert(!await toggle.isChecked());await toggle.check();assert(await toggle.isChecked());
 const bar=page.locator('.map-phase-panel');await bar.getByRole('button',{name:'牌库栏',exact:true}).click();const panel=page.locator('.catalog-dock');await panel.waitFor();
 const rects=await panel.locator('.hand-card').evaluateAll(es=>es.slice(0,6).map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width})));
 assert.equal(rects.filter(r=>r.y===rects[0].y).length,3);assert((await panel.boundingBox()).width<=600);
 await mkdir('outputs/response-controls-review',{recursive:true});await page.screenshot({path:'outputs/response-controls-review/deck.png'});
 await bar.getByRole('button',{name:'手牌栏',exact:true}).click();await page.screenshot({path:'outputs/response-controls-review/toggle.png'});
 assert.deepEqual(errors,[]);console.log('PASS: toggle default, immediate skip, persistence/re-enable, no hand badge, three-column compact deck.');
}finally{await browser.close();}

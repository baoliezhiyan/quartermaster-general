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
 for(const selector of ['.map-hand-dock .hand-card','.map-interaction .hand-card']) {
 const box=await page.locator(selector).first().boundingBox();assert.equal(box.width,174);assert.equal(box.height,248);
 }
 await page.locator('.map-phase-panel').getByRole('button',{name:'牌库栏',exact:true}).click();
 const box=await page.locator('.map-hand-dock section[aria-label="牌库栏"] .hand-card').first().boundingBox();assert.equal(box.width,174);assert.equal(box.height,248);
 await page.locator('.map-workspace').scrollIntoViewIfNeeded();
 await page.screenshot({path:'outputs/map-panels/fixed-cards.png'});
 assert.deepEqual(errors,[]);console.log('PASS: hand, deck and operation cards all 174 x 248; no page errors.');
}finally{await browser.close();}
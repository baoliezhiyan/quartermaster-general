import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:4174/');await page.getByRole('button',{name:'创建新游戏 →',exact:true}).click();
 const room=page.getByRole('region',{name:'房间座位',exact:true});assert.equal(await room.getByRole('button').count(),7);assert.equal(await page.locator('.local-tools').count(),0);
 assert(await room.evaluate(e=>e.previousElementSibling.classList.contains('game-map')||!!e.previousElementSibling.querySelector('.map-stage')));
 await room.getByRole('button',{name:/GM/}).click();assert.equal(await page.locator('.local-tools > details').count(),5);
 await page.getByText('场景编辑器',{exact:true}).click();const tests=page.locator('details').filter({has:page.locator('summary').getByText('测试场景',{exact:true})}).last();assert.equal(await tests.getAttribute('open'),null);assert(await page.getByLabel('允许其他国家响应',{exact:true}).isChecked());
 assert.equal(await page.getByText('重置草稿',{exact:true}).count(),0);await tests.locator('summary').click();await page.getByRole('button',{name:'载入：布莱切利园 · 取消德国增强',exact:true}).click();
 await page.getByLabel('德国分数',{exact:true}).fill('12');await page.getByLabel('德国分数',{exact:true}).press('Tab');await page.waitForFunction(()=>document.querySelector('.map-scoreboard').textContent.includes('12'));
 assert.equal(await page.getByText('局面已修改。',{exact:true}).count(),0);
 await page.getByLabel('移除兵模国家',{exact:true}).selectOption('china');await page.getByLabel('移除兵种',{exact:true}).selectOption('navy');assert.equal(await page.getByLabel('移除兵模地区',{exact:true}).innerText(),'无');assert(await page.getByRole('button',{name:'移除兵模',exact:true}).isDisabled());
 await page.getByLabel('移除兵模国家',{exact:true}).selectOption('germany');await page.getByLabel('移除兵种',{exact:true}).selectOption('army');assert(!(await page.getByRole('button',{name:'移除兵模',exact:true}).isDisabled()));await page.getByRole('button',{name:'移除兵模',exact:true}).click();
 await page.getByLabel('编辑牌堆国家',{exact:true}).selectOption('united_kingdom');const options=await page.getByLabel('编辑卡牌',{exact:true}).locator('option').allTextContents();assert.equal(options.filter(x=>x.endsWith('· 牌库顶')).length,1);assert.equal(options.filter(x=>x.endsWith('· 牌库底')).length,1);assert(options.some(x=>x.endsWith('· 牌库中')));
 const first=await page.getByLabel('编辑卡牌',{exact:true}).locator('option').filter({hasText:/· 牌库顶$/}).getAttribute('value');await page.getByRole('button',{name:'抽一张牌',exact:true}).click();assert((await page.getByLabel('编辑卡牌',{exact:true}).locator('option[value="'+first+'"]').innerText()).endsWith('· 手牌'));
 await page.getByLabel('编辑卡牌',{exact:true}).selectOption(first);await page.getByLabel('卡牌移至',{exact:true}).selectOption('drawBottom');await page.getByRole('button',{name:'移动到所选区域',exact:true}).click();assert((await page.getByLabel('编辑卡牌',{exact:true}).locator('option[value="'+first+'"]').innerText()).endsWith('· 牌库底'));
 await page.getByLabel('卡牌移至',{exact:true}).selectOption('drawTop');await page.getByRole('button',{name:'移动到所选区域',exact:true}).click();assert((await page.getByLabel('编辑卡牌',{exact:true}).locator('option[value="'+first+'"]').innerText()).endsWith('· 牌库顶'));
 await page.getByRole('button',{name:'重洗牌库',exact:true}).click();
 await page.evaluate(()=>{window.showSaveFilePicker=undefined;});await page.getByText('回放查看',{exact:true}).click();const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'导出当前对局文件',exact:true}).click();const downloaded=await downloading;const exported=JSON.parse(await (await import('node:fs/promises')).readFile(await downloaded.path(),'utf8'));assert.equal(exported.format,'quartermaster-replay');assert(exported.record.steps.length>=6);
 await page.getByText('结算与响应查看',{exact:true}).click();assert.equal(await page.getByText('查看完整结算数据',{exact:true}).count(),0);
 await room.getByRole('button',{name:/01.*德国/}).click();assert.equal(await page.locator('.local-tools').count(),0);
 await page.locator('.map-phase-panel').getByRole('button',{name:'兵模储备',exact:true}).click();assert((await page.locator('.reserve-dock').boundingBox()).width<400);
 await mkdir('outputs/gm-review',{recursive:true});await page.screenshot({path:'outputs/gm-review/player.png'});await room.getByRole('button',{name:/GM/}).click();await page.screenshot({path:'outputs/gm-review/gm.png'});
 assert.deepEqual(errors,[]);console.log('PASS: seven room seats, GM-only four tools, immediate edits, collapsed tests, compact reserve, no full resolution data.');
}finally{await browser.close();}

import {join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const page=await browser.newPage({viewport:{width:1920,height:1080}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:4174');await page.getByRole('button',{name:'创建新游戏 →',exact:true}).click();const room=page.getByRole('region',{name:'房间座位',exact:true});await room.getByRole('button',{name:/07.*GM/}).click();await page.getByText('场景编辑器',{exact:true}).click();await page.getByText('测试场景',{exact:true}).click();
 const hand=page.locator('.table-hand'),prompt=page.locator('.guided-prompt');
 for(const trigger of [false,true]){
  await page.getByRole('button',{name:'载入：布莱切利园 · 取消德国增强',exact:true}).click();await hand.locator('.hand-card').filter({hasText:'云量'}).click();await prompt.getByRole('button',{name:'确认',exact:true}).click();await page.getByRole('button',{name:'切换到英国',exact:true}).click();
  const back=page.getByRole('button',{name:'返回德国继续操作',exact:true});await back.waitFor();
  if(trigger){await hand.locator('.hand-card').filter({hasText:'布莱切利园'}).click();await prompt.getByRole('button',{name:'确认',exact:true}).click();await hand.locator('.available-card').first().click();await prompt.getByRole('button',{name:'确认',exact:true}).click();}
  else await prompt.getByRole('button',{name:'跳过',exact:true}).click();
  await back.waitFor();await back.click();await back.waitFor({state:'detached'});assert(await hand.locator('.hand-card').filter({hasText:'建设陆军'}).count()>0);
 }
 await room.getByRole('button',{name:/02.*英国.*分/}).click();assert.equal(await page.locator('.gm-response-switch').count(),0);assert.deepEqual(errors,[]);console.log('PASS: GM return to original country after both skipped and triggered paid response; national seats unaffected.');
}finally{await browser.close();}

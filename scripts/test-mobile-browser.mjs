import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const port=4338,root=resolve('.');
const server=spawn(process.execPath,['scripts/multiplayer-server.mjs'],{cwd:root,windowsHide:true,env:{...process.env,QM_PORT:String(port),QM_DATA_DIR:resolve('outputs/history-browser-'+Date.now())},stdio:'pipe'});
let output='',browser;server.stdout.on('data',s=>output+=s);server.stderr.on('data',s=>output+=s);
const assert=(v,m)=>{if(!v)throw Error(m);};
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/`)).ok)break;}catch{}if(server.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1500,height:1000},acceptDownloads:true,hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/`);await page.getByRole('textbox').first().fill('存档验收');await page.getByRole('button',{name:'创建用户并进入',exact:true}).click();
 await page.locator('button.seat').filter({hasText:'GM'}).click();
 await page.getByText('存档、读档与备份',{exact:true}).click();
 assert(await page.getByText('回放查看',{exact:true}).count()===0,'Old replay tab still exists');
 let largeUploadHeader=false;page.on('request',r=>{if(r.headers()['x-qm-history-import']==='1')largeUploadHeader=true;});
 await page.getByLabel('导入完整存档',{exact:true}).setInputFiles('outputs/match-log-samples/client-prelude-round1.jsonl');
 await page.getByText('已导入历史文件。',{exact:true}).first().waitFor({timeout:60000});
 assert(largeUploadHeader,'Missing authenticated history upload route');
 assert((await page.getByLabel('存档回合').locator('option').count())>0,'Missing rebuilt slots');
 const portrait=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const entry=await portrait.newPage();await entry.goto(`http://127.0.0.1:${port}/`);await entry.getByRole('textbox').first().fill('方向检查');assert(await entry.locator('.rotate-device').count()===0,'Entry blocked by orientation');await portrait.close();
 const source=page.url();
 const mobile=await browser.newContext({viewport:{width:844,height:390},hasTouch:true,isMobile:true,acceptDownloads:true});
 const phone=await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));await phone.goto(source);await phone.locator('.map-viewport').waitFor();
 assert(await phone.locator('.record-dock').isHidden(),'Phone sidebar must start closed');
 for(const size of [{width:667,height:375},{width:844,height:390},{width:915,height:412},{width:1024,height:768}]){
  await phone.setViewportSize(size);await phone.waitForTimeout(150);
  const boxes=await phone.evaluate(()=>Object.fromEntries(['.map-toolbar','.map-viewport','.map-footer'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,{x:r.x,y:r.y,w:r.width,h:r.height,b:r.bottom}]})));
  assert(boxes['.map-footer'].b<=size.height+1,'Footer clipped '+JSON.stringify({size,boxes}));
  assert(boxes['.map-viewport'].h>=80,'No map space');
  assert(boxes['.map-toolbar'].h<=52,'Toolbar wrapped');
 }
 await phone.setViewportSize({width:844,height:390});await phone.waitForTimeout(100);
 // Dismiss actual historical result notices before operating the map.
 for(let i=0;i<20;i++){const ack=phone.locator('button:enabled').filter({hasText:/^知道了$/});if(!await ack.count()){await phone.waitForTimeout(150);continue;}await ack.first().click({timeout:2000}).catch(()=>{});await phone.waitForTimeout(150);}
 await phone.getByRole('button',{name:'对局记录',exact:true}).click();const logWidth=await phone.locator('.record-dock .public-game-log').evaluate(el=>el.clientWidth);assert(logWidth>=145&&logWidth<=180,'Record text column not halved: '+logWidth);await phone.getByLabel('关闭记录侧栏').click();assert(await phone.locator('.record-dock').isHidden(),'Record close failed');
 await phone.getByRole('button',{name:'对局记录',exact:true}).click();await phone.getByRole('button',{name:'房间聊天',exact:true}).click();await phone.getByLabel('聊天消息').fill('保留草稿');await phone.getByLabel('关闭记录侧栏').click();
 await page.goto(`http://127.0.0.1:${port}/`);await page.getByRole('textbox').first().fill('聊天发送方');await page.getByRole('button',{name:'创建用户并进入',exact:true}).click();await page.locator('.map-viewport').waitFor();
 if(await page.locator('.record-dock').isHidden())await page.locator('.record-toggle').click();
 await page.getByRole('button',{name:'房间聊天',exact:true}).click();await page.getByLabel('聊天消息').fill('手机未读验收');await page.getByRole('button',{name:'发送',exact:true}).click();await phone.locator('.record-toggle .chat-unread').waitFor();
 await phone.locator('.record-toggle').click();assert(await phone.getByLabel('聊天消息').inputValue()==='保留草稿','Closing drawer lost chat draft');await phone.getByLabel('关闭记录侧栏').click();
 await phone.getByRole('button',{name:'全卡图鉴',exact:true}).click();const atlas=phone.getByRole('region',{name:'全卡图鉴',exact:true});await atlas.waitFor();assert(await atlas.locator('[data-card-id="build_army"]').count()===1,'Missing atlas');await phone.getByRole('button',{name:'全卡图鉴',exact:true}).click();
 // Collapse the hand so the touch test addresses only the map.
 const handToggle=phone.locator('.map-panel-buttons button[aria-pressed="true"]').filter({hasText:/手牌/});if(await handToggle.count())await handToggle.first().click();
 const point=await phone.evaluate(()=>{const r=document.querySelector('.map-viewport').getBoundingClientRect();for(let y=r.top+30;y<r.bottom-20;y+=30)for(let x=r.left+50;x<r.right-40;x+=40){const el=document.elementFromPoint(x,y)?.closest('[data-region-id]');if(el)return {x,y,id:el.getAttribute('data-region-id')};}return null;});
 assert(point,'No exposed region for tap');await phone.touchscreen.tap(point.x,point.y);await phone.waitForTimeout(100);assert(await phone.locator(`[data-region-id="${point.id}"]`).first().getAttribute('aria-pressed')==='true','Touch tap failed to select region');
 await phone.getByRole('button',{name:/^查看.*详情$/}).click();await phone.getByRole('dialog',{name:'地区详情',exact:true}).waitFor();await phone.getByLabel('关闭地区详情').click();
 let mutations=0;phone.on('request',r=>{if(r.url().endsWith('/api/request')&&/"method":"(?:dispatch|undo|editScene|importSave|seekReplay)"/.test(r.postData()??''))mutations++;});
 const cdp=await mobile.newCDPSession(phone),box=await phone.locator('.map-viewport').boundingBox();
 const tx=box.x+box.width*.6,ty=box.y+box.height*.55;
 const before=await phone.locator('.map-viewport').getAttribute('data-zoom');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx-25,y:ty,id:1},{x:tx+25,y:ty,id:2}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx-60,y:ty,id:1},{x:tx+60,y:ty,id:2}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await phone.waitForTimeout(100);
 assert(Number(await phone.locator('.map-viewport').getAttribute('data-zoom'))>Number(before),'Pinch did not zoom');
 assert(await phone.locator(`[data-region-id="${point.id}"]`).first().getAttribute('aria-pressed')==='true','Pinch accidentally changed selection');
 await phone.getByRole('button',{name:'手牌',exact:true}).click();
 const dock=phone.locator('.table-hand-dock'),handBox=await dock.boundingBox();
 const sx=handBox.x+handBox.width-80,sy=handBox.y+70;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:sx,y:sy,id:1}]});
 for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:sx-i*65,y:sy,id:1}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await phone.waitForTimeout(200);assert(await dock.evaluate(el=>el.scrollLeft)>0,'Hand swipe did not scroll');
 const first=phone.locator('.table-hand .card-shell').first(),original=await first.locator('.hand-card').getAttribute('aria-label');
 assert(await first.locator('.touch-card-detail').count()===0,'Redundant card details button still present');
 const art=await first.locator('.card-art').evaluate(el=>({fit:getComputedStyle(el).objectFit,max:getComputedStyle(el).maxHeight}));assert(art.fit==='contain'&&art.max==='none','Card art is cropped');
 await phone.getByRole('button',{name:'整理手牌',exact:true}).click();await first.getByRole('button',{name:'向后移动',exact:true}).click();assert(await phone.locator('.table-hand .card-shell').first().locator('.hand-card').getAttribute('aria-label')!==original,'Touch reorder did not move card');await phone.getByRole('button',{name:'完成整理',exact:true}).click();
 assert(mutations===0,'Display gestures sent a game mutation');
 await phone.screenshot({path:'outputs/mobile-hand-v180.png'});
 await phone.getByRole('button',{name:'手牌',exact:true}).click();
 for(const label of [/^牌库\(/,/^弃牌堆\(/]){await phone.locator('.map-panel-buttons button').filter({hasText:label}).click();const card=phone.locator('.catalog-dock .hand-card:visible').first();const dim=await card.boundingBox();assert(dim.width===154&&dim.height===180,'Pile size differs from hand');await phone.locator('.map-panel-buttons button').filter({hasText:label}).click();}
 assert(await phone.locator('.world-map').evaluate(el=>getComputedStyle(el).webkitTapHighlightColor)==='rgba(0, 0, 0, 0)','Tap highlight still enabled');
 await phone.setViewportSize({width:390,height:844});assert(await phone.locator('.rotate-device').count()===0,'Orientation must not block the UI');await phone.locator('.record-toggle').click();await phone.getByLabel('关闭记录侧栏').click();
 await phone.getByRole('button',{name:'切换横竖屏',exact:true}).click();await phone.waitForTimeout(200);
 assert(await phone.evaluate(()=>document.documentElement.dataset.rotated)==='true','Manual rotation not applied');
 const rotatedSize=await phone.locator('#root').evaluate(el=>({w:el.clientWidth,h:el.clientHeight}));assert(rotatedSize.w===844&&rotatedSize.h===390,'Rotated logical dimensions wrong');
 const rpoint=await phone.evaluate(()=>{const r=document.querySelector('.map-viewport').getBoundingClientRect();for(let y=r.top+30;y<r.bottom-20;y+=30)for(let x=r.left+15;x<r.right-15;x+=25){const e=document.elementFromPoint(x,y)?.closest('[data-region-id]');if(e&&e.getAttribute('aria-pressed')!=='true')return {x,y,id:e.getAttribute('data-region-id')};}return null;});
 assert(rpoint,'No rotated map target');await phone.touchscreen.tap(rpoint.x,rpoint.y);assert(await phone.locator(`[data-region-id="${rpoint.id}"]`).first().getAttribute('aria-pressed')==='true','Rotated map tap missed target');
 await phone.getByRole('button',{name:'地图工具',exact:true}).click();await phone.locator('.zoom-tools button').first().click();await phone.locator('.zoom-tools button').first().click();
 await phone.getByRole('button',{name:'地图工具',exact:true}).click();
 const rb=await phone.locator('.map-viewport').boundingBox(),rx=rb.x+rb.width/2,ry=rb.y+rb.height/2,rz=Number(await phone.locator('.map-viewport').getAttribute('data-zoom'));
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rx-20,y:ry,id:1},{x:rx+20,y:ry,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rx-45,y:ry,id:1},{x:rx+45,y:ry,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await phone.waitForTimeout(100);assert(Number(await phone.locator('.map-viewport').getAttribute('data-zoom'))>rz,'Rotated pinch failed');
 await phone.screenshot({path:'outputs/mobile-rotated-v180.png'});
 await phone.getByRole('button',{name:'切换横竖屏',exact:true}).click();assert(await phone.evaluate(()=>document.documentElement.dataset.rotated)==='false','Rotation could not be restored');
 await phone.setViewportSize({width:844,height:390});await phone.locator('.map-viewport').waitFor();
 await phone.screenshot({path:'outputs/mobile-v180.png'});
 console.log('PASS: phone default sidebar, four viewport layouts, visible footer, record drawer, atlas, region tap/details, actual two-touch pinch without selecting, hand swipe, uncropped art and reorder without game mutations; chat unread/draft, portrait viewport remains interactive; manual rotation dimensions and region picking');
 await mobile.close();
 assert((await page.title()).includes('1.8.0'),'Wrong version');
 assert(errors.length===0,errors.join('\n'));
}finally{await browser?.close();server.kill();}

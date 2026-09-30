import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1200}});
const out='outputs/unit-layout-review';await mkdir(out,{recursive:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.argv[2]??'http://127.0.0.1:4174/');
  const toggle=page.getByRole('button',{name:'兵模检查',exact:true});await toggle.waitFor();
  await toggle.click();
  assert.equal(await page.locator('[data-preview="true"]').count(),153);
  assert.equal(await page.locator('.unit-token circle').first().getAttribute('r'),'18');
  const failures=await page.evaluate(()=>{
    const errors=[];
    for(const group of document.querySelectorAll('[data-token-region]')){
      const id=group.getAttribute('data-token-region');
      const path=document.querySelector(`[data-region-id="${id}"]:not([data-fragment]) path`);
      for(const token of group.querySelectorAll('.unit-token')){
        const m=token.transform.baseVal.consolidate().matrix;
        for(let a=0;a<Math.PI*2;a+=Math.PI/36){
          if(!path.isPointInFill(new DOMPoint(m.e+18.75*Math.cos(a),m.f+18.75*Math.sin(a))))errors.push(id);
        }
      }
    }
    return [...new Set(errors)];
  });assert.deepEqual(failures,[]);
  await page.getByRole('button',{name:'边界显示',exact:true}).click();
  await page.screenshot({path:out+'/all-regions.png'});
  for(const id of ['canada','sea_north_atlantic','iceland','iwo_jima','hawaii','philippines','japan','sea_black','sea_caspian','sea_north_sea','sea_east_pacific']){
    const bounds=await page.locator(`[data-region-id="${id}"]`).first().boundingBox();
    const clip={x:Math.max(0,bounds.x-10),y:Math.max(0,bounds.y-10),width:Math.min(bounds.width+20,1920-Math.max(0,bounds.x-10)),height:Math.min(bounds.height+20,1200-Math.max(0,bounds.y-10))};
    await page.screenshot({path:out+`/${id}.png`,clip});
  }
  await toggle.click();assert.equal(await page.locator('.unit-token').count(),0);
  await page.getByRole('button',{name:'新建对局',exact:true}).click();
  await page.getByRole('button',{name:'创建新游戏 →',exact:true}).click();
  await page.getByRole('heading',{name:/德国手牌/}).waitFor();
  await page.getByRole('button',{name:'收起手牌窗口',exact:true}).click();
  await page.evaluate(()=>window.scrollTo(0,0));
  const actual=await page.locator('.unit-layer').innerHTML();
  await toggle.click();assert.equal(await page.locator('[data-preview="true"]').count(),153);
  await toggle.click();assert.equal(await page.locator('.unit-layer').innerHTML(),actual);
  await page.locator('[data-region-id="germany"]').first().click({button:'right'});
  const dialog=page.getByRole('dialog',{name:'地区详情'});await dialog.waitFor();
  assert.match(await dialog.innerText(),/德国：陆军 × 1/);
  await page.screenshot({path:out+'/region-units.png'});
  assert.deepEqual(errors,[]);
  await writeFile(out+'/browser-verification.json',JSON.stringify({passed:true,previewCount:153,failures,errors,checks:['51 regions with three full circles inside SVG masks','36px diameter','preview toggle restores actual markers','right click unit details']},null,2));
  console.log('Unit display verification passed');
}finally{await browser.close();}

/** Headless existing-client import/seek check; server must be an isolated test build. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [url,...files]=process.argv.slice(2);
const releaseDir=process.env.QM_RELEASE_DIR;
const regions=JSON.parse(await readFile(new URL('../src/data/map.json',import.meta.url),'utf8')).regions;
if(!url||files.length!==4)throw Error('Usage: node scripts/verify-real-hand-client-import-v05.mjs URL old-raw old-replay new-raw new-replay');
const modulePath=join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(modulePath).href);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1080}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const checked=[];
try{
  await page.goto(url);
  await page.getByLabel('用户名').fill('V05只读回放验收');
  await page.getByRole('button',{name:'创建用户并进入'}).click();
  await page.getByRole('button',{name:/07.*GM/}).click();
  await page.getByRole('button',{name:'创建新游戏 →'}).click();
  await page.getByText('存档、读档与备份',{exact:true}).click();
  for(let pair=0;pair<2;pair++){
    const [rawPath,replayPath]=files.slice(pair*2,pair*2+2);
    const raw=(await readFile(rawPath,'utf8')).trimEnd().split('\n').map(JSON.parse);
    const states=raw.filter(row=>row.recordType==='state').map(row=>row.snapshot.state);
    const decisions=raw.filter(row=>row.type==='ppo-decision');
    await page.getByLabel('导入回放',{exact:true}).setInputFiles(replayPath);
    await page.getByRole('button',{name:'退出回放',exact:true}).waitFor({timeout:120000});
    const entries=page.locator('.replay-entry');
    assert.equal(await entries.count(),decisions.length);
    const opening=decisions.findIndex((row,i)=>row.action?.id==='hand-confirm'&&
      raw.filter(v=>v.recordType==='state')[i].snapshot.handSelection?.kind==='opening');
    assert(opening>=0);
    const chosen=[opening,decisions.findIndex(row=>String(row.action?.id).startsWith('source:')),
      decisions.findIndex(row=>row.choiceKind==='TRIGGER'),
      decisions.findIndex(row=>row.choiceKind==='PAY_COST'),decisions.length-1,
      ...(pair===0?[294,358]:[])].filter((i,p,a)=>i>=0&&i<decisions.length&&a.indexOf(i)===p);
    for(const index of chosen){
      await entries.nth(index).dispatchEvent('click');
      await page.getByRole('button',{name:'结算后'}).click();
      const state=states[index+1];
      const displayed=(await page.locator('[data-unit-ids]').evaluateAll(nodes=>nodes.flatMap(node=>
        (node.getAttribute('data-unit-ids')??'').split(',').filter(Boolean)))).sort();
      assert.deepEqual(displayed,state.units.map(unit=>unit.id).sort(),`map units at ${pair}/${index}`);
      const markers=await page.locator('[data-unit-ids]').evaluateAll(nodes=>nodes.map(node=>({ids:node.getAttribute('data-unit-ids').split(','),label:node.getAttribute('aria-label')})));
      for(const unit of state.units)assert(markers.find(m=>m.ids.includes(unit.id)).label.includes(regions.find(r=>r.id===unit.regionId).name),`region for ${unit.id}`);
      assert.equal(await page.locator('.table-hand .hand-card').count(),
        state.decks.germany.hand.length,`German GM view hand at ${pair}/${index}`);
      const zoneLabels=await page.locator('.map-panel-buttons').first().innerText();
      assert(zoneLabels.includes(`牌库(${state.decks.germany.drawPile.length})`),`deck count at ${pair}/${index}`);
      assert(zoneLabels.includes(`弃牌堆(${state.decks.germany.discardPile.length})`),`discard count at ${pair}/${index}`);
      const score=await page.getByLabel('阵营总分').innerText();
      const axis=state.scores.germany+state.scores.japan+state.scores.italy;
      const allies=state.scores.united_kingdom+state.scores.soviet_union+state.scores.united_states;
      assert(score.includes(String(axis))&&score.includes(String(allies)),`score at ${pair}/${index}`);
      checked.push({file:pair,index,round:state.round,phase:state.phase,
        activeSeat:state.activeSeat,units:displayed.length,hand:state.decks.germany.hand.length});
    }
    await entries.nth(opening).dispatchEvent('click');
    await page.getByRole('button',{name:'选择前'}).click();
    assert.equal(await page.locator('.table-hand .hand-card').count(),12);
    await page.getByRole('button',{name:'结算后'}).click();
    assert.equal(await page.locator('.table-hand .hand-card').count(),7);
    if(pair>=0){
      const summary=await entries.nth(opening).innerText();
      assert(summary.includes('完成起手留牌')&&summary.includes('保留7张')&&summary.includes('弃置5张'));
      assert(await entries.nth(opening).locator('.card-index-link').count()>0);
      await entries.nth(opening).locator('.card-index-link').first().click();
      await page.getByRole('dialog',{name:'卡牌索引'}).waitFor();
      await page.getByLabel('关闭卡牌索引').click();
      for(const seat of ['germany','united_kingdom','japan','soviet_union','italy','united_states']){
        await page.getByLabel('查看国家',{exact:true}).selectOption(seat);
        assert.equal(await page.locator('.table-hand .hand-card').count(),states[opening+1].decks[seat].hand.length);
      }
      await page.getByLabel('查看国家',{exact:true}).selectOption('germany');
      await page.getByLabel('回放视角').selectOption('public');
      assert(!(await entries.nth(opening).innerText()).includes('保留7张'));
    }
    await page.getByRole('button',{name:'退出回放',exact:true}).click();
  }
  if(releaseDir)for(const file of ['client-standard.jsonl','constructed-training-resources.jsonl','client-gm-edit.jsonl']){
    await page.getByLabel('导入回放',{exact:true}).setInputFiles(join(releaseDir,'回放样例',file));
    await page.getByRole('button',{name:'退出回放',exact:true}).waitFor();
    const entries=page.locator('.replay-entry');await entries.last().dispatchEvent('click');
    await page.getByRole('button',{name:'结算后'}).click();
    assert.equal(await page.locator('.action-replay-record [role="alert"]').count(),0);
    if(file.includes('resources'))assert(await page.getByRole('button',{name:/^资源池/}).count());
    if(file.includes('gm-edit'))assert((await entries.last().innerText()).includes('GM 修改场景'));
    checked.push({file,entries:await entries.count()});
    await page.getByRole('button',{name:'退出回放',exact:true}).click();
  }
  await page.getByLabel('导入回放',{exact:true}).setInputFiles({name:'invalid.jsonl',
    mimeType:'application/x-ndjson',buffer:Buffer.from('{"mode":"real_hand","formatVersion":3}\n')});
  await page.locator('.error').filter({hasText:/回放|Error|身份|格式/}).waitFor();
  assert.equal(await page.getByRole('button',{name:'退出回放',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({importedFiles:2,checked,errors}));
}finally{await browser.close();}

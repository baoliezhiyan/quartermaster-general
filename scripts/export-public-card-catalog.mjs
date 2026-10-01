// Generate reviewable Markdown from the same catalog functions used by the game.
import {build} from 'vite';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
async function load(entry){
  const result=await build({configFile:false,logLevel:'silent',build:{ssr:entry,write:false,rollupOptions:{input:entry}}});
  return import(`data:text/javascript;base64,${Buffer.from(result.output[0].code).toString('base64')}`);
}
const catalog=await load('src/core/cardCatalog.ts');
const basic=await load('src/core/basic.ts');
const numbering=await load('src/ui/cardNumbers.ts');
const {version}=JSON.parse(await readFile('package.json','utf8'));
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replaceAll('\n','<br>');
await mkdir('docs/cards',{recursive:true});
for(const balance of [false,true]){
  const lines=[`# ${balance?'平衡补丁开启':'平衡补丁关闭'}：牌表`,
    '',`生成自当前源码，应用版本 ${version}。请结合Git提交识别规则；此表是代码实际卡面定义，不是另行批准的规则裁定。`,
    '', '生成命令：`node scripts/export-public-card-catalog.mjs`。勿手改。提Issue请注明本表模式及卡牌ID。',
    '', '## 基本牌数量', '', '| 国家 | '+Object.values(basic.BASIC_NAMES).map(escape).join(' | ')+' |',
    '| --- | '+Object.keys(basic.BASIC_NAMES).map(()=> '---:').join(' | ')+' |'];
  for(const [seat,counts] of Object.entries(basic.BASIC_COUNTS)){
    const nums=counts.map((n,i)=>n+(balance&&seat==='italy'&&[2,3].includes(i)?1:0));
    lines.push(`| ${basic.COUNTRY_NAMES[seat]} | ${nums.join(' | ')} |`);
  }
  for(const [title,cards] of [['常规特殊牌',catalog.regularCatalog(balance,false)],['序章牌',catalog.preludeCatalog(balance)],['中立初始牌（仅启用中立时）',catalog.NEUTRALITY_CARDS]]){
    if(new Set(cards.map(c=>c.id)).size!==cards.length)throw Error(`Duplicate card ID in ${title}`);
    lines.push('',`## ${title}`,'','| 编号 | 内部稳定ID | 所属牌库 | 牌面国家 | 类别 | 名称 | 紧张度 | 卡面文本 |','| --- | --- | --- | --- | --- | --- | --- | --- |');
    for(const c of [...cards].sort((a,b)=>numbering.numberedCatalog(balance).findIndex(n=>n.id===a.id)-numbering.numberedCatalog(balance).findIndex(n=>n.id===b.id)))lines.push('| '+[numbering.catalogCardNumber(c.deckOwner,c.id,balance),c.id,basic.COUNTRY_NAMES[c.deckOwner],basic.COUNTRY_NAMES[c.country],c.type,c.name,c.type==='历史'?c.tension??'—':'—',c.text].map(escape).join(' | ')+' |');
  }
  await writeFile(`docs/cards/${balance?'balanced':'standard'}-ids.json`,JSON.stringify(numbering.numberedCatalog(balance),null,2)+'\n');
  await writeFile(`docs/cards/${balance?'balanced':'standard'}.md`,lines.join('\n')+'\n');
}
console.log('Generated docs/cards/standard.md and balanced.md');

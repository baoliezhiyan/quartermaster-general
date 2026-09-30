import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')));
const shapes=JSON.parse(await readFile('src/ui/map/traced-geometry.json','utf8'));
const background=(await readFile('public/assets/final-map.png')).toString('base64');
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1743,height:902},deviceScaleFactor:1});
 await page.setContent(`<style>body{margin:0}path{fill:transparent;stroke:#9fe9eb;stroke-width:1;pointer-events:all}</style><svg width="1743" height="902" viewBox="0 0 1743 902"><image href="data:image/png;base64,${background}" width="1743" height="902"/>${shapes.map(s=>`<path data-region="${s.regionId}" d="${s.path}" fill-rule="evenodd"/>`).join('')}</svg>`);
 // Use native SVG hit testing at each island's label and every unit slot.
 for(const key of ['british_isles','japan']){const shape=shapes.find(s=>s.key===key);for(const [x,y] of [shape.label,...shape.tokenSlots])assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.getAttribute('data-region'),[x,y]),key);}
 await mkdir('outputs/map-v168',{recursive:true});
 for(const [name,clip] of [['islands-west',{x:300,y:75,width:150,height:150}],['islands-east',{x:1270,y:215,width:140,height:180}],['suez',{x:640,y:410,width:105,height:80}],['new-zealand',{x:1400,y:795,width:140,height:107}]])await page.screenshot({path:`outputs/map-v168/${name}.png`,clip});
 console.log('PASS native SVG hit testing for both island labels and all six unit slots.');
} finally {await browser.close();}

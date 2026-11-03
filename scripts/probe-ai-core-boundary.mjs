import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
const dir=resolve('outputs/ai-core-boundary');await mkdir(dir,{recursive:true});
await writeFile(join(dir,'engine.mjs'),await readFile('dist-server/Room.js','utf8')+'\nexport {createGame,transition,refreshSceneResolution};\n');
await writeFile(join(dir,'case.mjs'),`
import {createGame,transition,refreshSceneResolution} from './engine.mjs';
let s=createGame('constructed-core-boundary',17,'FULL',false,false,true);s.status='PLAYING';s.phase='PLAY';s.round=1;s.activeSeat=s.viewSeat=s.operatorSeat='germany';
s.units=[{id:'gi',country:'germany',type:'army',regionId:'italy'},{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'ga',country:'germany',type:'air',regionId:'germany'},{id:'uk',country:'united_kingdom',type:'army',regionId:'western_europe'},{id:'ua',country:'united_kingdom',type:'air',regionId:'western_europe'}];
const d=s.decks.germany,c=[...d.hand,...d.drawPile].find(c=>c.definitionId==='land_battle');d.drawPile=d.drawPile.filter(v=>v.id!==c.id);d.hand=d.hand.filter(v=>v.id!==c.id);d.hand.push(c);
function send(command){const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...command});if(!r.ok)throw Error(r.error);s=r.state;}
send({type:'PLAY_CARD',cardId:c.id,effectIndices:[0],targetIds:[],guided:true});
for(let i=0;i<10&&s.resolution?.choice?.kind!=='AIR_INTERCEPT';i++){const q=s.resolution.choice;const id=q.kind==='AIR_DEFENSE'?'yes':q.field==='regionId'?'western_europe':q.field==='defenderId'?'uk':q.field==='attackerId'?'g':q.options[0].id;send({type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,choiceId:q.id,ids:[id],guided:true});}
console.log('before_refresh',s.resolution.choice.kind);s.units=s.units.filter(u=>u.id!=='g');const resolution=s.resolution;refreshSceneResolution(s);if(resolution.running||resolution.choice||!resolution.events.some(e=>e.outcome==='invalid'&&e.effect?.kind==='action')||!s.units.some(u=>u.id==='uk'))throw Error('unexpected refresh state');console.log('after_refresh invalid_selected_action_ended');
`);
const child=spawn(process.execPath,[join(dir,'case.mjs')],{stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},2500);const exitCode=await new Promise(r=>child.once('exit',r));clearTimeout(timer);assert.equal(timedOut,false,'selected action refresh must return');assert.equal(exitCode,0,output);assert(output.includes('after_refresh invalid_selected_action_ended'),output);console.log(JSON.stringify({coreOnly:true,timedOut,output,scope:'constructed case; no live room; no AI adapter execution'},null,2));

import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {realTriggers} from '../src/core/specialCards';
import {specialCard} from '../src/core/cardCatalog';
// @ts-expect-error Node is available in the benchmark runner; the app targets browser types.
import {writeFileSync,mkdirSync} from 'node:fs';
it('profiles trigger scanning with Substitute Material',()=>{
 const rows=[];
 for(const copy of [false,true]){
 const s=createGame('profile',42,'FULL',true,false,true);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';
 for(const d of Object.values(s.decks)){const cards=[...d.drawPile,...d.hand];d.hand=cards.slice(0,7);d.drawPile=cards.slice(7);d.active=[];d.faceDown=[];}
 const d=s.decks.germany;d.discardPile=d.drawPile.filter(c=>specialCard(c.definitionId,true)?.type==='状态');d.drawPile=d.drawPile.filter(c=>!d.discardPile.includes(c));
 if(copy)d.faceDown.push({id:'copy',definitionId:'prelude_DE-09',country:'germany',deckOwner:'germany',balance:true});
 const frame={id:'frame',currentEventId:'event',sourceAncestors:[]} as any;
 for(const action of ['build_army','air_deploy'] as const){const e={kind:'action',country:'germany',action,option:{regionId:'germany'},label:'测试'} as any;const t=performance.now();for(let i=0;i<5;i++)realTriggers(s,frame,e,'After');rows.push({copy,action,msPerScan:(performance.now()-t)/5});}
 }
 mkdirSync('outputs/performance-v160',{recursive:true});writeFileSync('outputs/performance-v160/trigger-after.json',JSON.stringify(rows,null,2));expect(Math.max(...rows.map(r=>r.msPerScan))).toBeLessThan(2000);
});

it('single-card copying finds the same rules as a full scan without changing the board',()=>{
 const s=createGame('equivalence',42,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';
 const d=s.decks.germany;const all=[...d.hand,...d.drawPile];d.active=all.filter(c=>specialCard(c.definitionId,true)?.type==='状态');d.hand=all.filter(c=>!d.active.includes(c)).slice(0,7);d.drawPile=all.filter(c=>!d.active.includes(c)&&!d.hand.includes(c));
 const frame={id:'frame',currentEventId:'event',sourceAncestors:[]} as any;
 const events:any[]=['build_army','build_navy','land_battle','air_deploy'].map(action=>({kind:'action',country:'germany',action,option:{regionId:'eastern_europe'},label:'事件'}));
 events.push(...['TURN_START_WINDOW','SCORE','PLAY'].map(phase=>({kind:'signal',tag:'PHASE:'+phase,label:'阶段'})));
 const before=JSON.stringify(s);
 for(const event of events)for(const timing of ['Before','After'] as const){
  const all=realTriggers(s,frame,event,timing,false,false);
  for(const card of d.active)expect(realTriggers(s,frame,event,timing,false,false,card.id)).toEqual(all.filter(r=>r.sourceInstanceId===card.id));
 }
 expect(JSON.stringify(s)).toBe(before);
});

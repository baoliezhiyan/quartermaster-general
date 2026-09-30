import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {BALANCE_CARDS,specialCard} from '../src/core/cardCatalog';
import {cardEffects} from '../src/core/specialCards';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {preludeCardEffects} from '../src/core/prelude';
import {preludeTriggers} from '../src/core/preludeTriggers';
import {projectState} from '../src/network/project';
import type {GameState,CardInstance} from '../src/core/types';
import type {ResolutionFrame,Effect} from '../src/core/resolutionTypes';
function game(){const s=createGame('audit',1940,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat='japan';for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0),...d.active.splice(0),...d.faceDown.splice(0));}return s;}
function add(s:GameState,id:string,zone:'hand'|'faceDown'|'active'='hand'){const def=specialCard(id,true)!;const d=s.decks[def.deckOwner];const i=d.drawPile.findIndex(c=>c.definitionId===id);const c=i>=0?d.drawPile.splice(i,1)[0]:{id:'fixture:'+id,definitionId:id,country:def.country,deckOwner:def.deckOwner,balance:true};d[zone].push(c);return c;}
function choose(s:GameState,id?:string){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,id?[id]:q.options.slice(0,q.min).map(o=>o.id))).toBe(true);}
function actions(s:GameState,region:string){for(let i=0;i<15&&s.resolution?.choice?.kind==='ACTION';i++){const q=s.resolution.choice;choose(s,q.options.find(o=>o.id===region)?.id??q.options[0].id);}}
for(const d of BALANCE_CARDS.filter(c=>c.id.startsWith('special_')&&['状态','响应'].includes(c.type)&&c.id!=='special_91'))it(`balance declaration installs ${d.id} ${d.name} without running replaced effects`,()=>{
 const s=game(),c:CardInstance={id:'audit:'+d.id,definitionId:d.id,deckOwner:d.deckOwner,country:d.country,balance:true};
 expect(cardEffects(s,c)).toEqual([expect.objectContaining({kind:'signal',tag:'INSTALL'})]);
});
it('Manchuria installs without old economic damage, then builds and attacks after Vladivostok battle',()=>{
 const s=game(),c=add(s,'special_178'),before=s.decks.soviet_union.drawPile.length,score=s.scores.japan;
 startResolution(s,'满洲攻略','japan',cardEffects(s,c),[],c.id,'faceDown');expect(s.resolution?.running).toBe(false);expect(s.decks.japan.faceDown.some(v=>v.id===c.id)).toBe(true);expect(s.scores.japan).toBe(score);expect(s.decks.soviet_union.drawPile.length).toBe(before);
 s.units=[{id:'j',country:'japan',type:'army',regionId:'eastern_china'},{id:'s',country:'soviet_union',type:'army',regionId:'vladivostok'},{id:'m',country:'soviet_union',type:'army',regionId:'mongolia'}];
 startResolution(s,'攻击海参崴','japan',[{kind:'action',country:'japan',action:'land_battle',regions:['vladivostok'],label:'攻击海参崴'}],[]);actions(s,'vladivostok');expect(s.units.some(u=>u.id==='s')).toBe(false);expect(s.resolution!.choice!.options.some(o=>o.label==='满洲攻略')).toBe(true);choose(s,s.resolution!.choice!.options.find(o=>o.label==='满洲攻略')!.id);actions(s,'vladivostok');
 if(s.resolution?.choice?.kind==='EFFECTS'){const q=s.resolution.choice;expect(resolveChoice(s,q.seat,q.id,['0','1'])).toBe(true);choose(s,s.resolution!.choice!.options[0].id);}
 expect(s.units.some(u=>u.country==='japan'&&u.regionId==='vladivostok')).toBe(true);
 for(let i=0;i<20&&s.resolution?.choice;i++){const q=s.resolution.choice;choose(s,q.kind==='ACTION'?q.options.find(o=>o.id==='mongolia'||o.label.includes('蒙古'))?.id??q.options[0].id:undefined);}
 expect(s.resolution?.running).toBe(false);expect(s.units.some(u=>u.id==='m'),JSON.stringify({trace:s.resolution?.trace,units:s.units})).toBe(false);expect(s.decks.japan.discardPile.some(v=>v.id===c.id)).toBe(true);expect(s.decks.soviet_union.drawPile.length).toBe(before);
 expect(fullTrigger(s,c,{kind:'action',country:'japan',action:'land_battle',option:{id:'x',label:'x',mode:'battle',regionId:'eastern_china'},label:'wrong region'},'After')).toBeUndefined();
});
it('Tientsin victims receive only their own discard information',()=>{
 const s=game();s.prelude!.active=true;s.phase='PRELUDE';const c=add(s,'prelude_JP-16');const lost=Object.fromEntries(['united_states','united_kingdom'].map(seat=>[seat,s.prelude!.decks[seat as 'united_states'].drawPile.slice(0,2).map(c=>c.id)]));
 startResolution(s,'天津事变','japan',preludeCardEffects(s,c).effects,[],c.id,'discardPile');expect(s.resolution?.running).toBe(false);
 for(const seat of ['united_states','united_kingdom'] as const){const notices=projectState(s,{kind:'player',seat},seat)!.responseNotices!;expect(notices).toHaveLength(1);expect(notices[0].cards.map(c=>c.id)).toEqual(lost[seat]);expect(notices[0].text).not.toContain(seat==='united_states'?'英国':'美国');}
});
it('Commonwealth air training retains the anytime window and scores plus deployment',()=>{
 const s=game();s.activeSeat='united_kingdom';const c=add(s,'prelude_UK-07','faceDown');const e:Effect={kind:'signal',tag:'ARMAMENT_ANYTIME',label:'任意时机'};
 const rule=preludeTriggers(s,{id:'frame',currentEventId:'event'} as ResolutionFrame,e,'After').find(r=>r.sourceInstanceId===c.id)!;expect(rule).toBeTruthy();expect(rule.effects).toEqual(expect.arrayContaining([expect.objectContaining({kind:'score',amount:1}),expect.objectContaining({kind:'action',action:'air_deploy',regions:['australia','india','canada','south_africa']})]));
});

it('steel pact can discard its last response and resolve even if Germany has no state',()=>{
 const s=game();s.activeSeat=s.viewSeat=s.operatorSeat='italy';const c=add(s,'special_227'),r=add(s,'special_218');const d=s.decks.italy,fee=d.drawPile.shift()!;d.hand.push(fee);
 expect(startResolution(s,'钢铁条约','italy',cardEffects(s,c),[],c.id,'discardPile',true)).toBe(true);
 const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,[r.id,fee.id],true)).toBe(true);
 expect(s.resolution?.running).toBe(false);expect(d.faceDown).toHaveLength(0);expect(d.discardPile.map(v=>v.id)).toEqual(expect.arrayContaining([c.id,r.id,fee.id]));
});
it('steel pact requires two other hand cards but not a response',()=>{
 const s=game();s.activeSeat=s.viewSeat=s.operatorSeat='italy';const c=add(s,'special_227'),d=s.decks.italy;
 const a=d.drawPile.shift()!;d.hand.push(a);expect(startResolution(s,'钢铁条约','italy',cardEffects(s,c),[],c.id,'discardPile',true)).toBe(false);
 const b=d.drawPile.shift()!;d.hand.push(b);expect(startResolution(s,'钢铁条约','italy',cardEffects(s,c),[],c.id,'discardPile',true)).toBe(true);
 const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,[a.id,b.id],true)).toBe(true);expect(s.resolution?.running).toBe(false);expect(d.discardPile.some(v=>v.id===c.id)).toBe(true);
});

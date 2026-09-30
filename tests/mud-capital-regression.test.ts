import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {occupiedNeutralitySupply} from '../src/core/neutrality';
import {countryScore} from '../src/core/supply';
import {specialCard} from '../src/core/cardCatalog';
import {startResolution,resolveChoice} from '../src/core/resolution';
import type {GameState} from '../src/core';
function card(s:GameState,id:string,zone:'active'|'faceDown'){
 const d=specialCard(id)!;s.decks[d.deckOwner][zone].push({id:'test-'+id,definitionId:id,country:d.country,deckOwner:d.deckOwner});
}
function choose(s:GameState,label?:string){const c=s.resolution!.choice!;const o=label?c.options.find(o=>o.label===label||o.id===label):undefined;if(label)expect(o,JSON.stringify(c)).toBeDefined();expect(resolveChoice(s,c.seat,c.id,o?[o.id]:[])).toBe(true);}
it('relocated Siberia scores for occupying Axis, Moscow stops scoring, and shared occupation splits points',()=>{
 const s=createGame('capital',1,'FULL');card(s,'special_42','active');
 s.units=[{id:'g',country:'germany',type:'army',regionId:'siberia'},{id:'m',country:'germany',type:'army',regionId:'moscow'}];
 expect(countryScore(s,'germany')).toBe(2);expect(countryScore(s,'soviet_union')).toBe(0);
 expect(occupiedNeutralitySupply(s)).toEqual(['siberia']);
 s.units.push({id:'i',country:'italy',type:'army',regionId:'siberia'});
 expect(countryScore(s,'germany')).toBe(1);expect(countryScore(s,'italy')).toBe(1);
 s.decks.soviet_union.active=[];expect(countryScore(s,'germany')).toBe(2);expect(countryScore(s,'italy')).toBe(0);
});
function setup(){
 const s=createGame('mud',1940,'FULL',true);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';s.activeSeat=s.operatorSeat=s.viewSeat='germany';s.settings.ignoreOtherPlayerInterrupts=false;
 for(const d of Object.values(s.decks)){d.drawPile.push(...d.active,...d.faceDown,...d.hand);d.active=[];d.faceDown=[];d.hand=[];}
 const sd=s.decks.soviet_union;sd.hand.push(...sd.drawPile.splice(sd.drawPile.findIndex(c=>c.definitionId==='build_army'),1));
 card(s,'special_137','active');card(s,'special_57','faceDown');card(s,'prelude_SU-16','faceDown');
 s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'m',country:'soviet_union',type:'army',regionId:'moscow'},{id:'b',country:'soviet_union',type:'army',regionId:'balkans'}];
 expect(startResolution(s,'建设陆军','germany',[{kind:'action',country:'germany',action:'build_army',regions:['ukraine'],label:'建设乌克兰陆军'}],[])).toBe(true);
 for(let n=0;n<10&&s.resolution?.choice?.kind==='ACTION';n++){const c=s.resolution.choice;expect(resolveChoice(s,c.seat,c.id,[c.options[0].id])).toBe(true);}
 return s;
}
it('offers Mud first; destruction prevents Moscow attack, another army can still attack and trigger Sorge',()=>{
 const s=setup();expect(s.resolution!.choice!.seat).toBe('soviet_union');expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['湿季泥沼']);
 choose(s,'湿季泥沼');expect(s.units.some(u=>u.country==='germany'&&u.regionId==='ukraine')).toBe(false);
 expect(s.resolution!.choice!.seat).toBe('germany');choose(s,'兵贵神速');
 const battle=s.resolution!.choice!;expect(battle.kind).toBe('ACTION');expect(JSON.stringify(battle.options)).not.toContain('moscow');expect(JSON.stringify(battle.options)).toContain('balkans');
 expect(resolveChoice(s,battle.seat,battle.id,[battle.options[0].id])).toBe(true);
 if(s.resolution?.choice?.field==='attackerId')choose(s,'e');
 expect(s.resolution!.choice!.options.some(o=>o.label==='佐尔格特工警告克里姆林宫'),JSON.stringify(s.resolution!.choice)).toBe(true);
 choose(s,'佐尔格特工警告克里姆林宫');
 expect(s.resolution!.frames.some(f=>f.source==='佐尔格特工警告克里姆林宫')).toBe(true);
 for(let n=0;n<12&&s.resolution?.choice;n++){const c=s.resolution.choice;expect(resolveChoice(s,c.seat,c.id,c.min?[c.options[0].id]:[])).toBe(true);}
 expect(s.resolution?.running).toBe(false);expect(s.decks.soviet_union.removed.some(c=>c.definitionId==='prelude_SU-16')).toBe(true);
 expect(s.units.filter(u=>u.country==='soviet_union'&&u.type==='army')).toHaveLength(2);
});
it('declining Mud allows the original construction follow-up to attack Moscow',()=>{
 const s=setup();choose(s);expect(s.resolution!.choice!.seat).toBe('germany');choose(s,'兵贵神速');
 expect(JSON.stringify(s.resolution!.choice!.options)).toContain('moscow');
});

function resolveActions(s:GameState,region:string){for(let n=0;n<15&&s.resolution?.choice?.kind==='ACTION';n++){const c=s.resolution.choice;choose(s,c.options.find(o=>o.id===region)?.id??c.options[0].id);}}
it.each([[false,true],[true,true],[false,false]])('Sorge resolves before offensive chains (restore %s, recruit %s)',(restore,recruit)=>{
 let s=createGame('sorge-chain',1940,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.round=1;s.activeSeat=s.viewSeat=s.operatorSeat='germany';
 for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}
 for(const id of ['special_134','special_136','special_137'])card(s,id,'active');card(s,'prelude_SU-16','faceDown');
 const sd=s.decks.soviet_union;sd.hand.push(...sd.drawPile.splice(sd.drawPile.findIndex(c=>c.definitionId==='build_army'),1));
 s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'r',country:'soviet_union',type:'army',regionId:'ross_region'},{id:'m',country:'soviet_union',type:'army',regionId:'moscow'}];
 startResolution(s,'陆攻','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['ross_region'],label:'罗斯陆战'}],[]);resolveActions(s,'ross_region');
 expect(s.resolution!.choice!.seat).toBe('soviet_union');choose(s);expect(s.resolution!.choice!.seat).toBe('germany');choose(s,'闪电战');resolveActions(s,'ross_region');choose(s,'兵贵神速');resolveActions(s,'moscow');
 expect(s.units.some(u=>u.country==='soviet_union'&&u.regionId==='moscow')).toBe(false);expect(s.resolution!.choice!.seat).toBe('soviet_union');expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('佐尔格特工警告克里姆林宫');
 if(restore)s=JSON.parse(JSON.stringify(s));if(!recruit){choose(s);for(let n=0;n<40&&s.resolution?.choice;n++){const q=s.resolution.choice;expect(q.seat).not.toBe('soviet_union');choose(s,q.min?q.options[0].id:undefined);}expect(s.resolution?.running).toBe(false);return;}choose(s,'佐尔格特工警告克里姆林宫');if(s.resolution?.choice?.kind==='CARDS')choose(s,s.resolution.choice.options[0].id);if(s.resolution?.choice?.kind==='SELECT')choose(s,'1');resolveActions(s,'moscow');
 expect(s.units.some(u=>u.country==='soviet_union'&&u.regionId==='moscow'),JSON.stringify(s.resolution!.choice)).toBe(true);expect(s.resolution!.choice!.seat).toBe('germany');choose(s,'俯冲式轰炸机');resolveActions(s,'moscow');
 expect(s.units.some(u=>u.country==='soviet_union'&&u.regionId==='moscow')).toBe(false);
 for(let n=0;n<40&&s.resolution?.choice;n++){const q=s.resolution.choice;choose(s,q.min?q.options[0].id:undefined);}expect(s.resolution?.running).toBe(false);
});

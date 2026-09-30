import {fullCardEffects} from '../src/core/fullCardEffects';
import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {specialCard,regularCatalog,preludeCatalog} from '../src/core/cardCatalog';
import {historyEffects,markPreludeInstall} from '../src/core/prelude';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {realTriggers} from '../src/core/specialCards';
import type {GameState} from '../src/core/types';
import type {ResolutionFrame,Effect} from '../src/core/resolutionTypes';
function game(){const s=createGame('v165',17,'FULL',true,false,true);s.prelude!.active=false;s.phase='TURN_START_WINDOW';s.activeSeat=s.viewSeat=s.operatorSeat='united_kingdom';s.redistributed=true;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0));d.active=[];d.faceDown=[];}return s;}
function add(s:GameState,id:string,zone:'hand'|'faceDown'='hand'){const def=specialCard(id,true)!;const card={id:'test:'+id,definitionId:id,country:def.country,deckOwner:def.deckOwner,balance:true};s.decks[card.deckOwner][zone].push(card);return card;}
function reply(s:GameState,ids:string[]){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.choice&&i<80;i++){const q=s.resolution.choice;reply(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
it.each([0,2])('Shadow Factories bottoms %s cards then fills to seven',n=>{
 const s=game(),card=add(s,'special_256');const d=s.decks.united_kingdom;d.hand.push(...d.drawPile.splice(0,3));const ids=d.hand.filter(c=>c.id!==card.id).slice(0,n).map(c=>c.id);
 startResolution(s,'start','united_kingdom',[{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'回合开始'}],[]);
 reply(s,[s.resolution!.choice!.options.find(o=>o.label==='影子工厂计划')!.id]);expect(s.resolution!.choice!.kind).toBe('CARDS');reply(s,ids);finish(s);
 expect(d.hand).toHaveLength(7);expect(d.discardPile.some(c=>c.id===card.id)).toBe(true);if(n)expect(d.drawPile.slice(-n).map(c=>c.id)).toEqual(ids);
});
it('Amtorg retrieves unplayed history, excludes a played history and an installed armament',()=>{
 const s=game();s.prelude!.active=true;s.phase='PRELUDE';s.activeSeat='united_states';const card=add(s,'prelude_US-06');const d=s.prelude!.decks.soviet_union;
 const history=add(s,'prelude_SU-19'),used=add(s,'prelude_SU-12'),arm=add(s,'prelude_SU-06');s.decks.soviet_union.hand=[];d.discardPile=[history,used,arm];markPreludeInstall(s,used.id);markPreludeInstall(s,arm.id);
 startResolution(s,'贸易公司','united_states',historyEffects(s,card),[],card.id);expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual([history.id]);reply(s,[history.id]);finish(s);
 expect(s.units.some(u=>u.country==='soviet_union'&&u.regionId==='ukraine')).toBe(true);expect(s.prelude!.tension).toBe(1);expect(Object.hasOwn(s.prelude!.installed,history.id)).toBe(true);
});
it('prelude suppresses regular facedown response even after naval construction',()=>{
 const s=game();s.prelude!.active=true;const card=add(s,'special_196','faceDown');s.units=[{id:'built',country:'united_states',type:'navy',regionId:'sea_east_china'},{id:'jp',country:'japan',type:'army',regionId:'japan'}];s.events.push({type:'UNIT_PLACED',revision:0,unitId:'built',country:'united_states',unitType:'navy',regionId:'sea_east_china',mode:'build'} as never);
 const f={id:'f',owner:'united_states',currentEventId:'e'} as ResolutionFrame;const e={kind:'action',country:'united_states',action:'build_navy',option:{regionId:'sea_east_china'},resultUnitId:'built',label:'build'} as Effect;
 expect(realTriggers(s,f,e,'After').some(r=>r.sourceInstanceId===card.id)).toBe(false);
 s.prelude!.active=false;expect(realTriggers(s,f,e,'After').some(r=>r.sourceInstanceId===card.id)).toBe(true);
});
it.each(['siberia','kazakhstan','ukraine'])('Endless Expansion intervenes before removal at %s during enemy turn',region=>{
 const s=game();s.activeSeat='germany';const card=add(s,'special_55','faceDown');const unit={id:'su',country:'soviet_union' as const,type:'army' as const,regionId:region};s.units=[unit];
 startResolution(s,'remove','germany',[{kind:'remove',unit,supplied:true,cause:'land_battle',label:'移除苏联陆军'}],[]);
 if(region==='ukraine'){expect(s.units).toHaveLength(0);return;}
 expect(s.resolution!.choice!.seat).toBe('soviet_union');reply(s,[s.resolution!.choice!.options.find(o=>o.label==='无休止的扩大')!.id]);finish(s);expect(s.units.map(u=>u.id)).toContain('su');expect(s.decks.soviet_union.discardPile.some(c=>c.id===card.id)).toBe(true);
});
it('merged catalog retains former experimental additions',()=>{
 expect(regularCatalog(true,false).some(c=>c.id==='special_256')).toBe(true);expect(preludeCatalog(true).some(c=>c.id==='prelude_SU-19')).toBe(true);
});

it.each([3,6,8])('experimental Strategic Planning retrieves before discarding from %s cards',count=>{
 const s=game();s.activeSeat='germany';const card=add(s,'special_153');const d=s.decks.germany;d.hand=[];d.hand.push(...d.drawPile.splice(0,count));
 startResolution(s,'战略规划','germany',fullCardEffects(s,card,[])!,[]);
 const ids=s.resolution!.choice!.options.slice(0,2).map(o=>o.id);reply(s,ids);
 expect(d.hand).toHaveLength(count+2);
 if(count+2>7){expect(s.resolution!.choice!.min).toBe(count+2-7);reply(s,d.hand.slice(0,count+2-7).map(c=>c.id));}
 finish(s);expect(d.hand).toHaveLength(Math.min(7,count+2));
});
it('experimental Endless Expansion triggers on own removal but not an arbitrary phase',()=>{
 const s=game();s.activeSeat='soviet_union';add(s,'special_55','faceDown');const unit={id:'su',country:'soviet_union' as const,type:'army' as const,regionId:'siberia'};s.units=[unit];
 startResolution(s,'phase','soviet_union',[{kind:'signal',tag:'PHASE:PLAY',label:'出牌'}],[]);expect(s.resolution?.choice).toBeFalsy();
 startResolution(s,'remove','soviet_union',[{kind:'remove',unit,supplied:true,cause:'land_battle',label:'移除陆军'}],[]);
 expect(s.resolution!.choice!.options.some(o=>o.label==='无休止的扩大')).toBe(true);reply(s,[s.resolution!.choice!.options.find(o=>o.label==='无休止的扩大')!.id]);finish(s);expect(s.units.some(u=>u.id===unit.id)).toBe(true);
});
it('experimental Spanish Gold offers the Soviet owner an anytime armament window',()=>{
 const s=game();s.activeSeat='soviet_union';s.phase='PLAY';add(s,'prelude_SU-06','faceDown');s.decks.soviet_union.hand.push(...s.decks.soviet_union.drawPile.splice(0,2));
 startResolution(s,'军备','soviet_union',[{kind:'signal',tag:'ARMAMENT_ANYTIME',label:'回合内军备'}],[]);
 expect(s.resolution!.choice!.seat).toBe('soviet_union');expect(s.resolution!.choice!.options.some(o=>o.label==='西班牙黄金储备')).toBe(true);
});

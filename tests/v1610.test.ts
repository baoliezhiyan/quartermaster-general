import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {specialCard,regularCatalog,preludeCatalog} from '../src/core/cardCatalog';
import {historyEffects,preludeCardEffects} from '../src/core/prelude';
import {checkNeutralitySupply,occupiedNeutralitySupply} from '../src/core/neutrality';
import {countryScore} from '../src/core/supply';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {preludeTriggers} from '../src/core/preludeTriggers';
import {cardEffects} from '../src/core/specialCards';
import {airActionOptions} from '../src/core/phaseAvailability';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {coversCost} from '../src/core/cardCosts';
import type {GameState,CardInstance,SeatId} from '../src/core/types';
import type {Effect,ResolutionFrame} from '../src/core/resolutionTypes';
function card(id:string,n=''):CardInstance{const d=specialCard(id,true);return {id:'test:'+id+n,definitionId:id,country:d?.country??'soviet_union',deckOwner:d?.deckOwner??'soviet_union',balance:true};}
function game(seat:SeatId='soviet_union'){const s=createGame('v1610',71,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat=seat;s.redistributed=true;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0));d.active=[];d.faceDown=[];}s.units=[];return s;}
function answer(s:GameState,ids?:string[]){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,ids??q.options.slice(0,q.min).map(o=>o.id))).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<60;i++)answer(s);expect(s.resolution?.running).toBe(false);}
const phase=(p:string):Effect=>({kind:'signal',tag:'PHASE:'+p,label:p});
const frame={id:'probe',currentEventId:'event'} as ResolutionFrame;
it('Hawaii counts twice toward US entry but keeps ordinary territorial points',()=>{
 const s=createGame('hawaii',4,'FULL',false,true,true);s.units=['hawaii','ukraine'].map((regionId,i)=>({id:String(i),country:'japan',type:'army',regionId}));checkNeutralitySupply(s);expect(s.neutrality!.united_states.neutral).toBe(true);
 const before=countryScore(s,'japan');s.units.push({id:'third',country:'germany',type:'army',regionId:'western_europe'});expect(occupiedNeutralitySupply(s)).toHaveLength(3);checkNeutralitySupply(s);expect(s.neutrality!.united_states.neutral).toBe(false);expect(countryScore(s,'japan')).toBe(before);
});
it('catalog restores Panay and replaces Chinese cooperation with American trade company',()=>{
 const p=preludeCatalog(true);expect(p.find(c=>c.id==='prelude_US-14')!.name).toBe('帕奈号事件');expect(p.find(c=>c.id==='prelude_US-06')!.name).toBe('阿姆托尔格贸易公司');expect(p.find(c=>c.id==='prelude_US-06')!.country).toBe('united_states');expect(p.some(c=>c.name==='第二次国共合作')).toBe(false);expect(regularCatalog(true,true).some(c=>c.id==='special_252')).toBe(false);expect(regularCatalog(true,false).filter(c=>['special_258','special_259'].includes(c.id))).toHaveLength(2);
});
it.each([['prelude_JP-16',2,2],['prelude_JP-11',4,2],['prelude_IT-08',3,2],['prelude_IT-09',1,2],['prelude_US-14',4,0]])('history %s applies actual discard and score', (id,count,points)=>{
 const s=game(),effects=historyEffects(s,card(id as string));expect(effects.filter(e=>e.kind==='prelude'&&e.op==='discard').every(e=>e.kind==='prelude'&&e.count===count)).toBe(true);expect(effects.filter(e=>e.kind==='score').reduce((n,e)=>n+(e.kind==='score'?e.amount:0),0)).toBe(points);
});
it('updated tension and Stalins recruitment are executable',()=>{
 const s=game();for(const [id,n] of [['prelude_IT-15',1],['prelude_JP-11',1],['prelude_SU-17',1],['prelude_US-10',-1]] as const)expect(preludeCardEffects(s,card(id)).effects[0]).toMatchObject({count:n});expect(historyEffects(s,card('prelude_SU-19'))[0]).toMatchObject({action:'recruit_army',regions:['ukraine']});
});
it('Hyde restores UK discard/play and US normal-panel extra play independently',()=>{
 const s=game('united_states');s.prelude!.active=true;s.prelude!.played=true;s.prelude!.discarded=3;s.prelude!.decks.united_kingdom.hand=[];
 startResolution(s,'野餐','united_states',historyEffects(s,card('prelude_US-10')),[]);finish(s);expect(s.prelude!.played).toBe(false);expect(s.prelude!.discarded).toBe(0);expect(s.resolution?.choice).toBeFalsy();
});
it('Kamikaze is a supply-start trigger, not an air action, and preserves existing air action state',()=>{
 const s=game('japan'),c=card('special_247');s.decks.japan.active=[c];s.units=[{id:'home',country:'japan',type:'army',regionId:'japan'},{id:'plane',country:'japan',type:'air',regionId:'japan'},{id:'target',country:'united_kingdom',type:'navy',regionId:'sea_east_china'}];s.phase='AIR';expect(airActionOptions(s).some(o=>(o.id as string)==='kamikaze')).toBe(false);expect(fullTrigger(s,c,phase('AIR'),'After')).toBeUndefined();s.phase='SUPPLY';s.airAction='deploy';
 startResolution(s,'补给','japan',[phase('SUPPLY')],[]);expect(s.resolution!.choice!.options.some(o=>o.label==='神风敢死队')).toBe(true);answer(s,[s.resolution!.choice!.options.find(o=>o.label==='神风敢死队')!.id]);finish(s);expect(s.units.some(u=>u.id==='plane'||u.id==='target')).toBe(false);expect(s.airAction).toBe('deploy');
});
it.each(['prelude_SU-01','prelude_SU-03'])('army fee bypasses removal for %s',id=>{
 const s=game(),c=card(id),fee=card('build_army');s.decks.soviet_union.faceDown=[c];s.decks.soviet_union.hand=[fee];s.units=[{id:'home',country:'soviet_union',type:'army',regionId:'moscow'}];
 const event:Effect=id.endsWith('01')?{kind:'action',country:'soviet_union',action:'land_battle',option:{regionId:'ukraine'} as any,label:'陆战'}:{kind:'remove',unit:{id:'dead',country:'soviet_union',type:'army',regionId:'ukraine'},supplied:true,cause:'land_battle',label:'阵亡'};
 const rule=preludeTriggers(s,frame,event,'After')[0];expect(rule).toBeTruthy();startResolution(s,'军备','soviet_union',rule.effects,[]);answer(s,[fee.id]);finish(s);expect(s.units.some(u=>u.id==='home')).toBe(true);expect(s.units.some(u=>u.regionId==='ukraine'&&u.country==='soviet_union')).toBe(true);
});
it('ordinary armament fee still removes another army',()=>{
 const s=game(),c=card('prelude_SU-01'),fee=card('land_battle');s.decks.soviet_union.faceDown=[c];s.decks.soviet_union.hand=[fee];s.units=[{id:'home',country:'soviet_union',type:'army',regionId:'moscow'},{id:'other',country:'soviet_union',type:'army',regionId:'siberia'}];
 const event:Effect={kind:'action',country:'soviet_union',action:'land_battle',option:{regionId:'ukraine'} as any,label:'陆战'};const rule=preludeTriggers(s,frame,event,'After')[0];startResolution(s,'军备','soviet_union',rule.effects,[]);answer(s,[fee.id]);answer(s,['other']);finish(s);expect(s.units.some(u=>u.id==='other')).toBe(false);expect(s.units.some(u=>u.regionId==='ukraine')).toBe(true);
});
it('wartime production draws to 14 then bottoms exactly 7 in selected order',()=>{
 const s=game('united_states'),c=card('prelude_US-05');s.decks.united_states.faceDown=[c];s.decks.united_states.hand=s.decks.united_states.drawPile.splice(0,3);
 const rule=preludeTriggers(s,frame,phase('TURN_START_WINDOW'),'After')[0];startResolution(s,'生产线','united_states',rule.effects,[]);answer(s);expect(s.decks.united_states.hand).toHaveLength(14);expect(s.resolution!.choice!.min).toBe(7);const ids=s.resolution!.choice!.options.slice(0,7).map(o=>o.id);answer(s,ids);finish(s);expect(s.decks.united_states.hand).toHaveLength(7);expect(s.decks.united_states.drawPile.slice(-7).map(c=>c.id)).toEqual(ids);
});
it.each(['drawPile','discardPile'] as const)('advanced technology plays a state from %s',zone=>{
 const s=game('united_states'),c=card('special_258'),status=card('special_87');s.decks.united_states.drawPile=[];s.decks.united_states[zone]=[status];s.decks.united_states.hand=[c];startResolution(s,'先进技术迭代','united_states',cardEffects(s,c),[],c.id);answer(s,[status.id]);finish(s);expect(s.decks.united_states.active.some(v=>v.id===status.id)).toBe(true);expect(s.decks.united_states[zone].some(v=>v.id===status.id)).toBe(false);
});
it('quick production has indexed score trigger and pays one top card before playing status',()=>{
 const s=game('united_states'),c=card('special_259'),status=card('special_87');s.phase='SCORE';s.decks.united_states.hand=[c,status];const n=s.decks.united_states.drawPile.length;startResolution(s,'计分','united_states',[phase('SCORE')],[]);answer(s,[s.resolution!.choice!.options.find(o=>o.label==='快速生产')!.id]);finish(s);expect(s.decks.united_states.active.some(v=>v.id===status.id)).toBe(true);expect(s.decks.united_states.drawPile).toHaveLength(n-1);
});
it('tank transport accepts all three pairs but never unrelated cards',()=>{
 const s=game(),r=fullTrigger(s,card('special_44'),{kind:'action',country:'soviet_union',action:'build_army',option:{regionId:'ukraine'} as any,label:'建设'},'After')!;
 for(const defs of [['build_army','build_army'],['land_battle','land_battle'],['land_battle','build_army']])expect(coversCost(defs.map((id,i)=>card(id,String(i))),r.costRequirements!)).toBe(true);expect(coversCost([card('air_power'),card('build_army')],r.costRequirements!)).toBe(false);
});
it('winter war, human wave, and forward force have actual new targets',()=>{
 const s=game();s.decks.soviet_union.faceDown=[card('prelude_SU-04'),card('prelude_SU-07')];const winter=preludeTriggers(s,frame,phase('SCORE'),'After')[0].effects.at(-1)!;expect(winter).toMatchObject({kind:'choose'});if(winter.kind==='choose'){expect(winter.options[0].effects[0]).toMatchObject({action:'build_army',regions:['scandinavia']});}if(winter.kind==='choose')expect(winter.options[1].effects[0]).toMatchObject({action:'recruit_army',regions:['scandinavia']});const wave=preludeTriggers(s,frame,{kind:'action',country:'soviet_union',action:'land_battle',option:{regionId:'ukraine'} as any,label:'陆战'},'After').find(r=>r.sourceInstanceId===card('prelude_SU-07').id)!;expect(wave.effects.at(-1)).toMatchObject({action:'land_battle'});s.activeSeat='united_states';s.decks.united_states.faceDown=[card('prelude_US-16')];expect(preludeTriggers(s,frame,phase('SCORE'),'After')[0].effects.at(-1)).toMatchObject({regions:['philippines','iwo_jima','indonesia']});
});

it.each([0,1,3])('forced prelude top discard spills %s available prelude cards into the regular deck',available=>{
 const s=game('japan');s.prelude!.active=true;const d=s.prelude!.decks.united_kingdom;d.drawPile=d.drawPile.slice(0,available);const regular=s.decks.united_kingdom.drawPile.slice(0,Math.max(0,2-available));const before=s.decks.united_kingdom.drawPile.length;
 startResolution(s,'天津事变','japan',historyEffects(s,card('prelude_JP-16')),[]);finish(s);
 expect(s.decks.united_kingdom.drawPile.length).toBe(before-Math.max(0,2-available));expect(regular.every(c=>s.decks.united_kingdom.discardPile.some(v=>v.id===c.id))).toBe(true);
 const notices=s.responseNotices!.filter(n=>n.recipients.includes('united_kingdom'));expect(notices).toHaveLength(1);expect(notices[0].cards).toHaveLength(2);
});
it('self prelude burns do not spill and an empty regular deck retains its usual shortfall penalty',()=>{
 const s=game('soviet_union');s.prelude!.active=true;s.prelude!.decks.soviet_union.drawPile=[];const n=s.decks.soviet_union.drawPile.length;
 startResolution(s,'自己弃牌','soviet_union',[{kind:'prelude',seat:'soviet_union',op:'discard',count:2,label:'自己弃牌'}],[]);finish(s);expect(s.decks.soviet_union.drawPile).toHaveLength(n);
 s.decks.soviet_union.drawPile=[];startResolution(s,'被弃牌','japan',[{kind:'prelude',seat:'soviet_union',op:'discard',count:2,label:'被弃牌'}],[]);finish(s);expect(s.scores.soviet_union).toBe(-2);
});

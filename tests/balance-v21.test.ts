import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {specialCard,regularCatalog} from '../src/core/cardCatalog';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {balanceEffect} from '../src/core/balanceEffects';
import {preludeTriggers} from '../src/core/preludeTriggers';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {cardEffects} from '../src/core/specialCards';
import {historyEffects} from '../src/core/prelude';
import {kamikazeEffects,statusActionEffects} from '../src/core/statusActions';
import {encyclopediaCards} from '../src/ui/CardEncyclopedia';
import {triggerCandidate} from '../src/core/triggerIndex';
import type {CardInstance,GameState,SeatId} from '../src/core/types';
import type {Effect,ResolutionFrame} from '../src/core/resolutionTypes';
const card=(id:string,suffix=''):CardInstance=>{const d=specialCard(id,true)!;return {id:id+suffix,definitionId:id,deckOwner:d.deckOwner,country:d.country,balance:true};};
function game(seat:SeatId='united_kingdom'){const s=createGame('v21',9,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.activeSeat=seat;s.phase='PLAY';for(const d of Object.values(s.decks)){d.hand=[];d.faceDown=[];d.active=[];d.drawPile=[];d.discardPile=[];}s.units=[];return s;}
function answer(s:GameState,ids:string[]){const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<80;i++){const q=s.resolution!.choice!;expect(q).toBeTruthy();answer(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
const frame={id:'test',currentEventId:'ev'} as ResolutionFrame;
it.each(['hand','drawPile'] as const)('French base chooses either state from %s and only hand adds troops',from=>{
 for(const id of ['special_5','special_9']){
 const s=game(),d=s.decks.united_kingdom;d[from]=[card('special_5'),card('special_9')];
 startResolution(s,'自由法国基地','united_kingdom',[balanceEffect('united_kingdom','exile-government')],[]);
 expect(s.resolution!.choice!.options).toHaveLength(2);answer(s,[id]);finish(s);
 expect(d.active.some(c=>c.definitionId===id)).toBe(true);
 expect(s.units.some(u=>u.country==='france'&&u.regionId===(id==='special_5'?'british_isles':'south_africa'))).toBe(from==='hand');
 }
});
it('industry triggers before Moscow army removal; installs capital and recruits before original removal resumes',()=>{
 const s=game('germany'),d=s.decks.soviet_union;d.faceDown=[card('prelude_SU-18')];d.hand=[{id:'fee',definitionId:'build_navy',deckOwner:'soviet_union',country:'soviet_union'},card('special_42')];
 const unit={id:'moscow-army',country:'soviet_union' as const,type:'army' as const,regionId:'moscow'};s.units=[unit];
 const e:Effect={kind:'remove',unit,supplied:true,cause:'card',label:'移除莫斯科陆军'};
 expect(triggerCandidate('prelude_SU-18',e,'Before')).toBe(true);expect(preludeTriggers(s,frame,e,'Before')).toHaveLength(1);expect(preludeTriggers(s,frame,e,'After')).toHaveLength(0);
 startResolution(s,'移除','germany',[e],[]);expect(s.units.some(u=>u.id===unit.id)).toBe(true);
 answer(s,[s.resolution!.choice!.options.find(o=>o.label==='战时工业东迁')!.id]);finish(s);
 expect(d.active.some(c=>c.definitionId==='special_42')).toBe(true);expect(s.units.some(u=>u.regionId==='siberia'&&u.country==='soviet_union')).toBe(true);expect(s.units.some(u=>u.id===unit.id)).toBe(false);
});
it('Z fleet covers South Pacific construction but not recruitment under balance rules',()=>{
 const s=game('japan');s.decks.united_kingdom.faceDown=[card('prelude_UK-01')];const u={id:'n',country:'japan' as const,type:'navy' as const,regionId:'sea_south_pacific'};s.units=[u];
 for(const action of ['build_navy','recruit_navy'] as const){const e:Effect={kind:'action',country:'japan',action,resultUnitId:'n',option:{regionId:u.regionId} as any,label:'海军'};expect(preludeTriggers(s,frame,e,'After').length).toBe(action==='build_navy'?1:0);}
});
it('southern resource enhancement comes from hand at turn start and not later',()=>{
 const s=game('japan'),c=card('special_191');s.decks.japan.hand=[c];expect(specialCard(c.definitionId,true)!.type).toBe('增强');
 for(const phase of ['PLAY','SUPPLY'])expect(fullTrigger(s,c,{kind:'signal',tag:'PHASE:'+phase,label:phase},'After')).toBeUndefined();
 startResolution(s,'回合开始','japan',[{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'回合开始'}],[]);
 answer(s,[s.resolution!.choice!.options.find(o=>o.label==='南方资源航线')!.id]);finish(s);
 expect(s.decks.japan.discardPile.some(v=>v.id===c.id)).toBe(true);expect(s.turnFlags!.supplyRegions).toContain('japan:sea_east_china');
});
it('kamikaze accepts unsupplied plane near USA, selects only navy',()=>{
 const s=game('japan');s.units=[{id:'plane',country:'japan',type:'air',regionId:'sea_east_pacific'},{id:'navy',country:'united_states',type:'navy',regionId:'sea_north_pacific'},{id:'army',country:'united_states',type:'army',regionId:'united_states'}];
 const e=kamikazeEffects(s,card('special_247'))[0];expect(e).toMatchObject({options:[{id:'plane',effects:[{supplied:false},{targetIds:['navy'],destroyTypes:['navy']}]}]});
});
it('new US event selects discarded status, leaves other deck order and RNG unchanged',()=>{
 const s=game('united_states'),d=s.decks.united_states,c=card('special_260');d.hand=[c];d.discardPile=[card('special_79')];d.drawPile=[card('special_91')];const before=JSON.stringify(d.drawPile),rng=s.randomState;
 expect(regularCatalog(true,true).some(c=>c.id==='special_260')).toBe(true);expect(regularCatalog(false,true).some(c=>c.id==='special_260')).toBe(false);
 startResolution(s,'生产管理部','united_states',cardEffects(s,c),[],c.id);answer(s,['special_79']);finish(s);
 expect(d.active.some(c=>c.definitionId==='special_79')).toBe(true);expect(JSON.stringify(d.drawPile)).toBe(before);expect(s.randomState).toEqual(rng);
});
it('remaining reduced effects and atlas are independent of hidden card zones',()=>{
 const s=game('japan');s.units=[{id:'a',country:'japan',type:'army',regionId:'siberia'}];expect(fullTrigger(s,card('special_172'),{kind:'signal',tag:'PHASE:SCORE',label:''},'After')!.effects).toMatchObject([{amount:1}]);
 expect(historyEffects(s,card('prelude_JP-15'))).toMatchObject([{regions:['sea_east_china']}]);expect(historyEffects(s,card('prelude_DE-18'))).toMatchObject([{count:2},{count:2},{count:2}]);
 s.activeSeat='united_states';s.decks.united_states.active=[card('special_91')];expect(statusActionEffects(s,card('special_91'))).toMatchObject([{regions:['western_china']}]);
 s.units=[{id:'a',country:'united_kingdom',type:'army',regionId:'southeast_asia'}];expect(fullTrigger(s,card('special_79'),{kind:'signal',tag:'PHASE:SCORE',label:''},'After')!.effects).toMatchObject([{amount:0}]);
 const cards=encyclopediaCards('united_states',true);expect(cards.some(c=>c.id==='special_260')).toBe(true);expect(cards.some(c=>c.country==='china')).toBe(true);expect(new Set(cards.map(c=>c.id)).size).toBe(cards.length);const noPrelude=encyclopediaCards('italy',true,false);expect(noPrelude.some(c=>c.id.startsWith('prelude_'))).toBe(false);expect(noPrelude.slice(0,5).map(c=>c.id)).toContain('sea_battle');expect(noPrelude.find(c=>c.id==='build_navy')!.count).toBe(5);expect(noPrelude.find(c=>c.id==='sea_battle')!.count).toBe(3);expect(cards[0].id.startsWith('prelude_')).toBe(true);
});

import {describe,it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {specialCard,regularCatalog} from '../src/core/cardCatalog';
import {historyEffects,persistentHistory,preludeCardEffects} from '../src/core/prelude';
import {cardEffects} from '../src/core/specialCards';
import {startResolution,resolveChoice,canExecuteEffects} from '../src/core/resolution';
import {adjacent,resetMapCache} from '../src/core/supply';
import {withinPrintedDistance} from '../src/core/map';
import {checkNeutralityTurn,isNeutral,endNeutrality} from '../src/core/neutrality';
import type {GameState,CardInstance} from '../src/core/types';
function game(prelude=true){const s=createGame('v166',17,'FULL',prelude,true,true);if(s.prelude)s.prelude.active=false;s.round=1;s.phase='TURN_START_WINDOW';s.activeSeat=s.viewSeat=s.operatorSeat='italy';s.redistributed=true;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0));d.active=[];d.faceDown=[];}s.neutrality=undefined;return s;}
function card(id:string):CardInstance{const d=specialCard(id,true)!;return {id:'test:'+id,definitionId:id,country:d.country,deckOwner:d.deckOwner,balance:true};}
function answer(s:GameState,ids:string[]){const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.choice&&i<80;i++){const q=s.resolution.choice;answer(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
function ambition(s:GameState){s.decks.italy.active.push(card('prelude_IT-15'));startResolution(s,'意大利回合开始','italy',[{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'回合开始'}],[]);}
describe('1.6.6 merged rules',()=>{
 it.each([false,true])('retires Vichy statuses and keeps dissolution event without neutrality=%s',neutrality=>{
  const s=createGame('catalog',1,'FULL',false,neutrality,true);const cards=Object.values(s.decks).flatMap(d=>Object.values(d).flat());
  expect(cards.some(c=>['special_250','special_251'].includes(c.definitionId))).toBe(false);
  expect(cards.some(c=>c.definitionId==='special_252')).toBe(false);expect(regularCatalog(true,neutrality).some(c=>c.id==='special_257')).toBe(true);
 });
 it('dissolution pays three Italian hand cards and recruits German armies in both regions',()=>{
  const s=game(),c=card('special_252'),d=s.decks.italy;s.units=[];d.hand.push(c,...d.drawPile.splice(0,3));const fees=d.hand.filter(v=>v.id!==c.id).map(v=>v.id);
  expect(canExecuteEffects({...s,decks:{...s.decks,italy:{...d,hand:d.hand.slice(0,2)}}},cardEffects(s,c))).toBe(false);
  startResolution(s,'德国解散维希法国','italy',cardEffects(s,c),[],c.id);answer(s,fees);finish(s);
  expect(s.units.filter(u=>u.country==='germany').map(u=>u.regionId).sort()).toEqual(['italy','western_europe']);expect(fees.every(id=>d.discardPile.some(c=>c.id===id))).toBe(true);
 });
 it.each(['north_africa','south_africa'])('Ethiopia armament destroys an allied army in %s',region=>{
  const s=game(),c=card('prelude_IT-12');s.decks.italy.faceDown.push(c);s.decks.italy.hand.push(s.decks.italy.drawPile.shift()!);s.units=[{id:'target',country:'united_kingdom',type:'army',regionId:region}];s.phase='SCORE';
  startResolution(s,'计分','italy',[{kind:'signal',tag:'PHASE:SCORE',label:'计分'}],[]);answer(s,[s.resolution!.choice!.options.find(o=>o.label==='入侵埃塞俄比亚')!.id]);finish(s);expect(s.units).toHaveLength(0);
 });
 it('Suez applies to both alliances, overrides control, and invalidates cached geography',()=>{
  const s=game();s.units=[{id:'uk',country:'united_kingdom',type:'army',regionId:'middle_east'}];resetMapCache();
  expect(adjacent(s,'united_kingdom','north_africa','middle_east')).toBe(true);expect(adjacent(s,'united_kingdom','sea_mediterranean','sea_arabian')).toBe(true);
  s.decks.italy.active.push(card('special_257'));
  for(const country of ['germany','italy','japan'] as const){expect(adjacent(s,country,'sea_mediterranean','sea_arabian')).toBe(true);expect(adjacent(s,country,'north_africa','middle_east')).toBe(true);}
  for(const country of ['united_kingdom','france','soviet_union','united_states','china'] as const){expect(adjacent(s,country,'sea_mediterranean','sea_arabian')).toBe(false);expect(adjacent(s,country,'north_africa','middle_east')).toBe(false);}
  expect(withinPrintedDistance('north_africa','middle_east',1)).toBe(true);expect(withinPrintedDistance('sea_mediterranean','sea_arabian',1)).toBe(true);
  s.decks.italy.active=[];expect(adjacent(s,'united_kingdom','sea_mediterranean','sea_arabian')).toBe(true);
 });
 it('Ambition installs as a zero-tension treaty, without changing the original-card option',()=>{
  const s=game();s.prelude!.active=true;const c=card('prelude_IT-15');expect(preludeCardEffects(s,c).zone).toBe('active');expect(historyEffects(s,c)).toEqual([{kind:'signal',tag:'INSTALL',label:'正面放置条约【意大利雄心】'}]);expect(persistentHistory(c.definitionId,true)).toBe(true);expect(persistentHistory(c.definitionId,false)).toBe(false);expect(specialCard('prelude_IT-16',true)!.tension).toBe(0);
 });
 it('Ambition plays the first eligible deck status without an extra card-selection prompt',()=>{
  const s=game(),d=s.decks.italy;d.drawPile=['special_215','special_210','special_211','special_257','special_214','special_213'].map(card);d.hand=[];ambition(s);
  expect(s.resolution!.choice!.seat).toBe('italy');answer(s,['deck']);expect(s.resolution?.choice).toBeFalsy();
  expect(d.active.some(c=>c.definitionId==='special_214')).toBe(true);expect(d.drawPile.some(c=>c.definitionId==='special_213')).toBe(true);expect(d.active.some(c=>c.definitionId==='prelude_IT-15')).toBe(false);
 });
 it('Ambition can choose a non-scoring status from hand',()=>{
  const s=game(),d=s.decks.italy;d.hand=[card('special_257')];ambition(s);answer(s,['hand']);answer(s,[d.hand[0].id]);finish(s);expect(d.active.some(c=>c.definitionId==='special_257')).toBe(true);
 });
 it('Ambition does nothing if the deck has no eligible status',()=>{
  const s=game(),d=s.decks.italy;d.hand=[];d.drawPile=['special_215','special_210','special_211','special_257'].map(card);ambition(s);answer(s,['deck']);finish(s);expect(d.active).toHaveLength(0);expect(d.drawPile).toHaveLength(4);
 });
 it.each([0,2])('Ambition does not trigger outside first formal round: %s',round=>{
  const s=game();s.round=round;s.prelude!.active=round===0;ambition(s);expect(s.resolution?.choice).toBeFalsy();expect(s.decks.italy.active.some(c=>c.definitionId==='prelude_IT-15')).toBe(true);
 });
 it.each([false,true])('neutrality cards are historical treaties without prelude, balance=%s',balance=>{
  const s=createGame('neutral',2,'FULL',false,true,balance);s.units=[];
  for(const seat of ['united_states','soviet_union'] as const){const c=s.decks[seat].active[0];expect(specialCard(c.definitionId,c.balance)!.type).toBe('历史');expect(persistentHistory(c.definitionId,!!c.balance)).toBe(true);}
  s.round=7;checkNeutralityTurn(s);expect(isNeutral(s,'united_states')).toBe(true);s.round=8;checkNeutralityTurn(s);expect(isNeutral(s,'united_states')).toBe(false);expect(s.scores.united_states).toBe(4);endNeutrality(s,'united_states','重复');expect(s.scores.united_states).toBe(4);expect(isNeutral(s,'soviet_union')).toBe(true);
 });
});

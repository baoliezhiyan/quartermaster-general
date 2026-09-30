import {discardPhase} from '../src/core/decks';
import {describe,it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {SEATS} from '../src/core/types';
import type {GameState,CardInstance} from '../src/core/types';
import {specialCard} from '../src/core/cardCatalog';
import {mayAttack,mayPlace,mayReallocate,isNeutral,occupiedNeutralitySupply,checkNeutralitySupply,checkNeutralityTurn,neutralityIndiaPenalty,endNeutrality} from '../src/core/neutrality';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {boardOptions} from '../src/core/boardEffects';
import {placementPlans} from '../src/core/placement';
import {airPowerOptions,battleOptions} from '../src/core/actions';
import {validateState,recoverRecord} from '../src/controller/saveFormat';
import {projectState} from '../src/network/project';
import {updateNeutralityInbox} from '../src/ui/NeutralityNotice';

const game=(prelude=false)=>createGame('neutrality',52,'FULL',prelude,true);
function move(s:GameState,id:string,zone:'hand'|'active'|'faceDown'){
 for(const owner of SEATS)for(const d of [s.decks[owner],s.prelude?.decks[owner]].filter(Boolean))for(const cards of Object.values(d!) as CardInstance[][]){const i=cards.findIndex(c=>c.definitionId===id);if(i>=0){const c=cards.splice(i,1)[0];s.decks[owner][zone].push(c);return c;}}
 throw Error(id);
}
function quiet(s:GameState){for(const seat of SEATS){const d=s.decks[seat];d.drawPile.push(...d.hand.splice(0),...d.faceDown.splice(0));}s.status='PLAYING';s.phase='PLAY';s.round=1;return s;}
function reply(s:GameState,ids:string[]){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<150;i++){const c=s.resolution.choice;expect(c).toBeTruthy();reply(s,c!.options.slice(0,c!.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
function advance(s:GameState){const result=transition(s,{type:'ADVANCE_PHASE',seat:s.activeSeat,expectedRevision:s.revision});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);return result.state;}

describe('v1.2 neutrality',()=>{
 it.each([[false,false],[false,true],[true,false],[true,true]])('independent rule switches: prelude=%s neutrality=%s',(prelude,neutrality)=>{
  const s=createGame('options',7,'FULL',prelude,neutrality);
  expect(s.rules).toEqual({preludeEnabled:prelude,neutralityEnabled:neutrality});
  expect(!!s.prelude?.active).toBe(prelude);expect(isNeutral(s,'united_states')).toBe(neutrality);
  expect(s.decks.soviet_union.hand).toHaveLength(12);expect(s.decks.united_states.hand).toHaveLength(12);
  expect(s.decks.soviet_union.active).toHaveLength(neutrality?1:0);
  expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
 });
 it('old saves and commands retain the original rules, and malformed flags are rejected',()=>{
  const old=createGame('old',4,'FULL');expect(old.rules).toBeUndefined();expect(old.neutrality).toBeUndefined();expect(()=>validateState(old)).not.toThrow();
  expect(transition(null,{type:'CREATE_GAME',gameId:'bad',seed:5,neutrality:'yes'} as never).ok).toBe(false);
  expect(specialCard('neutrality_soviet_union_status')?.name).toBe('混乱的政局');expect(specialCard('prelude_SU-02')?.name).toBe('大清洗');
 });
 it('restricts attacks by actual unit country, but allows direct destruction and economic warfare',()=>{
  const s=quiet(game());s.units=[{id:'su',country:'soviet_union',type:'army',regionId:'ukraine'},{id:'de',country:'germany',type:'army',regionId:'eastern_europe'},{id:'j',country:'japan',type:'army',regionId:'siberia'}];
  expect(mayAttack(s,'soviet_union','germany')).toBe(false);expect(mayAttack(s,'soviet_union','italy')).toBe(false);expect(mayAttack(s,'soviet_union','japan')).toBe(true);expect(mayAttack(s,'china','germany')).toBe(true);
  expect(battleOptions(s,'soviet_union','LAND').some(o=>o.defenderId==='de')).toBe(false);
  const e={kind:'action',country:'soviet_union',action:'destroy',regions:['eastern_europe'],label:'直接消灭'} as const;
  expect(boardOptions(s,{...e,regions:[...e.regions]})).toHaveLength(1);startResolution(s,'直接消灭','soviet_union',[{...e,regions:[...e.regions]}],[]);finish(s);expect(isNeutral(s,'soviet_union')).toBe(true);
  startResolution(s,'经济战','united_states',[{kind:'deckTop',seat:'germany',count:2,label:'经济战'}],[]);finish(s);expect(isNeutral(s,'united_states')).toBe(true);
 });
 it('blocks American construction, recruitment and air deployment, without affecting Chinese units',()=>{
  const s=game();for(const region of ['british_isles','moscow','ukraine','kazakhstan'])expect(mayPlace(s,'united_states',region)).toBe(false);
  expect(mayPlace(s,'china','ukraine')).toBe(true);
  expect(placementPlans(s,{country:'united_states',unitType:'army',mode:'recruit',regionIds:['british_isles','ukraine']})).toEqual([]);
  s.units.push({id:'usa-uk',country:'united_states',type:'army',regionId:'british_isles'});
  expect(airPowerOptions(s,'united_states').some(o=>o.mode==='deploy'&&o.regionId==='british_isles')).toBe(false);
  endNeutrality(s,'united_states','test');expect(mayPlace(s,'united_states','british_isles')).toBe(true);
 });
 it('deduplicates adjacent German/Italian units and checks USSR only at its turn start',()=>{
  const s=quiet(game(true));s.activeSeat='germany';s.units=[{id:'su',country:'soviet_union',type:'army',regionId:'ukraine'},{id:'d1',country:'germany',type:'army',regionId:'eastern_europe'},{id:'d2',country:'germany',type:'army',regionId:'balkans'},{id:'i',country:'italy',type:'army',regionId:'balkans'}];
  checkNeutralityTurn(s);expect(isNeutral(s,'soviet_union')).toBe(true);s.activeSeat='soviet_union';checkNeutralityTurn(s);expect(isNeutral(s,'soviet_union')).toBe(false);
  const t=quiet(game());t.activeSeat='soviet_union';t.units=s.units.filter(u=>u.id!=='i');t.units.push({id:'air',country:'italy',type:'air',regionId:'balkans'},{id:'su2',country:'soviet_union',type:'army',regionId:'moscow'});checkNeutralityTurn(t);expect(isNeutral(t,'soviet_union')).toBe(true);
 });
 it('counts distinct activated supply points and applies Polish Sovereignty immediately during resolution',()=>{
  const s=quiet(game());s.units=[{id:'w',country:'germany',type:'army',regionId:'western_europe'},{id:'u',country:'italy',type:'army',regionId:'ukraine'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'e2',country:'italy',type:'army',regionId:'eastern_europe'},{id:'h',country:'germany',type:'army',regionId:'germany'},{id:'fourth',country:'japan',type:'army',regionId:'india'}];
  expect(occupiedNeutralitySupply(s)).toHaveLength(3);checkNeutralitySupply(s);expect(isNeutral(s,'united_states')).toBe(true);
  const card=move(s,'special_7','hand');startResolution(s,'波兰主权','united_kingdom',[{kind:'signal',tag:'INSTALL',label:'部署状态'},{kind:'choose',seat:'united_kingdom',min:1,max:1,label:'后续暂停',options:[{id:'ok',label:'ok',effects:[{kind:'trace',label:'继续'}]}]}],[],card.id,'active');
  expect(s.resolution?.choice?.kind).toBe('SELECT');expect(isNeutral(s,'united_states')).toBe(false);expect(s.scores.united_states).toBe(4);finish(s);
  checkNeutralitySupply(s);expect(s.scores.united_states).toBe(4);s.units=[];checkNeutralitySupply(s);expect(isNeutral(s,'united_states')).toBe(false);
 });
 it('does not count a supply status merely being played when its install is cancelled',()=>{
  const s=quiet(game());s.units=[{id:'w',country:'germany',type:'army',regionId:'western_europe'},{id:'u',country:'italy',type:'army',regionId:'ukraine'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'}];const card=move(s,'special_7','hand');
  startResolution(s,'波兰主权','united_kingdom',[{kind:'signal',tag:'INSTALL',label:'install'}],[{id:'cancel',label:'取消部署',sourceInstanceId:'test',owner:'germany',source:'system',mandatory:true,timing:'Before',on:'install',effects:[{kind:'frameChange',frameId:'frame:1',cancel:true,finalZone:'discardPile',label:'取消'}]}],card.id,'active');finish(s);expect(isNeutral(s,'united_states')).toBe(true);
 });
 it('ends USA neutrality at formal round 8 before Germany acts, never during prelude',()=>{
  let s=quiet(game());s.round=7;s.activeSeat=s.operatorSeat='united_states';s.phase='DRAW';s=advance(s);expect(s.round).toBe(8);expect(s.activeSeat).toBe('germany');expect(isNeutral(s,'united_states')).toBe(false);expect(s.scores.united_states).toBe(4);
  const p=game(true);p.prelude!.turn=100;checkNeutralityTurn(p);expect(isNeutral(p,'united_states')).toBe(true);
 });
 it('charges Britain once per Soviet army/navy near India and skips the entire penalty with occupied HQ',()=>{
  let s=quiet(game());s.units.push({id:'su-i',country:'soviet_union',type:'army',regionId:'india'},{id:'su-n',country:'soviet_union',type:'navy',regionId:'sea_arabian'},{id:'su-air',country:'soviet_union',type:'air',regionId:'india'},{id:'cn',country:'china',type:'army',regionId:'india'});expect(neutralityIndiaPenalty(s)).toBe(2);
  s.activeSeat=s.operatorSeat='united_kingdom';s.phase='SUPPLY';s=advance(s);expect(s.publicLog?.some(e=>e.text.includes('英国扣 2 分'))).toBe(true);expect(s.scores.soviet_union).toBe(0);
  let t=quiet(game());t.units=t.units.filter(u=>u.regionId!=='british_isles');t.units.push({id:'de-uk',country:'germany',type:'army',regionId:'british_isles'},{id:'su-i',country:'soviet_union',type:'army',regionId:'india'});t.activeSeat=t.operatorSeat='united_kingdom';t.phase='SUPPLY';t=advance(t);expect(t.phase).toBe('DISCARD');expect(t.scores.united_kingdom).toBe(0);
 });
 it('prevents reallocation and removes the prohibition permanently on Soviet entry',()=>{
  const s=quiet(game());expect(mayReallocate(s,'soviet_union')).toBe(false);expect(startResolution(s,'非法资源重整','soviet_union',[{kind:'reallocate',seat:'soviet_union',label:'资源重整'}],[])).toBe(false);
  endNeutrality(s,'soviet_union','test');expect(mayReallocate(s,'soviet_union')).toBe(true);expect(endNeutrality(s,'soviet_union','again')).toBe(false);expect(s.neutralityNotices).toHaveLength(1);
 });
 it.each([true,false])('resolves Soviet entry status (play=%s) before resuming the original attack',play=>{
  const s=quiet(game());s.units.push({id:'de-e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'su-u',country:'soviet_union',type:'army',regionId:'ukraine'});
  const status=move(s,'special_47','hand'),option=battleOptions(s,'germany','LAND').find(o=>o.defenderId==='su-u')!;expect(option).toBeTruthy();
  startResolution(s,'攻击苏联','germany',[{kind:'action',country:'germany',action:'land_battle',option,label:'攻击苏联'}],[]);
  expect(isNeutral(s,'soviet_union')).toBe(false);expect(s.resolution?.choice?.kind).toBe('EXTRA_CARD');expect(s.resolution?.choice?.seat).toBe('soviet_union');expect(s.units.some(u=>u.id==='su-u')).toBe(true);
  reply(s,play?[status.id]:[]);finish(s);
  expect(s.units.some(u=>u.id==='su-u')).toBe(false);expect(s.decks.soviet_union.active.some(c=>c.id===status.id)).toBe(play);expect(s.operatorSeat).toBe('germany');expect(s.neutralityNotices).toHaveLength(1);expect(()=>validateState(s)).not.toThrow();
 });
 it('a cancelled German armament does not end Soviet neutrality',()=>{
  const s=quiet(game(true));s.prelude!.active=false;s.phase='SCORE';s.units.push({id:'de-e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'su-u',country:'soviet_union',type:'army',regionId:'ukraine'});
  move(s,'prelude_DE-11','faceDown');move(s,'prelude_UK-04','faceDown');move(s,'build_army','hand');
  // Give Britain one ordinary card to cover its armament fee.
  const uk=s.decks.united_kingdom;uk.hand.push(uk.drawPile.shift()!);
  startResolution(s,'计分开始','germany',[{kind:'signal',tag:'PHASE:SCORE',label:'计分开始'}],[]);
  let c=s.resolution!.choice!;reply(s,[c.options.find(o=>o.label.includes('坦克'))!.id]);
  for(let i=0;i<8&&s.resolution?.choice?.seat!=='united_kingdom';i++){c=s.resolution!.choice!;reply(s,c.options.slice(0,c.min).map(o=>o.id));}
  c=s.resolution!.choice!;expect(c.seat).toBe('united_kingdom');reply(s,[c.options.find(o=>o.label.includes('秘密情报'))!.id]);finish(s);
  expect(isNeutral(s,'soviet_union')).toBe(true);expect(s.neutralityNotices).toHaveLength(0);expect(s.units.some(u=>u.id==='su-u')).toBe(true);
 });
 it('effective attacks end neutrality even when damage is prevented; air superiority counts too',()=>{
  const s=quiet(game());s.units.push({id:'de-e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'su-u',country:'soviet_union',type:'army',regionId:'ukraine'});
  s.turnFlags={protected:['su-u'],battleProtected:[],supplied:[],supplyCountries:[],supplyRegions:[],suppressed:[],noAirDefense:false};
  const option=battleOptions(s,'germany','LAND').find(o=>o.defenderId==='su-u')!;startResolution(s,'受保护的苏联陆军','germany',[{kind:'action',country:'germany',action:'land_battle',option,label:'攻击'}],[]);finish(s);expect(isNeutral(s,'soviet_union')).toBe(false);expect(s.units.some(u=>u.id==='su-u')).toBe(true);
  const t=quiet(game());t.units.push({id:'ja-air',country:'japan',type:'air',regionId:'sea_north_pacific'},{id:'us-air',country:'united_states',type:'air',regionId:'hawaii'});const air=airPowerOptions(t,'japan').find(o=>o.defenderId==='us-air')!;expect(air).toBeTruthy();
  startResolution(t,'夺取制空权','japan',[{kind:'action',country:'japan',action:'air_power',option:air,label:'夺取制空权'}],[]);finish(t);expect(isNeutral(t,'united_states')).toBe(false);expect(t.scores.united_states).toBe(4);
 });
 it('all observers receive public entry information without private hands, and notices never write to game state',()=>{
  const s=game();let inbox=updateNeutralityInbox(undefined,[]);endNeutrality(s,'united_states','test');
  const publicView=projectState(s,{kind:'public'},'germany')!;expect(publicView.neutralityNotices).toHaveLength(1);expect(publicView.decks.united_states.hand.every(c=>c.definitionId==='hidden')).toBe(true);
  inbox=updateNeutralityInbox(inbox,publicView.neutralityNotices!);expect(inbox.pending).toHaveLength(1);expect(updateNeutralityInbox(inbox,publicView.neutralityNotices!).pending).toHaveLength(1);
  expect(updateNeutralityInbox(undefined,publicView.neutralityNotices!).pending).toEqual([]);
 });
 it('preserves rule state, cards and one-time rewards in saves and recovery records',()=>{
  const s=game(true);endNeutrality(s,'united_states','test');expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
  const recovered=recoverRecord({initial:s,fromCreation:false,steps:[]});checkNeutralitySupply(recovered);expect(recovered.scores.united_states).toBe(4);expect(recovered.neutrality).toEqual(s.neutrality);
  const broken=structuredClone(s);broken.neutralityNotices!.push({...broken.neutralityNotices![0]});expect(()=>validateState(broken)).toThrow();
 });
});

it('merged neutrality deadlines and zero-discard cost',()=>{
 for(const balance of [false,true]){
  const s=createGame('experimental',52,'FULL',false,true,balance);s.units=[];s.round=7;checkNeutralityTurn(s);expect(isNeutral(s,'united_states')).toBe(true);
  discardPhase(s,'united_states',[]);expect(s.scores.united_states).toBe(-1);
  discardPhase(s,'soviet_union',[]);expect(s.scores.soviet_union).toBe(0);
  s.round=8;checkNeutralityTurn(s);expect(isNeutral(s,'united_states')).toBe(false);const score=s.scores.united_states;discardPhase(s,'united_states',[]);expect(s.scores.united_states).toBe(score);
  s.round=11;checkNeutralityTurn(s);expect(isNeutral(s,'soviet_union')).toBe(true);
  s.round=12;checkNeutralityTurn(s);expect(isNeutral(s,'soviet_union')).toBe(false);expect(s.neutralityStatusPending).toBe(true);
 }
});

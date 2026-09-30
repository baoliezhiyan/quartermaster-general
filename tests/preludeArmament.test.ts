import {describe,it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {copiedStatusRules} from '../src/core/copiedStatus';
import {specialCard,PRELUDE_CARDS} from '../src/core/cardCatalog';
import {SEATS} from '../src/core/types';
import type {GameState,CardInstance} from '../src/core/types';
import type {Effect,ResolutionFrame} from '../src/core/resolutionTypes';
import {validateState} from '../src/controller/saveFormat';
import {preludeTriggers} from '../src/core/preludeTriggers';

function game(balance=false){const s=createGame('armament',19,'FULL',true,false,balance);s.prelude!.active=false;s.phase='PLAY';s.round=1;return s;}
function move(s:GameState,id:string,zone:'faceDown'|'hand'|'discardPile'|'active'){
 for(const seat of SEATS)for(const d of [s.decks[seat],s.prelude!.decks[seat]])for(const z of Object.keys(d)){
  const cards=(d as unknown as Record<string,CardInstance[]>)[z];const i=cards.findIndex(c=>c.definitionId===id);if(i>=0){const card=cards.splice(i,1)[0];s.decks[seat][zone].push(card);return card;}
 }throw Error(id);
}
function reply(s:GameState,ids:string[]){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);}
function use(s:GameState,name:string){const c=s.resolution!.choice!;expect(c.kind).toBe('TRIGGER');const o=c.options.find(o=>o.label.includes(name));expect(o,JSON.stringify(c)).toBeDefined();reply(s,[o!.id]);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<150;i++){const c=s.resolution.choice!;expect(c).toBeTruthy();reply(s,c.options.slice(0,c.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
const frame=(e:Effect):ResolutionFrame=>({id:'frame',owner:'germany',source:'test',effects:[e],nextEffectIndex:0,stage:'After',status:'RUNNING',parentEventId:null,ancestorIds:[],sourceAncestors:[],currentEventId:'event',finalZone:'discardPile'});
describe('armament and persistent history',()=>{
 it.each([false,true])('new local game retains score armament through prelude and opening selection (balance %s)',balance=>{
  let s=createGame('fresh-armaments',19,'FULL',true,false,balance);
  const send=(command:Record<string,unknown>)=>{const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...command} as Parameters<typeof transition>[1]);expect(r.ok,JSON.stringify(r)).toBe(true);if(r.ok)s=r.state;};
  for(const seat of SEATS){
   const d=s.prelude!.decks[seat],id=seat==='germany'?'prelude_DE-11':PRELUDE_CARDS.find(c=>c.deckOwner===seat&&c.type==='军备')!.id;
   for(const zone of ['drawPile','discardPile'] as const){const i=d[zone].findIndex(c=>c.definitionId===id);if(i>=0)d.hand.push(...d[zone].splice(i,1));}
   if(seat==='united_states')s.prelude!.tension=10;
   send({type:'PLAY_PRELUDE',cardId:d.hand.find(c=>c.definitionId===id)!.id});
  }
  expect(s.prelude!.active).toBe(false);expect(s.status).toBe('SETUP');
  for(const seat of SEATS)send({type:'KEEP_OPENING',seat,cardIds:s.decks[seat].hand.filter(c=>c.definitionId!=='air_power').slice(0,7).map(c=>c.id)});
  for(let i=0;i<10&&s.phase!=='SCORE';i++){
   const c=s.resolution?.choice;
   if(c)send({type:'RESOLVE_ENGINE_CHOICE',choiceId:c.id,ids:[]});else send({type:'ADVANCE_PHASE'});
  }
  expect(s.phase).toBe('SCORE');expect(s.resolution?.choice?.options.some(o=>o.label.includes('坦克'))).toBe(true);
 });
 it('cannot activate military during prelude, but can set it without a hand fee',()=>{
  let s=createGame('setting',2,'FULL',true);const c=move(s,'prelude_DE-04','hand');s.decks.germany.hand=s.decks.germany.hand.filter(v=>v.id!==c.id);s.prelude!.decks.germany.hand.push(c);const count=s.decks.germany.hand.length;
  const r=transition(s,{type:'PLAY_PRELUDE',seat:'germany',expectedRevision:0,cardId:c.id});expect(r.ok).toBe(true);if(r.ok)s=r.state;
  expect(s.decks.germany.faceDown.some(v=>v.id===c.id)).toBe(true);expect(s.decks.germany.hand).toHaveLength(count);
  const e:Effect={kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'start'};expect(preludeTriggers(s,frame(e),e,'After')).toEqual([]);
 });
 it('pays one card and grants the independent bombing score without Atlantic units',()=>{
  const s=game();const c=move(s,'prelude_DE-04','faceDown'),before=s.decks.germany.hand.length;
  startResolution(s,'start','germany',[{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'start'}],[]);use(s,'轰炸纽约');expect(s.resolution!.choice!.kind).toBe('CARDS');reply(s,[s.resolution!.choice!.options[0].id]);finish(s);
  expect(s.scores.germany).toBe(3);expect(s.decks.germany.hand).toHaveLength(before-1);expect(s.decks.germany.removed).toContainEqual(c);expect(()=>validateState(s)).not.toThrow();
 });
 it.each([false,true])('Panzergrenadiers offers construction immediately after an actual land battle (balance %s)',balance=>{
  const s=createGame('panzergrenadiers',19,'FULL',true,false,balance);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';s.round=1;s.setupCompleted=[...SEATS];
  const card=move(s,'prelude_DE-12','faceDown');
  startResolution(s,'陆战','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['western_europe'],label:'攻击西欧'}],[]);
  expect(s.resolution!.choice!.kind).toBe('ACTION');reply(s,[s.resolution!.choice!.options[0].id]);
  use(s,'装甲掷弹兵');expect(s.resolution!.choice!.kind).toBe('CARDS');reply(s,[s.resolution!.choice!.options[0].id]);
  finish(s);expect(s.decks.germany.removed).toContainEqual(card);
  expect(s.units.some(u=>u.country==='germany'&&u.type==='army'&&u.regionId==='western_europe')).toBe(true);
 });
 it('Secret Intelligence cancels before either of the target costs, consumes its own fee',()=>{
  const s=game();const c=move(s,'prelude_DE-04','faceDown');move(s,'prelude_UK-04','faceDown');const de=s.decks.germany.hand.length,uk=s.decks.united_kingdom.hand.length;
  startResolution(s,'start','germany',[{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'start'}],[]);use(s,'轰炸纽约');use(s,'秘密情报机构');reply(s,[s.resolution!.choice!.options[0].id]);finish(s);
  expect(s.scores.germany).toBe(0);expect(s.decks.germany.hand).toHaveLength(de);expect(s.decks.united_kingdom.hand).toHaveLength(uk-1);expect(s.decks.germany.removed).toContainEqual(c);expect(()=>validateState(s)).not.toThrow();
 });
 it('Sterling Area requires two distinct cards including Construction Army',()=>{
  const s=game();s.activeSeat=s.operatorSeat=s.viewSeat='united_kingdom';move(s,'prelude_UK-06','faceDown');{const d=s.decks.united_kingdom;const i=d.drawPile.findIndex(c=>c.definitionId==='build_army');if(i>=0)d.hand.push(...d.drawPile.splice(i,1));}
  startResolution(s,'score','united_kingdom',[{kind:'signal',tag:'PHASE:SCORE',label:'score'}],[]);use(s,'英镑区');const c=s.resolution!.choice!,deck=s.decks.united_kingdom;
  const wrong=c.options.filter(o=>deck.hand.find(v=>v.id===o.id)?.definitionId!=='build_army').slice(0,2).map(o=>o.id);expect(resolveChoice(s,c.seat,c.id,wrong)).toBe(false);
  const army=c.options.find(o=>deck.hand.find(v=>v.id===o.id)?.definitionId==='build_army')!;reply(s,[army.id,c.options.find(o=>o.id!==army.id)!.id]);finish(s);expect(()=>validateState(s)).not.toThrow();
 });
 it('Substitute Material can discard a status for its fee and copy it at the original scoring window',()=>{
  const s=game();move(s,'prelude_DE-09','faceDown');const status=move(s,'special_139','hand');s.units.push({id:'ukraine-test',country:'germany',type:'army',regionId:'ukraine'});
  startResolution(s,'score','germany',[{kind:'signal',tag:'PHASE:SCORE',label:'score'}],[]);use(s,'替代物资');reply(s,[status.id]);expect(s.resolution!.choice!.kind).toBe('SELECT');reply(s,[status.id]);finish(s);
  expect(s.scores.germany).toBe(1);expect(s.decks.germany.discardPile).toContainEqual(status);expect(s.decks.germany.active).not.toContainEqual(status);expect(s.resolution!.frames.find(f=>f.cardId===status.id)!.effects.some(e=>e.kind==='signal'&&e.tag==='CARD_EFFECT_DONE')).toBe(false);expect(()=>validateState(s)).not.toThrow();
 });
 it('Substitute Material retains physical status once-per-turn use and Hobart suppression',()=>{
  const s=game(),card=move(s,'special_129','discardPile');const e:Effect={kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'start'},f=frame(e);
  expect(copiedStatusRules(s,f,e,'After').some(r=>r.sourceInstanceId===card.id)).toBe(true);
  startResolution(s,'empty','germany',[{kind:'trace',label:'empty'}],[]);s.resolution!.turnUses[`1:germany:${card.id}:special_129`]=1;expect(copiedStatusRules(s,f,e,'After').some(r=>r.sourceInstanceId===card.id)).toBe(false);
  s.resolution!.turnUses={};s.turnFlags={protected:[],battleProtected:[],supplied:[],supplyCountries:[],supplyRegions:[],suppressed:[card.id],noAirDefense:false};expect(copiedStatusRules(s,f,e,'After').some(r=>r.sourceInstanceId===card.id)).toBe(false);
 });
 it('all military cards can be set and round-trip through saves without entering normal decks',()=>{
  const s=game();for(const d of PRELUDE_CARDS.filter(c=>c.type==='军备'))move(s,d.id,'faceDown');expect(SEATS.reduce((n,v)=>n+s.decks[v].faceDown.filter(c=>specialCard(c.definitionId)?.type==='军备').length,0)).toBe(51);expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
 });
});

it.each(['闪电战','装甲掷弹兵'])('Dunkirk evacuation retains the land battle and allows %s',followup=>{
 const s=createGame('dunkirk-after',19,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.round=1;s.settings.ignoreOtherPlayerInterrupts=false;
 for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}
 move(s,'special_254','hand');move(s,'special_136','active');move(s,'prelude_DE-12','faceDown');
 s.decks.united_kingdom.hand.push(...s.decks.united_kingdom.drawPile.splice(0,3));s.decks.germany.hand.push(...s.decks.germany.drawPile.splice(0,2));
 s.units=[{id:'de',country:'germany',type:'army',regionId:'germany'},{id:'fr',country:'france',type:'army',regionId:'western_europe'}];
 startResolution(s,'西欧陆战','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['western_europe'],label:'攻击西欧'}],[]);
 reply(s,[s.resolution!.choice!.options[0].id]);use(s,'敦刻尔克');
 if(s.resolution!.choice?.kind==='EFFECTS')reply(s,s.resolution!.choice!.options.slice(0,s.resolution!.choice!.max).map(o=>o.id));
 expect(s.resolution!.choice!.kind).toBe('PAY_COST');reply(s,s.resolution!.choice!.options.slice(0,1).map(o=>o.id));
 for(let i=0;i<10&&s.resolution!.choice?.kind==='ACTION';i++)reply(s,[s.resolution!.choice!.options[0].id]);
 expect(s.units.some(u=>u.country==='france'&&u.regionId==='british_isles')).toBe(true);
 expect(s.resolution!.events.some(e=>e.applied&&e.effect?.kind==='action'&&e.effect.action==='land_battle'&&e.effect.option?.regionId==='western_europe')).toBe(true);
 use(s,followup);if(s.resolution!.choice?.kind==='CARDS')reply(s,[s.resolution!.choice!.options[0].id]);finish(s);
 expect(s.units.some(u=>u.country==='germany'&&u.regionId==='western_europe')).toBe(true);
});

it.each(['cancel','remove-attacker'])('evacuation never revives a battle after %s',mode=>{
 const s=createGame('invalid-evacuation',19,'FULL',true,false,true);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';s.round=1;
 s.units=[{id:'de',country:'germany',type:'army',regionId:'germany'},{id:'fr',country:'france',type:'army',regionId:'western_europe'}];
 const effects:Effect[]=[{kind:'remove',unit:{...s.units[1]},supplied:true,cause:'card',label:'撤离'}];
 effects.push(mode==='cancel'?{kind:'cancel',label:'取消攻击'}:{kind:'remove',unit:{...s.units[0]},supplied:true,cause:'card',label:'移除进攻者'});
 startResolution(s,'attack','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['western_europe'],label:'attack'}],[{id:'withdraw',label:'撤离并干预',sourceInstanceId:'system',owner:'united_kingdom',timing:'Before',on:'attack',mandatory:true,source:'system',effects}]);finish(s);
 const battle=s.resolution!.events.find(e=>e.effect?.kind==='action'&&e.effect.action==='land_battle')!;
 expect(battle.applied).toBe(false);expect(battle.outcome).toBe(mode==='cancel'?'cancelled':'invalid');
});

it.each([['build_army',3,true],['recruit_army',3,false],['recruit_army',2,false]] as const)('experimental Stonne %s with %s hand cards (pay %s)',(action,count,pay)=>{
 const s=game(true);s.status='PLAYING';s.activeSeat='germany';s.units=[{id:'home',country:'germany',type:'army',regionId:'germany'}];
 for(const seat of SEATS){s.decks[seat].hand=[];s.decks[seat].active=[];s.decks[seat].faceDown=[];}
 const arm=move(s,'prelude_UK-02','faceDown');s.prelude!.installedEvent??={};s.prelude!.installedEvent[arm.id]=s.events.length;
 s.decks.united_kingdom.hand=[{id:'fee',definitionId:'land_battle',country:'united_kingdom',deckOwner:'united_kingdom'}];
 s.decks.germany.hand=Array.from({length:count},(_,i)=>({id:'g'+i,definitionId:'build_navy',country:'germany',deckOwner:'germany'}));
 startResolution(s,'建设','germany',[{kind:'action',country:'germany',action,regions:['western_europe'],label:'建设西欧'}],[]);
 while(s.resolution!.choice?.kind!=='TRIGGER'){const q=s.resolution!.choice!;reply(s,[q.options[0].id]);}
 use(s,'斯通尼');expect(s.resolution!.choice!.kind).toBe('CARDS');reply(s,['fee']);
 expect(s.resolution!.choice).toMatchObject({kind:'SELECT',seat:'germany'});
 expect(s.resolution!.choice!.options.some(o=>o.id==='pay')).toBe(count>=3);reply(s,[pay?'pay':'destroy']);
 if(pay)reply(s,s.decks.germany.hand.map(c=>c.id));finish(s);
 expect(s.units.some(u=>u.regionId==='western_europe')).toBe(pay);expect(s.decks.germany.hand).toHaveLength(pay?0:count);expect(s.decks.united_kingdom.removed.some(c=>c.id===arm.id)).toBe(true);
});
it('experimental Stonne can trigger on a second placement after declining the first',()=>{
 const s=game(true);s.status='PLAYING';s.activeSeat='germany';s.units=[{id:'home',country:'germany',type:'army',regionId:'germany'}];const arm=move(s,'prelude_UK-02','faceDown');
 s.prelude!.installedEvent??={};s.prelude!.installedEvent[arm.id]=s.events.length;
 s.decks.united_kingdom.hand.push({id:'fee',definitionId:'land_battle',country:'united_kingdom',deckOwner:'united_kingdom'});
 const action:Effect={kind:'action',country:'germany',action:'recruit_army',regions:['western_europe'],label:'征召西欧'};
 startResolution(s,'第一次','germany',[action],[]);while(s.resolution!.choice?.kind!=='TRIGGER'){reply(s,[s.resolution!.choice!.options[0].id]);}reply(s,[]);finish(s);
 s.units=s.units.filter(u=>u.regionId!=='western_europe');startResolution(s,'第二次','germany',[action],[]);const current=()=>s.resolution!.choice;while(current()?.kind==='ACTION')reply(s,[current()!.options[0].id]);
 expect(s.resolution!.choice?.options.some(o=>o.label.includes('斯通尼'))??false).toBe(true);finish(s);
});

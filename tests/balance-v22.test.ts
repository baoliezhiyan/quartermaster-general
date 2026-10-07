import {it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {specialCard} from '../src/core/cardCatalog';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {balanceEffect} from '../src/core/balanceEffects';
import {cardEffects} from '../src/core/specialCards';
import {preludeTriggers} from '../src/core/preludeTriggers';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {triggerCandidate} from '../src/core/triggerIndex';
import {validateState} from '../src/controller/saveFormat';
import {SEATS} from '../src/core/types';
import {projectState} from '../src/network/project';
import {numberedCatalog} from '../src/ui/cardNumbers';
import {resolutionTargets} from '../src/ui/map/targetChoices';
import type {CardInstance,GameState,SeatId} from '../src/core/types';
import type {Effect,ResolutionFrame} from '../src/core/resolutionTypes';
const card=(id:string,seat:SeatId='soviet_union',suffix=''):CardInstance=>({id:id+suffix,definitionId:id,deckOwner:seat,country:seat,balance:true});
function game(seat:SeatId='soviet_union',balance=true){const s=createGame('v22',9,'FULL',true,false,balance);s.prelude!.active=false;s.status='PLAYING';s.activeSeat=s.viewSeat=seat;s.phase='PLAY';for(const d of Object.values(s.decks))for(const key of ['hand','active','faceDown','drawPile','discardPile'] as const)d[key]=[];s.units=[];return s;}
function answer(s:GameState,ids:string[],guided=false){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,ids,guided)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<120;i++){const q=s.resolution!.choice!;expect(q).toBeTruthy();answer(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
it.each([0,1,3,5])('88mm forces three discards with %i hand cards, then battle removes defender',count=>{
 const s=game('soviet_union'),d=s.decks.soviet_union;
 d.hand=Array.from({length:count},(_,i)=>card('build_army','soviet_union',String(i)));d.drawPile=Array.from({length:5},(_,i)=>card('build_navy','soviet_union',String(i)));
 s.units=[{id:'su',country:'soviet_union',type:'army',regionId:'moscow'},{id:'de',country:'germany',type:'army',regionId:'ross_region'}];
 s.decks.germany.faceDown=[card('prelude_DE-01','germany')];s.decks.germany.hand=[card('build_army','germany','fee')];
 startResolution(s,'attack','soviet_union',[{kind:'action',country:'soviet_union',action:'land_battle',regions:['ross_region'],label:'陆战'}],[]);
 let fired=false;
 for(let i=0;s.resolution?.running&&i<60;i++){const q=s.resolution!.choice!;if(q.kind==='TRIGGER'){const option=q.options.find(o=>o.label.includes('88毫米'));if(option){answer(s,[option.id]);fired=true;}else answer(s,[]);}else answer(s,q.options.slice(0,q.min).map(o=>o.id));}
 expect(fired).toBe(true);expect(d.hand.length).toBe(Math.max(0,count-3));expect(d.drawPile.length).toBe(5-Math.max(0,3-count));expect(d.discardPile.length).toBe(3);expect(s.units.some(u=>u.id==='de')).toBe(false);
});
it('Z fleet excludes South Pacific and recruitment',()=>{
 const s=game('japan');s.decks.united_kingdom.faceDown=[card('prelude_UK-01','united_kingdom')];
 for(const region of ['sea_south_china','sea_arabian','sea_south_pacific'])for(const action of ['build_navy','recruit_navy'] as const){s.units=[{id:'n',country:'japan',type:'navy',regionId:region}];const e:Effect={kind:'action',country:'japan',action,resultUnitId:'n',option:{regionId:region} as any,label:'海军'};expect(preludeTriggers(s,{id:'f',currentEventId:'e'} as ResolutionFrame,e,'After').length).toBe(action==='build_navy'&&region!=='sea_south_pacific'?1:0);}
});
it.each([false,true])('Soviet reveal commits source, decline shuffles without playing (guided=%s)',guided=>{
 const s=game(),d=s.decks.soviet_union;d.hand=[card('special_50')];d.drawPile=[card('build_army'),card('special_44'),card('special_42'),card('build_navy')];const before=s.randomState;
 s.neutralityStatusPending=true;startResolution(s,'neutrality','soviet_union',[{kind:'trace',label:'end'}],[],undefined,'discardPile',guided);
 expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual(['hand','deck']);answer(s,['deck'],guided);
 const q=s.resolution!.choice!;expect(q.kind).toBe('EXTRA_CARD');expect(q.options.map(o=>o.id)).toEqual(['special_44']);expect(resolveChoice(s,q.seat,q.id,['special_50'],guided)).toBe(false);
 answer(s,[],guided);finish(s);expect(d.hand.map(c=>c.id)).toEqual(['special_50']);expect(d.active).toEqual([]);expect(d.drawPile.map(c=>c.id).sort()).toEqual(['build_army','build_navy','special_42','special_44'].sort());expect(s.randomState).not.toEqual(before);
});
it('Soviet revealed state plays without shuffling; hand alternative never touches deck',()=>{
 for(const source of ['deck','hand']){const s=game(),d=s.decks.soviet_union;d.hand=[card('special_50')];d.drawPile=[card('build_army'),card('special_44'),card('special_42')];const before=s.randomState;
 startResolution(s,'neutrality','soviet_union',[balanceEffect('soviet_union','soviet-neutrality')],[]);answer(s,[source]);answer(s,[source==='deck'?'special_44':'special_50']);finish(s);
 expect(d.active.map(c=>c.id)).toContain(source==='deck'?'special_44':'special_50');expect(d.drawPile.map(c=>c.id)).toEqual(source==='deck'?['build_army','special_42']:['build_army','special_44','special_42']);expect(s.randomState).toEqual(before);}
});
it('Soviet standard mode remains hand-only; empty balanced deck offers no reveal',()=>{
 const s=game('soviet_union',false);s.decks.soviet_union.hand=[card('special_50')];s.decks.soviet_union.drawPile=[card('special_44')];s.neutralityStatusPending=true;startResolution(s,'end','soviet_union',[{kind:'trace',label:'end'}],[]);expect(s.resolution!.choice!.kind).toBe('EXTRA_CARD');expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual(['special_50']);
 const b=game();b.decks.soviet_union.hand=[card('special_50')];startResolution(b,'end','soviet_union',[balanceEffect('soviet_union','soviet-neutrality')],[]);expect(b.resolution!.choice!.options.map(o=>o.id)).toEqual(['hand']);
});
it.each(['drawPile','discardPile'] as const)('advanced technology triggers at PLAY and takes state from %s without installing',from=>{
 const s=game('united_states'),d=s.decks.united_states,c=card('special_258','united_states');d.hand=[c];d.drawPile=[card('build_army','united_states'),card('build_navy','united_states'),card('land_battle','united_states')];d[from].push(card('special_79','united_states'));const before=s.randomState;
 const e:Effect={kind:'signal',tag:'PHASE:PLAY',label:'出牌阶段开始'};expect(triggerCandidate(c.definitionId,e,'After')).toBe(true);expect(specialCard(c.definitionId,true)!.type).toBe('增强');expect(fullTrigger(s,c,{...e,tag:'PHASE:SCORE'},'After')).toBeUndefined();
 startResolution(s,'play','united_states',[e],[]);answer(s,[s.resolution!.choice!.options.find(o=>o.label==='先进技术迭代')!.id]);answer(s,['special_79']);finish(s);
 expect(d.hand.some(c=>c.id==='special_79')).toBe(true);expect(d.active).toEqual([]);expect(d.discardPile.some(c=>c.id==='special_258')).toBe(true);expect(s.randomState).not.toEqual(before);
});
it('redeployment selects units on map, rejects two navies, rebuilds navy then army and preserves unselected troops',()=>{
 const s=game('united_states');s.units=[{id:'a',country:'united_states',type:'army',regionId:'latin_america'},{id:'stay',country:'united_states',type:'army',regionId:'united_states'},{id:'n',country:'united_states',type:'navy',regionId:'sea_north_atlantic'},{id:'n2',country:'united_states',type:'navy',regionId:'sea_east_pacific'},{id:'cn',country:'china',type:'army',regionId:'eastern_china'}];
 startResolution(s,'战区移动','united_states',cardEffects(s,card('special_110','united_states')),[]);
 const q=s.resolution!.choice!;expect(q.kind).toBe('WITHDRAW');expect(resolutionTargets(s).map(o=>o.id)).toEqual(['a','stay','n','n2']);expect(resolveChoice(s,q.seat,q.id,['n','n2'])).toBe(false);answer(s,['a','n']);
 expect(s.units.map(u=>u.id)).toEqual(['stay','n2','cn']);expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual(['army','navy']);answer(s,['navy']);
 let builds=0;for(let i=0;s.resolution?.running&&i<80;i++){const q=s.resolution!.choice!;expect(q.kind).not.toBe('SELECT');if(q.kind==='ACTION')builds++;answer(s,q.options.slice(0,q.min).map(o=>o.id));}
 expect(builds).toBe(2);expect(s.units.filter(u=>u.country==='united_states'&&u.type==='navy').length).toBe(2);expect(s.units.filter(u=>u.country==='united_states'&&u.type==='army').length).toBe(2);expect(s.units.some(u=>u.id==='stay')).toBe(true);
});
it('army-only withdrawal asks no troop type; selecting none is a legal no-op; original card remains all armies',()=>{
 for(const ids of [[],['a']]){const s=game('united_states');s.units=[{id:'a',country:'united_states',type:'army',regionId:'united_states'}];startResolution(s,'move','united_states',cardEffects(s,card('special_110','united_states')),[]);answer(s,ids);expect(s.resolution?.choice?.kind).not.toBe('SELECT');finish(s);expect(s.units).toHaveLength(1);if(!ids.length)expect(s.units[0].id).toBe('a');}
 const s=game('united_states',false);expect(cardEffects(s,card('special_110','united_states'))).toMatchObject([{kind:'rebuild',country:'united_states'}]);expect((cardEffects(s,card('special_110','united_states'))[0] as any).selective).toBeUndefined();
});

it('new enhancement cannot be played as an ordinary event; catalogs reflect balanced neutrality text',()=>{
 const s=game('united_states'),c=card('special_258','united_states');s.decks.united_states.hand=[c];s.decks.united_states.drawPile=[card('special_79','united_states')];
 expect(cardEffects(s,c)).toEqual([]);expect(transition(s,{type:'PLAY_CARD',seat:'united_states',expectedRevision:s.revision,cardId:c.id,effectIndices:[0],targetIds:[]}).ok).toBe(false);
 expect(numberedCatalog(true).find(c=>c.id==='neutrality_soviet_union_status')!.text).toContain('查看');expect(numberedCatalog(false).find(c=>c.id==='neutrality_soviet_union_status')!.text).not.toContain('查看');
});
it('Soviet revealed state is only included in its own decision projection',()=>{
 const s=game(),d=s.decks.soviet_union;d.drawPile=[card('special_44')];startResolution(s,'neutrality','soviet_union',[balanceEffect('soviet_union','soviet-neutrality')],[]);answer(s,['deck']);
 const own=projectState(s,{kind:'observer',seat:'soviet_union'},'soviet_union')!,other=projectState(s,{kind:'observer',seat:'germany'},'germany')!;
 expect(own.resolution!.choice!.options.map(o=>o.id)).toEqual(['special_44']);expect(JSON.stringify(other.resolution)).not.toContain('special_44');
});
it('guided real redeployment consumes the event and reaches construction without a second troop-type question',()=>{
 const s=game('united_states'),c=card('special_110','united_states');s.decks.united_states.hand=[c];s.units=[{id:'a',country:'united_states',type:'army',regionId:'united_states'}];
 expect(startResolution(s,'战区移动','united_states',cardEffects(s,c),[],c.id,'discardPile',true,structuredClone(s))).toBe(true);
 for(let i=0;s.resolution?.choice?.kind!=='WITHDRAW'&&i<10;i++){const q=s.resolution!.choice!;answer(s,[q.options[0].id],true);}
 answer(s,['a'],true);expect(s.resolution!.choice!.kind).toBe('ACTION');finish(s);expect(s.decks.united_states.discardPile.some(v=>v.id===c.id)).toBe(true);expect(s.units).toHaveLength(1);
});

it.each(['ppo-events-v1','ppo-signals-a2s1-v2'] as const)('preserves frozen redeployment for existing training course %s',version=>{
 const s=game('united_states');s.trainingCourse={version,mode:'A',openIds:Object.fromEntries(Object.keys(s.decks).map(seat=>[seat,[]])) as any,openRandomState:1,discardRandomState:2};
 const effects=cardEffects(s,card('special_110','united_states'));expect(effects).toEqual([{kind:'rebuild',country:'united_states',label:'收回全部陆军，然后依次重新建设全部被收回的陆军'}]);
});

it('withdrawal and construction checkpoints remain valid serialized saves',()=>{
 const s=createGame('save-v22',33,'FULL',false,false,true);s.status='PLAYING';s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat='united_states';s.setupCompleted=[...SEATS];
 const d=s.decks.united_states;d.drawPile.push(...d.hand.splice(0));const c=d.drawPile.splice(d.drawPile.findIndex(c=>c.definitionId==='special_110'),1)[0];d.hand.push(c);
 startResolution(s,'战区移动','united_states',cardEffects(s,c),[],c.id);validateState(s);
 answer(s,[s.units.find(u=>u.country==='united_states'&&u.type==='army')!.id]);validateState(s);
 for(let i=0;s.resolution?.running&&i<60;i++){const q=s.resolution!.choice!;answer(s,q.options.slice(0,q.min).map(o=>o.id));validateState(s);}
 expect(s.resolution!.running).toBe(false);
});

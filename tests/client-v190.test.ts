import {it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {requestManualShuffle,executeManualShuffles} from '../src/core/manualShuffle';
import {specialCard,preludeCatalog} from '../src/core/cardCatalog';
import {cardEffects,realTriggers} from '../src/core/specialCards';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {balanceEffect} from '../src/core/balanceEffects';
import {endNeutrality,checkNeutralityTurn,neutralityDiscardPenalty} from '../src/core/neutrality';
import {historyEffects} from '../src/core/prelude';
import {reserve} from '../src/core/basic';
import {validateState} from '../src/controller/saveFormat';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay} from '../src/actionReplay/codec';
import {Player} from '../src/actionReplay/player';
import {stateHash} from '../src/actionReplay/state';
import type {GameState,CardInstance,SeatId} from '../src/core/types';
const card=(id:string):CardInstance=>{const d=specialCard(id,true)!;return {id,definitionId:id,deckOwner:d.deckOwner,country:d.country,balance:true};};
function game(seat:SeatId='germany'){const s=createGame('v190',1940,'FULL',true,true,true);s.prelude!.active=false;s.status='PLAYING';s.round=1;s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat=seat;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}return s;}
function answer(s:GameState,ids?:string[]){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,ids??q.options.slice(0,q.kind==='EXTRA_EFFECTS'?q.max:q.min).map(o=>o.id))).toBe(true);}
function finish(s:GameState){for(let n=0;s.resolution?.running&&n<100;n++)answer(s);expect(s.resolution?.running).toBe(false);}
it('opening skips ambition without losing cards and removed histories stay out of balanced decks',()=>{
 for(let seed=0;seed<40;seed++){const s=createGame('opening',seed,'FULL',true,false,true),d=s.prelude!.decks.italy;expect(d.discardPile).toHaveLength(2);expect(d.discardPile.some(c=>c.definitionId==='prelude_IT-15')).toBe(false);expect([...d.hand,...d.drawPile].filter(c=>c.definitionId==='prelude_IT-15')).toHaveLength(1);}
 for(const id of ['prelude_SU-17','prelude_US-01','prelude_DE-04','prelude_DE-15']){expect(preludeCatalog(true).some(c=>c.id===id)).toBe(false);expect(preludeCatalog(false).some(c=>c.id===id)).toBe(true);}
});
it('manual shuffle freezes at three, executes once at boundary, isolates RNG and cycles through four/zero',()=>{
 const s=game(),before=s.randomState,order=s.decks.germany.drawPile.map(c=>c.id);
 for(let n=0;n<7;n++)requestManualShuffle(s,'germany');expect(s.manualShuffle!.counters.germany).toBe(3);expect(s.decks.germany.drawPile.map(c=>c.id)).toEqual(order);
 executeManualShuffles(s);expect(s.randomState).toBe(before);expect(s.decks.germany.drawPile.map(c=>c.id)).not.toEqual(order);const shuffled=structuredClone(s);
 executeManualShuffles(s);expect(s).toEqual(shuffled);requestManualShuffle(s,'germany');expect(s.manualShuffle!.counters.germany).toBe(4);requestManualShuffle(s,'germany');expect(s.manualShuffle!.counters.germany).toBe(0);
 const p=createGame('prelude',1,'FULL',true,false,true),old=structuredClone(p.manualShuffle);requestManualShuffle(p,'germany');expect(p.manualShuffle).toEqual(old);
});
it('manual shuffle saves, records exact permutation and replays from a national handover',async()=>{
 const s=game();s.phase='DRAW';s.redistributed=true;const c=new LocalGameController();await c.importSave(JSON.stringify({format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state:s,replayBase:s,rounds:[],nations:[],undo:[],commands:[]}));
 for(let n=0;n<3;n++){const v=c.getSnapshot()!;expect(await c.dispatch({type:'REQUEST_SHUFFLE',seat:'germany',expectedRevision:v.revision})).toEqual({ok:true});}
 const v=c.getSnapshot()!,normal=v.randomState;expect(await c.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:v.revision})).toEqual({ok:true});
 validateState(c.getSnapshot());expect(c.getSnapshot()!.randomState).toBe(normal);const archive=await parseReplay(await c.exportReplay());expect(archive.records.some(r=>r.type==='shuffle'&&r.owner==='germany')).toBe(true);
 const last=archive.groups.at(-1)!;expect(await stateHash(await new Player(archive).seek(last.root.actionId,true,true))).toBe(await stateHash(c.getSnapshot()!));
});
it('random Soviet state viewing never changes original deck order on decline and commits source',()=>{
 const s=game('soviet_union'),d=s.decks.soviet_union;d.hand=[card('special_50')];d.drawPile=[card('special_44'),card('special_42'),card('special_52')];const before=d.drawPile.map(c=>c.id);
 startResolution(s,'混乱的政局','soviet_union',[balanceEffect('soviet_union','soviet-neutrality')],[]);answer(s,['deck']);expect(s.resolution!.choice!.options).toHaveLength(1);expect(s.resolution!.choice!.options.some(o=>o.id==='special_50')).toBe(false);answer(s,[]);finish(s);expect(d.drawPile.map(c=>c.id)).toEqual(before);expect(d.hand.map(c=>c.id)).toEqual(['special_50']);
});
it('Soviet neutrality refill waits until next own turn, not the same start',()=>{
 const s=game('soviet_union');endNeutrality(s,'soviet_union','test');checkNeutralityTurn(s);expect(s.decks.soviet_union.hand).toHaveLength(0);s.round=2;checkNeutralityTurn(s);expect(s.decks.soviet_union.hand).toHaveLength(7);expect(s.sovietNeutralityDrawRound).toBeUndefined();
 const other=game('japan');endNeutrality(other,'soviet_union','test');other.activeSeat='soviet_union';checkNeutralityTurn(other);expect(other.decks.soviet_union.hand).toHaveLength(7);
});
it('Roosevelt history suppresses neutral penalty then discards on entering war',()=>{
 const s=game('united_states'),c=card('prelude_US-17');s.decks.united_states.active=[c];expect(neutralityDiscardPenalty(s,'united_states')).toBe(0);endNeutrality(s,'united_states','test');expect(s.decks.united_states.active).toEqual([]);expect(s.decks.united_states.discardPile).toContainEqual(c);
});
it('Tizard commits five-card opening cap only after UK elects an actual card and grants US another action',()=>{
 const s=game('united_states');s.prelude!.active=true;s.prelude!.played=true;s.prelude!.decks.united_kingdom.hand=[card('prelude_UK-03')];startResolution(s,'蒂泽德','united_states',historyEffects(s,card('prelude_US-07')),[]);answer(s,['prelude_UK-03']);finish(s);expect(s.openingHandLimits?.united_kingdom).toBe(5);expect(s.prelude!.played).toBe(false);
});
it('Suez hand state can install at Italian score start, not at German score start',()=>{
 const s=game('italy'),c=card('special_257');s.decks.italy.hand=[c];s.units=[{id:'a',country:'germany',type:'army',regionId:'north_africa'},{id:'b',country:'italy',type:'army',regionId:'middle_east'}];startResolution(s,'计分','italy',[{kind:'signal',tag:'PHASE:SCORE',label:'计分'}],[]);answer(s,[s.resolution!.choice!.options.find(o=>o.label===specialCard(c.definitionId,true)!.name)!.id]);finish(s);expect(s.decks.italy.active).toContainEqual(c);
 const t=game();t.decks.italy.hand=[c];t.units=s.units;expect(realTriggers(t,{id:'f',currentEventId:'e'} as any,{kind:'signal',tag:'PHASE:SCORE',label:'计分'},'After').some(r=>r.sourceInstanceId===c.id)).toBe(false);
});
it('capital itself recruits and PLA increases Chinese army reserve',()=>{
 const s=game('soviet_union'),c=card('special_42');s.decks.soviet_union.hand=[c];startResolution(s,'迁都','soviet_union',cardEffects(s,c),[],c.id,'active');finish(s);expect(s.units.some(u=>u.country==='soviet_union'&&u.regionId==='siberia')).toBe(true);
 const before=reserve(s,'china','army');s.decks.soviet_union.active.push(card('special_52'));expect(reserve(s,'china','army')).toBe(before+1);
});
it('air-phase kamikaze consumes the air action and never triggers at supply start',()=>{
 const s=game('japan'),c=card('special_247');s.phase='AIR';s.decks.japan.active=[c];s.units=[{id:'a',country:'japan',type:'army',regionId:'japan'},{id:'p',country:'japan',type:'air',regionId:'japan'},{id:'n',country:'united_states',type:'navy',regionId:'sea_east_china'}];const r=transition(s,{type:'STATUS_ACTION',seat:'japan',expectedRevision:s.revision,cardId:c.id});expect(r.ok).toBe(true);if(!r.ok)return;finish(r.state);expect(r.state.units.some(u=>u.id==='p'||u.id==='n')).toBe(false);
 expect(realTriggers(s,{id:'f',currentEventId:'e'} as any,{kind:'signal',tag:'PHASE:SUPPLY',label:'补给'},'After').some(r=>r.sourceInstanceId===c.id)).toBe(false);
});
it('attrition scores automatically once across build, attack and defense in the same national turn',()=>{
 const s=game('soviet_union');s.decks.soviet_union.active=[card('special_49')];s.units=[{id:'home',country:'soviet_union',type:'army',regionId:'moscow'}];
 startResolution(s,'两次建设','soviet_union',[{kind:'action',country:'soviet_union',action:'build_army',regions:['ukraine'],label:'建设乌克兰'},{kind:'action',country:'soviet_union',action:'build_army',regions:['ross_region'],label:'建设罗斯'}],[]);finish(s);expect(s.scores.soviet_union).toBe(1);
 startResolution(s,'再次建设','soviet_union',[{kind:'action',country:'soviet_union',action:'build_army',regions:['moscow'],label:'建设'}],[]);finish(s);expect(s.scores.soviet_union).toBe(1);
 s.activeSeat='germany';s.units.push({id:'german-home',country:'germany',type:'army',regionId:'germany'},{id:'attacker',country:'germany',type:'army',regionId:'eastern_europe'});startResolution(s,'被攻击','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['ukraine'],label:'攻击'}],[]);finish(s);expect(s.scores.soviet_union).toBe(2);
});
it('Soviet German treaty recurs, removes navy before scoring and expires on Soviet attack',()=>{
 const s=game(),c=card('prelude_SU-10');s.decks.soviet_union.active=[c];s.units=[{id:'n',country:'germany',type:'navy',regionId:'sea_baltic'}];
 startResolution(s,'计分','germany',[{kind:'signal',tag:'PHASE:SCORE',label:'计分'}],[]);answer(s,[]);finish(s);expect(s.scores.soviet_union).toBe(1);expect(s.decks.soviet_union.active).toContainEqual(c);
 startResolution(s,'下次计分','germany',[{kind:'signal',tag:'PHASE:SCORE',label:'计分'}],[]);answer(s,['n']);finish(s);expect(s.scores.soviet_union).toBe(1);expect(s.units).toEqual([]);expect(s.decks.soviet_union.active).toContainEqual(c);
 s.neutrality!.soviet_union.neutral=false;s.activeSeat='soviet_union';s.units=[{id:'s',country:'soviet_union',type:'army',regionId:'ukraine'},{id:'d',country:'germany',type:'army',regionId:'eastern_europe'}];startResolution(s,'苏联先战','soviet_union',[{kind:'action',country:'soviet_union',action:'land_battle',regions:['eastern_europe'],label:'攻击'}],[]);finish(s);expect(s.decks.soviet_union.active).toEqual([]);expect(s.scores.soviet_union).toBe(1);
});
it('ration offers recovery after standard Air Power but never for a status',()=>{
 const s=game('united_kingdom');s.phase='AIR';const d=s.decks.united_kingdom;const take=(id:string)=>d.drawPile.splice(d.drawPile.findIndex(c=>c.definitionId===id),1)[0];const air=take('air_power'),ration=take('special_13'),fee=take('build_army');d.hand=[air,ration,fee];
 const result=transition(s,{type:'PLAY_CARD',seat:'united_kingdom',expectedRevision:s.revision,cardId:air.id,targetIds:[],effectIndices:[0]});expect(result.ok).toBe(true);if(!result.ok)return;const next=result.state;
 while(next.resolution!.choice?.kind==='ACTION')answer(next);
 const q=next.resolution!.choice!;expect(q.options.some(o=>o.label==='配给')).toBe(true);answer(next,[q.options.find(o=>o.label==='配给')!.id]);finish(next);expect(next.decks.united_kingdom.drawPile.some(c=>c.id===air.id)).toBe(true);expect(next.decks.united_kingdom.discardPile.some(c=>c.id===fee.id)).toBe(true);
 const t=game('united_kingdom'),status=card('special_3');t.decks.united_kingdom.hand=[ration,fee];t.decks.united_kingdom.resolving=[status];expect(realTriggers(t,{id:'f',currentEventId:'e',cardId:status.id} as any,{kind:'signal',tag:'STANDARD_CARD_PLAYED',label:'标准打出'},'After').some(r=>r.label==='配给')).toBe(false);
});
it('shuffle queue survives intermediate actions, clears on restore, and replays across round checkpoints',async()=>{
 for(const seat of ['germany','united_states'] as SeatId[]){
 const s=game(seat);s.phase='DRAW';s.redistributed=true;const c=new LocalGameController();const save=JSON.stringify({format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state:s,replayBase:s,rounds:[],nations:[],undo:[],commands:[]});await c.importSave(save);
 const before=c.getSnapshot();for(let i=0;i<8;i++)c.queueManualShuffle('japan');expect(c.getSnapshot()).toBe(before);
 await c.importSave(save);expect(await c.dispatch({type:'ADVANCE_PHASE',seat,expectedRevision:c.getSnapshot()!.revision})).toEqual({ok:true});expect(c.getSnapshot()!.manualShuffle!.counters.japan).toBeUndefined();
 await c.importSave(save);for(let i=0;i<8;i++)c.queueManualShuffle('japan');
 expect(await c.dispatch({type:'ADVANCE_PHASE',seat,expectedRevision:c.getSnapshot()!.revision})).toEqual({ok:true});expect(c.getSnapshot()!.manualShuffle!.counters.japan).toBe(3);
 const archive=await parseReplay(await c.exportReplay());expect(await stateHash(await new Player(archive).seek(archive.groups.at(-1)!.root.actionId,true,true))).toBe(await stateHash(c.getSnapshot()!));
 }
});

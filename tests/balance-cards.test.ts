import {near} from '../src/core/fullCardEffects';
import {REGIONS} from '../src/core/map';
import {expect,it} from 'vitest';
import {createGame} from '../src/core/game';
import {validateState} from '../src/controller/saveFormat';
import {SEATS,type GameState} from '../src/core/types';
import {specialCard,regularCatalog,preludeCatalog} from '../src/core/cardCatalog';
import {cardEffects} from '../src/core/specialCards';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {balanceEffect} from '../src/core/balanceEffects';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {statusActionEffects} from '../src/core/statusActions';
import {projectState} from '../src/network/project';
import {discardHandCards,discardDeckTop} from '../src/core/decks';
import {boardOptions} from '../src/core/boardEffects';
import type {Effect} from '../src/core/resolutionTypes';
function game(){const s=createGame('patch',12,'FULL',false,true,true);s.status='PLAYING';s.phase='PLAY';s.round=1;for(const seat of SEATS){const d=s.decks[seat];d.drawPile.push(...d.hand.splice(0));}return s;}
function move(s:GameState,id:string,zone:'hand'|'active'|'faceDown') {for(const seat of SEATS)for(const old of ['drawPile','hand','active','faceDown','removed','discardPile'] as const){const d=s.decks[seat],i=d[old].findIndex(c=>c.definitionId===id);if(i>=0){const card=d[old].splice(i,1)[0];d[zone].push(card);return card;}}throw Error(id);}
function respond(s:GameState,ids:string[]){const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<120;i++){const q=s.resolution!.choice!;expect(q).toBeTruthy();respond(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
for(const balance of [false,true])for(const prelude of [false,true])for(const neutrality of [false,true])it(`deck and save compatibility ${balance}/${prelude}/${neutrality}`,()=>{
 const s=createGame('matrix',17,'FULL',prelude,neutrality,balance);expect(()=>validateState(structuredClone(s))).not.toThrow();
 const cards=Object.values(s.decks).flatMap(d=>Object.values(d).flat());expect(cards.find(c=>c.definitionId==='special_113')?.deckOwner).toBe(balance?'soviet_union':'united_states');
 expect(cards.some(c=>c.definitionId==='special_252')).toBe(false);expect(cards.some(c=>c.definitionId==='special_247')).toBe(balance);
 expect(s.decks.italy.active.length).toBe(0);
 expect(cards.find(c=>c.definitionId==='special_163')?.balance??false).toBe(balance);
 if(prelude)expect(Object.values(s.prelude!.decks).flatMap(d=>Object.values(d).flat()).length).toBe(balance?110:107);
});
it('new card types and old variants remain independent',()=>{
 expect(specialCard('special_178')?.type).toBe('经济战');expect(specialCard('special_178',true)?.type).toBe('响应');
 expect(specialCard('special_196',true)?.name).toBe('伏龙特工队');expect(specialCard('special_247',true)?.type).toBe('状态');
 expect(preludeCatalog(true).find(c=>c.id==='prelude_IT-12')?.type).toBe('军备');expect(preludeCatalog(false).find(c=>c.id==='prelude_IT-12')?.type).toBe('历史');
 expect(regularCatalog(true,false).filter(c=>c.id==='special_113')).toHaveLength(1);
});
it('random response reveal persists publicly, but random discarded hidden card stays private',()=>{
 const s=game(),a=move(s,'special_195','faceDown'),b=move(s,'special_196','faceDown');
 startResolution(s,'代号magic','united_states',[balanceEffect('japan','reveal-response')],[]);
 const shown=s.faceUpResponseIds![0];expect([a.id,b.id]).toContain(shown);expect(s.resolution!.choice!.seat).toBe('united_states');
 const publicView=projectState(s,{kind:'public'},'germany')!;expect(publicView.decks.japan.faceDown.find(c=>c.id===shown)?.definitionId).not.toBe('hidden');
 respond(s,['hidden']);finish(s);expect(s.decks.japan.faceDown.map(c=>c.id)).toEqual([shown]);
 const notice=s.responseNotices!.find(n=>n.title==='弃牌结果')!;expect(notice.recipients).toEqual(['japan']);expect(notice.cards.map(c=>c.id).sort()).toEqual([a.id,b.id].sort());expect(notice.text).toContain('揭开了');expect(notice.text).toContain('弃置了');
 expect(projectState(s,{kind:'player',seat:'united_states'},'united_states')!.responseNotices!.some(n=>n.id===notice.id)).toBe(false);
 validateState(s);
});
it('scry splits top and bottom and orders each group without duplicating cards',()=>{
 const s=game(),ids=s.decks.germany.drawPile.slice(0,4).map(c=>c.id),rest=s.decks.germany.drawPile.slice(4).map(c=>c.id);
 startResolution(s,'卓越规划','germany',[balanceEffect('germany','scry')],[]);respond(s,[ids[2],ids[0]]);respond(s,[ids[3],ids[1]]);finish(s);
 expect(s.decks.germany.drawPile.map(c=>c.id)).toEqual([ids[3],ids[1],...rest,ids[2],ids[0]]);
});
it('attrition counts costs and forced hand discards, not deck-top discard',()=>{
 const s=game();move(s,'special_49','active');const d=s.decks.soviet_union,cards=d.drawPile.filter(c=>c.definitionId==='build_army').slice(0,2);d.drawPile=d.drawPile.filter(c=>!cards.includes(c));d.hand.push(...cards);discardHandCards(s,'soviet_union',cards.map(c=>c.id));expect(s.scores.soviet_union).toBe(2);discardDeckTop(s,'soviet_union',1);expect(s.scores.soviet_union).toBe(2);
});
it('new army binding cannot silently switch to another army',()=>{
 const s=game();s.units=[{id:'bound',country:'china',type:'army',regionId:'eastern_china'},{id:'other',country:'china',type:'army',regionId:'western_china'},{id:'enemy',country:'japan',type:'army',regionId:'vladivostok'}];
 const e:Extract<Effect,{kind:'action'}>={kind:'action',country:'china',action:'land_battle',boundAttackerId:'bound',label:'bound'};
 expect(boardOptions(s,e).every(o=>o.attackerId==='bound')).toBe(true);s.units=s.units.filter(u=>u.id!=='bound');expect(boardOptions(s,e)).toEqual([]);
});
it('replacement card effects preserve independent clauses and full hand fees',()=>{
 const s=game(),card=move(s,'special_154','hand');expect(cardEffects(s,card)[0]).toMatchObject({kind:'action',action:'build_navy'});
 const steel=move(s,'special_227','hand');expect(cardEffects(s,steel)[0]).toMatchObject({kind:'cards',fee:true,min:2,max:2});
 const ballon=move(s,'special_179','hand');expect(cardEffects(s,ballon)[0]).toMatchObject({kind:'score',amount:3});
});
it('radar is once per turn and restricted to central Pacific seas',()=>{
 const s=game(),radar=move(s,'special_86','active');s.units=[{id:'us',country:'united_states',type:'navy',regionId:'sea_north_atlantic'},{id:'ua',country:'united_states',type:'army',regionId:'united_states'}];
 const e:Effect={kind:'action',country:'germany',action:'sea_battle',option:{id:'battle',label:'battle',mode:'battle',regionId:'sea_north_atlantic',defenderId:'us'},label:'attack'};
 expect(fullTrigger(s,radar,e,'Before')).toBeUndefined();
 for(const region of ['sea_central_pacific',...near(s,'united_states','sea_central_pacific')]){if(!REGIONS.some(r=>r.id===region&&r.type==='SEA'))continue;s.units[0].regionId=region;e.option!.regionId=region;const rule=fullTrigger(s,radar,e,'Before');expect(rule).toMatchObject({oncePerTurn:true});expect(rule?.oncePerRound).toBeFalsy();}
});
it('Jutland action binds Baltic navy and snapshots surcharge',()=>{
 const s=game();s.units=[{id:'navy',country:'germany',type:'navy',regionId:'sea_baltic'},{id:'ally',country:'united_kingdom',type:'army',regionId:'scandinavia'}];const card=move(s,'special_163','active');expect(statusActionEffects(s,card)).toMatchObject([{kind:'deckTop',count:3},{kind:'action',boundAttackerId:'navy'}]);
});
it('Dunkirk is additional and withdraws before damage with three other hand cards as cost',()=>{
 const s=game(),c=move(s,'special_254','hand');expect(regularCatalog(true,false).some(c=>c.id==='special_41')).toBe(true);
 s.units=[{id:'fr',country:'france',type:'army',regionId:'western_europe'}];
 const rule=fullTrigger(s,c,{kind:'action',country:'germany',action:'land_battle',option:{id:'battle',label:'battle',mode:'battle',regionId:'western_europe',defenderId:'fr'},label:'attack'},'Before');
 expect(rule).toMatchObject({cost:1,effects:[{kind:'remove',unit:{id:'fr'}},{kind:'action',country:'france',action:'recruit_army',regions:['british_isles']}]});
});
it('bomber cost selection cannot discard the economic card selected for extra play',()=>{
 const s=game(),economic=move(s,'special_112','hand'),deck=s.decks.united_states,index=deck.drawPile.findIndex(c=>c.definitionId==='build_army'),fee=deck.drawPile.splice(index,1)[0];deck.hand.push(fee);
 s.activeSeat='united_states';startResolution(s,'空中堡垒','united_states',[balanceEffect('united_states','bomber-economy')],[]);
 expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual([economic.id]);respond(s,[economic.id]);
 expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual([economic.id]);respond(s,[economic.id]);finish(s);
 expect(deck.discardPile.some(c=>c.id===economic.id)).toBe(true);expect(deck.hand.some(c=>c.id===fee.id)).toBe(true);
});

it('balance rollback tensions are separate from original cards',()=>{
 for(const [id,tension] of [['prelude_IT-15',1],['prelude_IT-08',1],['prelude_IT-09',1],['prelude_US-10',-1]] as const)expect(specialCard(id,true)?.tension).toBe(tension);
 expect(specialCard('prelude_US-10',false)?.tension).toBe(1);
});
it('steel pact discards two Italian cards, sets a remaining response, then lets Germany play a state',()=>{
 const s=game();s.activeSeat=s.viewSeat=s.operatorSeat='italy';const steel=move(s,'special_227','hand'),response=move(s,'special_218','hand'),state=move(s,'special_132','hand');const d=s.decks.italy;const fee=d.drawPile.splice(d.drawPile.findIndex(c=>c.definitionId==='build_army'),1)[0];d.hand.push(fee);
 expect(fullTrigger(s,steel,{kind:'signal',tag:'PHASE:PLAY',label:'出牌'},'After')).toBeUndefined();
 const fee2=d.drawPile.shift()!;d.hand.push(fee2);
 startResolution(s,'钢铁条约','italy',cardEffects(s,steel),[],steel.id,'discardPile',true);
 expect(s.resolution!.choice).toMatchObject({seat:'italy',kind:'CARDS',min:2,max:2});respond(s,[fee.id,fee2.id]);
 expect(s.resolution!.choice).toMatchObject({seat:'italy',kind:'CARDS',min:1,max:1});respond(s,[response.id]);
 expect(s.resolution!.choice).toMatchObject({seat:'germany',kind:'EXTRA_CARD'});respond(s,[state.id]);finish(s);
 expect(d.discardPile.map(c=>c.id)).toEqual(expect.arrayContaining([steel.id,fee.id,fee2.id]));expect(d.faceDown.map(c=>c.id)).toEqual([response.id]);expect(s.decks.germany.active.some(c=>c.id===state.id)).toBe(true);expect(s.decks.germany.discardPile).toHaveLength(0);
});
it('retired Vichy statuses are absent from every new-game zone',()=>{
 const s=game();for(const d of Object.values(s.decks))expect(Object.values(d).flat().some(c=>['special_250','special_251'].includes(c.definitionId))).toBe(false);
});

it.each([false,true])('southern resource route supply area follows the balance switch (%s)',balance=>{
 const s=game();s.rules!.balanceEnabled=balance;s.activeSeat='japan';const c=move(s,'special_191','faceDown');const rule=fullTrigger(s,c,{kind:'signal',tag:'PHASE:PLAY',label:'出牌阶段'},'After')!;
 startResolution(s,'补给航线','japan',rule.effects!,[]);finish(s);const regions=s.turnFlags!.supplyRegions;
 if(balance){expect(specialCard(c.definitionId,true)?.name).toBe('南方资源航线');expect(regions).toEqual(expect.arrayContaining(['japan:sea_east_china','japan:sea_south_china','japan:eastern_china','japan:philippines']));expect(regions).not.toContain('japan:hawaii');}
 else {expect(specialCard(c.definitionId,false)?.name).toBe('丘克群岛');expect(regions).toContain('japan:sea_central_pacific');expect(regions).not.toContain('japan:eastern_china');}
 expect(regions.length).toBe(new Set(regions).size);
});
it.each([false,true])('surprise attack excludes the US mainland only in the balance version (%s)',balance=>{
 const s=game();s.rules!.balanceEnabled=balance;s.activeSeat='japan';const c=move(s,'special_192','faceDown');
 s.units=[{id:'jp',country:'japan',type:'army',regionId:'canada'},{id:'us',country:'united_states',type:'army',regionId:'united_states'}];startResolution(s,'补给','japan',[{kind:'flag',flag:'supplied',ids:['jp'],label:'补给'}],[]);finish(s);
 const rule=fullTrigger(s,c,{kind:'action',country:'japan',action:'sea_battle',label:'海战'},'After')!;expect(rule.effects![0]).toMatchObject({kind:'action',action:'sea_battle'});const land=rule.effects![1];expect(land).toMatchObject({kind:'action',action:'land_battle'});if(land.kind!=='action')throw Error('land action missing');
 expect(boardOptions(s,land).some(o=>o.regionId==='united_states')).toBe(!balance);if(balance){expect(land.regions).toContain('hawaii');expect(land.regions).toContain('moscow');}
});

import {it,expect,vi} from 'vitest';
import {createGame} from '../src/core/game';
import {realTriggers} from '../src/core/specialCards';
import * as triggerIndex from '../src/core/triggerIndex';
import {adjacent as oldAdjacent,suppliedUnits as oldSupply,countryScore as oldScore,landControllers as oldControllers} from '../outputs/global-performance/baseline/src/core/supply';
import {adjacent,adjacentRegions,suppliedUnits,countryScore,landControllers,resetMapCache,mapCacheStats} from '../src/core/supply';
import {triggerCandidate,resetTriggerScanStats,triggerScanStats} from '../src/core/triggerIndex';
import {REGIONS} from '../src/core/map';
import {COUNTRY_NAMES} from '../src/core/basic';
import {specialCard} from '../src/core/cardCatalog';
import {SEATS} from '../src/core/types';
import type {CountryId,GameState} from '../src/core/types';
import type {Effect,ResolutionFrame} from '../src/core/resolutionTypes';
const countries=Object.keys(COUNTRY_NAMES) as CountryId[];
function game(balance=true){const s=createGame('map-parity',42,'FULL',true,false,balance);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';return s;}
function put(s:GameState,id:number){const d=specialCard('special_'+id,true)!;s.decks[d.deckOwner].active.push({id:'map:'+id,definitionId:d.id,country:d.country,deckOwner:d.deckOwner,balance:!!s.rules?.balanceEnabled});}
function check(s:GameState){
 expect(landControllers(s)).toEqual(oldControllers(s));expect([...suppliedUnits(s)].sort()).toEqual([...oldSupply(s)].sort());
 for(const c of countries){expect(countryScore(s,c)).toBe(oldScore(s,c));for(const a of REGIONS)expect(adjacentRegions(s,c,a.id).sort()).toEqual(REGIONS.filter(b=>oldAdjacent(s,c,a.id,b.id)).map(b=>b.id).sort());}
}
it('map pool equals old rules across straits, statuses, suppression, temporary supply and mutable edits',()=>{
 for(const balance of [false,true]){const s=game(balance);resetMapCache();check(s);
 for(const id of [5,6,7,9,10,42,47,48,52,79,91,163,210,211]){const isolated=structuredClone(s);put(isolated,id);check(isolated);}
 for(const id of [42,48,79,91,163,210,211])put(s,id);check(s);
 s.units.push({id:'occupy',country:'germany',type:'army',regionId:'scandinavia'},{id:'new-siberia',country:'soviet_union',type:'army',regionId:'siberia'});check(s);
 s.units.find(u=>u.id==='occupy')!.country='united_kingdom';check(s);
 s.turnFlags={protected:[],battleProtected:[],supplied:['occupy'],supplyCountries:['japan'],supplyRegions:['china:western_china'],suppressed:['map:163'],noAirDefense:false};check(s);
 put(s,6);s.activeSeat='united_kingdom';check(s);
 s.turnFlags=undefined;s.activeSeat='germany';s.units=s.units.filter(u=>u.id!=='occupy');check(s);
 }
},120000);
it('unchanged geography reuses the pool across clones and private hand changes; moves and status transitions refresh',()=>{
 const s=game();resetMapCache();suppliedUnits(s);expect(mapCacheStats().builds).toBe(1);
 const clone=structuredClone(s);clone.revision++;clone.scores.germany+=3;clone.decks.germany.hand.reverse();clone.events=[];
 suppliedUnits(clone);adjacent(clone,'japan','sea_east_china','sea_south_china');expect(mapCacheStats().builds).toBe(1);
 const original=structuredClone(s);s.units[0].regionId='western_europe';suppliedUnits(s);expect(mapCacheStats().builds).toBe(2);
 suppliedUnits(original);expect(mapCacheStats().builds).toBe(2);
 put(s,163);suppliedUnits(s);expect(mapCacheStats().builds).toBe(3);
 const d=s.decks.germany,card=d.active.find(c=>c.id==='map:163')!;d.active=d.active.filter(c=>c!==card);d.resolving.push(card);suppliedUnits(s);expect(mapCacheStats().builds).toBe(3);
 d.resolving=[];suppliedUnits(s);expect(mapCacheStats().builds).toBe(3); // exact previous map can be reused
 const set=suppliedUnits(s);set.clear();expect(suppliedUnits(s).size).toBeGreaterThan(0);
 const controls=landControllers(s);controls.germany='allies';expect(landControllers(s)).toEqual(oldControllers(s));
 for(let i=0;i<80;i++){s.units[0].id='cache:'+i;suppliedUnits(s);}expect(mapCacheStats().entries).toBeLessThanOrEqual(64);
});
it('filtered candidates match complete pre-optimization scans for both rulesets and all event families',()=>{
 for(const balance of [false,true]){
 const s=game(balance);for(const d of Object.values(s.decks)){const cards=[...d.hand,...d.drawPile,...d.active,...d.faceDown];d.hand=cards.filter(c=>specialCard(c.definitionId,balance)?.type!=='状态');d.active=cards.filter(c=>specialCard(c.definitionId,balance)?.type==='状态');d.drawPile=[];d.faceDown=[];}
 for(const [seat,d] of Object.entries(s.prelude!.decks))s.decks[seat as GameState['activeSeat']].faceDown.push(...[...d.hand,...d.drawPile,...d.discardPile].filter(c=>c.definitionId!=='prelude_DE-09'));
 const frame={id:'frame',currentEventId:'event',sourceAncestors:[],source:'parity',effects:[],nextEffectIndex:0,stage:'Apply',status:'RUNNING',parentEventId:null,ancestorIds:[],finalZone:'discardPile',owner:'germany',cardId:s.decks.germany.active[0]?.id} as ResolutionFrame;s.decks.germany.resolving=[s.decks.germany.active[0]];
 const effects:Effect[]=[];
 for(const c of countries){const unit=s.units.find(u=>u.country===c)!;for(const action of ['build_army','build_navy','recruit_army','recruit_navy','land_battle','sea_battle','air_power','air_move','air_deploy','destroy'] as const){effects.push({kind:'action',country:c,action,option:{id:'o',regionId:unit?.regionId??'western_europe',defenderId:unit?.id,defenderCountry:c,mode:'battle'},resultUnitId:unit?.id,label:'event'} as Effect);}
 if(unit)effects.push({kind:'remove',unit:{...unit},supplied:true,cause:'land_battle',label:'event'});}
 for(const tag of ['CARD_EFFECT','CARD_EFFECT_DONE','CARD_PLAYED','STANDARD_CARD_PLAYED','ARMAMENT','ARMAMENT_ANYTIME',...['TURN_START_WINDOW','EARLY_TURN_START','PLAY','AIR','SUPPLY','SCORE','SCORE_STATUS','DISCARD','DRAW'].map(p=>'PHASE:'+p)])effects.push({kind:'signal',tag,label:'event'});
 effects.push({kind:'deckTop',seat:'united_kingdom',count:3,label:'event'},{kind:'trace',label:'event'});
 for(const seat of SEATS){s.activeSeat=seat;frame.owner=seat;
 for(const e of effects)for(const timing of ['Before','After'] as const){const filtered=realTriggers(s,frame,e,timing);const scan=vi.spyOn(triggerIndex,'triggerCandidate').mockReturnValue(true);let all;try{all=realTriggers(s,frame,e,timing);}finally{scan.mockRestore();}expect(filtered,`${balance} ${timing} ${JSON.stringify(e)}`).toEqual(all);}
 }
 }
},120000);
it('index excludes unrelated known cards but preserves anytime and unknown future cards',()=>{
 resetTriggerScanStats();const e:Effect={kind:'action',country:'germany',action:'air_deploy',label:'部署'};
 expect(triggerCandidate('special_139',e,'After')).toBe(false);expect(triggerCandidate('special_70',e,'After')).toBe(true);expect(triggerCandidate('special_191',e,'After')).toBe(true);expect(triggerCandidate('special_999',e,'After')).toBe(true);expect(triggerScanStats()).toEqual({seen:4,accepted:3,skipped:1});
});

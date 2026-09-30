import {seatAirMoveOptions,airPowerOptions} from '../src/core/actions';
import {expect,it} from 'vitest';
import {createGame,transition,SEATS} from '../src/core';
import type {GameState,Command,SeatId} from '../src/core';
import {airActionOptions} from '../src/core/phaseAvailability';
import {validateState} from '../src/controller/saveFormat';
import {projectState} from '../src/network/project';
function game(seat:SeatId='germany'){
 const s=createGame('phase-flow',1940,'FULL',false,false,true);s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];s.activeSeat=s.operatorSeat=s.viewSeat=seat;
 for(const id of SEATS){const d=s.decks[id];d.drawPile.push(...d.hand.splice(0),...d.active.splice(0),...d.faceDown.splice(0));}return s;
}
function add(s:GameState,id:string,zone:'hand'|'active'='hand'){
 for(const seat of SEATS){const d=s.decks[seat],i=d.drawPile.findIndex(c=>c.definitionId===id);if(i>=0){const c=d.drawPile.splice(i,1)[0];d[zone].push(c);return c;}}throw Error(id);
}
function send(s:GameState,c:Record<string,unknown>){const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...c} as Command);if(!r.ok)throw Error(r.error+JSON.stringify(c));return r.state;}
function complete(s:GameState){for(let i=0;s.resolution?.running&&i<60;i++){const q=s.resolution!.choice!;expect(q).toBeTruthy();s=send(s,{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,choiceId:q.id,ids:q.kind==='TRIGGER'?[]:[q.options[0].id],guided:true});}expect(s.resolution?.running).toBe(false);return s;}
it('empty air, supply and score advance automatically but empty discard always waits',()=>{
 let s=game();s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('DISCARD');expect(s.activeSeat).toBe('germany');expect(s.scores.germany).toBe(1);expect(s.decks.germany.hand).toHaveLength(0);
 expect(transition(s,{type:'ADVANCE_PHASE',seat:'germany',expectedRevision:s.revision}).ok).toBe(false);
 s=send(s,{type:'DISCARD_HAND',cardIds:[]});expect(s.scores.germany).toBe(1);expect(s.decks.germany.hand).toHaveLength(7);expect(s.activeSeat).toBe('united_kingdom');expect(s.phase).toBe('DISCARD');
});
it('air options check payment cards, destinations and enemy aircraft independently',()=>{
 const s=game();s.phase='AIR';expect(airActionOptions(s).map(o=>o.enabled)).toEqual([false,false,false]);add(s,'air_power');expect(airActionOptions(s).map(o=>o.enabled)).toEqual([false,true,false]);
 s.units.push({id:'air',country:'germany',type:'air',regionId:'germany'},{id:'enemy',country:'united_kingdom',type:'air',regionId:'western_europe'});
 expect(airActionOptions(s).map(o=>o.enabled)).toEqual([true,false,true]);
 s.decks.germany.drawPile.push(...s.decks.germany.hand.splice(0));expect(airActionOptions(s).map(o=>o.enabled)).toEqual([false,false,false]);
});
it('deployment selection survives save and multiplayer projection, constrains targets, then advances',()=>{
 let s=game();const c=add(s,'air_power');s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('AIR');
 expect(transition(s,{type:'SELECT_AIR_ACTION',seat:'germany',expectedRevision:s.revision,action:'supremacy'}).ok).toBe(false);
 s=send(s,{type:'SELECT_AIR_ACTION',action:'deploy'});s=JSON.parse(JSON.stringify(s));validateState(s);expect(projectState(s,{kind:'player',seat:'germany'},'germany')!.airAction).toBe('deploy');
 s=send(s,{type:'PLAY_CARD',cardId:c.id,effectIndices:[0],targetIds:[],guided:true});expect(s.resolution!.choice!.kind).toBe('ACTION');expect(s.resolution!.frames[0].effects.find(e=>e.kind==='action')).toMatchObject({airMode:'deploy'});
 s=complete(s);expect(s.units.some(u=>u.country==='germany'&&u.type==='air')).toBe(true);expect(s.phase).toBe('DISCARD');expect(s.airAction).toBeUndefined();
});
it('supremacy never offers deployment and consumes one standard air action',()=>{
 let s=game();const c=add(s,'air_power');s.units.push({id:'air',country:'germany',type:'air',regionId:'germany'},{id:'enemy',country:'united_kingdom',type:'air',regionId:'western_europe'});s=send(s,{type:'ADVANCE_PHASE'});s=send(s,{type:'SELECT_AIR_ACTION',action:'supremacy'});
 s=send(s,{type:'PLAY_CARD',cardId:c.id,effectIndices:[0],targetIds:[],guided:true});expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual(['western_europe']);s=complete(s);expect(s.units.some(u=>u.id==='enemy')).toBe(false);expect(s.phase).toBe('DISCARD');
});
it('air-start enhancement resolves before deciding that no standard air action is possible',()=>{
 let s=game('united_states');add(s,'special_116');s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('AIR');expect(s.resolution!.choice!.kind).toBe('TRIGGER');const q=s.resolution!.choice!;
 s=send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids:[q.options.find(o=>o.label.includes('喷火'))?.id??q.options[0].id],guided:true});s=complete(s);expect(s.units.some(u=>u.country==='united_kingdom'&&u.type==='air')).toBe(true);expect(s.phase).toBe('DISCARD');
});
it('kamikaze triggers at supply start and runs to the mandatory discard stop',()=>{
 let s=game('japan');add(s,'special_247','active');s.units=[{id:'a',country:'japan',type:'army',regionId:'eastern_china'},{id:'air',country:'japan',type:'air',regionId:'eastern_china'},{id:'target',country:'soviet_union',type:'army',regionId:'vladivostok'}];s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('SUPPLY');expect(airActionOptions(s).map(o=>o.id)).not.toContain('kamikaze');
 const q=s.resolution!.choice!;s=send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids:[q.options.find(o=>o.label==='神风敢死队')!.id],guided:true});s=complete(s);expect(s.units.some(u=>u.id==='air'||u.id==='target')).toBe(false);expect(s.phase).toBe('DISCARD');
});
it('a selected air mode can return to the menu or skip with the original phase button',()=>{
 let s=game();add(s,'air_power');s=send(s,{type:'ADVANCE_PHASE'});s=send(s,{type:'SELECT_AIR_ACTION',action:'deploy'});s=send(s,{type:'SELECT_AIR_ACTION',action:null});expect(s.airAction).toBeUndefined();s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('DISCARD');expect(s.decks.germany.hand).toHaveLength(1);
});
it('automatic supply work pauses for a removal response before continuing to score and discard',()=>{
 let s=game('soviet_union');add(s,'special_48','active');const c=add(s,'special_54');s.decks.soviet_union.hand=s.decks.soviet_union.hand.filter(v=>v.id!==c.id);s.decks.soviet_union.faceDown.push(c);s.units=s.units.filter(u=>u.country!=='soviet_union');s.units.push({id:'isolated',country:'soviet_union',type:'army',regionId:'ukraine'});
 s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('SUPPLY');expect(s.resolution!.choice!.seat).toBe('soviet_union');expect(s.units.some(u=>u.id==='isolated')).toBe(true);
 const q=s.resolution!.choice!;s=send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids:[q.options[0].id],guided:true});s=complete(s);expect(s.units.some(u=>u.id==='isolated')).toBe(true);expect(s.phase).toBe('DISCARD');
});
it('automatic scoring keeps the opponent counter window and counts territorial score only once',()=>{
 let s=game('italy');add(s,'special_212','active');const calm=add(s,'special_37');s.decks.united_kingdom.hand=s.decks.united_kingdom.hand.filter(c=>c.id!==calm.id);s.decks.united_kingdom.faceDown.push(calm);s.decks.united_kingdom.hand.push(...s.decks.united_kingdom.drawPile.splice(0,1));s.units.push({id:'it-west',country:'italy',type:'army',regionId:'western_europe'});
 s.phase='SUPPLY';s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('SCORE');expect(s.resolution!.choice!.seat).toBe('united_kingdom');expect(s.publicLog?.some(e=>e.text.startsWith('意大利计分阶段获得'))??false).toBe(false);
 s=complete(s);expect(s.phase).toBe('DISCARD');expect(s.publicLog!.filter(e=>e.text.startsWith('意大利计分阶段获得'))).toHaveLength(1);
});

it.each([['united_kingdom','france','western_europe','north_africa'],['united_states','china','eastern_china','western_china']] as const)('%s may move %s air but basic Air Power cannot deploy or use it for supremacy', (seat,minor,from,to)=>{
 let s=game(seat);s.phase='AIR';const d=s.decks[seat],fee=d.drawPile.splice(d.drawPile.findIndex(c=>c.definitionId==='air_power'),1)[0];d.hand.push(fee);
 // Supply flags keep this focused on ownership rather than overseas supply routes.
 s.units=[{id:'base',country:minor,type:'army',regionId:from},{id:'dest',country:minor,type:'army',regionId:to},{id:'minor-air',country:minor,type:'air',regionId:from}];
 s.turnFlags={protected:[],battleProtected:[],supplied:['base','dest'],supplyCountries:[],supplyRegions:[],suppressed:[],noAirDefense:false};
 const options=seatAirMoveOptions(s,seat);expect(options.some(o=>o.airId==='minor-air')).toBe(true);
 expect(airPowerOptions(s,seat)).toEqual([]);expect(airActionOptions(s).map(o=>o.enabled)).toEqual([true,false,false]);
 const option=options.find(o=>o.regionId===to)!;expect(option).toBeTruthy();
 s=send(s,{type:'SELECT_AIR_ACTION',action:'move'});s=send(s,{type:'MOVE_AIR',cardId:fee.id,optionId:option.id});
 s=complete(s);expect(s.units.find(u=>u.id==='minor-air')).toMatchObject({country:minor,regionId:to});
 expect(s.decks[seat].discardPile.some(c=>c.id===fee.id)).toBe(true);
});

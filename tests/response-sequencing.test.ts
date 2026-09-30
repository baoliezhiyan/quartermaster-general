import {it,expect} from 'vitest';
import {createGame,transition} from '../src/core';
import type {GameState,SeatId,CardInstance} from '../src/core';
import {startResolution,resolveChoice,waitingResponseSeats} from '../src/core/resolution';
import {cardEffects} from '../src/core/specialCards';
import {ALL_SPECIAL_CARDS} from '../src/core/cardCatalog';
import {projectState} from '../src/network/project';
function ready(seat:SeatId){const s=createGame('sequence',1940,'FULL');s.status='PLAYING';s.round=1;s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat=seat;for(const d of Object.values(s.decks))for(const z of ['hand','drawPile','discardPile','active','faceDown','resolving','removed'] as const)d[z]=[];return s;}
function special(s:GameState,id:number,zone:'hand'|'discardPile'|'faceDown'='hand'){const d=ALL_SPECIAL_CARDS.find(c=>c.sourceIndex===id)!;const c={id:`test:${id}`,definitionId:d.id,country:d.country,deckOwner:d.deckOwner};s.decks[d.deckOwner][zone].push(c);return c;}
function basic(s:GameState,seat:SeatId,id:string,zone:'hand'|'discardPile'|'drawPile'='discardPile'){const c:CardInstance={id:`${seat}:${id}:${s.decks[seat][zone].length}`,definitionId:id,country:seat,deckOwner:seat};s.decks[seat][zone].push(c);return c;}
function choose(s:GameState,ids:string[]){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);}
function trigger(s:GameState,id:number){const c=s.resolution!.choice!;const o=c.options.find(o=>o.id.includes(`test:${id}:`));expect(o,c.prompt+JSON.stringify(c.options)).toBeDefined();choose(s,[o!.id]);}
function finishUntilTrigger(s:GameState){for(let n=0;n<30&&s.resolution?.running&&s.resolution.choice?.kind!=='TRIGGER';n++){const c=s.resolution!.choice!;choose(s,c.options.slice(0,c.min).map(o=>o.id));}}
it('rechecks Fortress Rebuild after Asia Manpower supplies its hand cost at the same discard timing',()=>{
 const s=ready('soviet_union');s.phase='DISCARD';special(s,72);special(s,74);special(s,57,'discardPile');basic(s,'soviet_union','build_army');basic(s,'soviet_union','build_army');
 startResolution(s,'discard','soviet_union',[{kind:'signal',tag:'PHASE:DISCARD',label:'discard'}],[],undefined,'discardPile',true);
 expect(s.resolution!.choice!.options.some(o=>o.id.includes('test:74:'))).toBe(false);trigger(s,72);finishUntilTrigger(s);
 expect(s.decks.soviet_union.hand.filter(c=>c.definitionId==='build_army')).toHaveLength(2);trigger(s,74);
 expect(s.resolution!.choice!.kind).toBe('PAY_COST');choose(s,[s.decks.soviet_union.hand.find(c=>c.definitionId==='build_army')!.id]);finishUntilTrigger(s);
 expect(s.decks.soviet_union.faceDown.some(c=>c.definitionId==='special_57')).toBe(true);
});
it('rechecks Pappy after Pacific Bases recruits the Hawaiian army in the same score timing',()=>{
 const s=ready('united_states');s.phase='SCORE';s.units=[];special(s,117);special(s,120);basic(s,'united_states','build_army','drawPile');basic(s,'united_states','build_army','drawPile');
 startResolution(s,'score','united_states',[{kind:'signal',tag:'PHASE:SCORE',label:'score'}],[],undefined,'discardPile',true);
 expect(s.resolution!.choice!.options.some(o=>o.id.includes('test:117:'))).toBe(false);trigger(s,120);
 for(let n=0;n<20&&s.resolution?.choice?.kind!=='TRIGGER';n++){const c=s.resolution!.choice!;const o=c.options.find(o=>o.id==='hawaii');choose(s,o?[o.id]:c.options.slice(0,Math.max(1,c.min)).map(o=>o.id));}
 expect(s.units.some(u=>u.regionId==='hawaii'&&u.type==='army')).toBe(true);trigger(s,117);
 for(let n=0;n<20&&s.resolution?.choice&&s.resolution.choice.kind!=='TRIGGER';n++){const c=s.resolution.choice;const o=c.options.find(o=>o.id==='hawaii');choose(s,o?[o.id]:c.options.slice(0,Math.max(1,c.min)).map(o=>o.id));}
 expect(s.units.some(u=>u.regionId==='hawaii'&&u.type==='air')).toBe(true);
});
it('reveals independently, displays an unplayable card, then offers Germany before Japan with waiting hints',()=>{
 let s=ready('italy');const card=special(s,236);basic(s,'germany','build_army');basic(s,'japan','build_army');const unplayable=special(s,219,'discardPile');
 startResolution(s,'乔里亚尼号、卡佩里尼海军司令号','italy',cardEffects(s,card),[],card.id,'discardPile',false);
 const group=structuredClone(s.resolution!.revealGroup!);expect(group.items.map(i=>i.seat)).toEqual(['germany','italy','japan']);expect(s.resolution!.choice).toBeNull();
 const ack=(seat:SeatId,id:string)=>{s.viewSeat=seat;const result=transition(s,{type:'ACK_RESPONSE_NOTICE',seat,expectedRevision:s.revision,noticeId:id});expect(result.ok).toBe(true);if(result.ok)s=result.state;};
 for(const seat of ['japan','italy','germany'] as SeatId[]){const i=group.items.find(i=>i.seat===seat)!;const before=projectState(s,{kind:'player',seat},seat)!;expect(before.resolution!.revealGroup).toBeUndefined();expect(before.responseNotices?.find(n=>n.id===i.requestId)?.cards).toEqual([]);ack(seat,i.requestId);expect(s.responseNotices!.find(n=>n.id===i.resultId)!.cards).toHaveLength(1);if(seat==='italy')expect(s.responseNotices!.find(n=>n.id===i.resultId)!.text).toContain('不能打出');ack(seat,i.resultId);if(seat!=='germany')expect(s.resolution!.choice).toBeNull();}
 expect(s.decks.italy.drawPile[0].id).toBe(unplayable.id);expect(s.resolution!.choice!.seat).toBe('germany');expect(waitingResponseSeats(s,'japan')).toEqual(['germany']);expect(waitingResponseSeats(s,'united_kingdom')).toEqual([]);
 const projected=projectState(s,{kind:'player',seat:'japan'},'japan')!;expect(projected.resolution!.choice).toBeNull();expect(waitingResponseSeats(projected,'japan')).toEqual([]);expect(projected.resolution!.waiting).toBe(true);expect(projected.resolution).not.toHaveProperty('waitingFor');
 choose(s,[]);expect(s.resolution!.choice!.seat).toBe('japan');choose(s,[]);expect(s.resolution!.running).toBe(false);
});
it('shows the attacking UK a safe waiting hint for Italian mountain troops, not unrelated players',()=>{
 const s=ready('united_kingdom');special(s,219,'faceDown');s.units=[{id:'uk',country:'united_kingdom',type:'army',regionId:'western_europe'},{id:'it',country:'italy',type:'army',regionId:'italy'}];
 startResolution(s,'attack','united_kingdom',[{kind:'action',country:'united_kingdom',action:'land_battle',regions:['italy'],label:'attack'}],[]);
 for(let n=0;n<10&&s.resolution?.choice?.kind!=='TRIGGER';n++){const c=s.resolution!.choice!;choose(s,[c.options[0].id]);}
 expect(s.resolution!.choice!.seat).toBe('italy');expect(projectState(s,{kind:'player',seat:'united_kingdom'},'united_kingdom')!.resolution!.waiting).toBe(true);expect(projectState(s,{kind:'player',seat:'germany'},'germany')!.resolution!.waiting).toBe(false);
});

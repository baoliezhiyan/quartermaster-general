import { describe, expect, it } from 'vitest';
import { createGame, transition, SEATS, TURN_PHASES } from '../src/core';
import type { Command, CountryId, GameState, SeatId, Unit } from '../src/core';
import { BASIC_COUNTS, REALLOCATION_CARD_IDS, canReallocateCard, phaseCountries, reserve, UNIT_TOTALS } from '../src/core/basic';
import { allianceScores, countryScore, suppliedUnits, unsuppliedForPhase } from '../src/core/supply';
import { airMoveOptions, cardOptions } from '../src/core/actions';
import { REGIONS } from '../src/core/map';

function send(state: GameState, payload: Record<string,unknown>): GameState {
  const command = { seat:state.operatorSeat,expectedRevision:state.revision,...payload } as Command;
  const result = transition(state,command);
  if (!result.ok) throw new Error(`${JSON.stringify(command)}: ${result.error}`);
  return result.state;
}
function started(seed = 1940): GameState {
  let state = createGame('test',seed);
  for (const seat of SEATS) state = send(state,{ type:'KEEP_OPENING',cardIds:state.decks[seat].hand.slice(0,7).map(c => c.id) });
  return state;
}
function unit(country: CountryId, type: Unit['type'], regionId: string): Unit { return { id:`${country}:${type}:${regionId}`,country,type,regionId }; }
function atPhase(phase: GameState['phase'], seat: SeatId = 'germany') {
  const state = started(); state.phase=phase; state.activeSeat=state.viewSeat=state.operatorSeat=seat; return state;
}
function addBasic(state: GameState, id: string) {
  const card = { id:`test:${id}`,definitionId:id,country:state.activeSeat,deckOwner:state.activeSeat };
  state.decks[state.activeSeat].hand.push(card); return card.id;
}

describe('opening and deterministic basic decks', () => {
  it('deploys all eight countries without build events and deducts their stock', () => {
    const s = createGame('x',0);
    expect(s.units).toHaveLength(8);
    for (const region of REGIONS.filter(r => r.initialArmyCountry)) {
      const country=region.initialArmyCountry!;
      expect(s.units).toContainEqual({ id:`initial:${country}`,country,type:'army',regionId:region.id });
      expect(reserve(s,country,'army')).toBe(UNIT_TOTALS[country].army-1);
    }
    expect(s.events.map(e => e.type)).toEqual(['GAME_CREATED']);
  });
  it('uses exact basic counts, twelve-card opening and distinct identities', () => {
    const s=createGame('x',4), ids:string[]=[];
    for (const seat of SEATS) {
      const d=s.decks[seat]; expect(d.hand).toHaveLength(12);
      expect(d.hand.length+d.drawPile.length).toBe(BASIC_COUNTS[seat].reduce((a,b)=>a+b));
      ids.push(...[...d.hand,...d.drawPile].map(c=>c.id));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(s).toEqual(createGame('x',4));
    expect(s.decks).not.toEqual(createGame('x',5).decks);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
  it('requires seven distinct owned cards, waits for all six and charges no setup penalty', () => {
    const s=createGame('x',0), ids=s.decks.germany.hand.map(c=>c.id);
    for (const invalid of [ids.slice(0,6),ids.slice(0,8),Array(7).fill(ids[0]),[...ids.slice(0,6),'foreign']]) {
      expect(transition(s,{ type:'KEEP_OPENING',seat:'germany',expectedRevision:0,cardIds:invalid }).ok).toBe(false);
    }
    const one=send(s,{type:'KEEP_OPENING',cardIds:ids.slice(0,7)});
    expect(one.phase).toBe('SETUP'); expect(one.operatorSeat).toBe('united_kingdom');
    const ready=started(0); expect(ready).toMatchObject({status:'PLAYING',round:1,phase:'TURN_START_WINDOW',activeSeat:'germany'});
    for (const seat of SEATS) { expect(ready.decks[seat].hand).toHaveLength(7); expect(ready.decks[seat].discardPile).toHaveLength(5); expect(ready.scores[seat]).toBe(0); }
    expect(s.decks.germany.hand).toHaveLength(12);
  });
});

describe('turn phases and card choices', () => {
  it('visits seven phases in order; passing play costs one point and discard requires explicit choice', () => {
    let s=started(); const phases=[s.phase]; const cards=s.decks.germany.hand.map(c=>c.id);
    for(let i=0;i<5;i++) { s=send(s,{type:'ADVANCE_PHASE'}); phases.push(s.phase); }
    expect(s.phase).toBe('DISCARD'); expect(s.decks.germany.hand.map(c=>c.id)).toEqual(cards);
    expect(s.scores.germany).toBe(1);
    expect(transition(s,{type:'ADVANCE_PHASE',seat:'germany',expectedRevision:s.revision}).ok).toBe(false);
    s=send(s,{type:'DISCARD_HAND',cardIds:[cards[0]]}); phases.push(s.phase);
    expect(phases).toEqual(TURN_PHASES); expect(s.decks.germany.hand).toHaveLength(7);
    s=send(s,{type:'ADVANCE_PHASE'}); expect(s).toMatchObject({activeSeat:'united_kingdom',viewSeat:'united_kingdom',phase:'TURN_START_WINDOW',round:1});
  });
  it('rejects wrong operator, stale choices, invalid ids and duplicate discards atomically', () => {
    const s=atPhase('DISCARD'), before=JSON.stringify(s);
    for(const payload of [{seat:'japan',cardIds:[]},{expectedRevision:999,cardIds:[]},{cardIds:['unknown']},{cardIds:[s.decks.germany.hand[0].id,s.decks.germany.hand[0].id]}]) {
      expect(transition(s,{type:'DISCARD_HAND',seat:'germany',expectedRevision:s.revision,...payload} as Command).ok).toBe(false);
    }
    expect(JSON.stringify(s)).toBe(before);
    const viewed=send(s,{type:'SET_VIEW',seat:'japan'});
    expect(viewed.activeSeat).toBe('germany'); expect(send(viewed,{type:'SET_VIEW',seat:'germany'}).phase).toBe('DISCARD');
  });
  it('zero discard is free with either a nonempty or empty hand', () => {
    for(const empty of [false,true]) {
      const s=atPhase('DISCARD'); s.decks.germany.drawPile=[]; if(empty)s.decks.germany.hand=[];
      const next=send(s,{type:'DISCARD_HAND',cardIds:[]});
      expect(next.scores.germany).toBe(s.scores.germany); expect(next.phase).toBe('DRAW');
      expect(next.events.filter(e=>e.type==='RULE_EVENT'&&e.code==='DISCARD_PHASE_POINT_LOSS')).toHaveLength(0);
    }
  });
  it('pays three for reallocation, takes only from draw pile, shuffles deterministically and stays in start window', () => {
    const s=started(), d=s.decks.germany;
    const target=d.drawPile.find(canReallocateCard)!;
    const command={type:'REDISTRIBUTE',cardIds:d.hand.slice(0,3).map(c=>c.id),takeCardId:target.id};
    const n=send(s,command); expect(n).toEqual(send(s,command)); expect(n.phase).toBe('TURN_START_WINDOW');
    expect(n.decks.germany.hand).toHaveLength(5); expect(n.redistributed).toBe(true);
    expect(n.decks.germany.hand.some(c=>c.id===target.id)).toBe(true);
    expect(transition(n,{...command,type:'REDISTRIBUTE',seat:'germany',expectedRevision:n.revision}).ok).toBe(false);
    expect(transition(s,{...command,type:'REDISTRIBUTE',seat:'germany',expectedRevision:s.revision,cardIds:d.hand.slice(0,2).map(c=>c.id)}).ok).toBe(false);
  });
  it('allows all five basic cards for reallocation retrieval and air power as a cost', () => {
    expect(REALLOCATION_CARD_IDS).toEqual(['build_army','land_battle','build_navy','sea_battle','air_power']);
    const s=started(), d=s.decks.germany;
    const air={id:'reallocation-air',definitionId:'air_power',country:'germany' as const,deckOwner:'germany' as const};
    d.drawPile.push(air);
    const before=JSON.stringify(s);
    expect(transition(s,{type:'REDISTRIBUTE',seat:'germany',expectedRevision:s.revision,cardIds:d.hand.slice(0,3).map(c=>c.id),takeCardId:air.id}).ok).toBe(true);
    expect(JSON.stringify(s)).toBe(before);
    for(const definitionId of REALLOCATION_CARD_IDS) {
      const test=structuredClone(s), deck=test.decks.germany;
      const costAir={...air,id:'air-as-cost'};deck.hand.push(costAir);
      const target={...air,id:`target:${definitionId}`,definitionId};deck.drawPile.push(target);
      const n=send(test,{type:'REDISTRIBUTE',cardIds:[costAir.id,...deck.hand.slice(0,2).map(c=>c.id)],takeCardId:target.id});
      expect(n.decks.germany.hand.some(c=>c.id===target.id)).toBe(true);
      expect(n.decks.germany.discardPile.some(c=>c.id===costAir.id)).toBe(true);
    }
  });
  it('executes a legal basic build once then enters air; illegal options do not spend the card', () => {
    const s=atPhase('PLAY'), id=addBasic(s,'build_army');
    const option=cardOptions(s,id).find(o=>o.regionId==='eastern_europe')!;
    expect(option).toBeDefined();
    expect(transition(s,{type:'PLAY_BASIC',seat:'germany',expectedRevision:s.revision,cardId:id,optionId:'invalid'}).ok).toBe(false);
    const n=send(s,{type:'PLAY_BASIC',cardId:id,optionId:option.id});
    expect(n.units.some(u=>u.country==='germany'&&u.regionId==='eastern_europe')).toBe(true);
    expect(n.phase).toBe('AIR'); expect(n.decks.germany.discardPile.some(c=>c.id===id)).toBe(true);
    expect(cardOptions(n,n.decks.germany.hand.find(c=>c.definitionId==='build_army')?.id??'')).toEqual([]);
  });
  it('allows in-place repeat even at zero reserve without consuming or removing a unit', () => {
    const s=atPhase('PLAY'); s.units=['germany','western_europe','eastern_europe','ukraine','balkans','moscow','ross_region'].map((r,i)=>unit('germany','army',i===0?'germany':r));
    expect(reserve(s,'germany','army')).toBe(0);
    const id=addBasic(s,'build_army'), option=cardOptions(s,id).find(o=>o.regionId==='germany'&&!o.recycleId)!;
    const n=send(s,{type:'PLAY_BASIC',cardId:id,optionId:option.id}); expect(n.units).toEqual(s.units);
  });
  it('does not expose air power in play phase; deployment consumes stock and advances through supply', () => {
    const s=atPhase('PLAY'), id=addBasic(s,'air_power'); expect(cardOptions(s,id)).toEqual([]);
    s.phase='AIR'; const option=cardOptions(s,id).find(o=>o.mode==='deploy')!;
    const n=send(s,{type:'PLAY_BASIC',cardId:id,optionId:option.id}); expect(n.phase).toBe('SUPPLY');
    expect(reserve(n,'germany','air')).toBe(UNIT_TOTALS.germany.air-1);
  });
  it('paid air movement changes only the selected air position and discards one hand card', () => {
    const s=atPhase('AIR'); s.units.push(unit('germany','army','eastern_europe'),unit('germany','air','germany'));
    const option=airMoveOptions(s,'germany').find(o=>o.regionId==='eastern_europe')!;
    const id=s.decks.germany.hand[0].id, n=send(s,{type:'MOVE_AIR',cardId:id,optionId:option.id});
    expect(n.units.find(u=>u.type==='air')?.regionId).toBe('eastern_europe'); expect(n.decks.germany.hand).toHaveLength(6);
  });
  it('offers enemy targets and default air defense with an explicit interception choice', () => {
    for (const intercept of [false,true]) {
      const s=atPhase('PLAY'); s.units.push(unit('germany','air','germany'),unit('france','air','western_europe'));
      const id=addBasic(s,'land_battle');
      const option=cardOptions(s,id).find(o=>o.regionId==='western_europe'&&o.intercept===intercept)!;
      expect(option).toBeDefined();
      const n=send(s,{type:'PLAY_BASIC',cardId:id,optionId:option.id});
      expect(n.units.some(u=>u.country==='france'&&u.type==='army')).toBe(!intercept);
      expect(n.units.some(u=>u.country==='france'&&u.type==='air')).toBe(false);
      expect(n.units.some(u=>u.country==='germany'&&u.type==='air')).toBe(!intercept);
      expect(n.phase).toBe('AIR');
    }
  });
  it('permits battle against an empty region, while friendly-occupied targets are excluded', () => {
    const s=atPhase('PLAY'), id=addBasic(s,'land_battle');
    const options=cardOptions(s,id);
    expect(options.some(o=>o.regionId==='italy')).toBe(false);
    const empty=options.find(o=>o.regionId==='eastern_europe')!; expect(empty.defenderId).toBeUndefined();
    const n=send(s,{type:'PLAY_BASIC',cardId:id,optionId:empty.id}); expect(n.units).toEqual(s.units); expect(n.phase).toBe('AIR');
  });
  it('preserves a pending air relocation across a recycled build and resumes the phase exactly once', () => {
    const s=atPhase('PLAY');
    s.units=['germany','western_europe','eastern_europe','ukraine','balkans','moscow','ross_region'].map(r=>unit('germany','army',r));
    const air=unit('germany','air','western_europe');s.units.push(air);
    const id=addBasic(s,'build_army');
    const option=cardOptions(s,id).find(o=>o.recycleId==='germany:army:western_europe')!;expect(option).toBeDefined();
    let n=send(s,{type:'PLAY_BASIC',cardId:id,optionId:option.id});
    expect(n.pendingAir).toEqual([air.id]);expect(n.resumePhase).toBe('AIR');
    expect(cardOptions(n,n.decks.germany.hand[0].id)).toEqual([]);
    n=send(n,{type:'RELOCATE_AIR',regionId:'germany'});
    expect(n.pendingAir).toEqual([]); expect(n.resumePhase).toBeNull(); expect(n.phase).toBe('AIR');
    expect(n.decks.germany.discardPile.filter(c=>c.id===id)).toHaveLength(1);
  });
});

describe('iterative supply and simultaneous clearance', () => {
  it('requires a supplied chain AND adjacent friendly army for a navy', () => {
    const s=started(); s.units=[unit('united_kingdom','army','british_isles'),unit('united_kingdom','navy','sea_north_sea'),unit('united_kingdom','navy','sea_mid_atlantic')];
    const supplied=suppliedUnits(s); expect(supplied.has(s.units[1].id)).toBe(true); expect(supplied.has(s.units[2].id)).toBe(false);
    s.units.push(unit('france','army','south_africa')); expect(suppliedUnits(s).has(s.units[2].id)).toBe(true);
  });
  it('can add a navy then restore an adjacent army; unsupported cycles stay unsupplied', () => {
    const s=started(); s.units=[unit('united_kingdom','army','british_isles'),unit('united_kingdom','navy','sea_north_sea'),unit('united_kingdom','navy','sea_baltic'),unit('united_kingdom','army','eastern_europe'),unit('france','army','scandinavia')];
    expect(suppliedUnits(s).has(s.units[3].id)).toBe(true);
    s.units=[unit('germany','army','north_africa'),unit('germany','navy','sea_mid_atlantic')]; expect(suppliedUnits(s).size).toBe(0);
  });
  it('UK/France clear from the same snapshot, independent of unit traversal order', () => {
    const s=atPhase('AIR','united_kingdom');
    s.units=[unit('united_kingdom','army','british_isles'),unit('united_kingdom','navy','sea_north_sea'),unit('united_kingdom','navy','sea_baltic'),unit('france','army','scandinavia')];
    const before=unsuppliedForPhase(s,'united_kingdom'); expect(before).toEqual([s.units[3].id]);
    const reversed={...s,units:[...s.units].reverse()}; expect(unsuppliedForPhase(reversed,'united_kingdom')).toEqual(before);
    const n=send(s,{type:'ADVANCE_PHASE'}); expect(n.units).toHaveLength(3); expect(n.units.some(u=>u.regionId==='sea_baltic')).toBe(true);
  });
  it('China clears only in the US phase regardless of card provenance', () => {
    const s=started(); s.units.push(unit('china','army','south_africa'),unit('france','army','south_africa'));
    expect(unsuppliedForPhase(s,'soviet_union')).toEqual([]);
    expect(unsuppliedForPhase(s,'united_states')).toContain('china:army:south_africa');
    expect(unsuppliedForPhase(s,'united_kingdom')).toContain('france:army:south_africa');
    expect(phaseCountries('united_states')).toEqual(['united_states','china']);
  });
});

describe('scoring and victory', () => {
  it('scores France/China independently and checks each homeland separately', () => {
    const s=atPhase('SUPPLY','united_states');
    s.units=s.units.filter(u=>u.country!=='china'); s.units.push(unit('china','army','india'),unit('japan','army','eastern_china'));
    expect(countryScore(s,'china')).toBe(0); expect(countryScore(s,'united_states')).toBe(2);
    const n=send(s,{type:'ADVANCE_PHASE'}); expect(n.scores.united_states).toBe(2);
    const uk=atPhase('SUPPLY','united_kingdom'); expect(send(uk,{type:'ADVANCE_PHASE'}).scores.united_kingdom).toBe(4);
    uk.units=uk.units.filter(u=>u.country!=='france'); uk.units.push(unit('germany','army','western_europe'),unit('france','army','india'));
    expect(countryScore(uk,'france')).toBe(0); expect(countryScore(uk,'united_kingdom')).toBe(2);
  });
  it('splits occupied supply scoring as one point per friendly nation', () => {
    const s=started(); s.units.push(unit('france','army','british_isles'));
    expect(countryScore(s,'united_kingdom')).toBe(1); expect(countryScore(s,'france')).toBe(3);
  });
  it('checks both alliances at US turn end, with a >=30 threshold',()=>{
    for(const lead of [29,30,-29,-30]){const s=atPhase('DRAW','united_states');s.scores.germany=Math.max(0,lead);s.scores.united_kingdom=Math.max(0,-lead);const n=send(s,{type:'ADVANCE_PHASE'});expect(n.status).toBe(Math.abs(lead)===30?'FINISHED':'PLAYING');if(Math.abs(lead)===30)expect(n).toMatchObject({winner:lead>0?'axis':'allies',victoryReason:lead>0?'AXIS_LEAD':'ALLIES_LEAD',axisBonus:0});}
    const s=atPhase('SUPPLY','united_states');s.scores.germany=200;expect(send(s,{type:'ADVANCE_PHASE'}).status).toBe('PLAYING');
  });
  it('runs 20 complete rounds of six countries without special cards, then adds exactly half a point', () => {
    let s=started(); const order:SeatId[]=[]; let guard=0;
    while(s.status!=='FINISHED' && guard++<1000) {
      if(s.phase==='TURN_START_WINDOW') order.push(s.activeSeat);
      // Keep this lifecycle fixture below the early-victory threshold.
      if(s.phase==='DRAW'&&s.activeSeat==='united_states')s.scores.germany=s.scores.united_kingdom+s.scores.soviet_union+s.scores.united_states-s.scores.italy-s.scores.japan-1;
      s=send(s,s.phase==='DISCARD'?{type:'DISCARD_HAND',cardIds:s.decks[s.activeSeat].hand.slice(0,1).map(c=>c.id)}:{type:'ADVANCE_PHASE'});
    }
    expect(order).toHaveLength(120);for(let i=0;i<120;i++)expect(order[i]).toBe(SEATS[i%6]);
    expect(s).toMatchObject({round:20,activeSeat:'united_states',phase:'DRAW',status:'FINISHED',axisBonus:.5,victoryReason:'TWENTY_ROUNDS',winner:'allies'});
    expect(allianceScores(s).axis%1).toBe(.5);
    expect(transition(s,{type:'ADVANCE_PHASE',seat:s.operatorSeat,expectedRevision:s.revision}).ok).toBe(false);
  });
  it('resolves a tied integer total in favor of the axis at twenty complete rounds', () => {
    const s=atPhase('DRAW','united_states');s.round=20;
    const n=send(s,{type:'ADVANCE_PHASE'}); expect(n.winner).toBe('axis');expect(allianceScores(n)).toEqual({axis:.5,allies:0});
  });
});

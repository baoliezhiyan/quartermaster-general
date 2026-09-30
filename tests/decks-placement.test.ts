import { describe, expect, it } from 'vitest';
import { createGame, transition, SEATS } from '../src/core';
import type { Command, GameState } from '../src/core';
import { drawCards, payDiscardCost, forceDiscardHand, discardPhase, discardDeckTop } from '../src/core/decks';
import { placementPlans } from '../src/core/placement';
import { reserve } from '../src/core/basic';
import { suppliedUnits } from '../src/core/supply';

function send(s: GameState, payload: Record<string,unknown>) {
  const result = transition(s,{ seat:s.operatorSeat,expectedRevision:s.revision,...payload } as Command);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}
function started() {
  let s = createGame('stage4',0);
  for (const seat of SEATS) s = send(s,{type:'KEEP_OPENING',cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)});
  return s;
}
describe('distinct card movement semantics',()=>{
  it('rejects incomplete, duplicate and foreign voluntary costs without moving cards',()=>{
    const s=started(), before=structuredClone(s), ids=s.decks.germany.hand.map(c=>c.id);
    for (const selection of [ids.slice(0,2),[ids[0],ids[0],ids[1]],['foreign',...ids.slice(0,2)]]) expect(payDiscardCost(s,'germany',3,selection)).toBe(false);
    expect(s).toEqual(before);
    expect(payDiscardCost(s,'germany',3,ids.slice(0,3))).toBe(true);
    expect(s.decks.germany.hand).toHaveLength(4);
    expect(s.scores.germany).toBe(0);
  });
  it('forced shortage discards all available with no penalty, including an empty hand',()=>{
    const s=started(), ids=s.decks.germany.hand.map(c=>c.id);
    expect(forceDiscardHand(s,'germany',10,ids.slice(0,6))).toBe(false);
    expect(forceDiscardHand(s,'germany',10,ids)).toBe(true);
    expect(forceDiscardHand(s,'germany',10,[])).toBe(true);
    expect(s.scores.germany).toBe(0);
    expect(discardPhase(s,'germany',[])).toBe(true);
    expect(s.scores.germany).toBe(0);
  });
  it('deck-top shortfalls are sequential losses to the deck owner and never recycle discards',()=>{
    const s=started(), deck=s.decks.united_kingdom;
    drawCards(s,'united_kingdom',deck.drawPile.length-2);
    const remaining=[...deck.drawPile], initial=deck.discardPile.length;
    expect(discardDeckTop(s,'united_kingdom',5)).toEqual({discarded:2,lost:3});
    expect(deck.discardPile.slice(initial)).toEqual(remaining);
    expect(s.scores.united_kingdom).toBe(-3); expect(s.scores.germany).toBe(0);
    expect(s.events.slice(-5).map(e=>e.type === 'RULE_EVENT' && e.code)).toEqual(['DECK_TOP_DISCARDED','DECK_TOP_DISCARDED','DECK_TOP_SHORTFALL','DECK_TOP_SHORTFALL','DECK_TOP_SHORTFALL']);
    expect(drawCards(s,'united_kingdom',7)).toBe(0); expect(s.scores.united_kingdom).toBe(-3);
  });
  it('pauses for the opponent hand owner and restores the acting seat after exact selection',()=>{
    const s=started();
    let next=send(s,{type:'DEBUG_DECK',operation:'force',target:'united_kingdom',count:3,cardIds:[]});
    expect(next.operatorSeat).toBe('united_kingdom'); expect(next.activeSeat).toBe('germany');
    expect(next.settings.ignoreOtherPlayerInterrupts).toBe(true);
    expect(transition(next,{type:'ADVANCE_PHASE',seat:'united_kingdom',expectedRevision:next.revision}).ok).toBe(false);
    const ids=next.decks.united_kingdom.hand.slice(0,3).map(c=>c.id);
    expect(transition(next,{type:'RESOLVE_FORCED_DISCARD',seat:'germany',expectedRevision:next.revision,cardIds:ids}).ok).toBe(false);
    const oldRevision=next.revision;
    next=send(next,{type:'RESOLVE_FORCED_DISCARD',cardIds:ids});
    expect(next).toMatchObject({pendingDiscard:null,operatorSeat:'germany',viewSeat:'germany',phase:s.phase});
    expect(next.decks.united_kingdom.hand).toHaveLength(4);
    expect(transition(next,{type:'RESOLVE_FORCED_DISCARD',seat:'germany',expectedRevision:oldRevision,cardIds:ids}).ok).toBe(false);
  });
  it('auto resolves forced all/zero cards without a meaningless choice',()=>{
    let s=started();
    s=send(s,{type:'DEBUG_DECK',operation:'force',target:'japan',count:99,cardIds:[]});
    expect(s.pendingDiscard).toBeNull(); expect(s.decks.japan.hand).toHaveLength(0);
    expect(s.scores.japan).toBe(0);
    s=send(s,{type:'DEBUG_DECK',operation:'force',target:'japan',count:3,cardIds:[]});
    expect(s.pendingDiscard).toBeNull(); expect(s.operatorSeat).toBe('germany');
  });
});
describe('atomic placement and independent inventories',()=>{
  it('recruits at an effect region without build supply conditions, but rejects sea and enemies',()=>{
    const s=started();
    expect(placementPlans(s,{country:'germany',unitType:'army',mode:'build',regionIds:['australia']})).toEqual([]);
    expect(placementPlans(s,{country:'germany',unitType:'army',mode:'recruit',regionIds:['australia']})).toHaveLength(1);
    for (const regionId of ['sea_north_sea','moscow']) expect(placementPlans(s,{country:'germany',unitType:'army',mode:'recruit',regionIds:[regionId]})).toEqual([]);
    expect(placementPlans(s,{country:'germany',unitType:'army',mode:'recruit'})).toEqual([]);
  });
  it('uses reserves first and never offers voluntary recycling',()=>{
    const plans=placementPlans(started(),{country:'germany',unitType:'army',mode:'build'});
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every(p=>!p.recycleId)).toBe(true);
  });
  it('emits repeat recruitment referring to the original unit with zero stock and no removal',()=>{
    const s=started();
    s.units.push({id:'china:second',country:'china',type:'army',regionId:'western_china'});
    expect(reserve(s,'china','army')).toBe(0);
    const initial=s.units.find(u=>u.country==='china' && u.id!=='china:second')!;
    const plan=placementPlans(s,{country:'china',unitType:'army',mode:'recruit',regionIds:[initial.regionId]})[0];
    expect(plan.recycleId).toBeUndefined(); expect(plan.existingId).toBe(initial.id);
    const next=send(s,{type:'DEBUG_PLACEMENT',country:'china',unitType:'army',mode:'recruit',regionId:initial.regionId,optionId:plan.id,cost:0,cardIds:[]});
    expect(next.units).toEqual(s.units);
    expect(next.events).toContainEqual({type:'UNIT_PLACED',revision:next.revision,mode:'recruit',country:'china',unitId:initial.id,regionId:initial.regionId,repeated:true});
  });
  it('rechecks supply after removal and excludes an incomplete plan before any fee',()=>{
    const s=started();
    // All German stock is used, but only the HQ supplies a route into Eastern Europe.
    const remote=['australia','new_zealand','latin_america','canada','western_china','india'];
    s.units.push(...remote.map((regionId,i)=>({id:`remote:${i}`,country:'germany' as const,type:'army' as const,regionId})));
    const request={country:'germany' as const,unitType:'army' as const,mode:'build' as const,regionIds:['eastern_europe']};
    expect(reserve(s,'germany','army')).toBe(0);
    const plans=placementPlans(s,request);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.some(p=>p.recycleId==='initial:germany')).toBe(false);
    const before=structuredClone(s), cards=s.decks.germany.hand.slice(0,2).map(c=>c.id);
    expect(transition(s,{type:'DEBUG_PLACEMENT',seat:'germany',expectedRevision:s.revision,...request,regionId:'eastern_europe',optionId:'build:eastern_europe:initial:germany',cost:2,cardIds:cards}).ok).toBe(false);
    expect(s).toEqual(before);
    const next=send(s,{type:'DEBUG_PLACEMENT',...request,regionId:'eastern_europe',optionId:plans[0].id,cost:2,cardIds:cards});
    expect(reserve(next,'germany','army')).toBe(0);
    expect(next.units.some(u=>u.id===plans[0].recycleId)).toBe(false);
    expect(next.decks.germany.hand).toHaveLength(5);
    expect(suppliedUnits(next).has(`unit:${next.revision}`)).toBe(true);
  });
  it('pays the acting deck while recruiting another country and leaves its own inventory alone',()=>{
    const s=started(), regionId='western_china';
    const plan=placementPlans(s,{country:'china',unitType:'army',mode:'recruit',regionIds:[regionId]})[0];
    const next=send(s,{type:'DEBUG_PLACEMENT',country:'china',unitType:'army',mode:'recruit',regionId,optionId:plan.id,cost:1,cardIds:[s.decks.germany.hand[0].id]});
    expect(reserve(next,'china','army')).toBe(reserve(s,'china','army')-1);
    expect(reserve(next,'germany','army')).toBe(reserve(s,'germany','army'));
    expect(next.decks.germany.hand).toHaveLength(6); expect(next.decks.united_states).toEqual(s.decks.united_states);
  });
});

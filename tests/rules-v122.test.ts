import { describe, expect, it } from 'vitest';
import { createGame, transition } from '../src/core';
import type { Command, GameState, SeatId } from '../src/core';
import { payDiscardCost } from '../src/core/decks';
import { canAffordHandCost } from '../src/core/cardCosts';
import { resolveChoice, startResolution } from '../src/core/resolution';
import type { Effect, TriggerRule } from '../src/core/resolutionTypes';
import { cardEffects } from '../src/core/specialCards';
import { specialCard } from '../src/core/cardCatalog';

function state() {const s=createGame('v122',1940,'FULL');s.status='PLAYING';s.round=1;s.phase='PLAY';return s;}
function take(s:GameState,id:string,zone:'hand'|'active'='hand') {
  for(const seat of Object.keys(s.decks) as SeatId[])for(const from of ['hand','drawPile','discardPile','active','faceDown'] as const) {
    const d=s.decks[seat],index=d[from].findIndex(c=>c.definitionId===id);
    if(index>=0){const [card]=d[from].splice(index,1);d[zone].push(card);return card;}
  }
  throw new Error(id);
}
function trim(s:GameState,seat:SeatId,n:number) {const d=s.decks[seat];d.discardPile.push(...d.hand.splice(n));}
function choose(s:GameState,ids:string[]) {const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);}
function finish(s:GameState) {
  for(let i=0;s.resolution?.running&&i<100;i++) {const c=s.resolution.choice!;choose(s,c.kind==='TRIGGER'?[]:c.options.slice(0,c.min).map(o=>o.id));}
  expect(s.resolution?.running).toBe(false);
}
const fee=(count:number):Effect=>({kind:'cards',seat:'germany',from:'hand',to:'discardPile',min:count,max:count,fee:true,label:'弃手牌费用'});
const gain:Effect={kind:'score',seat:'germany',amount:3,label:'获得三分'};

describe('v1.4.0 full hand costs',()=>{
  it.each([0,1,2,3,4])('requires three actual cards with %s available',n=>{
    const s=state();trim(s,'germany',n);const before=structuredClone(s);
    expect(payDiscardCost(s,'germany',3,s.decks.germany.hand.slice(0,3).map(c=>c.id),true)).toBe(n>=3);
    if(n<3)expect(s).toEqual(before);
    else {expect(s.decks.germany.hand).toHaveLength(n-3);expect(s.decks.germany.drawPile).toEqual(before.decks.germany.drawPile);expect(s.scores).toEqual(before.scores);}
  });
  it('excludes the played source and requires two OTHER cards',()=>{
    const s=state();trim(s,'germany',0);const source=take(s,'special_153');take(s,'build_army');const before=structuredClone(s);
    expect(startResolution(s,'test','germany',[fee(2),gain],[],source.id)).toBe(false);expect(s).toEqual(before);
    take(s,'build_navy');expect(startResolution(s,'test','germany',[fee(2),gain],[],source.id)).toBe(true);
    expect(s.resolution!.choice).toMatchObject({kind:'CARDS',min:2,max:2});choose(s,s.decks.germany.hand.map(c=>c.id));finish(s);expect(s.scores.germany).toBe(3);
  });
  it('reserves distinct cards across all fee steps and survives serialization',()=>{
    let s=state();trim(s,'germany',2);const before=structuredClone(s);
    expect(startResolution(s,'cost','germany',[fee(1),fee(2),gain],[])).toBe(false);expect(s).toEqual(before);
    take(s,'build_navy');expect(startResolution(s,'cost','germany',[fee(1),fee(2),gain],[])).toBe(true);
    choose(s,[s.decks.germany.hand[0].id]);s=JSON.parse(JSON.stringify(s));expect(s.resolution!.choice).toMatchObject({min:2,max:2});choose(s,s.decks.germany.hand.map(c=>c.id));finish(s);expect(s.scores.germany).toBe(3);
  });
  it('does not reuse a specific card to satisfy an arbitrary requirement',()=>{
    const s=state(),army=take(s,'build_army'),navy=take(s,'build_navy');
    expect(canAffordHandCost([army],['build_army','*'])).toBe(false);
    expect(canAffordHandCost([army,navy],['build_army','*'])).toBe(true);
    expect(canAffordHandCost([army,navy],['build_army','build_army'])).toBe(false);
  });
  it('prevents paying the only specific card in an earlier generic fee',()=>{
    const s=state();trim(s,'germany',0);const army=take(s,'build_army'),navy=take(s,'build_navy');
    expect(startResolution(s,'cost','germany',[fee(1),{...fee(1),filter:'build_army'} as Effect,gain],[])).toBe(true);
    const c=s.resolution!.choice!,before=structuredClone(s);expect(resolveChoice(s,c.seat,c.id,[army.id])).toBe(false);expect(s).toEqual(before);
    choose(s,[navy.id]);choose(s,[army.id]);finish(s);expect(s.scores.germany).toBe(3);
  });
  it.each([0,1,2,3])('resource reallocation needs all three hand cards (%s)',n=>{
    const s=state();trim(s,'germany',n);s.phase='TURN_START_WINDOW';
    expect(startResolution(s,'turn','germany',[{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'turn'}],[])).toBe(true);
    const option=s.resolution!.choice?.options.find(o=>o.label==='资源重整');expect(!!option).toBe(n>=3);
    if(option){choose(s,[option.id]);choose(s,s.decks.germany.hand.map(c=>c.id));choose(s,[s.resolution!.choice!.options[0].id]);finish(s);expect(s.decks.germany.hand).toHaveLength(1);}
  });
  it('hides an unaffordable nested branch but preserves the no-payment branch',()=>{
    const s=state();trim(s,'germany',3);
    const e:Effect={kind:'choose',seat:'germany',min:1,max:1,label:'choice',options:[{id:'pay',label:'pay',effects:[fee(4),gain]},{id:'stop',label:'stop',effects:[{kind:'trace',label:'stop'}]}]};
    expect(startResolution(s,'nested','germany',[e],[])).toBe(true);expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual(['stop']);choose(s,['stop']);finish(s);expect(s.decks.germany.hand).toHaveLength(3);
  });
  it('does not offer an enhancement if the source would be needed for payment',()=>{
    const s=state();trim(s,'germany',0);const source=take(s,'special_136');take(s,'build_army');
    const rule:TriggerRule={id:'fee',label:'fee',sourceInstanceId:source.id,owner:'germany',timing:'After',on:'opening',mandatory:false,source:'enhancement',cost:2,effects:[gain]};
    expect(startResolution(s,'test','germany',[{kind:'trace',label:'opening'}],[rule])).toBe(true);expect(s.resolution!.choice).toBeNull();expect(s.scores.germany).toBe(0);
  });
});

describe('v1.2.2 strategy and passing',()=>{
  it.each([0,1,2])('strategy can choose %s cards and never offers playing an acquired card',count=>{
    let s=state();const card=take(s,'special_153');const before=s.decks.germany.hand.length;
    const effects=cardEffects(s,card);expect(effects.some(e=>e.kind==='extraPlay')).toBe(false);
    expect(specialCard(card.definitionId)!.text).not.toContain('可打出');
    const played=transition(s,{type:'PLAY_CARD',seat:'germany',expectedRevision:s.revision,cardId:card.id,effectIndices:[0],targetIds:[]});
    expect(played.ok).toBe(true);if(!played.ok)return;s=played.state;
    expect(s.resolution!.choice).toMatchObject({kind:'CARDS',min:0,max:2});
    const step=(ids:string[])=>{const c=s.resolution!.choice!;const result=transition(s,{type:'RESOLVE_ENGINE_CHOICE',seat:c.seat,expectedRevision:s.revision,choiceId:c.id,ids} as Command);expect(result.ok).toBe(true);if(result.ok)s=result.state;};
    step(s.resolution!.choice!.options.slice(0,count).map(o=>o.id));
    expect(s.resolution!.choice!.kind).toBe('CARDS');step([s.decks.germany.hand[0].id]);
    expect(s.phase).toBe('AIR');expect(s.resolution!.running).toBe(false);
    expect(s.decks.germany.hand).toHaveLength(before+count-2);expect(s.scores.germany).toBe(0);
  });
  it('passing costs one point once, even with an empty hand; stale retries do not apply',()=>{
    for(const empty of [false,true]) {
      const s=state();if(empty)trim(s,'germany',0);
      const command:Command={type:'ADVANCE_PHASE',seat:'germany',expectedRevision:s.revision};
      const r=transition(s,command);expect(r.ok).toBe(true);if(!r.ok)continue;
      expect(r.state.scores.germany).toBe(r.state.phase==='DISCARD'?1:-1);expect(['AIR','DISCARD']).toContain(r.state.phase);
      expect(transition(r.state,command).ok).toBe(false);
      expect(r.state.events.filter(e=>e.type==='RULE_EVENT'&&e.code==='PLAY_PHASE_POINT_LOSS')).toHaveLength(1);
    }
  });
  it('using Conscription instead of playing does not incur a pass penalty',()=>{
    const s=state(),card=take(s,'special_135','active');
    const r=transition(s,{type:'STATUS_ACTION',seat:'germany',expectedRevision:s.revision,cardId:card.id});
    expect(r.ok).toBe(true);if(!r.ok)return;
    expect(r.state.scores.germany).toBe(0);
    expect(r.state.events.some(e=>e.type==='RULE_EVENT'&&e.code==='PLAY_PHASE_POINT_LOSS')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createGame, transition, SEATS } from '../src/core';
import type { Command, GameState, SeatId } from '../src/core';
import { startResolution } from '../src/core/resolution';
import type { Effect, FinalZone, TriggerRule } from '../src/core/resolutionTypes';

function send(s:GameState,payload:Record<string,unknown>):GameState {
  const result=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...payload} as Command);
  if(!result.ok) throw new Error(result.error);
  return result.state;
}
function ready() {
  let s=createGame('resolver',1940);
  for(const seat of SEATS) s=send(s,{type:'KEEP_OPENING',cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)});
  return s;
}
const scenario=(id:string)=>send(ready(),{type:'START_RESOLUTION_SCENARIO',scenarioId:id});
function choose(s:GameState,ids:string[]) { return send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids}); }
function trigger(s:GameState,label:string) { return choose(s,[s.resolution!.choice!.options.find(o=>o.label===label)!.id]); }
const trace=(label:string):Effect=>({kind:'trace',label});
function fixture(s:GameState,id:string,zone:'hand'|'active'|'faceDown'='active',seat:SeatId='germany') {
  s.decks[seat][zone].push({id,definitionId:id,deckOwner:seat,country:seat}); return id;
}
function rule(s:GameState,id:string,on:string,effects:Effect[],extra:Partial<TriggerRule>={}):TriggerRule {
  return {id,label:id,sourceInstanceId:fixture(s,id),owner:'germany',timing:'After',on,mandatory:false,source:'active',effects,...extra};
}
describe('resolution stack and lifecycle',()=>{
  it('resolves A-B1-C1-C2-B2 depth first and completes every frame',()=>{
    const s=scenario('nested'),r=s.resolution!;
    expect(r.trace).toEqual(['A','B1','C1','C2','B2']);
    expect(r.running).toBe(false); expect(r.stack).toEqual([]);
    expect(r.frames.every(f=>f.status==='COMPLETE')).toBe(true);
    expect(s.decks.germany.resolving).toEqual([]);
    expect(r.frames[2].ancestorIds).toHaveLength(2);
  });
  it('keeps all cards in resolving until their nested windows finish',()=>{
    let s=scenario('windows');
    const root=s.resolution!.frames[0].cardId!;
    expect(s.decks.germany.resolving.some(c=>c.id===root)).toBe(true);
    expect(s.decks.germany.discardPile.some(c=>c.id===root)).toBe(false);
    s=trigger(s,'B');
    expect(s.decks.germany.resolving).toHaveLength(2);
    s=trigger(s,'D');
    expect(s.resolution!.trace).toEqual(['A','B1','D','B2']);
    expect(s.decks.germany.resolving.some(c=>c.id===root)).toBe(true);
    s=trigger(s,'C');
    expect(s.resolution!.trace).toEqual(['A','B1','D','B2','C']);
    expect(s.decks.germany.discardPile.filter(c=>c.id===root)).toHaveLength(1);
    expect(s.decks.germany.resolving).toHaveLength(0);
  });
  it.each(['hand','drawPile','active','removed','faceDown','discardPile'] as FinalZone[])('honors final destination %s exactly once',zone=>{
    const s=ready(),id=fixture(s,'returning','hand');
    expect(startResolution(s,'return','germany',[trace('done')],[],id,zone)).toBe(true);
    expect(s.decks.germany[zone].filter(c=>c.id===id)).toHaveLength(1);
    expect(Object.values(s.decks.germany).flat().filter(c=>c.id===id)).toHaveLength(1);
  });
  it('rejects all-skipped effects without formal play or mutation',()=>{
    const s=ready(),id=fixture(s,'unused','hand'),before=structuredClone(s);
    expect(startResolution(s,'unused','germany',[],[],id)).toBe(false);
    expect(s).toEqual(before);
  });
});
describe('trigger window branching',()=>{
  it('crosses to the ancestor C and permanently closes D while preserving remaining B2',()=>{
    let s=trigger(scenario('windows'),'B');
    expect(s.resolution!.choice!.options.map(o=>o.label).sort()).toEqual(['C','D']);
    const dWindow=s.resolution!.choice!.windowId;
    s=trigger(s,'C');
    expect(s.resolution!.trace).toEqual(['A','B1','C','B2']);
    expect(s.resolution!.windows.find(w=>w.id===dWindow)!.closed).toBe(true);
    expect(s.resolution!.running).toBe(false);
  });
  it('passes only the deepest window and returns to the ancestor choice',()=>{
    let s=trigger(scenario('windows'),'B');
    s=choose(s,[]);
    expect(s.resolution!.trace).toEqual(['A','B1','B2']);
    expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['C']);
    s=trigger(s,'C'); expect(s.resolution!.trace).not.toContain('D');
  });
  it('requests a complete player permutation of mandatory triggers, including their children',()=>{
    const s=scenario('order'),c=s.resolution!.choice!;
    expect(c.kind).toBe('ORDER_MANDATORY_TRIGGERS');
    for(const ids of [[],['B'],['B','B'],['B','foreign']]) expect(transition(s,{type:'RESOLVE_ENGINE_CHOICE',seat:s.operatorSeat,expectedRevision:s.revision,choiceId:c.id,ids}).ok).toBe(false);
    const next=choose(s,['C','B']);
    expect(next.resolution!.trace).toEqual(['A','C','B1','D','B2']);
  });
  it('replays legacy windows with their original candidate pruning',()=>{
    let s=ready();delete s.resolutionVersion;
    const b=rule(s,'B','A',[{kind:'draw',label:'draw',seat:'germany',count:1}]);
    const c=rule(s,'late','A',[trace('late')],{minHand:8});
    startResolution(s,'legacy','germany',[trace('A')],[b,c]);s=trigger(s,'B');
    expect(s.resolution!.running).toBe(false);expect(s.resolution!.trace).toEqual(['A','draw']);expect(s.resolution!.windows.every(w=>w.declinedSeats===undefined)).toBe(true);
  });
  it('refreshes newly legal candidates in open windows and excludes candidates that lose their conditions',()=>{
    let s=ready();
    const b=rule(s,'B','A',[{kind:'draw',label:'draw',seat:'germany',count:1}]);
    const c=rule(s,'late','A',[trace('late')],{minHand:8});
    startResolution(s,'snapshot','germany',[trace('A')],[b,c]);
    expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['B']);
    s=trigger(s,'B');
    expect(s.decks.germany.hand).toHaveLength(8);
    expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['late']);
    s=trigger(s,'late');
    expect(s.resolution!.trace).toEqual(['A','draw','late']);
    s=scenario('sources'); s=trigger(s,'清空费用手牌');
    expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['已暗置响应']);
  });
  it('prevents an active effect from triggering itself again through descendant events',()=>{
    const s=ready();
    const self=rule(s,'self','A',[trace('A')],{mandatory:true});
    startResolution(s,'cycle','germany',[trace('A')],[self]);
    expect(s.resolution!.trace).toEqual(['A','A']);
    expect(s.resolution!.fired).toHaveLength(1);
  });
  it('enforces once per turn in core, but resets its scope on the next seat turn',()=>{
    let s=ready(); const b=rule(s,'once','A',[trace('B')],{oncePerTurn:true});
    startResolution(s,'once','germany',[trace('A'),trace('A')],[b]);
    s=trigger(s,'once');
    expect(s.resolution!.trace).toEqual(['A','B','A']);
    startResolution(s,'again','germany',[trace('A')],[b]);
    expect(s.resolution!.choice).toBeNull();
    s.activeSeat='united_kingdom';
    startResolution(s,'next turn','germany',[trace('A')],[b]);
    expect(s.resolution!.choice!.options).toHaveLength(1);
  });
});
describe('Before, choices and source eligibility',()=>{
  it('revalidates conditions after Before and skips invalid Apply and After while continuing independent effects',()=>{
    let s=ready();
    const b=rule(s,'before','conditional',[{kind:'forceHand',label:'empty',seat:'germany',count:100}],{timing:'Before'});
    const after=rule(s,'after','conditional',[trace('must not run')],{mandatory:true});
    startResolution(s,'revalidate','germany',[{kind:'score',label:'conditional',seat:'germany',amount:3,requires:{seat:'germany',minHand:1}},trace('independent')],[b,after]);
    s=trigger(s,'before');
    expect(s.scores.germany).toBe(0);
    expect(s.resolution!.trace).toEqual(['empty','independent']);
  });
  it('does not formally play a card when all effects are currently invalid',()=>{
    const s=ready(),id=fixture(s,'invalid','hand'),before=structuredClone(s);
    expect(startResolution(s,'invalid','germany',[{kind:'score',label:'invalid',seat:'germany',amount:2,requires:{seat:'germany',minHand:100}}],[],id)).toBe(false);
    expect(s).toEqual(before);
  });
  it('cancels Apply and its success-only After while consuming the prepared response',()=>{
    let s=scenario('cancel');
    expect(s.scores.germany).toBe(0);
    s=trigger(s,'取消 A');
    expect(s.scores.germany).toBe(0);
    expect(s.resolution!.trace).toEqual(['阻止扣分']);
    expect(s.resolution!.events.find(e=>e.label==='A：扣 3 分')).toMatchObject({applied:false,cancelled:true});
    expect(s.decks.germany.discardPile.some(c=>c.definitionId==='示例 取消 A')).toBe(true);
  });
  it('applies the original effect and After when response is declined',()=>{
    const s=choose(scenario('cancel'),[]);
    expect(s.scores.germany).toBe(-2);
    expect(s.resolution!.trace).toEqual(['A：扣 3 分','成功后加 1 分']);
  });
  it('excludes hand responses and other-seat optional cards but includes prepared responses and affordable enhancements',()=>{
    const s=scenario('sources');
    expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['已暗置响应','增强：付 2 张后摸 1 张','清空费用手牌']);
  });
  it('supports the explicitly face-down enhancement exception and deck-owner seats for China',()=>{
    const s=ready(),id=fixture(s,'chinese-enhancement','faceDown');
    s.decks.germany.faceDown.find(c=>c.id===id)!.country='china';
    const r:TriggerRule={id:'exception',label:'exception',owner:'germany',sourceInstanceId:id,source:'enhancement',faceDownEnhancement:true,timing:'After',on:'A',mandatory:false,effects:[trace('exception')]};
    startResolution(s,'exception','germany',[trace('A')],[r]);
    expect(s.resolution!.choice!.options[0].label).toBe('exception');
  });
  it('collects exact enhancement cost before moving the source to resolving',()=>{
    let s=scenario('sources'); s=trigger(s,'增强：付 2 张后摸 1 张');
    const c=s.resolution!.choice!;
    expect(c.kind).toBe('PAY_COST');
    const source=s.resolution!.rules.find(r=>r.cost===2)!.sourceInstanceId;
    expect(c.options.some(o=>o.id===source)).toBe(false);
    const before=s.decks.germany.hand.length;
    s=choose(s,c.options.slice(0,2).map(o=>o.id));
    expect(s.decks.germany.hand.length).toBe(before-2); // cost 2 + source 1 - draw 1
    expect(s.decks.germany.discardPile.some(c=>c.id===source)).toBe(true);
  });
  it('requires opponent hand choice despite ignored interrupts and resumes at the next effect exactly once',()=>{
    let s=scenario('forced'); const c=s.resolution!.choice!;
    expect(c.kind).toBe('FORCE_HAND'); expect(c.seat).toBe('united_kingdom');
    expect(s.operatorSeat).toBe('united_kingdom'); expect(s.activeSeat).toBe('germany');
    expect(transition(s,{type:'ADVANCE_PHASE',seat:s.operatorSeat,expectedRevision:s.revision}).ok).toBe(false);
    const before=s.decks.united_kingdom.hand.length;
    s=choose(s,c.options.slice(0,2).map(o=>o.id));
    expect(s.decks.united_kingdom.hand).toHaveLength(before-2);
    expect(s.resolution!.trace).toEqual(['对手摸 2 张','对手强制弃 2 张','返回父结算']);
    expect(s.operatorSeat).toBe('germany'); expect(s.phase).toBe('TURN_START_WINDOW');
  });
  it('preserves a paused engine through JSON and rejects stale, wrong-player or forged choices atomically',()=>{
    const s=trigger(scenario('windows'),'B'),copy=JSON.parse(JSON.stringify(s)) as GameState;
    const next=trigger(s,'D'); expect(trigger(copy,'D')).toEqual(next);
    const c=s.resolution!.choice!,before=structuredClone(s);
    for(const override of [{choiceId:'foreign'},{ids:['foreign']},{seat:'japan'},{expectedRevision:s.revision-1}]) {
      const result=transition(s,{type:'RESOLVE_ENGINE_CHOICE',seat:s.operatorSeat,expectedRevision:s.revision,choiceId:c.id,ids:[c.options[0].id],...override} as Command);
      expect(result.ok).toBe(false); expect(s).toEqual(before);
    }
  });
});

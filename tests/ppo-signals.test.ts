import {describe,expect,it} from 'vitest';
import {PpoTrainingArena,PPO_A2S1_STATIC_SCHEMA} from '../src/training/ppoArena';
import {TRAINING_A2S1_IDS,TRAINING_EVENT_IDS,TRAINING_SIGNAL_IDS_BY_SEAT} from '../src/core/trainingCourse';
import {regularCatalog} from '../src/core/cardCatalog';
import {startResolution} from '../src/core/resolution';

const fingerprint='a'.repeat(64);
const options={mode:'A' as const,cardSet:'signals' as const,buildFingerprint:fingerprint};

describe('A2S1 signals course',()=>{
  it('loads the exact balanced status/response whitelist beside prior events',()=>{
    const added=Object.values(TRAINING_SIGNAL_IDS_BY_SEAT).flat();
    expect(added).toHaveLength(89);
    expect(new Set(added).size).toBe(89);
    expect(added.every(id=>!TRAINING_EVENT_IDS.has(id))).toBe(true);
    expect(TRAINING_A2S1_IDS.size).toBe(147);
    const catalog=regularCatalog(true,false);
    for(const id of added){
      const definition=catalog.find(card=>card.id===id);
      expect(definition?.type).toMatch(/^(状态|响应|事件)$/);
    }
    expect(PPO_A2S1_STATIC_SCHEMA.eventIds).toHaveLength(147);
  });

  it('shows face-up statuses but conceals another seat’s face-down response identity',()=>{
    const original=new PpoTrainingArena(1,'signals-hidden',options).exportSnapshot();
    const state=original.state;
    const response=state.decks.soviet_union.hand.find(c=>c.definitionId==='special_57')!;
    state.decks.soviet_union.hand=state.decks.soviet_union.hand.filter(c=>c.id!==response.id);
    state.decks.soviet_union.faceDown.push(response);
    const status=state.decks.germany.hand.find(c=>c.definitionId==='special_137')!;
    state.decks.germany.hand=state.decks.germany.hand.filter(c=>c.id!==status.id);
    state.decks.germany.active.push(status);
    const arena=PpoTrainingArena.fromSnapshot(original,options);
    const obs=arena.observe()!;
    expect(obs.visibleCards?.active.germany).toContain('special_137');
    expect(obs.visibleCards?.ownFaceDown).not.toContain('special_57');
    expect(obs.visibleCards?.otherFaceDownCount.soviet_union).toBe(1);
    expect(JSON.stringify(obs)).not.toContain('special_57');
  });

  it('retains placement facts across a response decision and allows Wet Season to resolve',()=>{
    const saved=new PpoTrainingArena(2,'signals-wet-season',options).exportSnapshot();
    const state=saved.state;
    state.units.push({id:'training-german-east',country:'germany',type:'army',regionId:'eastern_europe'});
    const response=state.decks.soviet_union.hand.find(c=>c.definitionId==='special_57')!;
    state.decks.soviet_union.hand=state.decks.soviet_union.hand.filter(c=>c.id!==response.id);
    state.decks.soviet_union.faceDown.push(response);
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    const first=arena.observe()!;
    const build=first.candidates.find(c=>c.definitionId==='build_army'&&
      c.choices?.[0]?.regionId==='ukraine'&&!c.choices[0].repeated);
    expect(build).toBeDefined();
    const next=arena.step({...first.decision,actionId:build!.id}).observation!;
    expect(next.choiceKind).toBe('TRIGGER');
    expect(next.decisionSeat).toBe('soviet_union');
    const wet=next.candidates.find(c=>c.choices?.some(choice=>choice.definitionId==='special_57'));
    expect(wet).toBeDefined();
    expect(()=>arena.step({...next.decision,actionId:wet!.id})).not.toThrow();
    expect(arena.exportSnapshot().state.units.some(u=>u.country==='germany'&&u.type==='army'&&
      u.regionId==='ukraine')).toBe(false);
  });
  it('assigns one training-only penalty to an empty optional militia trigger',()=>{
    const saved=new PpoTrainingArena(3,'signals-militia',options).exportSnapshot();
    const state=saved.state;
    const militia=state.decks.germany.hand.find(c=>c.definitionId==='special_129')!;
    state.decks.germany.hand=state.decks.germany.hand.filter(c=>c.id!==militia.id);
    state.decks.germany.active.push(militia);
    state.phase='TURN_START_WINDOW';
    expect(startResolution(state,'回合开始','germany',
      [{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'回合开始'}],[])).toBe(true);
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    const obs=arena.observe()!;
    expect(obs.choiceKind).toBe('TRIGGER');
    const trigger=obs.candidates.find(c=>c.choices?.some(v=>v.definitionId==='special_129'));
    expect(trigger).toBeDefined();
    const before=state.scores.germany;
    const result=arena.step({...obs.decision,actionId:trigger!.id});
    expect(result.info.rewardAdjustments?.filter(item=>item.reason==='optional_trigger_no_effect'))
      .toHaveLength(1);
    expect(result.info.rewardAdjustments?.[0].seat).toBe('germany');
    expect(arena.exportSnapshot().state.scores.germany).toBe(before);
  });
  it('automatically pays a wildcard status cost from available resources',()=>{
    const saved=new PpoTrainingArena(4,'signals-random-fee',options).exportSnapshot();
    const state=saved.state;
    const status=state.decks.united_kingdom.hand.find(c=>c.definitionId==='special_1')!;
    state.decks.united_kingdom.hand=state.decks.united_kingdom.hand.filter(c=>c.id!==status.id);
    state.decks.united_kingdom.active.push(status);
    state.units.push({id:'uk-forward',country:'united_kingdom',type:'army',regionId:'western_europe'});
    state.phase='PLAY';state.activeSeat=state.operatorSeat=state.viewSeat='united_kingdom';
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    const before=arena.exportSnapshot().state.decks.united_kingdom.hand.length;
    const obs=arena.observe()!;
    const activate=obs.candidates.find(c=>c.statusAction&&c.definitionId==='special_1');
    expect(activate).toBeDefined();
    const next=arena.step({...obs.decision,actionId:activate!.id});
    expect(arena.exportSnapshot().state.decks.united_kingdom.hand.length).toBe(before-2);
    expect(arena.exportSnapshot().state.decks.united_kingdom.discardPile).toHaveLength(2);
    expect(next.observation?.choiceKind).not.toBe('PAY_COST');
  });
  it('lets Germany choose Steel Pact discard quantity without enumerating resource identities',()=>{
    const saved=new PpoTrainingArena(5,'signals-steel-count',options).exportSnapshot();
    const state=saved.state;
    state.phase='PLAY';state.activeSeat=state.operatorSeat=state.viewSeat='italy';
    expect(startResolution(state,'钢铁条约','italy',[
      {kind:'cards',seat:'germany',from:'hand',to:'discardPile',min:0,max:5,
        label:'德国选择弃置零至五张手牌'}],[])).toBe(true);
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    const obs=arena.observe()!;
    expect(obs.choiceKind).toBe('CARDS');
    expect(obs.decisionSeat).toBe('germany');
    expect(obs.candidates.map(c=>c.randomDiscardCount)).toEqual([0,1,2,3,4,5]);
    expect(JSON.stringify(obs.candidates)).not.toContain('germany:build_army:1');
    const before=arena.exportSnapshot().state.decks.germany.hand.length;
    const chosen=obs.candidates.find(c=>c.randomDiscardCount===3)!;
    arena.step({...obs.decision,actionId:chosen.id});
    const after=arena.exportSnapshot().state.decks.germany;
    expect(after.hand).toHaveLength(before-3);
    expect(after.discardPile).toHaveLength(3);
  });

});

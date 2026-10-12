import {describe,expect,it} from 'vitest';
import {PpoTrainingArena,PPO_A2S1_STATIC_SCHEMA} from '../src/training/ppoArena';
import {TRAINING_A2S1_IDS,TRAINING_EVENT_IDS,TRAINING_SIGNAL_IDS_BY_SEAT} from '../src/core/trainingCourse';
import {regularCatalog} from '../src/core/cardCatalog';
import {createGame} from '../src/core/game';
import {realTriggers} from '../src/core/specialCards';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {potentialSignalCoverage,potentialSignalSemantics} from '../src/training/potentialSignalSemantics';

const fingerprint='a'.repeat(64);
const options={mode:'A' as const,cardSet:'signals' as const,buildFingerprint:fingerprint};

describe('A2S1 signals course',()=>{
  it('encodes and resolves merged Blitzkrieg targets without a frame-bound action',()=>{
    const saved=new PpoTrainingArena(2901,'signals-merged-blitz',options).exportSnapshot();
    const state=saved.state;
    for(const definitionId of ['special_134','special_136']){
      const deck=state.decks.germany;
      const zone=deck.hand.find(card=>card.definitionId===definitionId)?'hand':'drawPile';
      const card=deck[zone].find(card=>card.definitionId===definitionId)!;
      expect(card).toBeDefined();
      deck[zone]=deck[zone].filter(item=>item.id!==card.id);
      deck.active.push(card);
    }
    state.units=[
      {id:'g',country:'germany',type:'army',regionId:'germany'},
      {id:'e',country:'germany',type:'army',regionId:'eastern_europe'},
      {id:'u',country:'soviet_union',type:'army',regionId:'ukraine'},
      {id:'b',country:'soviet_union',type:'army',regionId:'balkans'},
    ];
    expect(startResolution(state,'陆攻','germany',[
      {kind:'action',country:'germany',action:'land_battle',regions:['balkans'],label:'攻击A'},
    ],[])).toBe(true);
    const choose=(label?:string)=>{
      const choice=state.resolution!.choice!;
      expect(choice).toBeDefined();
      const id=label?choice.options.find(option=>option.id===label||option.label===label)?.id:
        choice.options[0]?.id;
      expect(id).toBeDefined();
      expect(resolveChoice(state,choice.seat,choice.id,[id!])).toBe(true);
    };
    const hasActionChoice=()=>state.resolution?.choice?.kind==='ACTION';
    while(hasActionChoice())
      choose(state.resolution!.choice!.field==='regionId'?'balkans':undefined);
    choose('俯冲式轰炸机');
    while(hasActionChoice())
      choose(state.resolution!.choice!.field==='regionId'?'ukraine':undefined);
    choose('闪电战');
    expect(state.resolution?.choice?.triggerTargets).toBeDefined();
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    const observation=arena.observe()!;
    expect(observation.candidates.map(candidate=>candidate.choiceIds?.[0]).sort())
      .toEqual(['balkans','ukraine']);
    expect(observation.candidates.every(candidate=>candidate.choices?.[0]?.action==='build_army')).toBe(true);
    const target=observation.candidates.find(candidate=>candidate.choiceIds?.[0]==='ukraine')!;
    expect(()=>arena.step({...observation.decision,actionId:target.id})).not.toThrow();
  });
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
    const coverage=potentialSignalCoverage();
    expect(coverage.missing).toEqual([]);
    expect(coverage.extra).toEqual([]);
    expect(coverage.described).toBe(88);
    for(const id of added.filter(id=>id!=='special_227')){
      const meaning=potentialSignalSemantics(id)!;
      expect(meaning.futureActions.length).toBeGreaterThan(0);
      expect(meaning.known.effects).toBe(true);
      expect(meaning.known.fee).toBe(true);
      for(const region of meaning.targetRegions){
        if(region==='united_states')continue; // exclusion denotes a country
        expect(PPO_A2S1_STATIC_SCHEMA.regions.map(item=>item.id)).toContain(region);
      }
    }
  });

  it('keeps audited triggers, effects, costs and target constraints separate',()=>{
    const blitz=potentialSignalSemantics('special_136')!;
    expect(blitz.subscriptions).toContain('After:action:land_battle');
    expect(blitz.futureActions).toEqual(['build_army']);
    expect(blitz.targetMode).toBe('battle_region');
    expect(blitz.feeCount).toBe(1);
    const rapid=potentialSignalSemantics('special_137')!;
    expect(rapid.subscriptions).toContain('After:action:build_army');
    expect(rapid.futureActions).toEqual(['land_battle']);
    expect(rapid.targetMode).toBe('adjacent_built_army');
    const yard=potentialSignalSemantics('special_84')!;
    expect(yard.subscriptions).toContain('After:action:build_navy');
    expect(yard.futureActions).toEqual(['build_navy']);
    expect(potentialSignalSemantics('special_44')?.feeResourceActions).toEqual(['build_army','land_battle']);
    expect(potentialSignalSemantics('special_44')?.feeCount).toBe(2);
    expect(potentialSignalSemantics('special_188')?.targetRegions).toEqual(['southeast_asia']);
    expect(potentialSignalSemantics('special_199')?.futureActions).toEqual(['build_army','land_battle']);
    expect(potentialSignalSemantics('special_199')?.branchMode).toBe('sequence');
    expect(potentialSignalSemantics('special_199')?.effectScopes.map(e=>e.targetMode)).toEqual([
      'battle_region','fixed_or_adjacent']);
    expect(potentialSignalSemantics('special_197')?.effectScopes.map(e=>e.targetRegions)).toEqual([
      ['sea_south_china'],['southeast_asia']]);
    expect(potentialSignalSemantics('special_192')?.effectScopes[1].excludedCountries).toEqual([
      'united_states']);
    expect(potentialSignalSemantics('special_163')?.feeCount).toBe(2);
    expect(potentialSignalSemantics('special_163')?.conditionalExtraFee).toBe(1);
    const radar=potentialSignalSemantics('special_86')!;
    expect(radar.effectScopes[0]).toMatchObject({action:'prevent_remove',
      targetMode:'fixed_or_adjacent',targetRegions:['sea_central_pacific'],
      sourceMode:'attacked_defender'});
    const defense=potentialSignalSemantics('special_59')!;
    expect(defense.effectScopes.map(effect=>[effect.action,effect.targetMode,
      effect.targetRegions])).toEqual([
        ['recruit_army','fixed_or_adjacent',['moscow']],
        ['destroy','fixed',['moscow']]]);
    expect(defense.effectScopes.map(effect=>effect.allianceConstraint)).toEqual([
      'owner','enemy']);
    expect(defense.allianceConstraint).toBe('unknown');
    expect(defense.known.target).toBe(false); // no misleading shared scope
    const jutland=potentialSignalSemantics('special_163')!;
    expect(jutland.effectScopes[0]).toMatchObject({action:'sea_battle',
      sourceMode:'fixed',sourceRegions:['sea_baltic'],targetMode:'any_legal'});
    expect(jutland.conditionalFeeCondition).toBe('allies_control_scandinavia');
    expect(jutland.persistentRules).toContain('axis_adjacent:sea_baltic:sea_north_sea');
    expect(potentialSignalSemantics('special_48')?.futureActions).toEqual(['remove_supply_point']);
    expect(potentialSignalSemantics('special_218')?.effectScopes[0]).toMatchObject({
      targetMode:'new_enemy_army',sourceMode:'adjacent_uk_us_army'});
    expect(potentialSignalSemantics('special_196')?.effectScopes[0]).toMatchObject({
      targetMode:'new_enemy_navy',sourceMode:'adjacent_japanese_unit'});
    expect(potentialSignalSemantics('special_174')?.effectScopes[0].condition).toBe('no_allied_army');
    expect(potentialSignalSemantics('special_42')?.effectScopes.map(e=>
      [e.action,e.targetRegions])).toEqual([
        ['home_base',['siberia']],['supply',['siberia']],
        ['remove_supply_point',['moscow']]]);
    for(const id of Object.values(TRAINING_SIGNAL_IDS_BY_SEAT).flat()){
      if(id==='special_227')continue;
      const item=potentialSignalSemantics(id)!;
      expect(item.effectScopes.map(effect=>effect.action)).toEqual(item.futureActions);
      if(item.futureActions.length>1&&!['special_59'].includes(id))
        expect(item.known.target).toBe(false);
    }
  });

  it('compares Defense of the Motherland scopes with actual engine effects',()=>{
    const state=createGame('defense-scope',31,'FULL',false,false,true);
    state.status='PLAYING';state.activeSeat='soviet_union';
    state.phase='TURN_START_WINDOW';
    const deck=state.decks.soviet_union;
    const zone=deck.hand.some(card=>card.definitionId==='special_59')?'hand':'drawPile';
    const card=deck[zone].find(item=>item.definitionId==='special_59')!;
    deck[zone]=deck[zone].filter(item=>item.id!==card.id);
    deck.faceDown.push(card);
    const frame={id:'scope-frame',cardId:card.id,currentEventId:'scope-event'} as any;
    const rule=realTriggers(state,frame,{kind:'signal',tag:'PHASE:TURN_START_WINDOW',
      label:'turn start'},'After').find(item=>item.sourceInstanceId===card.id)!;
    const actions=rule.effects.filter(effect=>effect.kind==='action');
    expect(actions.map(effect=>effect.kind==='action'&&effect.action)).toEqual([
      'recruit_army','destroy']);
    expect(actions[0]).toMatchObject({kind:'action',country:'soviet_union'});
    expect(actions[0].kind==='action'&&actions[0].regions).toContain('moscow');
    expect(actions[0].kind==='action'&&actions[0].regions?.length).toBeGreaterThan(1);
    expect(actions[1]).toMatchObject({kind:'action',action:'destroy',regions:['moscow']});
  });

  it('separates future signal capability from the immediate INSTALL effect',()=>{
    const saved=new PpoTrainingArena(1,'potential-signal',options).exportSnapshot();
    const deck=saved.state.decks.germany;
    for(const id of ['special_137','special_136']){
      const zone=deck.hand.some(card=>card.definitionId===id)?'hand':'drawPile';
      const card=deck[zone].find(item=>item.definitionId===id)!;
      expect(card).toBeDefined();
      deck[zone]=deck[zone].filter(item=>item.id!==card.id);
      deck.hand.push(card);
      saved.state.trainingCourse!.openIds.germany.push(card.id);
    }
    const observation=PpoTrainingArena.fromSnapshot(saved,options).observe()!;
    const rapid=observation.candidates.find(candidate=>candidate.definitionId==='special_137')!;
    const blitz=observation.candidates.find(candidate=>candidate.definitionId==='special_136')!;
    expect(rapid.effects?.some(effect=>effect.tag==='INSTALL')).toBe(true);
    expect(rapid.potential?.subscriptions).toContain('After:action:build_army');
    expect(rapid.potential?.futureActions).toContain('land_battle');
    expect(rapid.potential?.feeKind).toBe('deck');
    expect(rapid.potential?.feeCount).toBe(1);
    expect(rapid.potential?.futureActions).toEqual(['land_battle']);
    expect(rapid.potential?.targetMode).toBe('adjacent_built_army');
    expect(rapid.potential?.useLimit).toBe('turn');
    expect(blitz.potential?.subscriptions).toContain('After:action:land_battle');
    expect(blitz.potential?.futureActions).toContain('build_army');
    expect(blitz.potential?.futureActions).toEqual(['build_army']);
    expect(blitz.potential?.targetMode).toBe('battle_region');
    expect(rapid.potential).not.toEqual(blitz.potential);
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
  it('chooses a generic zero-to-five random discard quantity without enumerating identities',()=>{
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

  it('plays the real Steel Pact with Italy paying two, Italy hiding a response, then Germany choosing a status',()=>{
    const saved=new PpoTrainingArena(31,'signals-real-steel',options).exportSnapshot();
    const state=saved.state;
    state.phase='PLAY';state.activeSeat=state.operatorSeat=state.viewSeat='italy';
    const initialItaly=[...state.decks.italy.hand],initialGermany=[...state.decks.germany.hand];
    const responses=initialItaly.filter(card=>
      regularCatalog(true,false).some(def=>def.id===card.definitionId&&def.type==='响应'));
    state.decks.italy.hand=initialItaly.filter(card=>card.definitionId==='special_227'||
      responses.some(response=>response.id===card.id));
    state.decks.italy.drawPile=initialItaly.filter(card=>!state.decks.italy.hand.some(kept=>kept.id===card.id));
    expect(responses.length).toBeGreaterThan(2);
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    let observation=arena.observe()!;
    const steel=observation.candidates.find(candidate=>candidate.definitionId==='special_227');
    expect(steel).toBeDefined();
    let step=arena.step({...observation.decision,actionId:steel!.id});
    expect(arena.exportSnapshot().state.decks.italy.discardPile).toHaveLength(2);
    observation=step.observation!;
    expect(observation.choiceKind).toBe('CARDS');
    expect(observation.decisionSeat).toBe('italy');
    const hidden=observation.candidates.find(candidate=>candidate.choiceIds?.length===1)!;
    expect(hidden).toBeDefined();
    const hiddenId=hidden.choiceIds![0];
    const hiddenDefinition=arena.exportSnapshot().state.decks.italy.hand.find(card=>card.id===hiddenId)!.definitionId;
    step=arena.step({...observation.decision,actionId:hidden.id});
    observation=step.observation!;
    expect(observation.choiceKind).toBe('EXTRA_CARD');
    expect(observation.decisionSeat).toBe('germany');
    const visible=JSON.stringify(observation),leakAt=visible.indexOf(hiddenDefinition);
    if(leakAt>=0)throw Error(`Hidden response leaked near ${visible.slice(leakAt-90,leakAt+90)}`);
    const germanStatus=observation.candidates.find(candidate=>candidate.choiceIds?.some(id=>
      id===initialGermany.find(card=>card.definitionId==='special_137')?.id));
    expect(germanStatus).toBeDefined();
    arena.step({...observation.decision,actionId:germanStatus!.id});
    const italy=arena.exportSnapshot().state.decks.italy;
    const germany=arena.exportSnapshot().state.decks.germany;
    expect(italy.faceDown.map(card=>card.id)).toContain(hiddenId);
    expect(italy.discardPile.some(card=>card.definitionId==='special_227')).toBe(true);
    expect(italy.discardPile).toHaveLength(3);
    expect(germany.active.some(card=>card.definitionId==='special_137')).toBe(true);
    const allItaly=[...italy.hand,...italy.drawPile,...italy.discardPile,...italy.active,
      ...italy.faceDown,...italy.resolving,...italy.removed];
    expect(new Set(allItaly.map(card=>card.id)).size).toBe(initialItaly.length);
  });
  it('rejects Steel Pact without two payable resources',()=>{
    const saved=new PpoTrainingArena(32,'signals-steel-poor',options).exportSnapshot();
    const state=saved.state;
    state.phase='PLAY';state.activeSeat=state.operatorSeat=state.viewSeat='italy';
    const steel=state.decks.italy.hand.find(card=>card.definitionId==='special_227')!;
    const one=state.decks.italy.hand.find(card=>card.definitionId==='build_army')!;
    state.decks.italy.drawPile=state.decks.italy.hand.filter(card=>
      card.id!==steel.id&&card.id!==one.id);
    state.decks.italy.hand=[steel,one];
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    expect(arena.observe()!.candidates.some(candidate=>candidate.definitionId==='special_227')).toBe(false);
  });
  it('skips Steel Pact response placement when none remains after the two-card cost',()=>{
    const saved=new PpoTrainingArena(33,'signals-steel-no-response',options).exportSnapshot();
    const state=saved.state;
    state.phase='PLAY';state.activeSeat=state.operatorSeat=state.viewSeat='italy';
    const steel=state.decks.italy.hand.find(card=>card.definitionId==='special_227')!;
    const basics=state.decks.italy.hand.filter(card=>card.definitionId==='build_army').slice(0,3);
    state.decks.italy.drawPile=state.decks.italy.hand.filter(card=>
      card.id!==steel.id&&!basics.some(kept=>kept.id===card.id));
    state.decks.italy.hand=[steel,...basics];
    const arena=PpoTrainingArena.fromSnapshot(saved,options),observation=arena.observe()!;
    const source=observation.candidates.find(candidate=>candidate.definitionId==='special_227');
    expect(source).toBeDefined();
    const next=arena.step({...observation.decision,actionId:source!.id}).observation!;
    expect(next.choiceKind).toBe('EXTRA_CARD');
    expect(next.decisionSeat).toBe('germany');
    expect(arena.exportSnapshot().state.decks.italy.faceDown).toHaveLength(0);
    expect(arena.exportSnapshot().state.decks.italy.discardPile).toHaveLength(2);
  });

});

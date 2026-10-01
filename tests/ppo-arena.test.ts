import {describe,expect,it} from 'vitest';
import {PpoTrainingArena} from '../src/training/ppoArena';
import {TRAINING_EVENT_IDS,TRAINING_EVENT_IDS_BY_SEAT,basicOpenProbability,openSpecialCount} from '../src/core/trainingCourse';
import {createGame} from '../src/core/game';
import {cardEffects} from '../src/core/specialCards';
import {realTriggers} from '../src/core/specialCards';
import type {Effect,ResolutionFrame} from '../src/core/resolutionTypes';
import {discardDeckTop} from '../src/core/decks';
import {regularCatalog} from '../src/core/cardCatalog';
import type {CardInstance} from '../src/core/types';

const fingerprint='b'.repeat(64);
describe('PPO event curriculum',()=>{
  it('training trigger scan matches the unfiltered reference on course-only sources',()=>{
    const state=new PpoTrainingArena(42,'trigger-parity',{mode:'A',buildFingerprint:fingerprint})
      .exportSnapshot().state;
    const reference=structuredClone(state);
    delete reference.trainingCourse;
    const frame={id:'parity-frame',source:'test',owner:'germany',effects:[],nextEffectIndex:0,
      stage:'Validate',status:'RUNNING',parentEventId:null,ancestorIds:[],sourceAncestors:[],
      currentEventId:'parity-event',finalZone:'discardPile'} as ResolutionFrame;
    const effects:Effect[]=[
      ...['TURN_START_WINDOW','SCORE','SCORE_STATUS','STANDARD_CARD_PLAYED'].map(tag=>
        ({kind:'signal',tag:`PHASE:${tag}`,label:tag}) as Effect),
      ...(['build_army','build_navy','land_battle','sea_battle'] as const).map(action=>
        ({kind:'action',country:'germany',action,label:action}) as Effect),
    ];
    for(const effect of effects)for(const timing of ['Before','After'] as const)
      expect(realTriggers(structuredClone(state),frame,structuredClone(effect),timing))
        .toEqual(realTriggers(structuredClone(reference),frame,structuredClone(effect),timing));
  });
  it('freezes exactly 58 balanced event IDs and A/B opening boundaries',()=>{
    expect(TRAINING_EVENT_IDS.size).toBe(58);
    expect(TRAINING_EVENT_IDS.has('special_227')).toBe(false);
    expect(regularCatalog(true,false).some(card=>card.id==='special_260')).toBe(true);
    expect(TRAINING_EVENT_IDS.has('special_260')).toBe(false);
    const arena=new PpoTrainingArena(176,'v176-stable-ids',{mode:'A',buildFingerprint:fingerprint});
    expect(arena.header.eventIds).not.toContain('special_260');
    expect(arena.header.eventIds.every(id=>/^special_\d+$/.test(id))).toBe(true);
    expect(arena.exportSnapshot().state.decks.united_states.hand.some(card=>card.definitionId==='special_260')).toBe(false);
    expect(Object.values(TRAINING_EVENT_IDS_BY_SEAT).map(ids=>ids.length)).toEqual([12,13,0,10,10,13]);
    expect([0,5,6,8,10,11,20].map(openSpecialCount)).toEqual([0,5,6,6,6,7,12]);
    expect([0,1,2,3,4].map(basicOpenProbability)).toEqual([0,0.4,0.7,0.9,1]);
    const a=new PpoTrainingArena(7,'course-a',{mode:'A',buildFingerprint:fingerprint});
    const b=new PpoTrainingArena(7,'course-b',{mode:'B',buildFingerprint:fingerprint});
    expect(a.observe()?.ownResources.remaining.special_166).toBe(1);
    expect(b.observe()?.ownResources.open.build_army).toBe(6);
    expect(b.observe()?.ownResources.open.special_166).toBeLessThanOrEqual(1);
    expect(a.observe()?.candidates.some(c=>c.definitionId==='special_227')).toBe(false);
    const definitions=regularCatalog(true,false).filter(def=>TRAINING_EVENT_IDS.has(def.id));
    expect(definitions).toHaveLength(58);
    expect(definitions.every(def=>def.type==='事件')).toBe(true);
    expect(definitions.map(def=>def.id).sort()).toEqual([...TRAINING_EVENT_IDS].sort());
    const frozen=a.exportSnapshot().state;
    for(const def of definitions){
      const owner=Object.entries(TRAINING_EVENT_IDS_BY_SEAT).find(([,ids])=>ids.includes(def.id))![0] as CardInstance['deckOwner'];
      const instance=frozen.decks[owner].hand.find(card=>card.definitionId===def.id)!;
      expect(instance).toBeDefined();
      expect(()=>cardEffects(frozen,instance)).not.toThrow();
    }
  });
  it('uses fresh decision tokens through source and engine choices',()=>{
    const arena=new PpoTrainingArena(8,'course-step',{mode:'A',buildFingerprint:fingerprint});
    for(let i=0;i<12&&!arena.done;i++){
      const obs=arena.observe()!,candidate=obs.candidates[0];
      expect(candidate).toBeDefined();
      const before=arena.exportSnapshot();
      expect(()=>arena.step({...obs.decision,actionId:'impossible'})).toThrow();
      expect(arena.exportSnapshot()).toEqual(before);
      const result=arena.step({...obs.decision,actionId:candidate.id});
      expect(result.info.decision).toEqual(obs.decision);
      expect(()=>arena.step({...obs.decision,actionId:candidate.id})).toThrow();
    }
  });
  it('restores openness and rejects a different build',()=>{
    const arena=new PpoTrainingArena(19,'course-save',{mode:'B',buildFingerprint:fingerprint});
    const snap=arena.exportSnapshot();
    expect(()=>PpoTrainingArena.fromSnapshot(snap,{mode:'B',buildFingerprint:'c'.repeat(64)})).toThrow();
    const restored=PpoTrainingArena.fromSnapshot(snap,{mode:'B',buildFingerprint:fingerprint});
    expect(restored.observe()).toEqual(arena.observe());
  });
  it('runs headlessly through nested event choices',()=>{
    const arena=new PpoTrainingArena(31,'course-simulation',{mode:'A',buildFingerprint:fingerprint});
    let nested=0,random=31;
    for(let i=0;i<400&&!arena.done;i++){
      const obs=arena.observe()!;
      if(obs.node==='ENGINE_CHOICE')nested++;
      random=(Math.imul(random,1664525)+1013904223)>>>0;
      const candidate=obs.candidates[random%obs.candidates.length];
      expect(candidate).toBeDefined();
      arena.step({...obs.decision,actionId:candidate.id});
    }
    expect(nested).toBeGreaterThan(0);
    expect(arena.decisions).toBeGreaterThan(20);
  });
  it('keeps course overrides separate from the formal game',()=>{
    const formal=createGame('formal',1,'FULL',false,false,true);
    const training=new PpoTrainingArena(1,'course-effects',{mode:'A',buildFingerprint:fingerprint})
      .exportSnapshot().state;
    for(const [id,seat] of [['special_113','soviet_union'],['special_255','united_states'],
      ['special_94','united_states']] as const){
      const card:CardInstance={id:`${seat}:${id}`,definitionId:id,country:seat,deckOwner:seat,balance:true};
      const live=cardEffects(formal,card),course=cardEffects(training,card);
      expect(course).not.toEqual(live);
      if(id==='special_94'){
        expect(JSON.stringify(course)).not.toContain('"kind":"draw"');
        expect(JSON.stringify(live)).toContain('"kind":"draw"');
        expect(JSON.stringify(course)).toContain('"kind":"extraPlay"');
      }else expect(course.length).toBe(live.length-1);
    }
  });
  it('preserves ordered multistep and bound-unit event effects',()=>{
    const state=new PpoTrainingArena(2,'event-effects',{mode:'A',buildFingerprint:fingerprint})
      .exportSnapshot().state;
    const instance=(seat:CardInstance['deckOwner'],id:string)=>state.decks[seat].hand.find(c=>c.definitionId===id)!;
    expect(cardEffects(state,instance('germany','special_158')).map(e=>e.kind==='action'?e.action:e.kind))
      .toEqual(['land_battle','build_army']);
    const firstFire=cardEffects(state,instance('united_states','special_107'));
    expect(firstFire[0]).toMatchObject({kind:'action',action:'build_navy',bindAs:'built-navy'});
    expect(firstFire[1]).toMatchObject({kind:'action',action:'sea_battle',fromBinding:'built-navy'});
    const hundred=cardEffects(state,instance('soviet_union','special_113'));
    expect(hundred[0]).toMatchObject({kind:'action',country:'china',bindAs:'new-china'});
    expect(hundred[1]).toMatchObject({kind:'action',country:'china',fromBinding:'new-china',
      decisionSeat:'soviet_union'});
    expect(hundred).toHaveLength(2);
    expect(cardEffects(state,instance('germany','special_150')).map(e=>e.kind))
      .toEqual(['deckTop','action','extraPlay']);
  });
  it('does not leak other seats opening, and random deck-top discard can take unopened cards',()=>{
    const arena=new PpoTrainingArena(45,'course-privacy',{mode:'B',buildFingerprint:fingerprint});
    const original=arena.observe()!;
    const snapshot=arena.exportSnapshot();
    snapshot.state.trainingCourse!.openIds.united_kingdom=[];
    const hidden=PpoTrainingArena.fromSnapshot(snapshot,{mode:'B',buildFingerprint:fingerprint});
    expect(hidden.observe()).toEqual(original);
    const state=hidden.exportSnapshot().state;
    state.trainingCourse!.openIds.germany=[];
    const before=state.decks.germany.hand.length;
    const outcome=discardDeckTop(state,'germany',2);
    expect(outcome.discarded).toBe(2);
    expect(state.decks.germany.hand).toHaveLength(before-2);
    expect(state.decks.germany.discardPile).toHaveLength(2);
  });
  it('precommits every legal Barbarossa attack order independently of unit array order',()=>{
    const original=new PpoTrainingArena(81,'ordered',{mode:'A',buildFingerprint:fingerprint});
    const snapshot=original.exportSnapshot();
    const units=[
      {id:'g-home',country:'germany',type:'army',regionId:'germany'},
      {id:'g-front',country:'germany',type:'army',regionId:'eastern_europe'},
      {id:'s-ukr',country:'soviet_union',type:'army',regionId:'ukraine'},
      {id:'s-ross',country:'soviet_union',type:'army',regionId:'ross_region'},
      {id:'s-balkans',country:'soviet_union',type:'army',regionId:'balkans'},
    ] as typeof snapshot.state.units;
    const orders=(reversed:boolean)=>{
      const input=structuredClone(snapshot);input.state.units=reversed?[...units].reverse():units;
      const arena=PpoTrainingArena.fromSnapshot(input,{mode:'A',buildFingerprint:fingerprint});
      const obs=arena.observe()!,source=obs.candidates.find(c=>c.definitionId==='special_162')!;
      expect(source.effects?.[0]).toMatchObject({precommitTargets:true,min:1,max:3,count:3});
      const targets=arena.step({...obs.decision,actionId:source.id}).observation!;
      return targets.candidates.map(c=>c.targetIds!.join(',')).sort();
    };
    expect(orders(false)).toContain('s-ross,s-ukr');
    expect(orders(false)).toContain('s-ukr,s-ross');
    expect(orders(false)).toContain('s-balkans,s-ukr,s-ross');
    expect(orders(false)).toContain('s-ross,s-ukr,s-balkans');
    expect(orders(false)).toHaveLength(15);
    expect(orders(false)).toEqual(orders(true));
  });
  it('merges equivalent basic instances in extra-card choices',()=>{
    const arena=new PpoTrainingArena(3,'extra-copies',{mode:'A',buildFingerprint:fingerprint});
    const snapshot=arena.exportSnapshot();
    const hand=snapshot.state.decks.germany.hand;
    const ids=hand.filter(c=>['build_army','build_navy'].includes(c.definitionId)).map(c=>c.id);
    snapshot.state.resolution={running:true,choice:{id:'choose-extra',kind:'EXTRA_CARD',seat:'germany',
      prompt:'额外出牌',min:1,max:1,options:ids.map(id=>({id,label:id}))},frames:[],events:[],
      windows:[],rules:[],stack:[],trace:[],fired:[],turnUses:{},serial:0,owner:'germany',scenario:'test'};
    const restored=PpoTrainingArena.fromSnapshot(snapshot,{mode:'A',buildFingerprint:fingerprint});
    const obs=restored.observe()!;
    expect(obs.candidates.filter(c=>c.choiceIds?.[0].includes(':build_army:'))).toHaveLength(1);
    expect(obs.candidates.filter(c=>c.choiceIds?.[0].includes(':build_navy:'))).toHaveLength(1);
  });
  it('can start a basic-only course with the same decision schema',()=>{
    const arena=new PpoTrainingArena(2,'basic-course',{mode:'B',cardSet:'basics',buildFingerprint:fingerprint});
    const obs=arena.observe()!;
    expect(obs.cardSet).toBe('basics');
    expect(arena.header.eventIds).toHaveLength(0);
    expect(obs.candidates.some(c=>c.definitionId?.startsWith('special_'))).toBe(false);
    const snap=arena.exportSnapshot();
    expect(()=>PpoTrainingArena.fromSnapshot(snap,{mode:'B',cardSet:'events',buildFingerprint:fingerprint})).toThrow();
    expect(PpoTrainingArena.fromSnapshot(snap,{mode:'B',cardSet:'basics',buildFingerprint:fingerprint}).observe())
      .toEqual(obs);
  });
  it('uses the intended B opening probabilities without an extra first-turn draw',()=>{
    const trials=120;
    let one=0,two=0,three=0;
    for(let seed=0;seed<trials;seed++){
      const arena=new PpoTrainingArena(seed,`b-frequency-${seed}`,{mode:'B',buildFingerprint:fingerprint});
      const snapshot=arena.exportSnapshot(),course=snapshot.state.trainingCourse!;
      const before=course.openRandomState;
      arena.observe();arena.observe();
      expect(arena.exportSnapshot().state.trainingCourse!.openRandomState).toBe(before);
      const opened=(seat:CardInstance['deckOwner'],definition:string)=>course.openIds[seat]
        .some(id=>snapshot.state.decks[seat].hand.find(card=>card.id===id)?.definitionId===definition);
      if(opened('soviet_union','build_navy'))one++;
      if(opened('germany','build_navy'))two++;
      if(opened('italy','sea_battle'))three++;
      expect(opened('germany','build_army')).toBe(true);
    }
    expect(one/trials).toBeGreaterThan(0.3);expect(one/trials).toBeLessThan(0.5);
    expect(two/trials).toBeGreaterThan(0.6);expect(two/trials).toBeLessThan(0.8);
    expect(three/trials).toBeGreaterThan(0.8);expect(three/trials).toBeLessThan(0.98);
  });
  it('does not reroll the recipient while another country grants an extra play',()=>{
    const arena=new PpoTrainingArena(513,'aid-cycle',{mode:'B',buildFingerprint:fingerprint});
    const input=arena.exportSnapshot(),state=input.state;
    state.activeSeat=state.operatorSeat=state.viewSeat='united_states';state.phase='PLAY';
    const aid=state.decks.united_states.hand.find(card=>card.definitionId==='special_94')!;
    state.trainingCourse!.openIds.united_states.push(aid.id);
    const recipientBefore=[...state.trainingCourse!.openIds.united_kingdom];
    const randomBefore=state.trainingCourse!.openRandomState;
    const restored=PpoTrainingArena.fromSnapshot(input,{mode:'B',buildFingerprint:fingerprint});
    const start=restored.observe()!,source=start.candidates.find(c=>c.definitionId==='special_94')!;
    expect(source).toBeDefined();
    const choose=restored.step({...start.decision,actionId:source.id}).observation!;
    const british=choose.candidates.find(c=>c.choiceIds?.includes('united_kingdom'))!;
    expect(british).toBeDefined();
    const extra=restored.step({...choose.decision,actionId:british.id}).observation!;
    expect(extra.activeSeat).toBe('united_states');
    expect(extra.decisionSeat).toBe('united_kingdom');
    expect(extra.choiceKind).toBe('EXTRA_CARD');
    expect(extra.candidates.filter(c=>c.choiceIds?.[0]?.includes(':build_army:'))).toHaveLength(1);
    expect(extra.candidates.filter(c=>c.choiceIds?.[0]?.includes(':build_navy:'))).toHaveLength(1);
    expect(restored.exportSnapshot().state.trainingCourse!.openRandomState).toBe(randomBefore);
    expect(restored.exportSnapshot().state.trainingCourse!.openIds.united_kingdom).toEqual(recipientBefore);
  });
  it('refreshes B opening only at the next own-country cycle',()=>{
    const arena=new PpoTrainingArena(211,'next-cycle',{mode:'B',buildFingerprint:fingerprint});
    const initial=arena.exportSnapshot().state.trainingCourse!.openRandomState;
    for(let i=0;i<12&&!arena.done;i++){
      const obs=arena.observe()!;
      if(obs.round>1)break;
      expect(arena.exportSnapshot().state.trainingCourse!.openRandomState).toBe(initial);
      arena.step({...obs.decision,actionId:'pass'});
    }
    expect(arena.observe()?.round).toBe(2);
    expect(arena.exportSnapshot().state.trainingCourse!.openRandomState).not.toBe(initial);
  });
});

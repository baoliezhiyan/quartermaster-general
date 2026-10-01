import {describe,expect,it} from 'vitest';
import {PpoTrainingArena} from '../src/training/ppoArena';
import {TRAINING_EVENT_IDS,TRAINING_EVENT_IDS_BY_SEAT,basicOpenProbability,openSpecialCount} from '../src/core/trainingCourse';
import {createGame,transition} from '../src/core/game';
import {cardEffects} from '../src/core/specialCards';
import {startResolution} from '../src/core/resolution';
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
  it('submits a basic card with its full legal action and no confirmation rollback',()=>{
    const arena=new PpoTrainingArena(2,'basic-committed',{mode:'A',cardSet:'basics',buildFingerprint:fingerprint});
    const start=arena.observe()!;
    const actions=start.candidates.filter(c=>c.definitionId==='build_army');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(c=>c.optionId&&c.choices?.[0]?.kind==='action_plan')).toBe(true);
    const selected=actions[0],before=arena.exportSnapshot().state;
    const result=arena.step({...start.decision,actionId:selected.id});
    const after=arena.exportSnapshot().state;
    expect(result.info.submittedCardDefinitions).toContain('build_army');
    expect(result.info.resolvedCardDefinitions).toContain('build_army');
    expect(after.decks.germany.hand.length).toBe(before.decks.germany.hand.length-1);
    expect(after.decks.germany.discardPile.some(c=>c.id===selected.cardId)).toBe(true);
    expect(result.observation?.choiceKind).not.toBe('ACTION');
    expect(result.observation?.candidates.some(c=>c.choiceIds?.length===0&&c.kind==='choice')).toBe(false);
  });
  it('commits a no-target event as a legal empty play and never offers a rollback',()=>{
    const original=new PpoTrainingArena(81,'empty-event',{mode:'A',buildFingerprint:fingerprint});
    const snapshot=original.exportSnapshot();
    snapshot.state.units=snapshot.state.units.filter(u=>u.country!=='soviet_union');
    const arena=PpoTrainingArena.fromSnapshot(snapshot,{mode:'A',buildFingerprint:fingerprint});
    const obs=arena.observe()!,card=obs.candidates.find(c=>c.definitionId==='special_162')!;
    expect(card).toBeDefined();
    const before=arena.exportSnapshot().state;
    const result=arena.step({...obs.decision,actionId:card.id});
    const after=arena.exportSnapshot().state;
    expect(result.info.submittedCardDefinitions).toContain('special_162');
    expect(result.info.resolvedCardDefinitions).toContain('special_162');
    expect(after.decks.germany.hand.length).toBe(before.decks.germany.hand.length-1);
    expect(after.decks.germany.discardPile.some(c=>c.id===card.cardId)).toBe(true);
    expect(result.observation?.candidates.some(c=>c.id===card.id)).toBe(false);
  });
  it('does not treat an unpaid voluntary hand cost as a legal empty play',()=>{
    const state=new PpoTrainingArena(7,'unpaid-cost',{mode:'A',buildFingerprint:fingerprint})
      .exportSnapshot().state;
    state.decks.germany.hand=[];
    expect(startResolution(state,'需付费效果','germany',[
      {kind:'cards',seat:'germany',from:'hand',to:'discardPile',min:2,max:2,
        fee:true,label:'支付两张手牌'},
      {kind:'score',seat:'germany',amount:1,label:'获得一分'},
    ],[],undefined,'discardPile',true)).toBe(false);
    expect(state.resolution?.running).toBeFalsy();
  });
  it('keeps declining an uncommitted optional response as a genuine choice',()=>{
    const initial=new PpoTrainingArena(7,'optional-trigger',{mode:'A',buildFingerprint:fingerprint})
      .exportSnapshot().state;
    const response=initial.decks.united_kingdom.hand.shift()!;
    initial.decks.united_kingdom.faceDown.push(response);
    const trigger={id:'training-optional-response',label:'可选响应',sourceInstanceId:response.id,
      owner:'united_kingdom' as const,timing:'After' as const,on:'测试时点',mandatory:false,
      source:'response' as const,effects:[{kind:'score' as const,seat:'united_kingdom' as const,
        amount:1,label:'响应加分'}]};
    const setup=()=>{const state=structuredClone(initial);
      expect(startResolution(state,'测试','germany',[{kind:'trace',label:'测试时点'}],
        [trigger],undefined,'discardPile',true)).toBe(true);
      expect(state.resolution?.choice?.kind).toBe('TRIGGER');
      expect(state.resolution?.choice?.min).toBe(0);
      return state;};
    const decline=setup(),choice=decline.resolution!.choice!;
    const declined=transition(decline,{type:'RESOLVE_ENGINE_CHOICE',seat:choice.seat,
      expectedRevision:decline.revision,choiceId:choice.id,ids:[],guided:true});
    expect(declined.ok).toBe(true);
    if(declined.ok){
      expect(declined.state.scores.united_kingdom).toBe(initial.scores.united_kingdom);
      expect(declined.state.decks.united_kingdom.faceDown.some(c=>c.id===response.id)).toBe(true);
    }
    const accept=setup(),triggerChoice=accept.resolution!.choice!;
    const accepted=transition(accept,{type:'RESOLVE_ENGINE_CHOICE',seat:triggerChoice.seat,
      expectedRevision:accept.revision,choiceId:triggerChoice.id,
      ids:[triggerChoice.options[0].id],guided:true});
    expect(accepted.ok).toBe(true);
    if(accepted.ok){
      expect(accepted.state.scores.united_kingdom).toBe(initial.scores.united_kingdom+1);
      expect(accepted.state.decks.united_kingdom.faceDown.some(c=>c.id===response.id)).toBe(false);
    }
  });
  it('records a genuine countered card as cancelled while consuming it',()=>{
    const state=new PpoTrainingArena(7,'countered-card',{mode:'A',buildFingerprint:fingerprint})
      .exportSnapshot().state;
    const card=state.decks.germany.hand.find(c=>c.definitionId==='special_158')!;
    const response=state.decks.united_kingdom.hand.shift()!;
    state.decks.united_kingdom.faceDown.push(response);
    expect(startResolution(state,'受反制出牌','germany',
      [{kind:'trace',label:'将被取消的子效果'}],[{
        id:'training-counter',label:'真实反制',sourceInstanceId:response.id,
        owner:'united_kingdom',timing:'Before',on:'将被取消的子效果',mandatory:false,
        source:'response',effects:[{kind:'cancel',label:'取消此效果'}],
      }],card.id,'discardPile',true)).toBe(true);
    const choice=state.resolution!.choice!;
    expect(choice.kind).toBe('TRIGGER');
    const accepted=transition(state,{type:'RESOLVE_ENGINE_CHOICE',seat:choice.seat,
      expectedRevision:state.revision,choiceId:choice.id,ids:[choice.options[0].id],guided:true});
    expect(accepted.ok).toBe(true);
    if(accepted.ok){
      expect(accepted.state.trainingCourse?.cardOutcomes?.find(v=>v.id===card.id)?.outcome)
        .toBe('cancelled');
      expect(accepted.state.decks.germany.discardPile.some(c=>c.id===card.id)).toBe(true);
    }
  });
  it('consumes only the committed card from B openness without rerolling other cards',()=>{
    const original=new PpoTrainingArena(81,'b-empty-event',{mode:'B',buildFingerprint:fingerprint});
    const snapshot=original.exportSnapshot();
    snapshot.state.units=snapshot.state.units.filter(u=>u.country!=='soviet_union');
    const event=snapshot.state.decks.germany.hand.find(c=>c.definitionId==='special_162')!;
    snapshot.state.trainingCourse!.openIds.germany.push(event.id);
    const openedBefore=[...snapshot.state.trainingCourse!.openIds.germany];
    const randomBefore=snapshot.state.trainingCourse!.openRandomState;
    const arena=PpoTrainingArena.fromSnapshot(snapshot,{mode:'B',buildFingerprint:fingerprint});
    const obs=arena.observe()!,candidate=obs.candidates.find(c=>c.definitionId==='special_162')!;
    expect(candidate).toBeDefined();
    const result=arena.step({...obs.decision,actionId:candidate.id});
    expect(result.info.resolvedCardDefinitions).toContain('special_162');
    const course=arena.exportSnapshot().state.trainingCourse!;
    expect(course.openIds.germany).toEqual(openedBefore.filter(id=>id!==event.id));
    expect(course.openRandomState).toBe(randomBefore);
  });
  it('forces a playable branch after committing guns or butter',()=>{
    const arena=new PpoTrainingArena(91,'guns-committed',{mode:'A',buildFingerprint:fingerprint});
    const start=arena.observe()!,card=start.candidates.find(c=>c.definitionId==='special_160')!;
    expect(card).toBeDefined();
    let result=arena.step({...start.decision,actionId:card.id});
    expect(result.info.submittedCardDefinitions).toContain('special_160');
    let seenChoice=false;
    for(let i=0;i<12&&!result.info.resolvedCardDefinitions.includes('special_160');i++){
      const obs=result.observation!;
      expect(obs.node).toBe('ENGINE_CHOICE');
      expect(obs.candidates.some(c=>c.kind==='choice'&&c.choiceIds?.length===0)).toBe(false);
      seenChoice=true;
      const candidate=obs.candidates[0];
      result=arena.step({...obs.decision,actionId:candidate.id});
    }
    expect(seenChoice).toBe(true);
    expect(result.info.resolvedCardDefinitions).toContain('special_160');
    expect(arena.exportSnapshot().state.decks.germany.discardPile.some(c=>c.id===card.cardId)).toBe(true);
  });
  it('rechecks each action in a committed multiaction event without offering an empty skip',()=>{
    const original=new PpoTrainingArena(7,'arden-committed',{mode:'A',buildFingerprint:fingerprint});
    const snapshot=original.exportSnapshot();
    snapshot.state.units=[
      {id:'g-front',country:'germany',type:'army',regionId:'germany'},
      {id:'uk-west',country:'united_kingdom',type:'army',regionId:'western_europe'},
    ];
    const arena=PpoTrainingArena.fromSnapshot(snapshot,{mode:'A',buildFingerprint:fingerprint});
    const first=arena.observe()!,card=first.candidates.find(c=>c.definitionId==='special_158')!;
    expect(card).toBeDefined();
    let result=arena.step({...first.decision,actionId:card.id});
    for(let i=0;i<15&&!result.info.resolvedCardDefinitions.includes('special_158');i++){
      const obs=result.observation!;
      expect(obs.candidates.some(c=>c.kind==='choice'&&c.choiceIds?.length===0)).toBe(false);
      const candidate=obs.candidates[0];
      expect(candidate).toBeDefined();
      result=arena.step({...obs.decision,actionId:candidate.id});
    }
    expect(result.info.resolvedCardDefinitions).toContain('special_158');
    const state=arena.exportSnapshot().state;
    expect(state.units.some(u=>u.id==='uk-west')).toBe(false);
    expect(state.units.some(u=>u.country==='germany'&&u.regionId==='western_europe')).toBe(true);
  });
  it('continues to a later event effect when its first effect has no legal target',()=>{
    const original=new PpoTrainingArena(7,'arden-first-invalid',{mode:'A',trace:'full',buildFingerprint:fingerprint});
    const snapshot=original.exportSnapshot();
    snapshot.state.units=[
      {id:'g-home',country:'germany',type:'army',regionId:'germany'},
      {id:'g-west',country:'germany',type:'army',regionId:'western_europe'},
    ];
    const arena=PpoTrainingArena.fromSnapshot(snapshot,{mode:'A',trace:'full',buildFingerprint:fingerprint});
    const start=arena.observe()!,card=start.candidates.find(c=>c.definitionId==='special_158')!;
    expect(card).toBeDefined();
    const result=arena.step({...start.decision,actionId:card.id});
    expect(result.info.resolvedCardDefinitions).toContain('special_158');
    expect((result.record as any).events.some((event:{type:string;mode?:string;regionId?:string})=>
      event.type==='UNIT_PLACED'&&event.mode==='build'&&event.regionId==='western_europe')).toBe(true);
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

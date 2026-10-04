import {describe,expect,it} from 'vitest';
import {PpoTrainingArena,type PpoCandidate,type PpoObservation,type PpoStepInfo} from '../src/training/ppoArena';

const options={mode:'A' as const,cardSet:'signals' as const,buildFingerprint:'b'.repeat(64)};
const act=(arena:PpoTrainingArena,observation:PpoObservation,candidate:PpoCandidate)=>
  arena.step({...observation.decision,actionId:candidate.id});
const find=(observation:PpoObservation,predicate:(candidate:PpoCandidate)=>boolean)=>{
  const candidate=observation.candidates.find(predicate);
  if(!candidate)throw Error(`No candidate in ${observation.choiceKind??observation.node}: `+
    observation.candidates.map(item=>item.label).join(' / '));
  return candidate;
};
const pendingPenalty=(info:PpoStepInfo)=>info.rewardAdjustments?.filter(item=>
  item.reason==='avoidable_repeated_target')??[];

function gunsOrButterScenario(){
  const saved=new PpoTrainingArena(101,'a2s1-repeat-link',options).exportSnapshot();
  const s=saved.state;
  const blitz=s.decks.germany.hand.find(card=>card.definitionId==='special_137')!;
  s.decks.germany.hand=s.decks.germany.hand.filter(card=>card.id!==blitz.id);
  s.decks.germany.active.push(blitz);
  s.units.push({id:'g-east',country:'germany',type:'army',regionId:'eastern_europe'},
    {id:'su-ukraine',country:'soviet_union',type:'army',regionId:'ukraine'});
  s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat='germany';
  return PpoTrainingArena.fromSnapshot(saved,options);
}

function chooseRepeatedBuild(arena:PpoTrainingArena){
  let observation=arena.observe()!;
  let step=act(arena,observation,find(observation,c=>c.definitionId==='special_160'));
  observation=step.observation!;
  step=act(arena,observation,find(observation,c=>c.choices?.some(choice=>
    choice.effects?.some(effect=>effect.kind==='action'&&effect.action==='build_army'))??false));
  observation=step.observation!;
  step=act(arena,observation,find(observation,c=>c.choiceIds?.includes('eastern_europe')??false));
  expect(pendingPenalty(step.info)).toHaveLength(0);
  return step;
}

describe('A2S1 independent acceptance regressions',()=>{
  it('encodes only the acting country turn and current round, including after restoration',()=>{
    const saved=new PpoTrainingArena(106,'a2s1-use-scope',options).exportSnapshot();
    const s=saved.state;
    const status=s.decks.germany.hand.find(card=>card.definitionId==='special_137')!;
    s.decks.germany.hand=s.decks.germany.hand.filter(card=>card.id!==status.id);
    s.decks.germany.active.push(status);
    s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat='germany';s.round=4;
    s.resolution!.turnUses={
      [`1:germany:${status.id}:old`]:50,
      [`4:united_kingdom:${status.id}:other_turn`]:1,
      [`4:germany:${status.id}:this_turn`]:1,
    };
    s.roundUses={[status.id]:4};
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    let obs=arena.observe()!;
    expect(obs.visibleUseCounts?.special_137).toBe(1);
    expect(obs.visibleRoundUseCounts?.special_137).toBe(1);
    const restored=PpoTrainingArena.fromSnapshot(arena.exportSnapshot(),options);
    expect(restored.observe()!.visibleUseCounts?.special_137).toBe(1);
    const next=restored.exportSnapshot();
    next.state.round=5;
    let resumed=PpoTrainingArena.fromSnapshot(next,options).observe()!;
    expect(resumed.visibleUseCounts?.special_137).toBe(0);
    expect(resumed.visibleRoundUseCounts?.special_137).toBe(0);
    next.state.round=4;next.state.activeSeat=next.state.operatorSeat='united_kingdom';
    resumed=PpoTrainingArena.fromSnapshot(next,options).observe()!;
    expect(resumed.visibleUseCounts?.special_137).toBe(1);
    expect(resumed.visibleRoundUseCounts?.special_137).toBe(1);
  });

  it('uses the active country scope for a hidden response on another country turn',()=>{
    const saved=new PpoTrainingArena(109,'a2s1-response-use-scope',options).exportSnapshot();
    const s=saved.state;
    const response=s.decks.soviet_union.hand.find(card=>card.definitionId==='special_57')!;
    s.decks.soviet_union.hand=s.decks.soviet_union.hand.filter(card=>card.id!==response.id);
    s.decks.soviet_union.faceDown.push(response);
    s.units.push({id:'g-east-scope',country:'germany',type:'army',regionId:'eastern_europe'});
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    const start=arena.observe()!;
    const build=find(start,c=>c.definitionId==='build_army'&&
      c.choices?.some(choice=>choice.regionId==='ukraine'&&!choice.repeated)===true);
    const next=act(arena,start,build).observation!;
    expect(next.choiceKind).toBe('TRIGGER');
    expect(next.decisionSeat).toBe('soviet_union');
    const awaiting=arena.exportSnapshot();
    awaiting.state.resolution!.turnUses={
      [`${awaiting.state.round}:germany:${response.id}:response`]:1,
      [`${awaiting.state.round}:soviet_union:${response.id}:other`]:5,
    };
    const visible=PpoTrainingArena.fromSnapshot(awaiting,options).observe()!;
    expect(visible.activeSeat).toBe('germany');
    expect(visible.decisionSeat).toBe('soviet_union');
    expect(visible.visibleUseCounts?.special_57).toBe(1);
    expect(visible.visibleCards?.ownFaceDown).toContain('special_57');
  });

  it('preserves a committed card’s legitimate one-or-two quantity choice',()=>{
    const saved=new PpoTrainingArena(110,'a2s1-one-or-two',options).exportSnapshot();
    saved.state.phase='PLAY';
    saved.state.activeSeat=saved.state.operatorSeat=saved.state.viewSeat='germany';
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    const source=arena.observe()!;
    const next=act(arena,source,find(source,c=>c.definitionId==='special_161')).observation!;
    expect(next.choiceMin).toBe(1);
    expect(next.choiceMax).toBe(2);
    expect(next.candidates.some(c=>c.choiceIds?.length===1)).toBe(true);
    expect(next.candidates.some(c=>c.choiceIds?.length===2)).toBe(true);
    expect(next.candidates.some(c=>c.choiceIds?.length===0)).toBe(false);
  });

  it('requires the committed special_166 extra play when a legal matching card remains',()=>{
    const saved=new PpoTrainingArena(102,'a2s1-166-committed',options).exportSnapshot();
    const s=saved.state;
    s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat='germany';
    s.units.push({id:'uk-scandinavia',country:'united_kingdom',type:'army',regionId:'scandinavia'});
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    let obs=arena.observe()!,step=act(arena,obs,find(obs,c=>c.definitionId==='special_166'));
    for(let i=0;i<12&&step.observation?.choiceKind!=='EXTRA_CARD';i++){
      obs=step.observation!;
      expect(obs.node).not.toBe('SOURCE');
      step=act(arena,obs,obs.candidates[0]);
    }
    obs=step.observation!;
    expect(obs.choiceKind).toBe('EXTRA_CARD');
    expect(obs.choiceMin).toBe(1);
    expect(obs.candidates.some(c=>c.choiceIds?.length===0)).toBe(false);
    expect(obs.candidates.length).toBeGreaterThan(0);
  });

  it('also commits the balanced Swedish Support Finland special_154 extra play',()=>{
    const saved=new PpoTrainingArena(107,'a2s1-154-committed',options).exportSnapshot();
    const s=saved.state;
    s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat='germany';
    s.units.push({id:'g-ross',country:'germany',type:'army',regionId:'ross_region'});
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    let obs=arena.observe()!,step=act(arena,obs,find(obs,c=>c.definitionId==='special_154'));
    for(let i=0;i<15&&step.observation?.choiceKind!=='EXTRA_CARD';i++){
      obs=step.observation!;
      expect(obs.node).not.toBe('SOURCE');
      step=act(arena,obs,obs.candidates[0]);
    }
    obs=step.observation!;
    expect(obs.choiceKind).toBe('EXTRA_CARD');
    expect(obs.choiceMin).toBe(1);
    expect(obs.candidates.some(c=>c.choiceIds?.length===0)).toBe(false);
  });

  it('requires White Plan extra play when possible and naturally finishes if none is legal',()=>{
    const saved=new PpoTrainingArena(103,'a2s1-white-extra',options).exportSnapshot();
    saved.state.phase='PLAY';saved.state.activeSeat=saved.state.operatorSeat=saved.state.viewSeat='germany';
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    let obs=arena.observe()!,step=act(arena,obs,find(obs,c=>c.definitionId==='special_150'));
    for(let i=0;i<10&&step.observation?.choiceKind!=='EXTRA_CARD';i++){
      obs=step.observation!;step=act(arena,obs,obs.candidates[0]);
    }
    obs=step.observation!;
    expect(obs.choiceKind).toBe('EXTRA_CARD');
    expect(obs.choiceMin).toBe(1);
    expect(obs.candidates.some(c=>c.choiceIds?.length===0)).toBe(false);

    const noExtra=new PpoTrainingArena(104,'a2s1-white-no-extra',options).exportSnapshot();
    const s=noExtra.state;
    s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat='germany';
    const only=s.decks.germany.hand.find(c=>c.definitionId==='special_150')!;
    s.decks.germany.drawPile=s.decks.germany.hand.filter(c=>c.id!==only.id);
    s.decks.germany.hand=[only];
    const emptyArena=PpoTrainingArena.fromSnapshot(noExtra,options);
    obs=emptyArena.observe()!;
    step=act(emptyArena,obs,find(obs,c=>c.definitionId==='special_150'));
    for(let i=0;i<10&&step.observation?.node!=='SOURCE';i++){
      obs=step.observation!;
      expect(obs.choiceKind).not.toBe('EXTRA_CARD');
      step=act(emptyArena,obs,obs.candidates[0]);
    }
    expect(emptyArena.exportSnapshot().state.decks.germany.discardPile.some(c=>
      c.definitionId==='special_150')).toBe(true);
  });

  it('waits for Blitzkrieg follow-up before judging a repeated event target',()=>{
    const arena=gunsOrButterScenario();let step=chooseRepeatedBuild(arena);
    const penalties:PpoStepInfo['rewardAdjustments']=[];
    let attacked=false;
    for(let i=0;i<15&&step.observation?.node!=='SOURCE';i++){
      const obs=step.observation!;
      const candidate=obs.choiceKind==='TRIGGER'?
        find(obs,c=>c.choices?.some(v=>v.definitionId==='special_137')??false):
        obs.candidates.find(c=>c.choices?.some(v=>v.action==='land_battle'&&
          (v.regionId==='ukraine'||v.target?.regionId==='ukraine'))??false)??obs.candidates[0];
      attacked ||= candidate.choices?.some(v=>v.action==='land_battle'&&
        (v.regionId==='ukraine'||v.target?.regionId==='ukraine'))??false;
      step=act(arena,obs,candidate);penalties.push(...step.info.rewardAdjustments??[]);
    }
    expect(attacked).toBe(true);
    expect(penalties?.filter(item=>item.reason==='avoidable_repeated_target')).toHaveLength(0);
  });

  it('does not call an actual attack waste when the defender responds successfully',()=>{
    const saved=gunsOrButterScenario().exportSnapshot();
    const defense=saved.state.decks.soviet_union.hand.find(c=>c.definitionId==='special_54')!;
    saved.state.decks.soviet_union.hand=saved.state.decks.soviet_union.hand.filter(c=>c.id!==defense.id);
    saved.state.decks.soviet_union.faceDown.push(defense);
    const arena=PpoTrainingArena.fromSnapshot(saved,options);
    let step=chooseRepeatedBuild(arena),defended=false;
    const penalties:NonNullable<PpoStepInfo['rewardAdjustments']>=[];
    for(let i=0;i<20&&step.observation?.node!=='SOURCE';i++){
      const obs=step.observation!;
      const candidate=obs.choiceKind==='TRIGGER'?
        find(obs,c=>c.choices?.some(v=>v.definitionId===
          (obs.decisionSeat==='soviet_union'?'special_54':'special_137'))??false):
        obs.candidates.find(c=>c.choices?.some(v=>v.action==='land_battle'&&
          (v.regionId==='ukraine'||v.target?.regionId==='ukraine'))??false)??obs.candidates[0];
      defended ||= obs.choiceKind==='TRIGGER'&&obs.decisionSeat==='soviet_union';
      step=act(arena,obs,candidate);penalties.push(...step.info.rewardAdjustments??[]);
    }
    expect(defended).toBe(true);
    expect(arena.exportSnapshot().state.units.some(u=>u.id==='su-ukraine')).toBe(true);
    expect(penalties.filter(item=>item.reason==='avoidable_repeated_target')).toHaveLength(0);
    expect(penalties.filter(item=>item.reason==='optional_trigger_no_effect')).toHaveLength(0);
  });

  it('still penalizes a standalone repeated basic build with an effective alternative',()=>{
    const saved=new PpoTrainingArena(105,'a2s1-basic-repeat',options).exportSnapshot();
    const s=saved.state;
    s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat='germany';
    s.units.push({id:'g-east',country:'germany',type:'army',regionId:'eastern_europe'});
    const arena=PpoTrainingArena.fromSnapshot(saved,options),obs=arena.observe()!;
    const repeated=find(obs,c=>c.definitionId==='build_army'&&
      c.choices?.some(v=>v.regionId==='eastern_europe'&&v.repeated)===true);
    const step=act(arena,obs,repeated);
    expect(step.info.rewardAdjustments?.filter(item=>item.reason==='avoidable_repeated_target'))
      .toHaveLength(1);
    expect(step.info.wasteCheck?.penalty).toBe(false);
  });

  it('charges a repeated target once after its optional follow-up is declined',()=>{
    const arena=gunsOrButterScenario();let step=chooseRepeatedBuild(arena);
    const penalties:PpoStepInfo['rewardAdjustments']=[];
    for(let i=0;i<15&&step.observation?.node!=='SOURCE';i++){
      const obs=step.observation!;
      const candidate=obs.choiceKind==='TRIGGER'?find(obs,c=>c.choiceIds?.length===0):obs.candidates[0];
      step=act(arena,obs,candidate);penalties.push(...step.info.rewardAdjustments??[]);
    }
    expect(penalties?.filter(item=>item.reason==='avoidable_repeated_target')).toHaveLength(1);
  });
});

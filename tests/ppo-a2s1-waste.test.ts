import {describe,expect,it} from 'vitest';
import {PpoTrainingArena,type PpoCandidate,type PpoObservation,type PpoStepInfo} from '../src/training/ppoArena';
import type {SeatId,Unit} from '../src/core/types';

const options={mode:'A' as const,cardSet:'signals' as const,buildFingerprint:'d'.repeat(64)};
function arena(seat:SeatId,units?:Unit[]){
  const saved=new PpoTrainingArena(421,'waste-regression-'+seat,options).exportSnapshot();
  if(units)saved.state.units=units;saved.state.phase='PLAY';
  saved.state.activeSeat=saved.state.operatorSeat=saved.state.viewSeat=seat;
  return PpoTrainingArena.fromSnapshot(saved,options);
}
const act=(a:PpoTrainingArena,o:PpoObservation,c:PpoCandidate)=>
  a.step({...o.decision,actionId:c.id});
function play(a:PpoTrainingArena,id:string,choose?:(o:PpoObservation)=>PpoCandidate){
  let o=a.observe()!;
  const card=o.candidates.find(c=>c.definitionId===id);
  if(!card)throw Error(`Missing ${id}: ${o.candidates.map(c=>c.definitionId).join(',')}`);
  const initial=o.decision.decisionId;
  const all:PpoStepInfo[]=[];
  let step=act(a,o,card);all.push(step.info);
  for(let n=0;n<24&&step.observation?.node!=='SOURCE';n++){
    o=step.observation!;
    step=act(a,o,choose?.(o)??o.candidates[0]);all.push(step.info);
  }
  expect(step.observation?.node).toBe('SOURCE');
  return {initial,all,last:step.observation!};
}
const penalties=(all:PpoStepInfo[])=>all.flatMap(info=>info.rewardAdjustments??[]);
const assessments=(all:PpoStepInfo[])=>all.flatMap(info=>info.wasteAssessments??[]);

describe('A2S1 complete-action waste',()=>{
  it.each(['special_33','special_35'])('charges empty French choice %s once',id=>{
    const a=arena('united_kingdom',[{id:'g-west',country:'germany',type:'army',regionId:'western_europe'}]);
    const result=play(a,id);
    expect(penalties(result.all)).toMatchObject([{decisionId:result.initial,seat:'united_kingdom',
      reason:'whole_action_no_effect',penalty:-0.01}]);
  });
  it('charges an empty conditional event with a confirmed event alternative',()=>{
    const a=arena('united_states');
    const result=play(a,'special_115');
    expect(penalties(result.all)).toMatchObject([{decisionId:result.initial,
      reason:'whole_action_no_effect',penalty:-0.01}]);
  });
  it('charges a destroy with no target',()=>{
    const a=arena('soviet_union');
    const result=play(a,'special_62');
    expect(penalties(result.all)).toMatchObject([{decisionId:result.initial,
      reason:'whole_action_no_effect',penalty:-0.01}]);
  });
  it.each([['germany','special_157'],['italy','special_237']] as const)(
    'charges zero direct score for %s', (seat,id)=>{
      const a=arena(seat,[{id:'home',country:seat,type:'army',regionId:seat}]);
      const result=play(a,id);
      expect(penalties(result.all)).toMatchObject([{decisionId:result.initial,
        reason:'whole_action_no_effect',penalty:-0.01}]);
    });
  it('recognizes an effective event alternative when no basic card remains',()=>{
    const a=arena('united_kingdom');
    const saved=a.exportSnapshot(),s=saved.state;
    s.decks.united_kingdom.drawPile.push(...s.decks.united_kingdom.hand.filter(c=>
      ['build_army','build_navy','land_battle','sea_battle'].includes(c.definitionId)));
    s.decks.united_kingdom.hand=s.decks.united_kingdom.hand.filter(c=>
      !['build_army','build_navy','land_battle','sea_battle'].includes(c.definitionId));
    const resumed=PpoTrainingArena.fromSnapshot(saved,options);
    const result=play(resumed,'special_22');
    expect(penalties(result.all)).toMatchObject([{decisionId:result.initial,
      reason:'whole_action_no_effect',penalty:-0.01}]);
    expect(assessments(result.all).find(item=>item.cardId.includes('special_22'))?.alternative).toBe(true);
  });
  it.each(['special_23','special_31'])('charges all-new-units supply loss for %s',id=>{
    const a=arena('united_kingdom');
    const result=play(a,id);
    expect(penalties(result.all)).toMatchObject([{decisionId:result.initial,seat:'united_kingdom',
      reason:'same_turn_supply_loss',penalty:-0.01}]);
  });
  it('charges an optional Blitzkrieg activation with only an empty attack',()=>{
    const saved=arena('germany',[{id:'g-home',country:'germany',type:'army',regionId:'germany'}]).exportSnapshot(),s=saved.state;
    const status=s.decks.germany.hand.find(c=>c.definitionId==='special_137')!;
    s.decks.germany.hand=s.decks.germany.hand.filter(c=>c.id!==status.id);
    s.decks.germany.active.push(status);
    const a=PpoTrainingArena.fromSnapshot(saved,options);
    let o=a.observe()!;
    let step=act(a,o,o.candidates.find(c=>c.definitionId==='build_army'&&
      c.choices?.[0]?.regionId==='eastern_europe')!);
    o=step.observation!;
    expect(o.choiceKind).toBe('TRIGGER');
    const trigger=o.candidates.find(c=>c.choices?.some(choice=>
      choice.definitionId==='special_137'))!;
    const triggerDecision=o.decision.decisionId;
    step=act(a,o,trigger);
    const all=[step.info];
    for(let n=0;n<12&&step.observation?.node!=='SOURCE';n++){
      o=step.observation!;
      const choice=o.candidates.find(c=>c.choices?.some(v=>v.regionId==='ukraine'))??o.candidates[0];
      step=act(a,o,choice);all.push(step.info);
    }
    expect(penalties(all)).toMatchObject([{decisionId:triggerDecision,seat:'germany',
      reason:'optional_trigger_no_effect',penalty:-0.01}]);
  });
  it('exempts the same choice event when its French build succeeds',()=>{
    const a=arena('united_kingdom',[]);
    const result=play(a,'special_33');
    expect(result.all.flatMap(info=>info.resolvedCardDefinitions)).toContain('special_33');
    expect(a.exportSnapshot().state.units.some(unit=>unit.country==='france')).toBe(true);
    expect(penalties(result.all)).toEqual([]);
  });
  it('exempts a nonzero direct score and keeps actual game score separate',()=>{
    const a=arena('germany',[{id:'g-away',country:'germany',type:'army',regionId:'eastern_europe'}]);
    const before=a.exportSnapshot().state.scores.germany;
    const result=play(a,'special_157');
    expect(a.exportSnapshot().state.scores.germany).toBeGreaterThan(before);
    expect(penalties(result.all)).toEqual([]);
  });
  it('does not penalize an empty card if there is no confirmed effective alternative',()=>{
    const saved=arena('united_kingdom').exportSnapshot(),s=saved.state;
    const only=s.decks.united_kingdom.hand.find(c=>c.definitionId==='special_22')!;
    s.decks.united_kingdom.drawPile.push(...s.decks.united_kingdom.hand.filter(c=>c.id!==only.id));
    s.decks.united_kingdom.hand=[only];
    const a=PpoTrainingArena.fromSnapshot(saved,options);
    const result=play(a,'special_22');
    expect(penalties(result.all)).toEqual([]);
    expect(assessments(result.all).find(item=>item.cardId===only.id)?.reason)
      .toBe('no_confirmed_alternative');
  });
  it('installing a public status has no immediate-waste penalty',()=>{
    const a=arena('germany');
    const result=play(a,'special_137');
    expect(penalties(result.all)).toEqual([]);
    expect(a.exportSnapshot().state.decks.germany.active.some(c=>
      c.definitionId==='special_137')).toBe(true);
  });
  it('an existing status does not disable a different action’s supply-loss check',()=>{
    const saved=arena('united_kingdom').exportSnapshot(),s=saved.state;
    const card=s.decks.germany.hand.find(c=>c.definitionId==='special_137')!;
    s.decks.germany.hand=s.decks.germany.hand.filter(c=>c.id!==card.id);
    s.decks.germany.active.push(card);
    const a=PpoTrainingArena.fromSnapshot(saved,options),result=play(a,'special_23');
    expect(penalties(result.all).filter(item=>item.reason==='same_turn_supply_loss'))
      .toMatchObject([{decisionId:result.initial,penalty:-0.01}]);
  });
});

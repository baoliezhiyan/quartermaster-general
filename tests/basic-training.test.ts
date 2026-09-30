import { describe, expect, it } from 'vitest';
import { BasicTrainingArena, BASIC_ACTIONS, basicActionWeight, effectiveUnitTotal, playTrainingGame,
  TRAINING_COUNTRIES, trainingLogLines } from '../src/training/basicArena';

const submit=(arena:BasicTrainingArena,actionId:string)=>arena.step({...arena.observe()!.decision,actionId});
const FINGERPRINT='a'.repeat(64);

describe('headless basic training arena',()=>{
  it('exposes only four finite balanced basic resources and reproducible legal candidates',()=>{
    const a=new BasicTrainingArena(1939),b=new BasicTrainingArena(1939);
    expect(a.header.recordType).toBe('AI训练记录');
    expect(a.header.rules).toMatchObject({prelude:false,neutrality:false,balance:true,resourceMode:'finite-pool'});
    expect({...a.observe(),decision:null}).toEqual({...b.observe(),decision:null});
    const obs=a.observe()!;
    expect(Object.keys(obs.resources.italy)).toEqual([...BASIC_ACTIONS]);
    expect(obs.resources.italy.build_navy).toBe(5);
    expect(obs.resources.italy.sea_battle).toBe(3);
    expect(obs.availableUnitReserve.italy.army).toBe(4); // One Italian army starts on the map.
    expect(TRAINING_COUNTRIES.find(c=>c.id==='italy')?.effectiveUnitTotal.army).toBe(5);
    expect(TRAINING_COUNTRIES.some(c=>c.id==='france')).toBe(true);
    expect(TRAINING_COUNTRIES.some(c=>c.id==='china')).toBe(true);
    expect(effectiveUnitTotal('italy',false).army).toBe(4);
    expect(obs.candidates.every(c=>c.kind==='pass'||BASIC_ACTIONS.includes(c.cardType))).toBe(true);
    expect(obs.candidates.map(c=>c.id).length).toBe(new Set(obs.candidates.map(c=>c.id)).size);
  });
  it('runs a legal turn through the production engine and records action and effects',()=>{
    const arena=new BasicTrainingArena(12,'training-12',{trace:'full',keepRecords:true});
    const first=arena.observe()!;
    const play=first.candidates.find(c=>c.kind==='play'&&c.cardType==='build_army');
    expect(play).toBeDefined();
    const result=submit(arena,play!.id);
    if(result.record?.recordType!=='decision')throw new Error('Missing full record');
    expect(result.record.action.cardType).toBe('build_army');
    expect(result.record.before.resources.germany.build_army-result.record.after.resources.germany.build_army).toBe(1);
    expect(result.record.engineEvents.some(e=>e.type==='RULE_EVENT'&&e.code==='COUNTRY_SCORED')).toBe(true);
    expect(result.observation?.activeSeat).toBe('united_kingdom');
    expect(trainingLogLines(arena)[0]).toContain('AI训练记录');
    expect(()=>submit(arena,'illegal')).toThrow(/Unknown candidate/);
  });
  it('can finish twenty rounds using pass without extra player inputs',()=>{
    const arena=new BasicTrainingArena(33,'training-33',{trace:'full',keepRecords:true});
    for(let n=0;!arena.done&&n<200;n++)submit(arena,'pass');
    expect(arena.done).toBe(true);
    expect(arena.result?.winner).not.toBeNull();
    expect(arena.result?.decisions).toBe(arena.records.length);
    expect(arena.records.some(r=>r.engineEvents.some(e=>e.type==='RULE_EVENT'&&e.code==='GAME_FINISHED'))).toBe(true);
  });
  it('rejects stale, repeated, and cross-episode submissions without changing state',()=>{
    const a=new BasicTrainingArena(1),b=new BasicTrainingArena(1);
    const initial=a.observe()!,old={...initial.decision,actionId:'pass'};
    expect(()=>b.step(old)).toThrow(/Stale decision context/);
    a.step(old);
    const after=a.exportSnapshot();
    expect(()=>a.step(old)).toThrow(/Stale decision context/);
    expect(a.exportSnapshot()).toEqual(after);
    for(let i=0;i<5;i++)submit(a,'pass');
    expect(a.observe()?.activeSeat).toBe('germany');
    expect(()=>a.step(old)).toThrow(/Stale decision context/);
    expect(a.observe()).toBe(a.observe());
    expect(()=>{a.observe()!.candidates.pop();}).toThrow();
  });
  it('restores a decision and distinguishes truncation from a win',()=>{
    const arena=new BasicTrainingArena(4,'restore-demo',{trace:'full',keepRecords:true,
      buildFingerprint:FINGERPRINT,requireBuildFingerprint:true});
    submit(arena,'pass');
    const restored=BasicTrainingArena.fromSnapshot(arena.exportSnapshot(),{trace:'full',keepRecords:true,
      buildFingerprint:FINGERPRINT});
    expect({...restored.observe(),decision:null}).toEqual({...arena.observe(),decision:null});
    submit(arena,'pass');submit(restored,'pass');
    expect({...restored.observe(),decision:null}).toEqual({...arena.observe(),decision:null});
    const last=restored.observe();
    const truncated=restored.truncate();
    expect(truncated.termination).toBe('truncated');
    expect(truncated.finalObservation).toEqual(last);
    expect(truncated.finalObservation?.decision).toEqual(last?.decision);
    expect(restored.observe()).toBeNull();
    expect(restored.result?.winner).toBeNull();
    expect(BasicTrainingArena.fromSnapshot(restored.exportSnapshot(),
      {buildFingerprint:FINGERPRINT}).result?.finalObservation).toEqual(last);
    expect(playTrainingGame(4,()=> 'pass',1).result?.termination).toBe('truncated');
  });
  it('requires matching build identity to restore and rejects unnamed formal runs',()=>{
    expect(()=>new BasicTrainingArena(1,'formal',{requireBuildFingerprint:true})).toThrow(/fingerprint/);
    const arena=new BasicTrainingArena(2,'identified',{buildFingerprint:FINGERPRINT,
      requireBuildFingerprint:true});
    const saved=arena.exportSnapshot();
    expect(()=>BasicTrainingArena.fromSnapshot(saved)).toThrow(/fingerprint/);
    expect(()=>BasicTrainingArena.fromSnapshot(saved,{buildFingerprint:'b'.repeat(64)})).toThrow(/fingerprint/);
    const changed=structuredClone(saved);changed.header.buildFingerprint='b'.repeat(64);
    expect(()=>BasicTrainingArena.fromSnapshot(changed,{buildFingerprint:FINGERPRINT})).toThrow(/fingerprint/);
    expect(BasicTrainingArena.fromSnapshot(saved,{buildFingerprint:FINGERPRINT}).observe()).toEqual(arena.observe());
  });
  it('returns the same compact learning feedback with diagnostics off or on',()=>{
    const base=new BasicTrainingArena(9,'feedback',{buildFingerprint:FINGERPRINT});
    const saved=base.exportSnapshot();
    const lean=BasicTrainingArena.fromSnapshot(saved,{buildFingerprint:FINGERPRINT,trace:'none'});
    const detailed=BasicTrainingArena.fromSnapshot(saved,{buildFingerprint:FINGERPRINT,trace:'summary'});
    const a=submit(lean,'pass'),b=submit(detailed,'pass');
    expect(a.info).toEqual(b.info);
    expect(a.info).toMatchObject({turnsAdvanced:1,termination:'ongoing',winner:null});
    expect(a.info.scoreDelta).toEqual(b.record?.scoreDelta);
    expect(a.record).toBeNull();
    expect(b.record?.recordType).toBe('decision-summary');
    expect('before' in (b.record??{})).toBe(false);
  });
  it('rejects empty truncation reasons without changing the episode',()=>{
    const arena=new BasicTrainingArena(10);const before=arena.exportSnapshot();
    expect(()=>arena.truncate('')).toThrow(/reason/);
    expect(()=>arena.truncate('  ')).toThrow(/reason/);
    expect(arena.exportSnapshot()).toEqual(before);
    expect(arena.done).toBe(false);
    expect(arena.truncate('time_limit').truncationReason).toBe('time_limit');
    expect(arena.result?.termination).toBe('truncated');
  });
  it('keeps all legal candidates in the weighted baseline',()=>{
    const observation=new BasicTrainingArena(7).observe()!;
    const weights=observation.candidates.map(action=>basicActionWeight(observation,action));
    expect(weights.every(weight=>weight>0&&Number.isFinite(weight))).toBe(true);
    expect(basicActionWeight(observation,observation.candidates.at(-1)!)).toBe(0.3);
  });
});

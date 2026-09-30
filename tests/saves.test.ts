import { describe, expect, it } from 'vitest';
import { LocalGameController } from '../src/controller/LocalGameController';
import type { SessionStore } from '../src/controller/SessionStore';
import type { SaveSession } from '../src/controller/saveFormat';
import { validateSession } from '../src/controller/saveFormat';
import type { Command } from '../src/core';

class MemoryStore implements SessionStore {
  values=new Map<string,SaveSession>();last='';fail=false;
  async read(id=this.last){return structuredClone(this.values.get(id)??null);}
  async write(s:SaveSession,_expected?:string,replaceExisting=false){if(this.fail)throw new Error('磁盘已满');if(replaceExisting)this.values.clear();this.values.set(s.state.gameId,structuredClone(s));this.last=s.state.gameId;}
  async list(){return [...this.values.values()].map(s=>({id:s.state.gameId,updatedAt:s.updatedAt}));}
}
async function send(c:LocalGameController,payload:Record<string,unknown>) {
  const s=c.getSnapshot()!;
  const r=await c.dispatch({seat:s.operatorSeat,expectedRevision:s.revision,...payload} as Command);
  expect(r).toEqual({ok:true});
}
async function ready(mode:'FULL'|'BASIC_DEBUG'='BASIC_DEBUG',store?:SessionStore) {
  const c=new LocalGameController(store);
  await c.dispatch({type:'CREATE_GAME',gameId:`save-${mode}`,seed:1940,mode});
  for(let i=0;i<6;i++){const s=c.getSnapshot()!;await send(c,{type:'KEEP_OPENING',cardIds:s.decks[s.viewSeat].hand.slice(0,7).map(v=>v.id)});}
  return c;
}
async function finishTurn(c:LocalGameController) {
  const seat=c.getSnapshot()!.activeSeat;
  for(let i=0;i<12&&c.getSnapshot()!.activeSeat===seat;i++) {
    const s=c.getSnapshot()!;
    if(s.phase==='DISCARD')await send(c,{type:'DISCARD_HAND',cardIds:s.decks[seat].hand.slice(0,1).map(v=>v.id)});
    else await send(c,{type:'ADVANCE_PHASE'});
  }
  expect(c.getSnapshot()!.activeSeat).not.toBe(seat);
}

describe('automatic saves and bounded undo',()=>{
  it('starts round saves at round 1, replaces one national slot per turn, and retains round starts',async()=>{
    const c=await ready();
    expect(c.getSessionInfo().rounds.map(v=>v.round)).toEqual([1]);
    expect(c.getSessionInfo().nations).toHaveLength(1);
    for(let i=0;i<6;i++)await finishTurn(c);
    expect(c.getSnapshot()).toMatchObject({round:2,activeSeat:'germany'});
    expect(c.getSessionInfo().rounds.map(v=>v.round)).toEqual([1,2]);
    expect(c.getSessionInfo().nations).toHaveLength(6);
    expect(c.getSessionInfo().nations.find(v=>v.seat==='germany')?.round).toBe(2);
    expect(c.getSessionInfo().nations.find(v=>v.seat==='united_kingdom')?.round).toBe(1);
    await finishTurn(c);
    expect(c.getSessionInfo().nations.find(v=>v.seat==='united_kingdom')?.round).toBe(2);
    expect(c.getSessionInfo().undoCount).toBe(0);
    await expect(c.undo()).rejects.toThrow('行动开始');
    await c.loadCheckpoint('round:1');
    expect(c.getSnapshot()).toMatchObject({round:1,activeSeat:'germany',phase:'TURN_START_WINDOW'});
    expect(c.getSessionInfo().rounds).toHaveLength(2);
    await c.loadCheckpoint('nation:2:united_kingdom');
    expect(c.getSnapshot()).toMatchObject({round:2,activeSeat:'united_kingdom'});
  });
  it('undo restores complete state, preserves revision safety, ignores view changes, and stops at turn start',async()=>{
    const c=await ready(),begin=c.getSnapshot()!;
    await send(c,{type:'SET_VIEW',seat:'japan'});expect(c.getSessionInfo().undoCount).toBe(0);
    await send(c,{type:'SET_VIEW',seat:'germany'});
    await send(c,{type:'ADVANCE_PHASE'});
    await send(c,{type:'ADVANCE_PHASE'});
    const revision=c.getSnapshot()!.revision;
    await c.undo();expect(c.getSnapshot()!.phase).toBe('PLAY');
    await c.undo();expect(c.getSnapshot()!.phase).toBe(begin.phase);
    expect(c.getSnapshot()!.randomState).toBe(begin.randomState);
    expect(c.getSnapshot()!.decks).toEqual(begin.decks);
    expect(c.getSnapshot()!.revision).toBeGreaterThan(revision);
    await expect(c.undo()).rejects.toThrow();
    expect(await c.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:revision})).toEqual({ok:false,error:'STALE_REVISION'});
    expect(c.checkReplay()).toBe(true);
  });
  it('exports/imports a pending full-deck trigger with the undo stack and rejects incompatible or broken saves atomically',async()=>{
    const c=await ready('FULL');
    const before=c.getSnapshot()!;expect(before.resolution?.choice?.kind).toBe('TRIGGER');
    const text=c.exportSave();
    const target=new LocalGameController();await target.importSave(text);
    expect(target.getSnapshot()!.resolution).toEqual(before.resolution);
    expect(target.getSnapshot()!.decks).toEqual(before.decks);
    const bad=JSON.parse(text);bad.state.rulesVersion='9.9';
    const intact=target.getSnapshot();await expect(target.importSave(JSON.stringify(bad))).rejects.toThrow('版本');expect(target.getSnapshot()).toBe(intact);
    const duplicate=JSON.parse(text);duplicate.state.decks.germany.hand.push(duplicate.state.decks.germany.hand[0]);
    await expect(target.importSave(JSON.stringify(duplicate))).rejects.toThrow('重复');
    await send(target,{type:'RESOLVE_ENGINE_CHOICE',choiceId:target.getSnapshot()!.resolution!.choice!.id,ids:[]});
    expect(target.getSnapshot()!.phase).toBe('PLAY');await target.undo();expect(target.getSnapshot()!.resolution).toEqual(before.resolution);
    expect(target.checkReplay()).toBe(true);
  });
  it('restores current progress and undo after reopening, replaces previous games, and surfaces storage failures',async()=>{
    const store=new MemoryStore(),c=await ready('BASIC_DEBUG',store);
    await send(c,{type:'ADVANCE_PHASE'});
    const reopened=new LocalGameController(store);
    await new Promise<void>(resolve=>{const off=reopened.subscribe(()=>{if(reopened.getSessionInfo().ready){off();resolve();}});});
    expect(reopened.getSnapshot()!.phase).toBe('PLAY');expect(reopened.getSessionInfo().undoCount).toBe(1);
    await reopened.undo();expect(reopened.getSnapshot()!.phase).toBe('TURN_START_WINDOW');
    await c.dispatch({type:'CREATE_GAME',gameId:'other-game',seed:12});expect(await store.list()).toHaveLength(1);
    store.fail=true;await send(c,{type:'SET_VIEW',seat:'japan'});
    expect(c.getSessionInfo().storageError).toContain('保存失败');expect(c.getSnapshot()!.viewSeat).toBe('japan');
  });
  it('validates deterministic replay and supports reversible scene editing without changing timing',async()=>{
    const c=await ready();await send(c,{type:'ADVANCE_PHASE'});
    const draft=structuredClone(c.getSnapshot()!);draft.scores.germany=23;
    await c.editScene(draft);expect(c.getSnapshot()!.scores.germany).toBe(23);
    expect(c.checkReplay()).toBe(true);expect(()=>validateSession(JSON.parse(c.exportSave()))).not.toThrow();
    await c.undo();expect(c.getSnapshot()!.scores.germany).toBe(0);
    const corrupt=JSON.parse(c.exportSave());corrupt.state.scores.germany=123;
    expect(()=>validateSession(corrupt)).toThrow('回放');
  });
  it('restores a target choice, undoes its placement, and can make a different choice without redo',async()=>{
    const c=await ready('FULL');
    await send(c,{type:'RESOLVE_ENGINE_CHOICE',choiceId:c.getSnapshot()!.resolution!.choice!.id,ids:[]});
    const card=c.getSnapshot()!.decks.germany.hand.find(v=>v.definitionId==='build_army')!;
    await send(c,{type:'PLAY_CARD',cardId:card.id,effectIndices:[0],targetIds:[]});
    const saved=c.exportSave(),original=c.getSnapshot()!;
    expect(original.resolution!.choice!.kind).toBe('ACTION');
    await send(c,{type:'RESOLVE_ENGINE_CHOICE',choiceId:original.resolution!.choice!.id,ids:['eastern_europe']});
    expect(c.getSnapshot()!.units).toHaveLength(original.units.length+1);
    await c.undo();expect(c.getSnapshot()!.units).toEqual(original.units);expect(c.getSnapshot()!.resolution).toEqual(original.resolution);
    await c.importSave(saved);
    await send(c,{type:'RESOLVE_ENGINE_CHOICE',choiceId:c.getSnapshot()!.resolution!.choice!.id,ids:['balkans']});
    expect(c.getSnapshot()!.units.some(u=>u.country==='germany'&&u.regionId==='balkans')).toBe(true);
    expect(c.getSnapshot()!.units.some(u=>u.country==='germany'&&u.regionId==='eastern_europe')).toBe(false);
    expect(c.checkReplay()).toBe(true);expect(()=>validateSession(JSON.parse(c.exportSave()))).not.toThrow();
  });
  it('can import a file into memory when browser storage is unavailable',async()=>{
    const source=await ready('FULL');
    const unavailable:SessionStore={read:async()=>{throw new Error('存储不可用');},write:async()=>{throw new Error('存储不可用');},list:async()=>[]};
    const target=new LocalGameController(unavailable);
    await target.importSave(source.exportSave());
    expect(target.getSnapshot()!.resolution).toEqual(source.getSnapshot()!.resolution);
    expect(target.getSessionInfo().storageError).toContain('保存失败');
    expect(target.checkReplay()).toBe(true);
  });
});

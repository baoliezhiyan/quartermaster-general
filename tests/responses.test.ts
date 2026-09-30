import { expect, it } from 'vitest';
import { transition } from '../src/core';
import type { Command, GameState } from '../src/core';
import { responsePreset, RESPONSE_PRESETS } from '../src/controller/responsePresets';
import { validateSession } from '../src/controller/saveFormat';
import { startResolution } from '../src/core/resolution';
function send(s:GameState,p:Record<string,unknown>) {const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...p} as Command);if(!r.ok)throw Error(r.error);return r.state;}
function choose(s:GameState,needle?:string) {const c=s.resolution!.choice!;return send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:c.id,ids:needle?[c.options.find(o=>o.label.includes(needle))!.id]:[]});}
function cloud(id='bletchley') {let s=responsePreset(id,id).state;return choose(s,'云量');}
it.each(RESPONSE_PRESETS)('validates preset $id',p=>{expect(()=>validateSession(responsePreset(p.id,p.id))).not.toThrow();});
it('waits for Britain without changing Germany view, rejects German answers and survives save validation',()=>{
 let s=cloud();expect(s.viewSeat).toBe('germany');expect(s.resolution!.choice!.seat).toBe('united_kingdom');
 const c=s.resolution!.choice!;
 expect(transition(s,{type:'RESOLVE_ENGINE_CHOICE',seat:'germany',expectedRevision:s.revision,choiceId:c.id,ids:[]}).ok).toBe(false);
 expect(transition(s,{type:'ADVANCE_PHASE',seat:s.operatorSeat,expectedRevision:s.revision}).ok).toBe(false);
 const session=responsePreset('bletchley','bletchley');session.state=s;session.replayBase=structuredClone(s);session.rounds=[];session.nations=[];
 expect(()=>validateSession(JSON.parse(JSON.stringify(session)))).not.toThrow();
 s=send(s,{type:'SET_VIEW',seat:'united_kingdom'});expect(s.resolution!.choice!.id).toBe(c.id);
 s=choose(s);expect(s.turnFlags?.noAirDefense).toBe(true);expect(s.viewSeat).toBe('united_kingdom');
});
it('Britain pays its own card and cancels Cloud',()=>{
 let s=cloud();s=send(s,{type:'SET_VIEW',seat:'united_kingdom'});s=choose(s,'布莱切利园');
 expect(s.resolution!.choice!.kind).toBe('PAY_COST');const c=s.resolution!.choice!;
 s=send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:c.id,ids:[c.options[0].id]});
 expect(s.turnFlags?.noAirDefense??false).toBe(false);expect(s.resolution!.running).toBe(false);
 expect(s.decks.united_kingdom.discardPile).toHaveLength(2);expect(s.decks.germany.discardPile.some(c=>c.definitionId==='special_142')).toBe(true);
});
it('does not offer Bletchley without another hand card for its cost',()=>{const s=cloud('bletchley-no-fee');expect(s.resolution!.running).toBe(false);expect(s.turnFlags?.noAirDefense).toBe(true);});
it('one country declining does not discard another country’s response',()=>{
 let s=responsePreset('bletchley-no-fee','multi').state;s.mode='BASIC_DEBUG';s.resolution=null;
 startResolution(s,'multi','germany',[{kind:'trace',label:'event'}],(['united_kingdom','italy'] as const).map(owner=>({id:owner,label:owner,sourceInstanceId:owner,owner,timing:'After',on:'event',mandatory:false,source:'system',effects:[{kind:'trace',label:owner}]})));
 expect(s.resolution!.choice!.seat).toBe('united_kingdom');s=choose(s);
 expect(s.resolution!.choice!.seat).toBe('italy');s=choose(s,'italy');expect(s.resolution!.trace).toEqual(['event','italy']);
});
it('a face-down British response cancels economic damage and German scoring',()=>{
 let s=responsePreset('anti-submarine','economic').state;const n=s.decks.united_kingdom.drawPile.length;
 s=send(s,{type:'PLAY_CARD',cardId:s.decks.germany.hand.find(c=>c.definitionId==='special_168')!.id,effectIndices:[0,1],targetIds:[]});
 expect(s.resolution!.choice!.seat).toBe('united_kingdom');s=send(s,{type:'SET_VIEW',seat:'united_kingdom'});s=choose(s,'反潜战术');
 expect(s.resolution!.running).toBe(false);expect(s.scores.germany).toBe(2);expect(s.publicLog?.some(e=>e.text==='德国计分阶段获得 2 分。')).toBe(true);expect(s.decks.united_kingdom.drawPile).toHaveLength(n);
});
it('Keep Calm interrupts Conscription and suppresses the status this turn',()=>{
 let s=responsePreset('keep-calm','calm').state;
 s=send(s,{type:'STATUS_ACTION',cardId:s.decks.germany.active[0].id});
 expect(s.resolution!.choice!.seat).toBe('united_kingdom');s=send(s,{type:'SET_VIEW',seat:'united_kingdom'});s=choose(s,'保持冷静');
 const c=s.resolution!.choice!;s=send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:c.id,ids:[c.options[0].id]});
 expect(s.turnFlags!.suppressed).toContain(s.decks.germany.active[0].id);expect(s.resolution!.running).toBe(false);
});

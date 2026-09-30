import {it,expect} from 'vitest';
import {encodeSnapshot} from '../scripts/wire-snapshot.mjs';
import {diffValue,applyPatch} from '../src/network/jsonPatch.ts';
import {createGame} from '../src/core';
import {projectState} from '../src/network/project';
const wrap=(state,sequence=1,access={kind:'player',seat:'germany'})=>({state,info:{},room:{epoch:'epoch',serverId:'server',access,sequence}});
it('sends presence-only messages without a state and reconstructs changed views exactly',()=>{
 const s=createGame('wire',1940,'FULL'),view=projectState(s,{kind:'player',seat:'germany'},'germany'),first=wrap(view);
 const presence=wrap(view,2);const small=JSON.parse(encodeSnapshot(first,presence,diffValue));expect(small.state).toBeUndefined();expect(small.statePatch).toEqual([]);expect(small.baseSequence).toBe(1);
 const next=structuredClone(view);next.scores.germany++;next.publicLog=[{round:1,seat:'germany',text:'德国获得1分'}];const update=JSON.parse(encodeSnapshot(presence,wrap(next,3),diffValue));expect(update.state).toBeUndefined();expect(applyPatch(view,update.statePatch)).toEqual(next);expect(JSON.stringify(update).length).toBeLessThan(JSON.stringify(next).length/4);
});
it('never diffs unfiltered hidden state, and sends a full baseline when access changes',()=>{
 const s=createGame('privacy',1940,'FULL'),a={kind:'player',seat:'germany'},first=wrap(projectState(s,a,'germany'));
 const secret=s.decks.japan.hand.pop();s.decks.japan.discardPile.push(secret);const next=wrap(projectState(s,a,'germany'),2),wire=encodeSnapshot(first,next,diffValue);expect(wire).not.toContain(secret.id);
 const changed=wrap(projectState(s,{kind:'public'},'germany'),3,{kind:'public'});expect(JSON.parse(encodeSnapshot(next,changed,diffValue)).state).toBeDefined();
});
it('keeps GM history incremental across automatic nation view changes',()=>{
 const s=createGame('gm-wire',1940,'FULL');s.events.push(...Array.from({length:1000},(_,i)=>({type:'RULE_EVENT',revision:i,code:'TEST',text:'Repeated old history '+i})));const first=wrap(s,1,{kind:'gm'});first.info={rounds:[],replayEntries:[],savedAt:'one'};
 const next=structuredClone(first);next.state.viewSeat='japan';next.room.sequence=2;next.info.savedAt='two';next.info.rounds.push({id:'new-checkpoint'});next.state.events.push({type:'RULE_EVENT',revision:1001,code:'TEST',text:'Newest event'});
 const encoded=JSON.parse(encodeSnapshot(first,next,diffValue));expect(encoded.state).toBeUndefined();expect(encoded.info).toBeUndefined();expect(applyPatch(first.state,encoded.statePatch)).toEqual(next.state);expect(applyPatch(first.info,encoded.infoPatch)).toEqual(next.info);expect(JSON.stringify(encoded)).not.toContain('Repeated old history');
});

it('sends reverse deltas across undo epochs and reconstructs all six private views',()=>{
 const before=createGame('undo-wire',1940,'FULL'),after=structuredClone(before);after.revision=5;after.scores.germany=3;after.units.push({id:'undo-unit',country:'germany',type:'army',regionId:'western_europe'});after.publicLog=[{round:1,seat:'germany',text:'德国建设陆军'}];
 for(const seat of ['germany','united_kingdom','japan','soviet_union','italy','united_states']){
  const access={kind:'player',seat},a=wrap(projectState(after,access,seat),10,access),b=wrap(projectState(before,access,seat),11,access);b.room.epoch='undo-epoch';
  const wire=JSON.parse(encodeSnapshot(a,b,diffValue));expect(wire.state).toBeUndefined();expect(wire.baseEpoch).toBe('epoch');expect(applyPatch(a.state,wire.statePatch)).toEqual(b.state);expect(wire.room.epoch).toBe('undo-epoch');expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(b).length/4);
 }
});
it('does not delta across server or game changes',()=>{
 const a=wrap(createGame('old',1,'FULL')),b=structuredClone(a);b.room.sequence=2;b.state.gameId='new';expect(JSON.parse(encodeSnapshot(a,b,diffValue)).state).toBeDefined();b.state.gameId='old';b.room.serverId='new-server';expect(JSON.parse(encodeSnapshot(a,b,diffValue)).state).toBeDefined();
});

it('chat changes are incremental and ordinary gameplay never repeats chat history',()=>{
 const first=wrap(createGame('chat-wire',1,'FULL'));first.room.chat=[{id:'one',text:'Old chat '.repeat(200)}];
 const next={...first,room:{...first.room,sequence:2,chat:[...first.room.chat,{id:'two',text:'new message'}]}};
 const wire=JSON.parse(encodeSnapshot(first,next,diffValue));expect(wire.room.chat).toBeUndefined();expect(JSON.stringify(wire)).not.toContain('Old chat');expect(applyPatch(first.room.chat,wire.chatPatch)).toEqual(next.room.chat);
 const later={...next,room:{...next.room,sequence:3}};const presence=JSON.parse(encodeSnapshot(next,later,diffValue));expect(presence.chatPatch).toEqual([]);
});

import {expect,it} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseMatchLog} from '../src/matchLog/codec';
import {GAME_VERSION} from '../src/matchLog/normalize';
import type {GameState} from '../src/core';
it('undo truncates whole suffix; external save creates snapshot recording',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'truncate',seed:1940,mode:'FULL'});
 for(let i=0;i<6;i++){const s=c.getSnapshot()!;expect((await c.dispatch({type:'KEEP_OPENING',seat:s.viewSeat,expectedRevision:s.revision,cardIds:s.decks[s.viewSeat].hand.slice(0,7).map(v=>v.id)})).ok).toBe(true);}
 const before=await parseMatchLog(await c.exportReplay(),GAME_VERSION),draft=structuredClone(c.getSnapshot()!) as GameState;draft.scores.italy=19;await c.editScene(draft);expect(c.getSnapshot()!.scores.italy).toBe(19);await c.undo();const after=await parseMatchLog(await c.exportReplay(),GAME_VERSION);expect(after.header.recordingId).toBe(before.header.recordingId);expect(after.header.recordingRevision).toBe(before.header.recordingRevision+1);expect(after.frames).toEqual(before.frames);expect(after.frames.some(f=>f.kind==='control')).toBe(false);
 const loaded=new LocalGameController();await loaded.importSave(c.exportSave());const external=await parseMatchLog(await loaded.exportReplay(),GAME_VERSION);expect(external.header.origin.kind).toBe('snapshot');expect(external.header.recordingId).not.toBe(after.header.recordingId);
},60000);

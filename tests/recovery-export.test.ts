import {expect,it} from 'vitest';
import {SEATS} from '../src/core';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay} from '../src/actionReplay/codec';
import {stateHash} from '../src/actionReplay/state';
import {Player} from '../src/actionReplay/player';
it('external saves and GM edits start a truthful snapshot origin without fabricating past actions',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'edit',seed:1940,mode:'FULL'});for(const seat of SEATS){const s=c.getSnapshot()!;await c.dispatch({type:'KEEP_OPENING',seat,expectedRevision:s.revision,cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)});}const before=await parseReplay(await c.exportReplay());
 const draft=structuredClone(c.getSnapshot()!);draft.scores.italy=19;await c.editScene(draft);const edit=await parseReplay(await c.exportReplay());expect(edit.header.origin).toBe('snapshot');expect(edit.header.recordingId).not.toBe(before.header.recordingId);expect(await stateHash(await new Player(edit).seek(null))).toBe(await stateHash(c.getSnapshot()!));
 const external=new LocalGameController();await external.importSave(c.exportSave());const a=await parseReplay(await external.exportReplay());expect(a.header.origin).toBe('snapshot');expect(a.header.recordingId).not.toBe(edit.header.recordingId);
});

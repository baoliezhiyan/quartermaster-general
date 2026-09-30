import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay} from '../src/actionReplay/codec';
import {ReplayController} from '../src/actionReplay/ReplayController';
it('uses an independent readonly controller and defaults to before the decision',async()=>{
 const live=new LocalGameController();await live.dispatch({type:'CREATE_GAME',gameId:'readonly',seed:4,mode:'FULL'});const s=live.getSnapshot()!;
 await live.dispatch({type:'KEEP_OPENING',seat:'germany',expectedRevision:s.revision,cardIds:s.decks.germany.hand.slice(0,7).map(c=>c.id)});
 const before=live.getSnapshot(),replay=new ReplayController(await parseReplay(await live.exportReplay())),id=replay.entries[0].id;
 await replay.seek(id);expect(replay.getSnapshot().decks.germany.hand).toHaveLength(12);await replay.seek(id,true);expect(replay.getSnapshot().decks.germany.hand).toHaveLength(7);
 expect((await replay.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:0})).ok).toBe(false);expect(live.getSnapshot()).toBe(before);
 replay.setRoomAccess({kind:'observer',seat:'germany'});expect(replay.getSnapshot().decks.japan.hand.every(c=>c.definitionId==='hidden')).toBe(true);
 await expect(live.importReplay(await live.exportReplay())).rejects.toThrow('只读');
});

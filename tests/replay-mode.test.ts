import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseMatchLog} from '../src/matchLog/codec';
import {GAME_VERSION} from '../src/matchLog/normalize';
import {replayNode} from '../src/matchLog/view';
it('fact replay defaults to pre-decision and cannot replace a running game',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'replay-facts',seed:4,mode:'FULL'});const s=c.getSnapshot()!;await c.dispatch({type:'KEEP_OPENING',seat:'germany',expectedRevision:s.revision,cardIds:s.decks.germany.hand.slice(0,7).map(c=>c.id)});
 const a=await parseMatchLog(await c.exportReplay(),GAME_VERSION),frame=a.frames.find(f=>f.kind==='decision')!;expect(replayNode(a,frame.seq).state.areas.find(a=>a.areaId==='germany/regular_hand')!.cardIds).toHaveLength(12);expect(replayNode(a,a.frames.at(-1)!.seq,false).state.areas.find(a=>a.areaId==='germany/regular_hand')!.cardIds).toHaveLength(7);
 const saved=c.getSnapshot();for(const seq of [1,frame.seq,a.frames.at(-1)!.seq])replayNode(a,seq);expect(c.getSnapshot()).toBe(saved);await expect(c.importReplay(await c.exportReplay())).rejects.toThrow('只读');expect(c.getSnapshot()).toBe(saved);
},30000);

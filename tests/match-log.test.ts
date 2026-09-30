import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay} from '../src/actionReplay/codec';
it('starts after initialization with actual shuffled orders and no per-shuffle initial snapshots',async()=>{const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'facts',seed:7,mode:'FULL',prelude:true,neutrality:true,balance:true});const a=await parseReplay(await c.exportReplay());expect(a.header.origin).toBe('creation');expect(a.records.map(r=>r.type)).toEqual(['header','start','end']);expect((a.start.state.ruleState.decks as any).germany.drawPile).toEqual(c.getSnapshot()!.decks.germany.drawPile);});

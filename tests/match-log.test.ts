import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseMatchLog} from '../src/matchLog/codec';
import {GAME_VERSION} from '../src/matchLog/normalize';
it('records initialization and validates exported facts',async()=>{const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'facts',seed:7,mode:'FULL',prelude:true,neutrality:true,balance:true});const text=await c.exportReplay();const a=await parseMatchLog(text,GAME_VERSION);expect(a.header.origin.kind).toBe('creation');expect(a.frames.some(f=>f.kind==='random')).toBe(true);expect(a.frames.length).toBeGreaterThan(12);});

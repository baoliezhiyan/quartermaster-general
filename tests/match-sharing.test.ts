import {it,expect} from 'vitest';
import {shareFactState} from '../src/matchLog/sharing';
import type {State} from '../src/matchLog/contract';

it('shares unchanged snapshot branches without mutating frozen inputs or older snapshots',()=>{
 const previous=Object.freeze({areas:Object.freeze([Object.freeze({id:'deck',cards:Object.freeze(['a','b'])})]),scores:Object.freeze({germany:1})});
 const next=Object.freeze({areas:Object.freeze([Object.freeze({id:'deck',cards:Object.freeze(['a','b'])})]),scores:Object.freeze({germany:2})});
 const result=shareFactState(previous as unknown as State,next as unknown as State);
 expect(result).toEqual(next);
 expect(result.areas).toBe(previous.areas);
 expect(result.scores).toBe(next.scores);
 expect(previous.scores.germany).toBe(1);
 expect(next.areas).not.toBe(previous.areas);
 expect(shareFactState(result,structuredClone(result))).toBe(result);
});

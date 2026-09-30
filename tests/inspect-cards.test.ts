import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {shuffle} from '../src/core/basic';
import {inspectTen} from '../src/core/inspectCards';
it.each(['状态','响应'] as const)('inspection retries exactly once on a miss: %s',type=>{
 const s=createGame('inspect',13,'FULL',true,false,true),seat='soviet_union',d=s.decks[seat];
 d.drawPile=Array.from({length:20},(_,i)=>({id:String(i),definitionId:'build_army',country:seat,deckOwner:seat}));
 const expected=structuredClone(s);shuffle(expected.decks[seat].drawPile,expected);
 expect(inspectTen(s,seat,type)).toEqual(expected.decks[seat].drawPile.slice(0,10));expect(s.randomState).toBe(expected.randomState);expect(d.drawPile).toEqual(expected.decks[seat].drawPile);
});
it.each([['状态','special_42'],['响应','special_55']] as const)('inspection keeps successful initial candidates: %s',(type,id)=>{
 const s=createGame('inspect',13,'FULL',true,false,true),d=s.decks.soviet_union;d.drawPile.unshift({id:'target',definitionId:id,country:'soviet_union',deckOwner:'soviet_union',balance:true});const before=structuredClone(s);
 expect(inspectTen(s,'soviet_union',type)).toEqual(before.decks.soviet_union.drawPile.slice(0,10));expect(s).toEqual(before);
});

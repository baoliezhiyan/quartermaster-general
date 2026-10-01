import {it,expect} from 'vitest';
import {numberedCatalog,catalogCardNumber} from '../src/ui/cardNumbers';
import {encyclopediaCards} from '../src/ui/CardEncyclopedia';
import {SEATS} from '../src/core/types';
const types=['build_army','land_battle','build_navy','sea_battle','air_power','状态','事件','经济战','响应','增强','历史','军备'];
it.each([false,true])('numbers are unique, complete and grouped for balance=%s',balance=>{
 const cards=numberedCatalog(balance);expect(new Set(cards.map(c=>c.catalogId)).size).toBe(cards.length);
 for(const seat of SEATS){const own=cards.filter(c=>c.deckOwner===seat);expect(own.slice(0,5).map(c=>c.id)).toEqual(types.slice(0,5));
  let child=false;for(const c of own){expect(types).toContain(c.type);if(c.country!==seat)child=true;else expect(child).toBe(false);expect(catalogCardNumber(seat,c.id,balance)).toBe(c.catalogId);}
  for(const country of new Set(own.map(c=>c.country))){const entries=own.filter(c=>c.country===country);const indices=entries.map(c=>types.indexOf(c.type));expect(indices).toEqual([...indices].sort((a,b)=>a-b));}
  for(const prefix of ['P','R']){const group=own.filter(c=>c.catalogId.includes('-'+prefix));expect(group.map(c=>Number(c.catalogId.slice(-3)))).toEqual(group.map((_,i)=>i+1));}
  const atlas=encyclopediaCards(seat,balance,true);const firstRegular=atlas.findIndex(c=>c.catalogId.includes('-R'));expect(atlas.slice(0,firstRegular).every(c=>c.catalogId.includes('-P'))).toBe(true);expect(atlas.slice(firstRegular).every(c=>c.catalogId.includes('-R'))).toBe(true);
  expect(encyclopediaCards(seat,balance,false).slice(0,5).map(c=>c.id)).toEqual(types.slice(0,5));
 }
});
it('new and retyped cards receive their current category number',()=>{
 const cards=numberedCatalog(true);expect(cards.find(c=>c.id==='special_260')!.type).toBe('事件');expect(cards.find(c=>c.id==='special_191')!.type).toBe('增强');expect(cards.find(c=>c.id==='neutrality_united_states_status')!.catalogId).toContain('-P');
});

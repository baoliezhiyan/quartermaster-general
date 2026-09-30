import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {createGame,transition} from '../src/core/game';
import {SEATS,type GameState} from '../src/core/types';
import {checkNeutralitySupply,checkNeutralityTurn,occupiedNeutralitySupply,mayPlace} from '../src/core/neutrality';
import {distanceWithin} from '../src/core/fullCardEffects';
import {countryScore,suppliedUnits} from '../src/core/supply';
import {reserve} from '../src/core/basic';
const snapshot=(c:LocalGameController)=>structuredClone(c.getSnapshot()!) as GameState;
const balanced=()=>{const s=createGame('balanced',7,'FULL',false,true);s.rules!.balanceEnabled=true;return s;};
it('editor cannot end neutrality in prelude or opening selection',async()=>{
 for(const prelude of [false,true]){const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'editor',seed:1,mode:'FULL',prelude,neutrality:true});
 for(const endNeutrality of ['united_states','soviet_union'] as const)await expect(c.editScene(snapshot(c),{endNeutrality})).rejects.toThrow('正式游戏');
 expect(c.getSnapshot()!.neutrality!.united_states.neutral).toBe(true);}
});
it('editor uses normal one-time entry effects, notifications, save and undo',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'editor',seed:17,mode:'FULL',neutrality:true});
 for(const seat of SEATS){const s=snapshot(c);expect((await c.dispatch({type:'KEEP_OPENING',seat,expectedRevision:s.revision,cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)})).ok).toBe(true);}
 // Finish any ordinary start-of-turn interrupt before using the editor.
 while(c.getSnapshot()!.resolution?.running){const s=snapshot(c),q=s.resolution!.choice!;await c.dispatch({type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:q.options.slice(0,q.min).map(x=>x.id)});}
 const before=snapshot(c);await c.editScene(before,{endNeutrality:'united_states'});
 expect(c.getSnapshot()!.scores.united_states).toBe(before.scores.united_states+4);
 expect(c.getSnapshot()!.neutralityNotices).toHaveLength(1);
 await c.editScene(snapshot(c),{endNeutrality:'united_states'});expect(c.getSnapshot()!.neutralityNotices).toHaveLength(1);
 const restored=new LocalGameController();await restored.importSave(await c.exportSave());expect(restored.getSnapshot()!.neutrality).toEqual(c.getSnapshot()!.neutrality);
 expect(c.checkReplay()).toBe(true);await c.undo();await c.undo();expect(c.getSnapshot()!.neutrality!.united_states.neutral).toBe(true);
 await c.editScene(snapshot(c),{endNeutrality:'soviet_union'});expect(c.getSnapshot()!.neutrality!.soviet_union.neutral).toBe(false);expect(c.getSnapshot()!.neutralityStatusPending).toBe(false);
 expect(c.getSnapshot()!.decks.soviet_union.discardPile.some(x=>x.id==='neutrality_soviet_union_status')).toBe(true);
});
it('scorched Ukraine loses both supply and points but remains an American entry point',()=>{
 const s=balanced();s.units=[{id:'ukr',country:'germany',type:'army',regionId:'ukraine'}];
 const card=Object.values(s.decks).flatMap(d=>[...d.hand,...d.drawPile]).find(c=>c.definitionId==='special_48')!;s.decks.soviet_union.active.push(card);
 expect(countryScore(s,'germany')).toBe(0);expect(suppliedUnits(s).has('ukr')).toBe(false);expect(occupiedNeutralitySupply(s)).toContain('ukraine');
 s.units[0].country='soviet_union';expect(countryScore(s,'soviet_union')).toBe(0);expect(suppliedUnits(s).has('ukr')).toBe(false);
 s.rules!.balanceEnabled=false;expect(countryScore(s,'soviet_union')).toBe(2);expect(suppliedUnits(s).has('ukr')).toBe(true);
});
it('balance reserve, weighted threats and placement do not leak into original games',()=>{
 const s=balanced();expect(reserve(s,'italy','army')).toBe(4);expect(mayPlace(s,'united_states','western_europe')).toBe(false);
 s.activeSeat='soviet_union';s.units=[{id:'su',country:'soviet_union',type:'army',regionId:'ukraine'},{id:'de',country:'germany',type:'army',regionId:'eastern_europe'},{id:'it',country:'italy',type:'navy',regionId:'sea_black'},{id:'den',country:'germany',type:'navy',regionId:'sea_black'}];
 checkNeutralityTurn(s);expect(s.neutrality!.soviet_union.neutral).toBe(true);
 s.rules!.balanceEnabled=false;checkNeutralityTurn(s);expect(s.neutrality!.soviet_union.neutral).toBe(false);
});
it('capturing current major Allied home ends both neutralities, France does not',()=>{
 const s=balanced();s.units=[{id:'de',country:'germany',type:'army',regionId:'western_europe'}];checkNeutralitySupply(s);expect(s.neutrality!.united_states.neutral).toBe(true);
 s.units[0].regionId='british_isles';checkNeutralitySupply(s);expect(s.neutrality!.united_states.neutral).toBe(false);expect(s.neutrality!.soviet_union.neutral).toBe(false);
});
it('distance crosses printed straits regardless of controller, never temporary land links',()=>{
 const s=balanced();expect(distanceWithin(s,'germany','sea_baltic','sea_north_sea',1)).toBe(true);expect(distanceWithin(s,'united_kingdom','sea_baltic','sea_north_sea',1)).toBe(true);
 const card=Object.values(s.decks).flatMap(d=>[...d.hand,...d.drawPile]).find(c=>c.definitionId==='special_210')!;s.decks.italy.active.push(card);
 expect(distanceWithin(s,'germany','balkans','middle_east',1)).toBe(false);
});
it('manual prelude discard restricts standard play and emptying top ends the turn',()=>{
 const s=createGame('prelude-balanced',7,'FULL',true,false);s.rules!.balanceEnabled=true;
 const discarded=transition(s,{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:s.revision});expect(discarded.ok).toBe(true);if(!discarded.ok)return;
 const n=discarded.state;expect(transition(n,{type:'PLAY_PRELUDE',seat:'germany',expectedRevision:n.revision,cardId:n.prelude!.decks.germany.hand[0].id}).ok).toBe(false);
 n.prelude!.decks.germany.drawPile.splice(1);const end=transition(n,{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:n.revision});expect(end.ok&&end.state.activeSeat).toBe('united_kingdom');
});

it.each([false,true])('Italian naval additions follow the balance option: %s',balance=>{
 const s=createGame('italian-naval',9,'FULL',false,false,balance);const cards=Object.values(s.decks.italy).flat();
 expect(cards.filter(c=>c.definitionId==='build_navy')).toHaveLength(balance?5:4);
 expect(cards.filter(c=>c.definitionId==='sea_battle')).toHaveLength(balance?3:2);
});

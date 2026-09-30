import { expect,it } from 'vitest';
import { catalogCards } from '../src/ui/MapPanels';
import { responsePreset } from '../src/controller/responsePresets';
it('displays identical catalog order regardless of draw order without mutating the deck',()=>{
 const cards=responsePreset('bletchley','order').state.decks.germany.drawPile;
 const before=structuredClone(cards);
 const visible=(items:typeof cards)=>catalogCards(items).map(c=>[c.definitionId,c.country]);
 expect(visible(cards)).toEqual(visible([...cards].reverse()));expect(cards).toEqual(before);
});

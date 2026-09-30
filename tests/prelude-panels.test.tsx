import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createGame} from '../src/core/game';
import {MapPanelContent,MAP_PANELS,panelLabel,catalogCards,visibleMapPanels} from '../src/ui/MapPanels';
import {TableHand} from '../src/ui/TableHand';

it('separates regular hand and three prelude panels, with live zone counts',()=>{
 const state=createGame('panels',44,'FULL',true),d=state.prelude!.decks.germany;
 expect(MAP_PANELS.slice(-5,-1).map(p=>p[0])).toEqual(['record','prelude-hand','prelude-discard','prelude-deck']);
 expect(panelLabel(state,'deck')).toBe(`牌库(${state.decks.germany.drawPile.length})`);
 expect(panelLabel(state,'discard')).toBe('弃牌堆(0)');
 expect(panelLabel(state,'prelude-deck')).toBe(`序章牌库(${d.drawPile.length})`);
 expect(panelLabel(state,'prelude-discard')).toBe('序章弃牌堆(2)');
 d.discardPile.push(d.drawPile.shift()!);
 expect(panelLabel(state,'prelude-discard')).toBe('序章弃牌堆(3)');
 const dispatch=async()=>{};
 const hand=renderToStaticMarkup(<TableHand state={state} busy={false} readOnly dispatch={dispatch} choiceCards={{}} chosenCards={[]} onChoiceCard={()=>{}} onPlayCard={()=>{}} playCardId={null} onMapAction={()=>{}} revealHand={()=>{}}/>);
 expect(hand).not.toContain('prelude-hand');expect(hand).not.toContain('hidden=""');
 const prelude=renderToStaticMarkup(<MapPanelContent panel="prelude-hand" state={state} busy={false} readOnly dispatch={dispatch}/>);
 expect(prelude).toContain('class="prelude-card-label">牌库顶');expect(prelude).not.toContain('card-hint');expect(prelude).not.toContain('<details');
 for(const panel of ['prelude-deck','prelude-discard'] as const){
  const html=renderToStaticMarkup(<MapPanelContent panel={panel} state={state} busy={false} readOnly dispatch={dispatch}/>);
  expect(html).toContain('card-grid');expect(html).not.toContain('牌库顶（不属于手牌）');
 }
 expect(catalogCards(d.drawPile).map(c=>c.id)).toEqual(catalogCards([...d.drawPile].reverse()).map(c=>c.id));
});

it('hides prelude panels when inactive and supports the classic opening',()=>{
 const classic=createGame('classic',44,'FULL',false);
 expect(classic.phase).toBe('SETUP');expect(classic.prelude?.active).toBeFalsy();
 expect(visibleMapPanels(classic)).toHaveLength(6);
 const s=createGame('prelude',44,'FULL',true);
 expect(visibleMapPanels(s)).toHaveLength(9);expect(visibleMapPanels(s,true).map(p=>p[0])).toEqual(['record']);
 s.prelude!.active=false;
 expect(visibleMapPanels(s)).toHaveLength(6);
});

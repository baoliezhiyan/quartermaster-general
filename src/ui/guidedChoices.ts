import type { ReadState } from '../core';
import type { MapPanel } from './MapPanels';
import { choiceCard } from './CardFace';
export function guidedChoices(state:ReadState) {
 const r=state.resolution,c=r?.running?r.choice:null;
 const cards:Record<string,string[]>={},panels=new Set<MapPanel>();
 const f=r?.frames.find(f=>f.id===c?.frameId),e=f?.effects[f.nextEffectIndex];
 const specificCards=c?.kind==='CARDS'&&e?.kind==='cards'&&e.from!=='hand'&&!!(e.topCount||e.filter||e.allowedIds);
 const specificPlay=c?.kind==='EXTRA_CARD'&&e?.kind==='extraPlay'&&e.from!=='hand'&&!!(e.filter||e.mention||e.onlyCardIds||e.onlyRemember||e.returnOnSkip);
 const ordered=!!c&&(specificCards||specificPlay||c.kind==='SELECT'&&(c.prompt==='检视常规牌库顶十张，选择状态牌'||c.options.some(o=>!!choiceCard(state,o))));
 if(!c||c.seat!==state.viewSeat)return {cards,panels,ordered:false};
 for(const o of c.options){
  const rule=c.kind==='TRIGGER'?r!.rules.find(rule=>o.id===`${o.windowId}/${rule.id}`):c.kind==='ORDER_MANDATORY_TRIGGERS'?r!.rules.find(rule=>rule.id===o.id):undefined;
  const id=rule?.sourceInstanceId??choiceCard(state,o)?.id;if(!id)continue;
  const d=state.decks[state.viewSeat];
  const panel=d.hand.some(v=>v.id===id)?'hand':d.drawPile.some(v=>v.id===id)?'deck':d.discardPile.some(v=>v.id===id)?'discard':[...d.active,...d.faceDown].some(v=>v.id===id)?'active':undefined;
  if(panel){(cards[id]??=[]).push(o.id);if(!ordered)panels.add(panel);}
 }
 return {cards,panels,ordered};
}

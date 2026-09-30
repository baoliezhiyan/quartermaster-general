import {specialCard} from '../core/cardCatalog';
import type {ReadState,SeatId} from '../core';
import {COUNTRY_NAMES,UNIT_NAMES,phaseCountries,reserve} from '../core/basic';
import {publicDiscard} from '../core/publicHistory';
import {activePanelCards} from './triggerContext';
import {CardFace} from './CardFace';
export function PublicCountryInfo({state,seat,onClose}:{state:ReadState;seat:SeatId;onClose:()=>void}){
 const deck=state.decks[seat];
 const armaments=state.publicArmamentCounts?.[seat]??deck.faceDown.filter(c=>specialCard(c.definitionId,c.balance)?.type==='军备').length;
 const active=activePanelCards({...state,viewSeat:seat}).filter(c=>deck.active.some(a=>a.id===c.id)||deck.resolving.some(a=>a.id===c.id)&&state.publicCardIds?.includes(c.id)&&state.resolution?.frames.some(f=>f.cardId===c.id&&f.publicSourceZone==='active'));
 const discard=publicDiscard(state,seat);
 return <section className="public-country-window" role="dialog" aria-label={COUNTRY_NAMES[seat]+'公开信息'}><button className="public-country-close" onClick={onClose} aria-label="关闭公开信息">×</button><h3>{COUNTRY_NAMES[seat]} · 公开信息</h3>
 <p>手牌 {deck.hand.length} 张 · 牌库 {deck.drawPile.length} 张 · 弃牌堆 {state.publicDiscardCounts?.[seat]??deck.discardPile.length} 张 · 暗置响应 {deck.faceDown.length-armaments} 张 · 暗置军备 {armaments} 张</p>
 {state.prelude?.active&&<p>序章手牌 {state.prelude.decks[seat].hand.length} 张 · 序章牌库 {state.prelude.decks[seat].drawPile.length} 张 · 序章弃牌 {state.prelude.decks[seat].discardPile.length} 张</p>}
 {state.neutrality&&(seat==='soviet_union'||seat==='united_states')&&<p>中立状态：{state.neutrality[seat].neutral?'中立中':'已结束中立'}</p>}
 <h4>兵模储备</h4>{phaseCountries(seat).map(country=><p key={country}>{COUNTRY_NAMES[country]}：{(['army','navy','air'] as const).map(type=>UNIT_NAMES[type]+' '+reserve(state,country,type)).join(' / ')}</p>)}

 <h4>持续生效卡牌</h4>{active.length>0&&<div className="card-grid">{active.map(c=><div className="hand-card" key={c.id}><CardFace card={c}/></div>)}</div>}{!active.length&&<p>无</p>}
 {deck.faceDown.some(c=>state.faceUpResponseIds?.includes(c.id))&&<><h4>明置响应</h4><div className="card-grid">{deck.faceDown.filter(c=>state.faceUpResponseIds?.includes(c.id)).map(c=><div className="hand-card" key={c.id}><CardFace card={c}/></div>)}</div></>}
 <h4>可见弃牌堆</h4>{discard.length>0&&<div className="card-grid">{discard.map(c=><div className="hand-card" key={c.id}><CardFace card={c}/></div>)}</div>}{!discard.length&&<p>暂无已公开的弃牌。</p>}
 </section>;
}

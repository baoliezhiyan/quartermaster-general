import {useCompactLayout} from './deviceLayout';
import {CardInspect} from './CardInspect';
import {useHandOrder} from './useHandOrder';
import {useEffect,useState} from 'react';
import type {ReadState,Command} from '../core';
import {CardFace} from './CardFace';
import {cardName} from '../core/basic';
export function PreludeHand({state,busy,readOnly,dispatch}:{state:ReadState;busy:boolean;readOnly:boolean;dispatch:(c:Command)=>Promise<void>}){
 const [sorting,setSorting]=useState(false);
 const compact=useCompactLayout();
 useEffect(()=>{if(!compact)setSorting(false);},[compact]);
 const [selected,setSelected]=useState<string|null>(null);
 const p=state.prelude!,d=p.decks[state.viewSeat],top=d.drawPile[0];
 const free=p.active&&!readOnly&&!busy&&!state.resolution?.running&&!p.played&&state.viewSeat===state.activeSeat;
 const handOrder=useHandOrder(`qm:prelude-hand-order:${state.gameId}:${state.viewSeat}`,d.hand);
 const cards=[...handOrder.ordered,...(top?[top]:[])],valid=cards.some(c=>c.id===selected)&&(!state.rules?.balanceEnabled||!p.discarded||selected===top?.id);
 return <section className="prelude-hand" aria-label="序章手牌"><h3>序章手牌 {d.hand.length} 张</h3>
 {!readOnly&&<div className="prelude-controls"><button disabled={!free||!top} onClick={()=>dispatch({type:'DISCARD_PRELUDE_TOP',seat:state.viewSeat,expectedRevision:state.revision})}>弃置序章牌库顶</button><button className="primary" disabled={!free||!valid} onClick={()=>dispatch({type:'PLAY_PRELUDE',seat:state.viewSeat,expectedRevision:state.revision,cardId:selected!})}>打出所选序章牌</button></div>}
 {state.rules?.balanceEnabled&&p.discarded>0&&free&&<p>本回合已主动弃顶，只能打出牌库顶的序章牌。</p>}
 <button className="touch-sort-toggle" onClick={()=>setSorting(v=>!v)}>{sorting?'完成整理':'整理手牌'}</button>
 <div className="card-grid">{cards.map(c=><div className="prelude-card" {...(c.id===top?.id?{}:handOrder.props(c.id))} key={c.id}><span className="prelude-card-label">{top?.id===c.id?'牌库顶':'手牌'}</span><button className={`hand-card${free&&(!state.rules?.balanceEnabled||!p.discarded||c.id===top?.id)?' available-card':''}${selected===c.id?' selected':''}`} disabled={sorting||!free||!!state.rules?.balanceEnabled&&p.discarded>0&&c.id!==top?.id} aria-label={`${cardName(c)}${top?.id===c.id?' · 牌库顶':''}`} onClick={()=>setSelected(v=>v===c.id?null:c.id)}><CardFace card={c}/></button><CardInspect card={c}/>{sorting&&c.id!==top?.id&&<div className="touch-sort-actions"><button aria-label="向前移动" onClick={()=>handOrder.move(c.id,-1)}>←</button><button aria-label="向后移动" onClick={()=>handOrder.move(c.id,1)}>→</button></div>}</div>)}</div>


 </section>;
}

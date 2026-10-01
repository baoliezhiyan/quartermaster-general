import {useMemo,useState} from 'react';
import {SEATS,type SeatId} from '../core/types';
import {COUNTRY_NAMES,makeDecks} from '../core/basic';
import {numberedCatalog} from './cardNumbers';
import {CardFace} from './CardFace';
export function encyclopediaCards(seat:SeatId,balance:boolean,showPrelude=true){
 const deck=makeDecks({randomState:0},'BASIC_DEBUG',balance,false,false)[seat].drawPile;
 const cards=numberedCatalog(balance).filter(c=>c.deckOwner===seat&&(showPrelude||!c.prelude));
 return [...cards].sort((a,b)=>Number(b.prelude)-Number(a.prelude)||a.catalogId.localeCompare(b.catalogId,'en',{numeric:true})).map(c=>({id:c.id,definitionId:c.id,country:c.country,balance,catalogId:c.catalogId,count:deck.some(v=>v.definitionId===c.id)?deck.filter(v=>v.definitionId===c.id).length:undefined}));
}
export function CardEncyclopedia({balance}:{balance:boolean}){
 const [seat,setSeat]=useState<SeatId>('germany');
 const [showPrelude,setShowPrelude]=useState(true);
 const cards=useMemo(()=>encyclopediaCards(seat,balance,showPrelude),[seat,balance,showPrelude]);
 return <section className="card-encyclopedia" role="region" aria-label="全卡图鉴">
  <nav aria-label="图鉴国家">{SEATS.map(s=><button key={s} className="country-name" data-country={s} aria-pressed={s===seat} onClick={()=>setSeat(s)}>{COUNTRY_NAMES[s]}</button>)}<label className="encyclopedia-prelude"><input type="checkbox" checked={showPrelude} onChange={e=>setShowPrelude(e.target.checked)}/>显示序章卡牌</label></nav>
  <div className="encyclopedia-grid">{cards.map(c=><article key={c.id} data-card-id={c.id}><CardFace card={c} hint={c.catalogId} nameSuffix={c.count===undefined?undefined:`*${c.count}`}/></article>)}</div>
 </section>;
}

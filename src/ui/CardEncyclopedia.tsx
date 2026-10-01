import {useMemo,useState} from 'react';
import {SEATS,type SeatId} from '../core/types';
import {BASIC_NAMES,COUNTRY_NAMES} from '../core/basic';
import {NEUTRALITY_CARDS,preludeCatalog,regularCatalog} from '../core/cardCatalog';
import {CardFace} from './CardFace';
export function encyclopediaCards(seat:SeatId,balance:boolean){
 const basic=Object.keys(BASIC_NAMES).map(id=>({id,definitionId:id,country:seat,balance}));
 const special=[...regularCatalog(balance,true),...preludeCatalog(balance),...NEUTRALITY_CARDS].filter(c=>c.deckOwner===seat).map(c=>({id:c.id,definitionId:c.id,country:c.country,balance}));
 return [...basic,...special].sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true}));
}
export function CardEncyclopedia({balance}:{balance:boolean}){
 const [seat,setSeat]=useState<SeatId>('germany');
 const cards=useMemo(()=>encyclopediaCards(seat,balance),[seat,balance]);
 return <section className="card-encyclopedia" role="region" aria-label="全卡图鉴">
  <nav aria-label="图鉴国家">{SEATS.map(s=><button key={s} className="country-name" data-country={s} aria-pressed={s===seat} onClick={()=>setSeat(s)}>{COUNTRY_NAMES[s]}</button>)}</nav>
  <div className="encyclopedia-grid">{cards.map(c=><article key={c.id} data-card-id={c.id}><CardFace card={c}/></article>)}</div>
 </section>;
}

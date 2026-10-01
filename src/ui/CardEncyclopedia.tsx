import {useMemo,useState} from 'react';
import {SEATS,type SeatId} from '../core/types';
import {BASIC_NAMES,COUNTRY_NAMES,makeDecks} from '../core/basic';
import {NEUTRALITY_CARDS,preludeCatalog,regularCatalog} from '../core/cardCatalog';
import {CardFace} from './CardFace';
export function encyclopediaCards(seat:SeatId,balance:boolean,showPrelude=true){
 const deck=makeDecks({randomState:0},'BASIC_DEBUG',balance,false,false)[seat].drawPile;
 const basic=Object.keys(BASIC_NAMES).map(id=>({id,definitionId:id,country:seat,balance,count:deck.filter(c=>c.definitionId===id).length}));
 const definitions=[...regularCatalog(balance,true),...NEUTRALITY_CARDS,...(showPrelude?preludeCatalog(balance):[])];
 const special=definitions.filter(c=>c.deckOwner===seat).map(c=>({id:c.id,definitionId:c.id,country:c.country,balance,count:undefined as number|undefined}));
 const group=(id:string)=>id.startsWith('prelude_')?0:Object.hasOwn(BASIC_NAMES,id)?1:2;
 return [...basic,...special].sort((a,b)=>group(a.id)-group(b.id)||a.id.localeCompare(b.id,'en',{numeric:true}));
}
export function CardEncyclopedia({balance}:{balance:boolean}){
 const [seat,setSeat]=useState<SeatId>('germany');
 const [showPrelude,setShowPrelude]=useState(true);
 const cards=useMemo(()=>encyclopediaCards(seat,balance,showPrelude),[seat,balance,showPrelude]);
 return <section className="card-encyclopedia" role="region" aria-label="全卡图鉴">
  <nav aria-label="图鉴国家">{SEATS.map(s=><button key={s} className="country-name" data-country={s} aria-pressed={s===seat} onClick={()=>setSeat(s)}>{COUNTRY_NAMES[s]}</button>)}<label className="encyclopedia-prelude"><input type="checkbox" checked={showPrelude} onChange={e=>setShowPrelude(e.target.checked)}/>显示序章卡牌</label></nav>
  <div className="encyclopedia-grid">{cards.map(c=><article key={c.id} data-card-id={c.id}><CardFace card={c} nameSuffix={c.count===undefined?undefined:`*${c.count}`}/></article>)}</div>
 </section>;
}

import {BASIC_NAMES} from '../core/basic';
import {NEUTRALITY_CARDS,specialCard,preludeCatalog,regularCatalog} from '../core/cardCatalog';
import {SEATS,type SeatId,type CountryId} from '../core/types';
/** Public catalog numbers are separate from permanent rules/save definition keys. */
export interface NumberedCard {id:string;catalogId:string;deckOwner:SeatId;country:CountryId;type:string;name:string;text:string;prelude:boolean;tension?:number;}
const prefixes:Record<SeatId,string>={germany:'DE',united_kingdom:'UK',japan:'JP',soviet_union:'SU',italy:'IT',united_states:'US'};
const order=['build_army','land_battle','build_navy','sea_battle','air_power','状态','事件','经济战','响应','增强','历史','军备'];
const cache=new Map<boolean,readonly NumberedCard[]>();
export function numberedCatalog(balance:boolean):readonly NumberedCard[]{
 const cached=cache.get(balance);if(cached)return cached;
 const result:NumberedCard[]=[];
 for(const seat of SEATS){
  const basic=Object.entries(BASIC_NAMES).map(([id,name])=>({id,name,type:id,text:'',deckOwner:seat,country:seat}));
  const definitions=[...basic,...regularCatalog(balance,true),...preludeCatalog(balance),...NEUTRALITY_CARDS.map(c=>specialCard(c.id,balance)!)].filter(c=>c.deckOwner===seat);
  const sorted=definitions.sort((a,b)=>Number(a.country!==seat)-Number(b.country!==seat)||order.indexOf(a.type)-order.indexOf(b.type)||a.id.localeCompare(b.id,'en',{numeric:true}));
  let regular=0,prelude=0;
  for(const c of sorted){const isPrelude=['历史','军备'].includes(c.type);const sequence=isPrelude?++prelude:++regular;result.push({...c,prelude:isPrelude,catalogId:`${prefixes[seat]}-${isPrelude?'P':'R'}${String(sequence).padStart(3,'0')}`});}
 }
 cache.set(balance,result);return result;
}
export function catalogCardNumber(seat:SeatId,id:string,balance:boolean){return numberedCatalog(balance).find(c=>c.deckOwner===seat&&c.id===id)?.catalogId;}

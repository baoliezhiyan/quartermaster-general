import balanceData from '../data/balance-cards.json';
import preludeData from '../data/prelude-cards.json';
import data from '../data/representative-cards.json';
import allData from '../data/all-cards.json';
import type { CountryId, SeatId } from './types';
export interface SpecialDefinition { id:string; sourceIndex:number; deckOwner:SeatId; country:CountryId; type:string; name:string; text:string; tension?:number }
export const SPECIAL_CARDS=data as SpecialDefinition[];
export const ALL_SPECIAL_CARDS=allData as SpecialDefinition[];
export const PRELUDE_CARDS=preludeData as (SpecialDefinition & {tension:number})[];
export const NEUTRALITY_CARDS:SpecialDefinition[]=[
 {id:'neutrality_soviet_union_status',sourceIndex:-1,deckOwner:'soviet_union',country:'soviet_union',type:'历史',name:'混乱的政局',text:'开局正面朝上放置在场上。苏联无法执行【资源重整】。结束【中立】时，弃置此【历史牌】，你可以打出1张状态卡。'},
 {id:'neutrality_united_states_status',sourceIndex:-2,deckOwner:'united_states',country:'united_states',type:'历史',name:'孤立主义',text:'若美国在弃牌阶段不弃牌，扣1分。结束【中立】时，弃置此【历史牌】，获得4分。'},
];
export const BALANCE_CARDS=balanceData as SpecialDefinition[];
export const specialCard=(id:string,balance=false)=>(balance?BALANCE_CARDS.find(c=>c.id===id):undefined)??ALL_SPECIAL_CARDS.find(c=>c.id===id)??PRELUDE_CARDS.find(c=>c.id===id)??NEUTRALITY_CARDS.find(c=>c.id===id);

export function regularCatalog(balance:boolean,_neutrality:boolean):SpecialDefinition[]{
 if(!balance)return ALL_SPECIAL_CARDS;
 const excluded=new Set(['special_250','special_251','special_252']);
 return [...ALL_SPECIAL_CARDS.map(c=>specialCard(c.id,true)!),...BALANCE_CARDS.filter(c=>c.id.startsWith('special_')&&!ALL_SPECIAL_CARDS.some(v=>v.id===c.id))].filter(c=>!excluded.has(c.id));
}
export const preludeCatalog=(balance:boolean)=>balance?[...PRELUDE_CARDS.map(c=>specialCard(c.id,true)!),...BALANCE_CARDS.filter(c=>c.id.startsWith('prelude_')&&!PRELUDE_CARDS.some(v=>v.id===c.id))]:PRELUDE_CARDS;

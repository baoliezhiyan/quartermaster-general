import type {CardInstance,GameState,SeatId} from '../core/types';
import {SEATS} from '../core/types';
import {cardName,COUNTRY_NAMES,UNIT_NAMES} from '../core/basic';
import {ACTION_NAMES} from '../core/effectNames';
import {REGION_BY_ID} from '../core/map';
import type {Action} from './contract';
export interface Phrase {text:string;cards:CardInstance[];owner?:SeatId;public:boolean;}
type Located={card:CardInstance;zone:string;seat:SeatId};
function locations(s:GameState){const out=new Map<string,Located>();for(const seat of SEATS){for(const [zone,cards] of Object.entries(s.decks[seat]))for(const card of cards)out.set(card.id,{card,zone,seat});if(s.prelude)for(const [zone,cards] of Object.entries(s.prelude.decks[seat]))for(const card of cards)out.set(card.id,{card,zone:'prelude.'+zone,seat});}return out;}
/** Derived display data only: never serialized, never consulted by the engine. */
export class Narrative {
 readonly phrases=new Map<string,Phrase[]>();
 private seenEffects=new Set<string>();
 private previous:Map<string,Located>;private logs:number;private units:GameState['units'];
 constructor(s:GameState){this.previous=locations(s);this.logs=(s.publicLog??[]).length;this.units=structuredClone(s.units);for(const e of s.resolution?.events??[])if(e.applied)this.seenEffects.add(String(s.balanceResolutionSerial)+':'+e.id);}
 observe(s:GameState,a:Action){
  const list=this.phrases.get(a.actionId)??[];this.phrases.set(a.actionId,list);
  const add=(p:Phrase)=>{if(!list.some(v=>v.text===p.text))list.push(p);};
  const now=locations(s),known=new Set(s.publicCardIds??[]);
  const played=new Set<string>();
  for(const log of (s.publicLog??[]).slice(this.logs)){if(!/打出/.test(log.text)||!log.text.includes('【'))continue;const cards=[...now.values()].map(v=>v.card).filter(c=>log.text.includes('【'+cardName(c)+'】'));for(const c of cards)played.add(c.id);if(cards.length&&cards.every(c=>c.id!==a.cardInstanceId))add({text:log.text.replace(/[。；]$/,''),cards,public:true});}
  const moved=new Map<string,{verb:string;seat:SeatId;public:boolean;cards:CardInstance[]}>();
  for(const [id,to] of now){const from=this.previous.get(id);if(!from||from.zone===to.zone)continue;
   let verb='';
   if(to.zone.endsWith('discardPile')&&!['resolving','active'].includes(from.zone))verb=from.zone.endsWith('drawPile')?(from.zone.startsWith('prelude.')?'弃置序章牌库顶的':'弃置牌库顶的'):'弃置';
   if(to.zone==='faceDown')verb='暗置';
   if(to.zone==='resolving'||to.zone==='active')verb='打出';
   if(to.zone.endsWith('drawPile')&&from.zone.endsWith('hand'))verb='置入牌库的';
   if(to.zone.endsWith('hand')&&from.zone.endsWith('drawPile'))verb='抽取';
   if(!verb)continue;
   if(verb.startsWith('弃置')&&(id===a.cardInstanceId||played.has(id)))continue;
   if(verb==='打出'&&id===a.cardInstanceId)continue;
   const visible=to.zone==='active'||known.has(id),key=to.seat+verb+visible;
   const group=moved.get(key)??{verb,seat:to.seat,public:visible,cards:[]};group.cards.push(to.card);moved.set(key,group);
  }
  for(const m of moved.values())add({text:COUNTRY_NAMES[m.seat]+m.verb+m.cards.map(c=>'【'+cardName(c)+'】').join('、'),cards:m.cards,owner:m.seat,public:m.public});
  for(const event of s.resolution?.events??[]){
   const key=String(s.balanceResolutionSerial)+':'+event.id;
   if(!event.applied||this.seenEffects.has(key))continue;
   this.seenEffects.add(key);const e=event.effect;
   if(e?.kind!=='action'||!e.option)continue;
   const o=e.option,region=REGION_BY_ID[o.regionId]?.name??o.regionId;
   let text=COUNTRY_NAMES[e.country]+'在<'+region+'>'+ (o.mode==='deploy'?'部署空军':o.mode==='supremacy'?'夺取制空权':ACTION_NAMES[e.action]??e.action);
   if(['land_battle','sea_battle','destroy'].includes(e.action)){
    const defender=this.units.find(u=>u.id===o.defenderId),country=o.defenderCountry??defender?.country;
    if(country)text=COUNTRY_NAMES[e.country]+(e.action==='destroy'?'消灭':'攻击')+'位于<'+region+'>的'+COUNTRY_NAMES[country]+UNIT_NAMES[defender?.type??(e.action==='sea_battle'?'navy':'army')];
   }
   add({text,cards:[],public:true});
  }
  for(const log of (s.publicLog??[]).slice(this.logs))if(/获得\s*\d+\s*分|结束中立/.test(log.text))add({text:log.text.replace(/[。；]$/,''),cards:[],public:true});
  this.previous=now;this.logs=(s.publicLog??[]).length;this.units=[...this.units.filter(u=>!s.units.some(v=>v.id===u.id)),...structuredClone(s.units)];
 }
}

import {fact} from './factObserver';
import {homeRegion} from './modifiers';
import type {CountryId,GameState,ReadState,SeatId} from './types';
import {COUNTRY_NAMES,allianceOf} from './basic';
import {REGIONS} from './map';
import {adjacent} from './supply';
import {publicRecord,revealPublic} from './publicHistory';

export const NEUTRAL_SEATS=['soviet_union','united_states'] as const;
export type NeutralSeat=typeof NEUTRAL_SEATS[number];
export const neutralityCardId=(seat:NeutralSeat)=>`neutrality_${seat}_status`;
export function isNeutral(s:ReadState,country:CountryId):boolean {
 return !!s.neutrality?.[country as NeutralSeat]?.neutral;
}
export function initializeNeutrality(s:GameState){
 s.neutrality={soviet_union:{neutral:true},united_states:{neutral:true}};
 s.neutralityNotices=[];
 for(const seat of NEUTRAL_SEATS){const id=neutralityCardId(seat);s.decks[seat].active.push({id,definitionId:id,deckOwner:seat,country:seat,...(s.rules?.balanceEnabled?{balance:true}:{})});}
}
export function mayAttack(s:ReadState,attacker:CountryId,defender?:CountryId){
 if(!defender||!isNeutral(s,attacker))return true;
 return attacker==='soviet_union'?!['germany','italy'].includes(defender):allianceOf(defender)!=='axis';
}
export function mayPlace(s:ReadState,country:CountryId,region:string){
 return country!=='united_states'||!isNeutral(s,country)||!(s.rules?.balanceEnabled&&region==='western_europe'||region==='british_isles'||region==='moscow'||adjacent(s,country,'moscow',region));
}
export const mayReallocate=(s:ReadState,seat:SeatId)=>(!s.basicPlaysRemaining)&&(seat!=='soviet_union'||!isNeutral(s,seat));

/** Check committed status installations, not a card merely entering the resolving zone. */
function activeSupplyStatus(s:ReadState,index:number){
 const definitionId=`special_${index}`;
 return Object.values(s.decks).some(d=>d.active.some(c=>c.definitionId===definitionId)||d.resolving.some(c=>c.definitionId===definitionId&&s.resolution?.frames.some(f=>f.cardId===c.id&&(f.publicSourceZone==='active'||s.resolution?.events.some(e=>e.frameId===f.id&&e.applied&&!e.cancelled&&e.effect?.kind==='signal'&&e.effect.tag==='INSTALL')))));
}
export function occupiedNeutralitySupply(s:ReadState):string[]{
 const eligible=new Set(REGIONS.filter(r=>r.supply&&!['germany','italy','japan'].includes(r.id)).map(r=>r.id));
 if(activeSupplyStatus(s,42))eligible.delete('moscow');
 for(const [id,region] of [[7,'eastern_europe'],[91,'western_china'],[10,'south_africa'],[42,'siberia']] as const)if(activeSupplyStatus(s,id))eligible.add(region);
 return [...new Set(s.units.filter(u=>u.type==='army'&&allianceOf(u.country)==='axis'&&eligible.has(u.regionId)).map(u=>u.regionId))];
}
export function endNeutrality(s:GameState,seat:NeutralSeat,reason:string){
 if(!isNeutral(s,seat))return false;
 const id=`${s.gameId}:neutrality:${seat}`;
 s.neutrality![seat]={neutral:false,reason,eventId:id,round:s.round};
 (s.neutralityNotices??=[]).push({id,seat,reason});
 publicRecord(s,seat,`${COUNTRY_NAMES[seat]}已结束中立：${reason}。`);
 const d=s.decks[seat],cardId=neutralityCardId(seat);
 // The rule effect belongs to the first entry into the war, never to recycling the card.
 for(const zone of ['active','resolving'] as const){const index=d[zone].findIndex(c=>c.id===cardId);if(index>=0){const cards=d[zone].splice(index,1);d.discardPile.push(...cards);revealPublic(s,cards);}}
 if(seat==='united_states'){s.scores[seat]+=4;publicRecord(s,seat,`美国弃置【孤立主义】，获得 4 分。`);}
 else {s.neutralityStatusPending=true;publicRecord(s,seat,s.rules?.balanceEnabled?'苏联弃置【混乱的政局】，可以打出手牌状态，或查看最靠近牌库顶的状态并决定是否打出。':'苏联弃置【混乱的政局】，可以打出一张手牌中的状态牌。');}
 fact(s,'neutrality_ended','结束中立',{seat,reason});
 return true;
}
export function checkNeutralitySupply(s:GameState){
 if(s.rules?.balanceEnabled&&(['united_kingdom','soviet_union','united_states'] as const).some(seat=>s.units.some(u=>u.type==='army'&&allianceOf(u.country)==='axis'&&u.regionId===homeRegion(s,seat)))){
   for(const seat of NEUTRAL_SEATS)endNeutrality(s,seat,'轴心国占领了英、美、苏的大本营');
 }

 if(isNeutral(s,'united_states')&&(s.rules?.balanceEnabled?occupiedNeutralitySupply(s).length>=3:occupiedNeutralitySupply(s).reduce((n,region)=>n+(region==='hawaii'?2:1),0)>=4))endNeutrality(s,'united_states',`轴心国合计占领了至少${s.rules?.balanceEnabled?'三个':'四个'}大本营之外的补给点`);
}
export function checkNeutralityTurn(s:GameState){
 if(!s.prelude?.active&&s.round>=8)endNeutrality(s,'united_states','正式游戏第8轮开始');
 if(!s.prelude?.active&&s.round>=12)endNeutrality(s,'soviet_union','正式游戏第12轮开始');
 if(s.activeSeat!=='soviet_union'||!isNeutral(s,'soviet_union'))return;
 const soviet=s.units.filter(u=>u.country==='soviet_union');
 const adjacentUnits=s.units.filter(u=>u.type!=='air'&&['germany','italy'].includes(u.country)&&soviet.some(v=>adjacent(s,u.country,u.regionId,v.regionId)));
 if([...new Map(adjacentUnits.map(u=>[u.id,u])).values()].reduce((sum,u)=>sum+(s.rules?.balanceEnabled&&u.type==='navy'?0.5:1),0)>=3)endNeutrality(s,'soviet_union','回合开始时，至少三支德国或意大利陆海军与苏联部队相邻');
}
/** Called only after cancellation windows have closed, before resolving combat damage. */
export function checkNeutralityAttack(s:GameState,attacker:CountryId,defender?:CountryId){
 if(defender==='soviet_union'&&['germany','italy'].includes(attacker))endNeutrality(s,defender,`受到${COUNTRY_NAMES[attacker]}的攻击`);
 if(defender==='united_states'&&allianceOf(attacker)==='axis')endNeutrality(s,defender,`受到${COUNTRY_NAMES[attacker]}的攻击`);
}
export function neutralityIndiaPenalty(s:ReadState){
 return isNeutral(s,'soviet_union')?s.units.filter(u=>u.country==='soviet_union'&&u.type!=='air'&&(u.regionId==='india'||adjacent(s,'soviet_union','india',u.regionId))).length:0;
}

export const neutralityDiscardPenalty=(s:ReadState,seat:SeatId)=>seat==='united_states'&&isNeutral(s,seat)?1:0;

import {SEATS} from './types';
import type { CardInstance,GameState,SeatId } from './types';
import type { Effect,ResolutionFrame } from './resolutionTypes';
import { cardName,COUNTRY_NAMES,UNIT_NAMES,seatOf } from './basic';
import { specialCard } from './cardCatalog';
import { effectText,ACTION_NAMES } from './effectNames';
import { REGION_BY_ID } from './map';

function card(s:GameState,id?:string) {return Object.values(s.decks).flatMap(d=>Object.values(d).flat()).find(c=>c.id===id);}
const description=(c:CardInstance)=>`${specialCard(c.definitionId,c.balance)?.type??'基本牌'}【${cardName(c)}】`;
export function addResponseNotice(s:GameState,recipients:SeatId[],text:string,cards:CardInstance[]=[],title?:string) {
 if(!recipients.length)return;
 const notices=s.responseNotices??=[];
 notices.push({id:`notice:${notices.length+1}`,recipients:[...new Set(recipients)],readBy:[],text,...(title?{title}:{}),cards:[...new Map(cards.map(c=>[c.id,{...c}])).values()]});
}
/** Describe completed, public response effects, never private hand or deck choices. */
export function notifyResponseFrame(s:GameState,f:ResolutionFrame) {
 const r=s.resolution!,source=card(s,f.cardId);
 const neutrality=f.noticeKind==='neutrality';
 const parentEventForKind=r.events.find(e=>e.id===f.parentEventId);
 const extra=f.noticeKind==='extra'||(!f.noticeKind&&parentEventForKind?.effect?.kind==='extraPlay');
 if(extra||(!source&&!neutrality))return; // Extra cards are summarized by the effect that played them.
 const parentEvent=r.events.find(e=>e.id===f.parentEventId);
 const ancestors=f.ancestorIds.map(id=>r.events.find(e=>e.id===id)).flatMap(e=>e?r.frames.filter(p=>p.id===e.frameId):[]);
 const foreign=ancestors.filter(p=>p.owner!==f.owner);
 const parent=[...ancestors].reverse().find(p=>p.cardId)??r.frames.find(p=>p.id===parentEvent?.frameId);
 const triggered=f.noticeKind==='trigger'||(!f.noticeKind&&!!f.parentEventId&&parentEvent?.effect?.kind!=='extraPlay');
 const target=card(s,parent?.cardId);
 const recipients=new Set<SeatId>(foreign.map(p=>p.owner));
 if(f.parentEventId&&f.owner!==s.activeSeat)recipients.add(s.activeSeat);
 if(neutrality)for(const seat of SEATS)recipients.add(seat);
 const refs=[...(source?[source]:[]),...(target&&triggered?[target]:[])];
 // Include effects of mechanical child frames, but not effects of a responding card.
 const belongs=(id:string):boolean=>{const frame=r.frames.find(p=>p.id===id);if(!frame)return false;if(frame.id===f.id)return true;const event=r.events.find(e=>e.id===frame.parentEventId);if(frame.cardId&&frame.noticeKind!=='extra'&&!(frame.noticeKind===undefined&&event?.effect?.kind==='extraPlay'))return false;return !!event&&belongs(event.frameId);};
 const events=r.events.filter(e=>belongs(e.frameId));
 const summaries:string[]=[];
 const detailed=new Map<SeatId,Set<string>>();
 const personalSummarySeats=new Map<string,SeatId>();
 const personalSeat=(e:Effect):SeatId|undefined=>e.kind==='score'||e.kind==='deckTop'||e.kind==='forceHand'||e.kind==='draw'||e.kind==='cards'||e.kind==='prelude'&&['discard','picnic-pay','draw-to-seven','draw-if-installed','draw-bottomed'].includes(e.op)?e.seat:undefined;
 const affected=(e:Effect)=>{
  if('seat' in e&&!e.fee)recipients.add(e.seat);
  if('country' in e)recipients.add(seatOf(e.country));
  if(e.kind==='remove')recipients.add(seatOf(e.unit.country));
  if(e.kind==='action'&&e.option?.defenderCountry)recipients.add(seatOf(e.option.defenderCountry));
  if(e.kind==='frameChange'||e.kind==='countChange'){
   const affectedFrame=r.frames.find(p=>p.id===(e.kind==='frameChange'?e.frameId:r.events.find(v=>v.id===e.eventId)?.frameId));
   if(affectedFrame){recipients.add(affectedFrame.owner);const c=card(s,affectedFrame.cardId);if(c)refs.push(c);}
  }
  if(e.kind==='flag')for(const id of e.ids){const unit=s.units.find(u=>u.id===id),c=card(s,id);if(unit)recipients.add(seatOf(unit.country));if(c){recipients.add(c.deckOwner);refs.push(c);}}
 };
 for(const event of events){
  const e=event.effect;if(!e||e.fee)continue;
  if(e.kind==='signal'){
   if(e.tag==='INSTALL'&&event.applied&&event.frameId===f.id)summaries.push(f.finalZone==='faceDown'?'已暗置该牌':'该状态已留场生效');
   continue;
  }
  affected(e);
  if(!event.applied){if(event.resultText)summaries.push(effectText(event.resultText));else if(event.cancelled)summaries.push(`${effectText(e.label)}未生效`);continue;}
  if(event.resultText){const text=effectText(event.resultText);summaries.push(text);const target=personalSeat(e);if(target)personalSummarySeats.set(text,target);for(const seat of event.detailedNoticeSeats??[]){if(!detailed.has(seat))detailed.set(seat,new Set());detailed.get(seat)!.add(text);}continue;}
  if(e.kind==='extraPlay'||e.kind==='prelude'){
   const child=r.frames.find(v=>v.parentEventId===event.id&&v.cardId&&v.noticeKind==='extra');
   const played=card(s,child?.cardId);
   if(played&&child?.publicDeclared){
    if(child.finalZone==='faceDown')summaries.push(`${COUNTRY_NAMES[child.owner]}暗置了一张${specialCard(played.definitionId,played.balance)?.type==='军备'?'军备':'响应卡'}`);
    else {summaries.push(`${COUNTRY_NAMES[child.owner]}打出了${description(played)}${child.cancelled?'（效果被取消）':''}`);refs.push(played);}
   }
   continue;
  }
  if(e.kind==='choose'||e.kind==='trace'||e.kind==='balance')continue;
  if(e.kind==='action'){
   const action=e.option?.mode==='supremacy'?'夺取制空权':e.option?.mode==='deploy'?'部署空军':e.option?.mode==='move'?'调度空军':e.action==='destroy'?'消灭'+(e.destroyedType?UNIT_NAMES[e.destroyedType]:'部队'):ACTION_NAMES[e.action];
   summaries.push(`${COUNTRY_NAMES[e.country]}${e.option?.regionId?`在${REGION_BY_ID[e.option.regionId].name}`:''}${action}`);
  }
  else if(e.kind==='remove')summaries.push(`${COUNTRY_NAMES[e.unit.country]}在${REGION_BY_ID[e.unit.regionId].name}的${UNIT_NAMES[e.unit.type]}被移除`);
  else if(e.kind==='deckTop'||e.kind==='forceHand'||e.kind==='draw'){const text=`${COUNTRY_NAMES[e.seat]}${e.kind==='deckTop'?'弃置牌库顶':e.kind==='forceHand'?'弃置手牌':'摸牌'} ${e.count} 张`;summaries.push(text);personalSummarySeats.set(text,e.seat);}
  else if(e.kind==='score'){const text=`${COUNTRY_NAMES[e.seat]}${e.amount<0?'扣':'获得'} ${Math.abs(e.amount)} 分`;summaries.push(text);personalSummarySeats.set(text,e.seat);}
  else {const text=effectText(e.label);summaries.push(text);const target=personalSeat(e);if(target)personalSummarySeats.set(text,target);for(const seat of event.detailedNoticeSeats??[]){if(!detailed.has(seat))detailed.set(seat,new Set());detailed.get(seat)!.add(text);}}
 }
 if(!neutrality)recipients.delete(f.owner);
 if(!recipients.size)return;
 const cancelled=events.some(e=>e.cancelled&&e.effect?.kind==='signal'&&e.effect.tag==='CARD_EFFECT');
 const result=[...new Set(summaries)].join('；')||(cancelled||f.cancelled?'本次效果被取消':events.some(e=>e.applied&&e.effect?.kind==='signal'&&e.effect.tag==='INSTALL')?'该牌已留场生效':neutrality?'未打出状态卡':'本次未执行额外效果');
 const prefix=neutrality?'苏联结束了中立，弃置了【混乱的政局】':`${COUNTRY_NAMES[f.owner]}使用${description(source!)}`+(triggered&&target&&parent?`，响应${COUNTRY_NAMES[parent.owner]}的${description(target)}`:triggered?'参与响应':'');
 const grouped=new Map<string,SeatId[]>();
 for(const seat of recipients){
  const remaining=summaries.filter(text=>!detailed.get(seat)?.has(text)&&!(personalSummarySeats.has(text)&&personalSummarySeats.get(text)!==seat));
  if(summaries.length&&!remaining.length)continue;
  const text=`${prefix}：${remaining.length?[...new Set(remaining)].join('；'):result}。`;
  grouped.set(text,[...(grouped.get(text)??[]),seat]);
 }
 for(const [text,seats] of grouped)addResponseNotice(s,seats,text,refs,neutrality?'结束中立结算':triggered?undefined:'效果结果');
}

export function notifyAirDecision(s:GameState,f:ResolutionFrame,e:Extract<Effect,{kind:'action'}>,seat:SeatId,kind:'AIR_DEFENSE'|'AIR_INTERCEPT',yes:boolean) {
 const defender=s.units.find(u=>u.id===(e.option?.defenderId??e.selection?.defenderId));
 const recipients=[s.activeSeat,f.owner,...(defender?[seatOf(defender.country)]:[])].filter(v=>v!==seat);
 const source=card(s,f.cardId),regionId=e.selection?.regionId??e.option?.regionId;
 addResponseNotice(s,recipients,`${COUNTRY_NAMES[seat]}${yes?'选择进行':'放弃了'}${kind==='AIR_DEFENSE'?'空军防御':'空军拦截'}${regionId?`（${REGION_BY_ID[regionId].name}）`:''}${source?`，对应${COUNTRY_NAMES[f.owner]}的${description(source)}`:''}。`,source?[source]:[]);
}

export function notifyAttack(s:GameState,e:Effect,defenderId?:string){
 if(e.kind!=='action'||e.attackNotified||!['land_battle','sea_battle','air_power'].includes(e.action))return;
 const defender=s.units.find(u=>u.id===(defenderId??e.option?.defenderId));if(!defender)return;
 e.attackNotified=true;
 addResponseNotice(s,[seatOf(defender.country)],`${COUNTRY_NAMES[e.country]}向${REGION_BY_ID[defender.regionId].name}的${COUNTRY_NAMES[defender.country]}部队发起${e.action==='land_battle'?'陆战':e.action==='sea_battle'?'海战':'夺取制空权'}。`,[],'受到攻击');
}

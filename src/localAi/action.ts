import {seatOf} from '../core/basic';
import {AiError,type ActionRequest,type ActionIntent} from './contract';
import type {observePlayer} from './observation';
type Observation=ReturnType<typeof observePlayer>;
type Active=Extract<Observation,{decisions:unknown}>;
export function validateAction(r:ActionRequest,o:Observation){
 if(!r||!r.intent||typeof r.intent!=='object'||Array.isArray(r.intent)||r.requestId.length>60)throw new AiError('INVALID_REQUEST','合并请求需要 intent，requestId 最长60字符');
 const allowed=['regionId','defenderId','attackerId','airId','recycleId','airIntercept','feeCardIds','cardId','answers'];
 if(Object.keys(r.intent).some(k=>!allowed.includes(k)))throw new AiError('INVALID_REQUEST','未知行动参数');
 for(const key of ['regionId','defenderId','attackerId','airId','recycleId','cardId'] as const)if(r.intent[key]!==undefined&&(typeof r.intent[key]!=='string'||!r.intent[key]!.length))throw new AiError('INVALID_REQUEST','标识必须为非空字符串');
 if(r.intent.airIntercept!==undefined&&typeof r.intent.airIntercept!=='boolean')throw new AiError('INVALID_REQUEST','airIntercept 必须为布尔值');
 
 if(r.intent.answers!==undefined&&(!Array.isArray(r.intent.answers)||r.intent.answers.length>16||r.intent.answers.some(a=>!['CARDS','PAY_COST','SELECT','EFFECT_DECISION','AIR_INTERCEPT'].includes(a.kind)||a.effectIndex!==undefined&&(!Number.isSafeInteger(a.effectIndex)||a.effectIndex<0))))throw new AiError('INVALID_REQUEST','answers 只能指定本行动的费用/效果选择');
 const arrays=[r.intent.feeCardIds,...(r.intent.answers??[]).map(a=>a.ids)].filter(x=>x!==undefined);
 if(arrays.some(ids=>!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string')))throw new AiError('INVALID_REQUEST','选择数组非法');
 const offer=o.offers.find(v=>v.id===r.offerId);if(!offer)throw new AiError('ILLEGAL_CHOICE','没有当前起始选择');
 const type=offer.command.type;
 if(!['PLAY_CARD','STATUS_ACTION','MOVE_AIR','SELECT_AIR_ACTION','RESOLVE_ENGINE_CHOICE'].includes(String(type)))throw new AiError('UNSUPPORTED_ACTION','该起始操作仍使用单步接口');
 if(!('privateCountries'in o))throw new AiError('UNAVAILABLE','没有对局');
 const own=o.privateCountries[offer.seat];
 if(type==='SELECT_AIR_ACTION'&&(!r.intent.cardId||!own.hand.some(c=>c.id===r.intent.cardId)||!r.intent.regionId||offer.command.action==='move'&&!r.intent.airId))throw new AiError('INVALID_REQUEST','空军行动合并须指定 cardId、regionId；调度还须 airId');
 if(type==='PLAY_CARD'&&!['build_army','build_navy','land_battle','sea_battle','air_power'].includes(own.hand.find(c=>c.id===offer.command.cardId)?.definitionId??''))throw new AiError('UNSUPPORTED_ACTION','普通事件仍使用单步接口；合并支持基本牌、状态及单次响应');
 if(type==='RESOLVE_ENGINE_CHOICE'&&(!o.decisions.some(q=>q.id===offer.command.choiceId&&q.kind==='TRIGGER')||r.selections?.ids?.length!==1))throw new AiError('UNSUPPORTED_ACTION','只能以一次明确响应/军备触发开始');
 for(const id of r.intent.feeCardIds??[])if(!own.hand.some(c=>c.id===id))throw new AiError('ILLEGAL_CHOICE','费用牌不在本国当前手牌');
 for(const key of ['attackerId','airId','recycleId'] as const)if(r.intent[key]&&!o.public.units.some(u=>u.id===r.intent[key]&&seatOf(u.country)===offer.seat))throw new AiError('ILLEGAL_CHOICE','指定部队不存在或不属于当前行动国');
 return offer;
}
export function visibleDelta(a:Observation,b:Observation){
 if(!('public'in a)||!('public'in b))return {};
 return {created:b.public.units.filter(u=>!a.public.units.some(v=>v.id===u.id)),removed:a.public.units.filter(u=>!b.public.units.some(v=>v.id===u.id)),moved:b.public.units.flatMap(u=>{const old=a.public.units.find(v=>v.id===u.id);return old&&old.regionId!==u.regionId?[{unitId:u.id,from:old.regionId,to:u.regionId}]:[];}),scores:Object.fromEntries(Object.entries(b.public.scores).filter(([key,v])=>a.public.scores[key as keyof typeof a.public.scores]!==v)),handChanges:Object.fromEntries(b.bindings.map(seat=>[seat,{left:a.privateCountries[seat]?.hand.filter(c=>!b.privateCountries[seat]?.hand.some(v=>v.id===c.id)),entered:b.privateCountries[seat]?.hand.filter(c=>!a.privateCountries[seat]?.hand.some(v=>v.id===c.id))}]))};
}
export function newInformation(a:Observation,b:Observation){
 if(!('privateCountries'in a)||!('privateCountries'in b))return false;
 return b.bindings.some(seat=>JSON.stringify(b.privateCountries[seat].deckComposition.map(c=>c.id))!==JSON.stringify(a.privateCountries[seat]?.deckComposition.map(c=>c.id))||b.privateCountries[seat].hand.some(c=>!a.privateCountries[seat]?.hand.some(v=>v.id===c.id))||b.privateCountries[seat].notices?.some(n=>n.cards.some(c=>!Object.values(a.privateCountries).flatMap(d=>[...d.hand,...d.deckComposition,...d.faceDown]).some(v=>v.id===c.id))));
}
export function continuation(o:Active,intent:ActionIntent,used:Set<number>,boardScope?:string,feeUsed=false){
 const q=o.decisions[0];if(!q)return {reason:'waiting_other'} as const;
 if(['TRIGGER','ORDER_MANDATORY_TRIGGERS','EXTRA_CARD','EXTRA_TARGET','EXTRA_EFFECTS','REALLOCATE','RELOCATE','WITHDRAW'].includes(q.kind))return {reason:'new_decision'} as const;
 // Player projection keeps only the current effect at index zero; effectIndex is the original frame index.
 const e=q.context?.effects[0];if(q.kind==='CARDS'&&e?.kind==='cards'&&'from'in e&&e.from!=='hand')return {reason:'new_information'} as const;
 const matches=(intent.answers??[]).map((a,i)=>({a,i})).filter(({a,i})=>!used.has(i)&&a.kind===q.kind&&(a.effectIndex===undefined||a.effectIndex===q.effectIndex));
 if(matches.length>1)return {reason:'ambiguous_parameters'} as const;
 if(matches.length===1)return {ids:matches[0].a.ids,answer:matches[0].i} as const;
 if(['PAY_COST','CARDS'].includes(q.kind)&&!feeUsed&&intent.feeCardIds&&(q.kind==='PAY_COST'||e?.fee))return {ids:intent.feeCardIds,fee:true} as const;
 if(q.kind==='AIR_INTERCEPT'&&intent.airIntercept!==undefined)return {ids:[intent.airIntercept?'yes':'no']} as const;
 if(q.kind!=='ACTION')return {reason:'missing_selection'} as const;
 const scope=q.frameId+':'+q.effectIndex;if(boardScope&&scope!==boardScope)return {reason:'missing_selection'} as const;
 if(q.field!=='option'){
  const id=q.field==='regionId'?intent.regionId:q.field==='defenderId'?intent.defenderId:q.field==='attackerId'?intent.attackerId:undefined;
  if(!id)return {reason:'missing_selection'} as const;
  return {ids:[id],scope} as const;
 }
 const candidates=q.options.filter(opt=>{const d=opt.details;if(!d)return false;return (['regionId','defenderId','attackerId','airId','recycleId'] as const).every(key=>intent[key]===undefined||d[key]===intent[key])&&(intent.airIntercept===undefined||d.mode!=='battle'||!!d.intercept===intent.airIntercept);});
 if(candidates.length!==1)return {reason:candidates.length?'ambiguous_parameters':'target_changed'} as const;
 return {ids:[candidates[0].id],scope} as const;
}
export function decisionKey(o:Observation){
 const offers=o.offers.filter(v=>v.command.type!=='ACK_RESPONSE_NOTICE'||'blockingNoticeSeats'in o&&o.blockingNoticeSeats.includes(v.seat));
 return offers.length?JSON.stringify([o.gameId,o.epoch,o.bindings,offers,'decisions'in o?o.decisions:null,'public'in o?[o.public.units,o.public.scores,o.privateCountries]:null]):null;
}

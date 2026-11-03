import type {Command,SeatId} from '../core/types';
export const AI_INTERFACE_VERSION='1.1.0';
export interface Offer {id:string;seat:SeatId;label:string;command:Record<string,unknown>; selections?:Record<string,{ids:string[];min:number;max:number;ordered?:boolean;requirements?:readonly string[]}>}
export interface Submission {requestId:string;gameId:string;epoch:string;revision:number;offerId:string;selections?:Record<string,string[]>}
export class AiError extends Error {constructor(public code:string,message:string){super(message);}}
export function compileOffer(offers:Offer[],request:Submission):Command {
 const offer=offers.find(o=>o.id===request.offerId);if(!offer)throw new AiError('ILLEGAL_CHOICE','选择不在当前合法集合中');
 const input=request.selections??{},spec=offer.selections??{};
 if(Object.keys(input).some(k=>!Object.hasOwn(spec,k)))throw new AiError('INVALID_REQUEST','未知选择字段');
 const selected:Record<string,unknown>={};
 for(const [key,rule] of Object.entries(spec)){const ids=input[key]??[];if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!rule.ids.includes(id))||new Set(ids).size!==ids.length||ids.length<rule.min||ids.length>rule.max)throw new AiError('ILLEGAL_CHOICE',key+' 数量或候选无效');selected[key]=key==='takeCardId'||key==='cardId'?ids[0]:ids;}
 return {...offer.command,...selected,seat:offer.seat,expectedRevision:request.revision} as Command;
}

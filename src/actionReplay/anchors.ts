import type {GameState,Command,SeatId} from '../core/types';
import type {ResolutionFrame,ChoiceRequest} from '../core/resolutionTypes';
import type {Anchor,ObjectData} from './contract';
import {canonical} from './state';
export function framePath(s:GameState,f?:ResolutionFrame):string[]{
 if(!f)return ['phase',s.phase];
 const r=s.resolution!,parent=r.events.find(e=>e.id===f.parentEventId),siblings=r.frames.filter(x=>x.parentEventId===f.parentEventId&&x.cardId===f.cardId&&x.owner===f.owner);
 return [...(parent?framePath(s,r.frames.find(x=>x.id===parent.frameId)).concat('effect',String(parent.effectIndex??0)):[]),f.cardId??`system:${f.owner}:${f.effects[0]?.kind??'empty'}`,String(siblings.indexOf(f))];
}
export function anchor(s:GameState,actionId:string):Anchor {
 const r=s.resolution,c=r?.choice,w=r?.windows.find(w=>w.id===c?.windowId),ev=r?.events.find(e=>e.id===w?.originEventId),f=r?.frames.find(f=>f.id===(c?.frameId??ev?.frameId??[...(r?.stack??[])].reverse().find(t=>t.kind==='frame')?.id));
 return {actionId,effectPath:[...framePath(s,f),'effect',String(ev?.effectIndex??f?.nextEffectIndex??0)],timing:`${w?.timing??f?.stage??s.phase}:${c?.kind??'idle'}:${c?.seat??s.activeSeat}`,occurrence:w?r!.windows.filter(x=>x.originEventId===w.originEventId&&x.timing===w.timing).indexOf(w):0};
}
export const sameAnchor=(a:Anchor,b:Anchor)=>canonical(a)===canonical(b);
export function selectedRule(s:GameState,id:string){const r=s.resolution,c=r?.choice,ref=c?.mergedTriggers?.[id]?.[0];return r?.rules.find(rule=>ref?rule.id===ref.ruleId:c?.options.some(o=>o.id===id&&o.id===`${o.windowId}/${rule.id}`));}
export function optionKey(s:GameState,c:ChoiceRequest,id:string):string {
 const r=s.resolution!,o=c.options.find(o=>o.id===id),ref=c.mergedTriggers?.[id]?.[0],rule=ref?r.rules.find(v=>v.id===ref.ruleId):r.rules.find(v=>v.id===id||`${o?.windowId}/${v.id}`===id);
 if(rule){const w=r.windows.find(w=>w.id===(ref?.windowId??o?.windowId??c.windowId)),ev=r.events.find(e=>e.id===w?.originEventId);return canonical({card:rule.sourceInstanceId,on:rule.on,timing:rule.timing,path:ev?[...framePath(s,r.frames.find(f=>f.id===ev.frameId)),String(ev.effectIndex??0)]:[]});}
 return id;
}
export function compactCommand(s:GameState,c:Command):ObjectData {
 const {expectedRevision,choiceId,seat,...input}=c as any;
 if(c.type==='RESOLVE_ENGINE_CHOICE')input.ids=c.ids.map(id=>optionKey(s,s.resolution!.choice!,id));
 return input;
}
export function liveCommand(s:GameState,input:ObjectData,seat:SeatId):Command {
 const c={...input,seat,expectedRevision:s.revision} as any;
 if(c.type==='RESOLVE_ENGINE_CHOICE'){
  const q=s.resolution?.choice;if(!q||q.seat!==seat)throw Error('回放选择国家或窗口不匹配');
  c.choiceId=q.id;c.ids=(input.ids as string[]).map(key=>{const matches=q.options.filter(o=>optionKey(s,q,o.id)===key);if(matches.length!==1)throw Error('记录中的选择已不合法或定位有歧义：'+key);return matches[0].id;});
 }
 return c;
}
export const omitted=(s:GameState,c:Command)=>c.type==='SET_VIEW'||c.type==='ACK_RESPONSE_NOTICE'||c.type==='RESOLVE_ENGINE_CHOICE'&&s.resolution?.choice?.kind==='TRIGGER'&&!c.ids.length;

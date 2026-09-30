import {expect,it} from 'vitest';
import {transition} from '../src/core';
import type {Command,GameState} from '../src/core';
import {responsePreset} from '../src/controller/responsePresets';
import {activePanelCards,triggerContext} from '../src/ui/triggerContext';
import {cardName} from '../src/core/basic';
import {projectState} from '../src/network/project';
function send(s:GameState,p:Record<string,unknown>){const result=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,guided:true,...p} as Command);if(!result.ok)throw Error(result.error);return result.state;}
function choose(s:GameState,ids:string[]){return send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids});}
const message=(s:GameState)=>{const p=triggerContext(s);return p.before+(p.card?cardName(p.card):'')+p.after;};
it('uses the actual nested Cloud event instead of the root phase title',()=>{
 let s=responsePreset('bletchley','context').state;
 expect(message(s)).toBe('当前阶段为出牌阶段开始，您有可用触发效果。');
 s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='云量')!.id]);
 expect(s.operatorSeat).toBe('united_kingdom');
 expect(message(s)).toBe('德国打出了增强 云量，您有可用触发效果。');
 expect(triggerContext(s).card?.definitionId).toBe('special_142');
});
it.each([false,true])('Conscription stays visible and active when British cancellation is %s',cancel=>{
 let s=responsePreset('keep-calm','status-context').state;
 const card=s.decks.germany.active.find(c=>c.definitionId==='special_135')!;
 s.decks.germany.active.unshift({id:'before',definitionId:'special_5',deckOwner:'germany',country:'germany'});
 s.decks.germany.active.push({id:'after',definitionId:'special_6',deckOwner:'germany',country:'germany'});
 const order=activePanelCards(s).map(c=>c.id);
 s=send(s,{type:'STATUS_ACTION',cardId:card.id});
 expect(activePanelCards(s).filter(c=>order.includes(c.id)).map(c=>c.id)).toEqual(order);
 expect(activePanelCards(projectState(s,{kind:'player',seat:'germany'},'germany')!).filter(c=>order.includes(c.id)).map(c=>c.id)).toEqual(order);
 expect(activePanelCards(s).some(c=>c.id===card.id)).toBe(true);
 s=choose(s,['execute']);
 expect(message(s)).toBe('德国使用了状态 征兵，您有可用触发效果。');
 if(cancel){s=choose(s,[s.resolution!.choice!.options[0].id]);s=choose(s,[s.resolution!.choice!.options[0].id]);}
 else {s=choose(s,[]);while(s.resolution?.running&&s.resolution.choice){const c=s.resolution.choice;s=choose(s,c.kind==='ACTION'?[c.options[0].id]:c.kind==='EFFECT_DECISION'?['execute']:[]);}}
 expect(s.decks.germany.active.some(c=>c.id===card.id)).toBe(true);
 expect(activePanelCards(s).map(c=>c.id)).toEqual(order);
 expect(s.decks.germany.discardPile.some(c=>c.id===card.id)).toBe(false);
 expect(s.decks.germany.resolving.some(c=>c.id===card.id)).toBe(false);
});

import {expect,it} from 'vitest';
import {createGame,transition} from '../src/core';
import type {GameState,CardInstance,Command} from '../src/core';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {fullCardEffects} from '../src/core/fullCardEffects';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {specialCard} from '../src/core/cardCatalog';
import {responsePreset} from '../src/controller/responsePresets';
import {validateState} from '../src/controller/saveFormat';
import {discardDeckTop} from '../src/core/decks';
const card=(id:number):CardInstance=>{const d=specialCard(`special_${id}`)!;return {id:`fixture:${id}`,definitionId:d.id,country:d.country,deckOwner:d.deckOwner};};
function send(s:GameState,p:Record<string,unknown>){const r=transition(s,{seat:s.viewSeat,expectedRevision:s.revision,...p} as Command);if(!r.ok)throw Error(r.error);return r.state;}
it('Murmansk recruitment belongs to US, subsequent construction belongs to USSR',()=>{
 const s=createGame('convoy',1940),c=card(93);s.status='PLAYING';s.activeSeat=s.viewSeat=s.operatorSeat='united_states';s.phase='PLAY';s.settings.ignoreOtherPlayerInterrupts=false;
 expect(specialCard(c.definitionId)?.name).toBe('摩尔曼斯克运输船队');
 expect(startResolution(s,'运输船队','united_states',fullCardEffects(s,c,[])!,[])).toBe(true);
 expect(s.resolution!.choice!.seat).toBe('united_states');expect(s.resolution!.choice!.options.map(o=>o.id)).toContain('ross_region');
 expect(resolveChoice(s,'united_states',s.resolution!.choice!.id,['ross_region'])).toBe(true);
 expect(s.units.some(u=>u.country==='soviet_union'&&u.regionId==='ross_region')).toBe(true);
 expect(s.resolution!.choice!.seat).toBe('soviet_union');
 expect(resolveChoice(s,'united_states',s.resolution!.choice!.id,[s.resolution!.choice!.options[0].id])).toBe(false);
 expect(resolveChoice(s,'soviet_union',s.resolution!.choice!.id,[s.resolution!.choice!.options[0].id])).toBe(true);
});
it('London air deployment belongs to UK; steel pact only triggers in Italian turn',()=>{
 const s=createGame('london',1940);s.status='PLAYING';s.phase='AIR';s.activeSeat='united_states';s.settings.ignoreOtherPlayerInterrupts=false;
 const e={kind:'signal' as const,tag:'PHASE:AIR',label:'空军开始'};
 const effect=fullTrigger(s,card(116),e,'After')!;
 startResolution(s,'伦敦上空的鹰','united_states',effect.effects!,[]);
 expect(s.resolution!.choice!.seat).toBe('united_kingdom');
 expect(fullTrigger(s,card(227),e,'After')).toBeUndefined();s.activeSeat='italy';expect(fullTrigger(s,card(227),e,'After')).toBeDefined();
});
it('disabling a pending response prunes its offer and survives serialization; enabling restores future offers',()=>{
 let s=responsePreset('bletchley','toggle').state;
 const cloud=s.decks.germany.hand.find(c=>c.definitionId==='special_142')!;
 s=send(s,{type:'SET_CARD_RESPONSE',cardId:cloud.id,enabled:false});
 expect(s.disabledResponseIds).toContain(cloud.id);expect(s.resolution?.choice?.options.some(o=>o.label==='云量')).not.toBe(true);
 expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
 s=send(s,{type:'SET_CARD_RESPONSE',cardId:cloud.id,enabled:true});
 startResolution(s,'重新进入出牌时点','germany',[{kind:'signal',tag:'PHASE:PLAY',label:'出牌开始'}],[]);
 expect(s.resolution!.choice!.options.some(o=>o.label==='云量')).toBe(true);
 const basic=s.decks.germany.hand.find(c=>!c.definitionId.startsWith('special_'))!;
 expect(transition(s,{type:'SET_CARD_RESPONSE',seat:'germany',expectedRevision:s.revision,cardId:basic.id,enabled:false}).ok).toBe(false);
});
it('deck-top result tells deck owner exact private cards and shortage, without revealing remaining draw pile',()=>{
 const s=createGame('deck-notice',1940);s.decks.germany.removed.push(...s.decks.germany.drawPile.splice(2));const expected=s.decks.germany.drawPile.map(c=>c.id);
 discardDeckTop(s,'germany',3,'united_kingdom');const n=s.responseNotices![0];
 expect(n.title).toBe('弃牌结果');expect(n.recipients).toEqual(['germany']);expect(n.cards.map(c=>c.id)).toEqual(expected);expect(n.text).toContain('德国扣 1 分');
 expect(n.readBy).toEqual([]);expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
});

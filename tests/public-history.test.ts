import {expect,it} from 'vitest';
import {createGame,transition} from '../src/core';
import type {GameState,CardInstance,Command} from '../src/core';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {publicDiscard,revealPublic} from '../src/core/publicHistory';
import {discardHandCards,discardDeckTop} from '../src/core/decks';
import {validateState} from '../src/controller/saveFormat';
import {responsePreset} from '../src/controller/responsePresets';
import {specialCard} from '../src/core/cardCatalog';
function send(s:GameState,p:Record<string,unknown>){const t=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...p} as Command);if(!t.ok)throw Error(t.error);return t.state;}
const card=(n:number):CardInstance=>{const c=specialCard('special_'+n)!;return{id:'public:'+n,definitionId:c.id,deckOwner:c.deckOwner,country:c.country};};
it('conceals set response identity, reveals only when it is actually flipped',()=>{
 const s=createGame('public',1940),c=card(15);s.decks[c.deckOwner].hand.push(c);
 startResolution(s,'秘密响应',c.deckOwner,[{kind:'signal',tag:'INSTALL',label:'暗置秘密响应'}],[],c.id,'faceDown');
 expect(s.publicLog!.map(e=>e.text)).toEqual(['英国暗置了一张响应。']);expect(s.publicCardIds??[]).not.toContain(c.id);
 startResolution(s,'翻开',c.deckOwner,[{kind:'trace',label:'已生效'}],[],c.id);
 expect(s.publicLog!.at(-1)!.text).toContain('翻开响应【'+specialCard(c.definitionId)!.name+'】');expect(publicDiscard(s,c.deckOwner).map(c=>c.id)).toContain(c.id);
});
it('ordinary hand and deck-top discards never become public, and recycled public cards lose identity on hidden discard',()=>{
 const s=createGame('private-discard',1940),c=s.decks.germany.hand[0];revealPublic(s,[c]);discardHandCards(s,'germany',[c.id]);discardDeckTop(s,'germany',2);
 expect(publicDiscard(s,'germany')).toEqual([]);expect(s.publicLog??[]).toEqual([]);
 expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
});
it('discarded active status is publicly identifiable, hidden hand-cost cards are not',()=>{
 const s=createGame('status-discard',1940),c=card(135);s.decks.germany.active.push(c);
 startResolution(s,'弃状态','germany',[{kind:'cards',seat:'germany',from:'active',to:'discardPile',min:1,max:1,label:'弃置状态'}],[]);
 expect(resolveChoice(s,'germany',s.resolution!.choice!.id,[c.id])).toBe(true);
 expect(publicDiscard(s,'germany').map(c=>c.id)).toContain(c.id);expect(s.publicLog!.at(-1)!.text).toContain('弃置持续生效卡牌');
});
it('logs declarations and actual effects but no normal phase work or voluntary skipped card',()=>{
 let s=responsePreset('bletchley','log').state;
 s=send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids:[]});
 expect(s.publicLog??[]).toEqual([]);
 s=send(s,{type:'ADVANCE_PHASE'});expect(s.publicLog?.map(e=>e.text)).toEqual(['德国计分阶段获得 2 分。']);
 let a=responsePreset('bletchley','cloudlog').state;
 a=send(a,{type:'RESOLVE_ENGINE_CHOICE',choiceId:a.resolution!.choice!.id,ids:[a.resolution!.choice!.options.find(o=>o.label==='云量')!.id],guided:true});
 expect(a.publicLog!.map(e=>e.text).join('')).toContain('德国打出增强【云量】');expect(a.publicLog!.map(e=>e.text).join('')).not.toContain('布莱切利园');
});

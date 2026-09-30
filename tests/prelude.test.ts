import {startResolution,resolveChoice} from '../src/core/resolution';
import {preludeCardEffects} from '../src/core/prelude';
import {describe,it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {PRELUDE_CARDS} from '../src/core/cardCatalog';
import {SEATS} from '../src/core/types';
import type {GameState,Command} from '../src/core/types';
import {projectState} from '../src/network/project';
import {validateState} from '../src/controller/saveFormat';
function send(s:GameState,c:Command):GameState{const r=transition(s,c);if(!r.ok)throw Error(`${c.type}: ${r.error}`);return r.state;}
function settle(s:GameState){let n=0;while(s.resolution?.running){if(++n>300)throw Error('loop');const c=s.resolution.choice;if(!c)throw Error('no choice');s.viewSeat=s.operatorSeat=c.seat;s=send(s,{type:'RESOLVE_ENGINE_CHOICE',seat:c.seat,expectedRevision:s.revision,choiceId:c.id,ids:c.options.slice(0,c.min).map(o=>o.id)});}return s;}
describe('prelude',()=>{
 it('initializes deterministic independent decks, leaves twelve regular cards, serializes',()=>{const s=createGame('p',12,'FULL',true);expect(s).toEqual(createGame('p',12,'FULL',true));for(const seat of SEATS){expect(s.decks[seat].hand).toHaveLength(12);expect(s.prelude!.decks[seat].hand).toHaveLength(2);expect(s.prelude!.decks[seat].discardPile).toHaveLength(2);}expect(s.phase).toBe('PRELUDE');expect(()=>validateState(s)).not.toThrow();});
 it('private wire views hide all other prelude cards and own future order',()=>{const s=createGame('p',44,'FULL',true),v=projectState(s,{kind:'player',seat:'germany'},'germany')!;expect(v.prelude!.decks.germany.drawPile[0]).toEqual(s.prelude!.decks.germany.drawPile[0]);expect(v.prelude!.decks.germany.drawPile.slice(1)).toEqual([...s.prelude!.decks.germany.drawPile.slice(1)].sort((a,b)=>a.definitionId.localeCompare(b.definitionId)));expect(v.prelude!.decks.germany.drawPile.map(c=>c.id).sort()).toEqual(s.prelude!.decks.germany.drawPile.map(c=>c.id).sort());expect(JSON.stringify(v.prelude!.decks.japan)).not.toContain('prelude_JP');expect(projectState(s,{kind:'public'},'germany')!.prelude!.decks.germany.hand.every(c=>c.definitionId==='hidden')).toBe(true);});
 it.each(PRELUDE_CARDS.filter(c=>c.type==='历史'))('$id resolves without deadlock and preserves turn flow',d=>{let s=createGame('p',7,'FULL',true);s.activeSeat=s.operatorSeat=s.viewSeat=d.deckOwner;const p=s.prelude!,deck=p.decks[d.deckOwner];for(const seat of SEATS)for(const z of ['hand','drawPile','discardPile'] as const)p.decks[seat][z]=p.decks[seat][z].filter(c=>c.definitionId!==d.id);const card={id:`${d.deckOwner}:${d.id}`,definitionId:d.id,country:d.country,deckOwner:d.deckOwner};deck.hand.push(card);s=send(s,{type:'PLAY_PRELUDE',seat:d.deckOwner,expectedRevision:s.revision,cardId:card.id});s=settle(s);expect(s.prelude!.tension).toBeTypeOf('number');expect(s.prelude!.played&&s.prelude!.active).toBe(false);expect(()=>validateState(s)).not.toThrow();});
 it('tension threshold waits for resolution then skips final refill',()=>{let s=createGame('p',3,'FULL',true);const p=s.prelude!;p.tension=9;const d=PRELUDE_CARDS.find(c=>c.id==='prelude_DE-13')!;const card={id:'test',definitionId:d.id,country:d.country,deckOwner:d.deckOwner};p.decks.germany.hand=[card];s=send(s,{type:'PLAY_PRELUDE',seat:'germany',expectedRevision:0,cardId:'test'});s=settle(s);expect(s.phase).toBe('SETUP');expect(s.prelude!.active).toBe(false);for(const seat of SEATS)expect(s.prelude!.decks[seat].drawPile).toHaveLength(0);});
 it.each([1,7,12,29,77,2026])('seed %i completes prelude and simultaneous keep without losing cards',seed=>{
  let s=createGame('complete',seed,'FULL',true),steps=0;
  while(s.prelude!.active){expect(++steps).toBeLessThan(250);const seat=s.activeSeat,d=s.prelude!.decks[seat];s.viewSeat=s.operatorSeat=seat;
   if(steps%3===0&&d.drawPile.length)s=send(s,{type:'DISCARD_PRELUDE_TOP',seat,expectedRevision:s.revision});
   if(!s.prelude!.active||s.activeSeat!==seat)continue;
   const card=s.prelude!.decks[seat].hand[0]??s.prelude!.decks[seat].drawPile[0];s=send(s,{type:'PLAY_PRELUDE',seat,expectedRevision:s.revision,cardId:card.id});s=settle(s);expect(()=>validateState(s)).not.toThrow();s=JSON.parse(JSON.stringify(s));
  }
  expect(s.phase).toBe('SETUP');for(const seat of SEATS){s.viewSeat=s.operatorSeat=seat;s=send(s,{type:'KEEP_OPENING',seat,expectedRevision:s.revision,cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)});}
  s=settle(s);expect(s.activeSeat).toBe('germany');expect(s.round).toBe(1);expect(s.phase).toBe('PLAY');expect(()=>validateState(s)).not.toThrow();
 });
 it('discarding the last available top card cannot strand an empty country',()=>{
  let s=createGame('empty',2,'FULL',true);const p=s.prelude!;
  for(const seat of SEATS){const d=p.decks[seat];d.discardPile.push(...d.hand.splice(0),...d.drawPile.splice(seat==='germany'?1:0));}
  s=send(s,{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:0});expect(s.phase).toBe('SETUP');expect(()=>validateState(s)).not.toThrow();
 });
});

it('air legion privately identifies discarded prelude cards for each victim without an empty-effect notice',()=>{
 const s=createGame('prelude-notice',44,'FULL',true,false,true);s.activeSeat=s.viewSeat=s.operatorSeat='italy';const d=s.prelude!.decks.italy;const pool=[...d.hand,...d.drawPile,...d.discardPile],source=pool.find(c=>c.definitionId==='prelude_IT-09')!;
 for(const z of ['hand','drawPile','discardPile'] as const)d[z]=d[z].filter(c=>c.id!==source.id);s.decks.italy.hand.push(source);
 const lost=s.prelude!.decks.soviet_union.drawPile.slice(0,1);startResolution(s,'空军军团','italy',preludeCardEffects(s,source).effects,[],source.id,'discardPile',true);
 for(let i=0;s.resolution?.running&&i<30;i++){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,c.options.slice(0,Math.max(c.min,1)).map(o=>o.id),true)).toBe(true);}
 const notices=s.responseNotices!.filter(n=>n.recipients.includes('soviet_union'));expect(notices.some(n=>n.text.includes('本次未执行额外效果'))).toBe(false);const detail=notices.find(n=>n.title==='序章弃牌结果')!;expect(detail.cards.map(c=>c.id)).toEqual(lost.map(c=>c.id));expect(detail.recipients).toEqual(['soviet_union']);expect(projectState(s,{kind:'player',seat:'italy'},'italy')!.responseNotices?.some(n=>n.id===detail.id)).toBe(false);
});

it.each([false,true])('Hyde UK discard/play is optional and US gets another normal-panel play (%s)',ukPlays=>{
 let s=createGame('picnic',44,'FULL',true,false,true);s.activeSeat=s.viewSeat=s.operatorSeat='united_states';
 const us=s.prelude!.decks.united_states,uk=s.prelude!.decks.united_kingdom;
 us.drawPile.push(...us.hand.splice(0),...us.discardPile.splice(0));const i=us.drawPile.findIndex(c=>c.definitionId==='prelude_US-10');us.hand.push(...us.drawPile.splice(i,1));
 uk.drawPile.push(...uk.hand.splice(0),...uk.discardPile.splice(0));const j=uk.drawPile.findIndex(c=>c.definitionId==='prelude_UK-01');uk.hand.push(...uk.drawPile.splice(j,1),...uk.drawPile.splice(0,1));
 const chosen=uk.hand[0].id,fee=uk.hand[1].id,discarded=uk.discardPile.length;
 s=send(s,{type:'PLAY_PRELUDE',seat:'united_states',expectedRevision:s.revision,cardId:us.hand[0].id});
 expect(s.resolution!.choice).toMatchObject({seat:'united_kingdom'});expect(s.resolution!.choice!.prompt).toContain('弃置');
 let q=s.resolution!.choice!;s=send(s,{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:ukPlays?[fee]:[]});
 if(ukPlays){q=s.resolution!.choice!;s=send(s,{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:[chosen]});}
 expect(s.resolution?.running).toBe(false);expect(s.activeSeat).toBe('united_states');expect(s.prelude!.played).toBe(false);expect(s.prelude!.tension).toBe(-1);expect(s.prelude!.decks.united_kingdom.discardPile).toHaveLength(discarded+Number(ukPlays));
 expect(s.decks.united_kingdom.faceDown.some(c=>c.id===chosen)).toBe(ukPlays);validateState(s);
});

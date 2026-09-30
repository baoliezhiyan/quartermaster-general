import {insertRandom} from '../src/core/basic';
import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {cardEffects} from '../src/core/specialCards';
import {specialCard} from '../src/core/cardCatalog';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {preludeEffect} from '../src/core/prelude';
import {balanceEffect} from '../src/core/balanceEffects';
import {sortCardChoices} from '../src/core/cardChoiceOrder';
import type {GameState,SeatId} from '../src/core/types';
function game(seat:SeatId='germany',balance=true){const s=createGame('search',1940,'FULL',true,false,balance);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat=seat;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}return s;}
function card(s:GameState,id:string){const d=specialCard(id,!!s.rules?.balanceEnabled)!;return {id:'source-'+id,definitionId:id,country:d.country,deckOwner:d.deckOwner,balance:!!s.rules?.balanceEnabled};}
function settle(s:GameState){for(let n=0;s.resolution?.choice&&n<150;n++){const q=s.resolution.choice;expect(resolveChoice(s,q.seat,q.id,q.kind==='TRIGGER'?[]:q.kind==='EFFECT_DECISION'?['execute']:q.options.slice(0,q.min).map(o=>o.id))).toBe(true);}expect(s.resolution?.running).toBe(false);}
it.each([false,true])('Malta with no own Mediterranean navy forces both top discards (guided=%s)',guided=>{
 const s=game('united_kingdom');s.units=[{id:'ally',country:'japan',type:'navy',regionId:'sea_mediterranean'},{id:'elsewhere',country:'germany',type:'navy',regionId:'sea_baltic'}];const before=['germany','italy'].map(seat=>s.decks[seat as SeatId].drawPile.map(c=>c.id));
 startResolution(s,'马耳他','united_kingdom',cardEffects(s,card(s,'special_26')),[],undefined,'discardPile',guided);settle(s);
 for(const [i,seat] of (['germany','italy'] as const).entries())expect(s.decks[seat].drawPile.map(c=>c.id)).toEqual(before[i].slice(2));expect(s.units).toHaveLength(2);
});
it('Malta requires a real own navy and rejects skipping or a stale removal',()=>{
 const s=game('united_kingdom');s.units=[{id:'de-navy',country:'germany',type:'navy',regionId:'sea_mediterranean'}];
 startResolution(s,'马耳他','united_kingdom',cardEffects(s,card(s,'special_26')),[],undefined,'discardPile',true);const q=s.resolution!.choice!;expect(q.seat).toBe('germany');expect(q.options.map(o=>o.id)).toEqual(['discard','de-navy']);expect(resolveChoice(s,q.seat,q.id,[])).toBe(false);
 s.units=[];expect(resolveChoice(s,q.seat,q.id,['de-navy'])).toBe(false);expect(resolveChoice(s,q.seat,q.id,['discard'])).toBe(true);settle(s);
});
it.each([151,153,258])('full-deck search %s preserves remaining order and random state',id=>{
 const s=game(id===258?'united_states':'germany'),source=card(s,'special_'+id),d=s.decks[source.deckOwner],before=d.drawPile.map(c=>c.id),rng=s.randomState;
 startResolution(s,'检索',source.deckOwner,cardEffects(s,source),[]);settle(s);
 expect(d.drawPile.map(c=>c.id)).toEqual(before.filter(id=>d.drawPile.some(c=>c.id===id)));expect(s.randomState).toBe(rng);
});
it.each(['status','response'])('partial inspection retains its final reshuffle: %s',kind=>{
 const s=game(kind==='status'?'germany':'soviet_union'),seat=s.activeSeat,d=s.decks[seat],wanted=kind==='status'?'状态':'响应';
 const index=d.drawPile.findIndex(c=>specialCard(c.definitionId,true)?.type===wanted);d.drawPile.unshift(...d.drawPile.splice(index,1));const rng=s.randomState;
 startResolution(s,'部分检视',seat,kind==='status'?[preludeEffect(seat,'inspect-status'),preludeEffect(seat,'shuffle-normal')]:[balanceEffect(seat,'inspect-response')],[]);settle(s);expect(s.randomState).not.toBe(rng);
});
it('card choices are ID-sorted without changing membership, deck order or selection order',()=>{
 const s=game(),d=s.decks.germany,before=structuredClone(d.drawPile);
 startResolution(s,'顶四张重排','germany',[{kind:'cards',seat:'germany',from:'drawPile',to:'drawPile',topCount:4,min:4,max:4,order:true,label:'排序'}],[]);
 const q=s.resolution!.choice!,expected=sortCardChoices(before.slice(0,4).map(c=>({id:c.id,label:c.definitionId})));expect(q.options).toEqual(expected);expect(d.drawPile).toEqual(before);
 const ids=q.options.map(o=>o.id).reverse();expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);expect(d.drawPile.slice(0,4).map(c=>c.id)).toEqual(ids);
 expect(sortCardChoices([...expected].reverse())).toEqual(expected);
});

it('returning a card samples one insertion slot without shuffling other cards',()=>{
 const seen=new Set<number>();
 for(let seed=0;seed<80;seed++){const rng={randomState:seed},pile=['a','b','c','d'];insertRandom(pile,'return',rng);expect(pile.filter(x=>x!=='return')).toEqual(['a','b','c','d']);expect(rng.randomState).toBe((seed+0x6d2b79f5)>>>0);seen.add(pile.indexOf('return'));}
 expect(seen.size).toBe(5);
});
it.each([true,false])('Italian ambition preserves remaining order and randomness (eligible=%s)',eligible=>{
 const s=game('italy'),d=s.decks.italy;if(!eligible)d.drawPile=d.drawPile.filter(c=>specialCard(c.definitionId,true)?.type!=='状态');const before=d.drawPile.map(c=>c.id),rng=s.randomState;
 startResolution(s,'意大利雄心','italy',[balanceEffect('italy','italian-ambition-deck')],[]);settle(s);
 expect(d.drawPile.map(c=>c.id)).toEqual(before.filter(id=>d.drawPile.some(c=>c.id===id)));expect(s.randomState).toBe(rng);
});

it('Malta permits removing the existing navy instead of discarding, independently for each country',()=>{
 const s=game('united_kingdom');s.units=[{id:'italy-navy',country:'italy',type:'navy',regionId:'sea_mediterranean'}];const de=s.decks.germany.drawPile.length,it=s.decks.italy.drawPile.length;
 startResolution(s,'马耳他','united_kingdom',cardEffects(s,card(s,'special_26')),[]);const q=s.resolution!.choice!;expect(q.seat).toBe('italy');expect(resolveChoice(s,q.seat,q.id,['italy-navy'])).toBe(true);settle(s);
 expect(s.units).toEqual([]);expect(s.decks.germany.drawPile.length).toBe(de-2);expect(s.decks.italy.drawPile.length).toBe(it);
});

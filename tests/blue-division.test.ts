import {expect,it} from 'vitest';
import {projectState} from '../src/network/project';
import {createGame} from '../src/core';
import {specialCard} from '../src/core/cardCatalog';
import {fullCardEffects} from '../src/core/fullCardEffects';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {publicDiscard} from '../src/core/publicHistory';
import {validateState} from '../src/controller/saveFormat';
it('Blue Division stays with Italy and randomly discards exactly one hidden Soviet response without revealing it',()=>{
 const outcomes=new Set<string>();
 for(let seed=1;seed<=8;seed++){
 const s=createGame('blue',seed,'FULL');s.status='PLAYING';s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat='italy';
 for(const deck of Object.values(s.decks)){deck.drawPile.push(...deck.hand);deck.hand=[];}
 const it=s.decks.italy,c=it.drawPile.find(c=>c.definitionId==='special_241')!;it.drawPile=it.drawPile.filter(v=>v.id!==c.id);it.hand.push(c);
 const d=s.decks.soviet_union,hidden=d.drawPile.filter(c=>specialCard(c.definitionId)?.type==='响应').slice(0,3);d.drawPile=d.drawPile.filter(c=>!hidden.some(v=>v.id===c.id));d.faceDown.push(...hidden);
 const before=s.randomState;startResolution(s,'西班牙蓝色师','italy',fullCardEffects(s,c,[])!,[],c.id,'discardPile',true,structuredClone(s));
 expect(s.resolution!.choice!.kind).toBe('EFFECT_DECISION');expect(s.resolution!.choice!.seat).toBe('italy');
 const copy=JSON.parse(JSON.stringify(s));expect(resolveChoice(s,'italy',s.resolution!.choice!.id,['execute'],true)).toBe(true);expect(resolveChoice(copy,'italy',copy.resolution!.choice!.id,['execute'],true)).toBe(true);
 expect(s.resolution?.running).toBe(false);expect(d.faceDown).toHaveLength(2);expect(d.discardPile).toHaveLength(1);expect(s.randomState).not.toBe(before);expect(copy.decks).toEqual(s.decks);outcomes.add(d.discardPile[0].definitionId);
 expect(publicDiscard(s,'soviet_union')).toEqual([]);const attacker=projectState(s,{kind:'player',seat:'italy'},'italy')!;const visible=JSON.stringify([attacker.publicLog,attacker.responseNotices]);const own=projectState(s,{kind:'player',seat:'soviet_union'},'soviet_union')!;expect(own.responseNotices!.find(n=>n.title==='弃牌结果')!.cards).toEqual([d.discardPile[0]]);for(const h of hidden){expect(visible).not.toContain(h.id);expect(visible).not.toContain(specialCard(h.definitionId)!.name);}
 expect(()=>validateState(s)).not.toThrow();
 }
 expect(outcomes.size).toBeGreaterThan(1);
});

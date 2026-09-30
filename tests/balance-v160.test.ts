import {expect,it} from 'vitest';
import {createGame} from '../src/core/game';
import {regularCatalog,specialCard} from '../src/core/cardCatalog';
import {cardEffects} from '../src/core/specialCards';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {cardArt} from '../src/ui/cardArt';
import art from '../src/data/card-art.json';
it.each([false,true])('US sympathy remains a Chinese army construction, balance=%s',balance=>{
 const s=createGame('v160',42,'FULL',false,false,balance);s.status='PLAYING';s.phase='PLAY';s.activeSeat=s.operatorSeat=s.viewSeat='united_states';
 const d=s.decks.united_states;d.drawPile.push(...d.hand.splice(0));const i=d.drawPile.findIndex(c=>c.definitionId==='special_114'),card=d.drawPile.splice(i,1)[0];d.hand.push(card);
 expect(specialCard(card.definitionId,balance)?.name).toBe('美国人民同情中国');
 const effects=cardEffects(s,card);expect(effects).toHaveLength(1);expect(effects[0]).toMatchObject({kind:'action',action:'build_army',country:'china'});
 const before=s.units.filter(u=>u.country==='china'&&u.type==='army').length;startResolution(s,'美国人民同情中国','united_states',effects,[],card.id);
 for(let n=0;s.resolution?.choice&&n<20;n++){const q=s.resolution.choice;expect(resolveChoice(s,q.seat,q.id,q.min?[q.options[0].id]:[])).toBe(true);}
 expect(s.resolution!.running).toBe(false);expect(s.units.filter(u=>u.country==='china'&&u.type==='army').length).toBe(before+1);
});
it('balance deck contains one copy each of Sympathy and Xiangxi with distinct effects',()=>{
 const cards=regularCatalog(true,false);expect(cards.filter(c=>c.name==='美国人民同情中国')).toHaveLength(1);expect(cards.filter(c=>c.name==='湘西会战')).toHaveLength(1);expect(regularCatalog(false,false).some(c=>c.id==='special_255')).toBe(false);
 const s=createGame('v160',42,'FULL',false,false,true);const c=[...s.decks.united_states.hand,...s.decks.united_states.drawPile].find(c=>c.definitionId==='special_255')!;expect(c).toBeTruthy();const effects=cardEffects(s,c);expect(effects[0]).toMatchObject({kind:'action',country:'china',action:'land_battle'});expect(effects[1]).toMatchObject({kind:'balance',op:'build-battle-region'});expect(effects[2].kind).toBe('choose');
});
it.each([false,true])('China stalemate remains economic warfare with ROC artwork, balance=%s',balance=>{
 expect(specialCard('special_112',balance)?.type).toBe('经济战');expect(cardArt({definitionId:'special_112',country:'china',balance}).src?.split('?')[0]).toBe(art['民国-经济战']);
});

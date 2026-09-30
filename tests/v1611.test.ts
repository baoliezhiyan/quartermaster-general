import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {specialCard} from '../src/core/cardCatalog';
import {cardEffects} from '../src/core/specialCards';
import {historyEffects} from '../src/core/prelude';
import {discardHandCards,discardPhase,drawCards} from '../src/core/decks';
import {publicDiscard} from '../src/core/publicHistory';
import {projectState} from '../src/network/project';
import {validateState} from '../src/controller/saveFormat';
import {publicCostIds} from '../src/core/cardCosts';
import {preludeTriggers} from '../src/core/preludeTriggers';
import type {Effect,ResolutionFrame} from '../src/core/resolutionTypes';
import {fullTrigger} from '../src/core/fullCardTriggers';
import type {GameState,CardInstance,SeatId} from '../src/core/types';
function card(id:string,n=''):CardInstance{const d=specialCard(id,true);return {id:'test:'+id+n,definitionId:id,country:d?.country??'soviet_union',deckOwner:d?.deckOwner??'soviet_union',balance:true};}
function game(seat:SeatId='soviet_union'){const s=createGame('v1611',71,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat=seat;s.redistributed=true;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0));d.active=[];d.faceDown=[];}s.units=[];return s;}
function answer(s:GameState,ids?:string[]){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,ids??q.options.slice(0,q.min).map(o=>o.id))).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<60;i++)answer(s);expect(s.resolution?.running).toBe(false);}
it('Betasom logs destruction of a navy, not an army',()=>{
 const s=game('italy'),c=card('special_253');s.decks.italy.hand=[c];s.units=[{id:'navy',country:'united_kingdom',type:'navy',regionId:'sea_north_sea'}];startResolution(s,'贝塔松','italy',cardEffects(s,c),[],c.id);finish(s);expect(s.units).toHaveLength(0);expect(s.publicLog!.some(l=>l.text==='意大利在北海消灭海军。')).toBe(true);expect(s.publicLog!.some(l=>l.text.includes('消灭陆军'))).toBe(false);
});
it.each(['army','navy','air'] as const)('destruction log follows actual %s target even in mixed-target effects',type=>{
 const s=game('italy');s.units=[{id:'target',country:'united_kingdom',type,regionId:'north_africa'}];startResolution(s,'消灭','italy',[{kind:'action',country:'italy',action:'destroy',destroyTypes:['army','navy','air'],label:'消灭部队'}],[]);finish(s);expect(s.publicLog!.some(l=>l.text===`意大利在非洲北部消灭${{army:'陆军',navy:'海军',air:'空军'}[type]}。`)).toBe(true);
});
it.each([0,1,2,3])('Spanish support burns %s cards one by one then Italy pays that count',count=>{
 let s=game();s.prelude!.active=true;s.phase='PRELUDE';const su=s.prelude!.decks.soviet_union,it=s.prelude!.decks.italy,topIds=su.drawPile.slice(0,3).map(c=>c.id),initial=it.drawPile.length;startResolution(s,'支援西班牙','soviet_union',historyEffects(s,card('prelude_SU-11')),[]);
 for(let i=0;i<count;i++){expect(s.resolution!.choice!.prompt).toContain(specialCard(s.prelude!.decks.soviet_union.drawPile[0].definitionId,true)!.name);expect(s.prelude!.decks.italy.drawPile.length).toBe(initial);answer(s,['discard']);s=JSON.parse(JSON.stringify(s));validateState(s);}
 if(count<3)answer(s,[]);finish(s);expect(s.prelude!.decks.italy.drawPile.length).toBe(initial-count);expect(topIds.slice(0,count).every(id=>s.prelude!.decks.soviet_union.discardPile.some(c=>c.id===id))).toBe(true);
});
it('Spanish support stops at an empty Soviet prelude deck and spills only Italys deficit',()=>{
 const s=game();s.prelude!.active=true;s.phase='PRELUDE';s.prelude!.decks.soviet_union.drawPile=s.prelude!.decks.soviet_union.drawPile.slice(0,1);s.prelude!.decks.italy.drawPile=[];const n=s.decks.italy.drawPile.length;startResolution(s,'西班牙','soviet_union',historyEffects(s,card('prelude_SU-11')),[]);answer(s,['discard']);finish(s);expect(s.decks.italy.drawPile.length).toBe(n-1);
});
it.each([['build_army','build_army'],['land_battle','land_battle'],['build_army','land_battle']])('typed tank transport fee %s/%s is publicly visible after payment', (a,b)=>{
 const s=game(),cards=[a,b].map(id=>{const pile=s.decks.soviet_union.drawPile;return pile.splice(pile.findIndex(c=>c.definitionId===id),1)[0];});s.decks.soviet_union.hand=cards;const requirements=fullTrigger(s,card('special_44'),{kind:'action',country:'soviet_union',action:'build_army',label:'建设'},'After')!.costRequirements;
 startResolution(s,'费用','soviet_union',[{kind:'cards',seat:'soviet_union',from:'hand',to:'discardPile',min:2,max:2,requirements,fee:true,label:'支付坦克运输费用'},{kind:'trace',label:'效果'}],[]);answer(s,cards.map(c=>c.id));finish(s);expect(publicDiscard(s,'soviet_union')).toEqual(cards);const view=projectState(s,{kind:'player',seat:'japan'},'japan')!;expect(publicDiscard(view,'soviet_union').map(c=>c.definitionId)).toEqual([a,b]);validateState(s);
});
it('typed filter fees are public but an unrestricted filler is private',()=>{
 const s=game(),army=card('build_army'),secret=card('special_55');s.decks.soviet_union.hand=[army,secret];startResolution(s,'军备费','soviet_union',[{kind:'cards',seat:'soviet_union',from:'hand',to:'discardPile',min:2,max:2,requirements:['*','build_army'],fee:true,label:'费用'},{kind:'trace',label:'效果'}],[]);answer(s,[secret.id,army.id]);finish(s);expect(publicDiscard(s,'soviet_union')).toEqual([army]);expect(publicCostIds([secret],undefined,'响应')).toEqual([secret.id]);
});
it('Attrition reveals only scoring army cards; ordinary private discards remain hidden',()=>{
 const s=game(),army=card('build_army'),secret=card('special_55');s.decks.soviet_union.active=[card('special_49')];s.decks.soviet_union.hand=[army,secret];discardPhase(s,'soviet_union',[army.id,secret.id]);expect(s.scores.soviet_union).toBe(1);expect(publicDiscard(s,'soviet_union')).toEqual([army]);
 const t=game();t.decks.soviet_union.hand=[army,secret];discardHandCards(t,'soviet_union',[army.id,secret.id]);expect(publicDiscard(t,'soviet_union')).toEqual([]);
});
it('known discard becomes private again if drawn back to hand',()=>{
 const s=game(),c=card('build_army');s.decks.soviet_union.hand=[c];discardHandCards(s,'soviet_union',[c.id],[c.id]);s.decks.soviet_union.discardPile=[];s.decks.soviet_union.drawPile=[c];drawCards(s,'soviet_union',1);expect(s.publicCardIds).not.toContain(c.id);
});

it.each(['prelude_SU-01','prelude_SU-03'])('army fee that waives sacrifice is public for %s',id=>{
 const s=game(),c=card(id),fee=card('build_army');s.decks.soviet_union.faceDown=[c];s.decks.soviet_union.hand=[fee];s.units=[{id:'home',country:'soviet_union',type:'army',regionId:'moscow'}];
 const event:Effect=id.endsWith('01')?{kind:'action',country:'soviet_union',action:'land_battle',option:{regionId:'ukraine'} as any,label:'陆战'}:{kind:'remove',unit:{id:'dead',country:'soviet_union',type:'army',regionId:'ukraine'},supplied:true,cause:'land_battle',label:'阵亡'};
 const rule=preludeTriggers(s,{id:'probe',currentEventId:'event'} as ResolutionFrame,event,'After')[0];startResolution(s,'军备','soviet_union',rule.effects,[]);answer(s,[fee.id]);finish(s);expect(publicDiscard(s,'soviet_union')).toContainEqual(fee);
});
it('a response-filtered hand discard reveals the exact response',()=>{
 const s=game('japan'),pile=s.decks.japan.drawPile,fee=pile.splice(pile.findIndex(c=>specialCard(c.definitionId,true)?.type==='响应'),1)[0];s.decks.japan.hand=[fee];startResolution(s,'费用','japan',[{kind:'cards',seat:'japan',from:'hand',to:'discardPile',min:1,max:1,filter:'响应',fee:true,label:'弃置响应'},{kind:'trace',label:'效果'}],[]);answer(s,[fee.id]);finish(s);expect(publicDiscard(s,'japan')).toEqual([fee]);
});

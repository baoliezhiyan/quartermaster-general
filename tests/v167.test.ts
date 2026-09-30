import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {historyEffects} from '../src/core/prelude';
import {specialCard} from '../src/core/cardCatalog';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {publicActiveCards} from '../src/core/publicActiveCards';
import {projectState} from '../src/network/project';
import {suppliedUnits} from '../src/core/supply';
import type {GameState,CardInstance} from '../src/core/types';
function card(id:string,balance=true):CardInstance{const d=specialCard(id,balance)!;return {id:'test:'+id,definitionId:id,country:d.country,deckOwner:d.deckOwner,balance};}
function answer(s:GameState,ids:string[]){const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.choice&&i<50;i++){const q=s.resolution.choice;answer(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
it.each([false,true])('Black Dragon sets a regular response and draws during prelude, balance=%s',balance=>{
 const s=createGame('dragon',1,'FULL',true,false,balance);s.activeSeat='japan';const d=s.decks.japan,response=card('special_196',balance);d.hand=[response];const before=d.drawPile.length;
 startResolution(s,'黑龙会','japan',historyEffects(s,card('prelude_JP-12',balance)),[]);expect(s.resolution!.choice).toMatchObject({kind:'CARDS',seat:'japan'});answer(s,[response.id]);finish(s);
 expect(d.faceDown).toContainEqual(response);expect(d.hand).toHaveLength(1);expect(d.drawPile).toHaveLength(before-1);expect(s.units.some(u=>u.country==='japan'&&u.regionId==='ukraine')).toBe(false);
});
it.each([false,true])('Socialism still sets responses during prelude, balance=%s',balance=>{
 const s=createGame('socialism',1,'FULL',true,false,balance);s.activeSeat='soviet_union';const d=s.decks.soviet_union,response=card('special_55',balance);d.hand=balance?d.drawPile.splice(0,1):[response];if(balance)d.drawPile=[response,...d.drawPile];
 startResolution(s,'一国建成社会主义','soviet_union',historyEffects(s,card('prelude_SU-14',balance)),[]);
 if(balance)answer(s,[d.hand[0].id]);expect(s.resolution!.choice!.options.some(o=>o.id===response.id)).toBe(true);answer(s,[response.id]);finish(s);expect(d.faceDown).toContainEqual(response);expect(d.hand).toHaveLength(1);
});
it.each(['army','navy','air'] as const)('Royal Air Force protection for %s',type=>{
 const s=createGame('raf',1,'FULL');const unit={id:'target',country:'united_kingdom' as const,type,regionId:'british_isles'};s.units=[unit];
 expect(!!fullTrigger(s,card('special_14'),{kind:'remove',unit,supplied:true,cause:'card',label:'移除'},'Before')).toBe(type!=='air');
});
it('active count stays at three through resolution for every multiplayer viewer',()=>{
 const s=createGame('count',1,'FULL',false,false,true);s.activeSeat='germany';const d=s.decks.germany;d.active=['special_131','special_132','special_133'].map(id=>card(id));const c=d.active[0];s.publicCardIds=d.active.map(c=>c.id);
 startResolution(s,'状态发动','germany',[{kind:'choose',seat:'germany',min:1,max:1,label:'暂停',options:[{id:'ok',label:'继续',effects:[{kind:'trace',label:'完成'}]}]}],[],c.id,'active');
 expect(d.active).toHaveLength(2);expect(publicActiveCards(s,'germany')).toHaveLength(3);
 for(const access of [{kind:'public' as const},{kind:'player' as const,seat:'united_states' as const},{kind:'gm' as const}])expect(publicActiveCards(projectState(s,access,'germany')!,'germany')).toHaveLength(3);
 finish(s);expect(publicActiveCards(s,'germany')).toHaveLength(3);
});
it('regional troop supply does not directly supply an isolated plane',()=>{
 const s=createGame('supply',1);s.units=[{id:'air',country:'japan',type:'air',regionId:'sea_east_china'}];s.turnFlags={protected:[],battleProtected:[],supplied:[],supplyCountries:[],supplyRegions:['japan:sea_east_china'],suppressed:[],noAirDefense:false};
 expect(suppliedUnits(s).has('air')).toBe(false);s.units.push({id:'navy',country:'japan',type:'navy',regionId:'sea_east_china'});expect(suppliedUnits(s).has('air')).toBe(true);
});

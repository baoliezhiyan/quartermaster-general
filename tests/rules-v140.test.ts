import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {validateState} from '../src/controller/saveFormat';
import {projectState} from '../src/network/project';
import type {GameState,SeatId} from '../src/core';
function game(seat:SeatId){
 const s=createGame('v140',1940,'FULL');s.status='PLAYING';s.phase='PLAY';s.round=2;s.activeSeat=s.viewSeat=s.operatorSeat=seat;s.settings.ignoreOtherPlayerInterrupts=false;
 for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}
 return s;
}
function add(s:GameState,seat:SeatId,id:string,zone:'active'|'hand'|'faceDown'){
 const d=s.decks[seat],i=d.drawPile.findIndex(c=>c.definitionId===id);expect(i).toBeGreaterThanOrEqual(0);const c=d.drawPile.splice(i,1)[0];d[zone].push(c);return c;
}
function choose(s:GameState,ids:string[]){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);}
function settle(s:GameState){for(let i=0;s.resolution?.choice&&i<50;i++){const c=s.resolution.choice;choose(s,c.kind==='TRIGGER'?[]:c.options.slice(0,c.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
it.each([['united_kingdom','france','western_europe','germany'],['united_states','china','eastern_china','western_china'],['soviet_union','china','eastern_china','western_china']] as const)('cruiser taxes %s decision maker using %s army, including restore and privacy',(owner,army,from,target)=>{
 let s=game(owner);add(s,'germany','special_126','active');
 s.units=[{id:'attacker',country:army,type:'army',regionId:from},{id:'defender',country:'germany',type:'army',regionId:target}];
 const before=structuredClone(s.decks),tops=before[owner].drawPile.slice(0,2);
 expect(startResolution(s,'cross-national attack',owner,[{kind:'action',country:army,action:'land_battle',regions:[target],label:'attack'}],[])).toBe(true);
 // Save before committing the target; owner context must survive without using viewSeat.
 s=JSON.parse(JSON.stringify(s));validateState(s);s.viewSeat='japan';settle(s);
 expect(s.decks[owner].drawPile).toEqual(before[owner].drawPile.slice(2));
 for(const seat of Object.keys(before) as SeatId[])if(seat!==owner)expect(s.decks[seat].drawPile).toEqual(before[seat].drawPile);
 expect(s.resolution!.events.find(e=>e.effect?.kind==='action')!.effect).toMatchObject({decisionSeat:owner,country:army});
 const notice=s.responseNotices!.find(n=>n.title==='弃牌结果')!;expect(notice.recipients).toEqual([owner]);expect(notice.cards.map(c=>c.id)).toEqual(tops.map(c=>c.id));
 const enemy=projectState(s,{kind:'player',seat:'germany'},'germany')!;
 expect(enemy.responseNotices?.some(n=>n.id===notice.id)).toBe(false);
});
it.each([3,4])('heavy tanks payment option requires four actual hand cards (%s)',n=>{
 const s=game('germany');add(s,'soviet_union','special_53','faceDown');
 s.decks.germany.hand.push(...s.decks.germany.drawPile.splice(0,n));
 s.units=[{id:'g',country:'germany',type:'army',regionId:'eastern_europe'},{id:'g-home',country:'germany',type:'army',regionId:'germany'},{id:'u',country:'soviet_union',type:'army',regionId:'ukraine'}];
 expect(startResolution(s,'attack','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['ukraine'],label:'attack'}],[])).toBe(true);
 while(s.resolution!.choice?.kind==='ACTION')choose(s,[s.resolution!.choice!.options[0].id]);
 const trigger=s.resolution!.choice!;choose(s,[trigger.options.find(o=>o.label==='重型坦克')!.id]);
 expect(s.resolution!.choice!.options.some(o=>o.id==='pay')).toBe(n===4);
 choose(s,[n===4?'pay':'protect']);if(n===4)choose(s,s.decks.germany.hand.map(c=>c.id));settle(s);
 expect(s.units.some(u=>u.id==='u')).toBe(n!==4);expect(s.decks.germany.hand).toHaveLength(n===4?0:3);
});
it.each([1,2])('SAS raid needs two hand cards besides enhancement (%s)',n=>{
 const s=game('united_kingdom');s.phase='PLAY';add(s,'united_kingdom','special_40','hand');s.decks.united_kingdom.hand.push(...s.decks.united_kingdom.drawPile.splice(0,n));
 s.units=[{id:'uk',country:'united_kingdom',type:'air',regionId:'western_europe'},{id:'g',country:'germany',type:'air',regionId:'germany'}];
 expect(startResolution(s,'play start','united_kingdom',[{kind:'signal',tag:'PHASE:PLAY',label:'play start'}],[])).toBe(true);
 const option=s.resolution!.choice?.options.find(o=>o.label==='特种空勤团突袭机场');expect(!!option).toBe(n===2);
 if(option){choose(s,[option.id]);expect(s.resolution!.choice).toMatchObject({kind:'PAY_COST',min:2,max:2});choose(s,s.decks.united_kingdom.hand.filter(c=>c.definitionId!=='special_40').map(c=>c.id));settle(s);expect(s.units.some(u=>u.id==='g')).toBe(false);}
});
it('rejects previous rule saves rather than silently changing costs in a pending game',()=>{
 const s=game('germany');expect(s.rulesVersion).toBe('1.4.0');expect(()=>validateState({...s,rulesVersion:'1.2.2'})).toThrow(/规则版本不兼容/);
});

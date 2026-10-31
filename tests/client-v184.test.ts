import {it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {LocalGameController} from '../src/controller/LocalGameController';
import {revealPublic} from '../src/core/publicHistory';
import {addResponseNotice} from '../src/core/responseNotices';
import {fullCardEffects} from '../src/core/fullCardEffects';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {preludeTriggers} from '../src/core/preludeTriggers';
import {startResolution,resolveChoice} from '../src/core/resolution';
import type {GameState,CardInstance} from '../src/core/types';
import type {ResolutionFrame,TriggerRule} from '../src/core/resolutionTypes';
function game(){const s=createGame('v184',1940,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.round=1;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0),...d.active.splice(0),...d.faceDown.splice(0));}return s;}
function answer(s:GameState,id?:string){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,id?[q.options.find(o=>o.id===id||o.label===id)!.id]:[])).toBe(true);}
it('frozen controller permits repeated cross-seat acknowledgements and settings without modifying old history',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'frozen184',seed:17,mode:'FULL'});
 const s=structuredClone(c.getSnapshot()!),d=s.decks.germany,card=d.drawPile.pop()!;d.discardPile.push(card);revealPublic(s,[card]);addResponseNotice(s,['united_states'],'受到攻击');await c.editScene(s);
 const notified=structuredClone(c.getSnapshot()!);addResponseNotice(notified,['united_states'],'受到攻击');
 function freeze(v:any){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
 Object.assign(c,{state:freeze(notified)});
 const old=c.getSnapshot()!,before=JSON.stringify(old);expect(Object.isFrozen(old.publicDiscardHistory)).toBe(true);
 const notice=old.responseNotices!.at(-1)!;
 expect((await c.dispatchFromRoom({type:'ACK_RESPONSE_NOTICE',seat:'united_states',expectedRevision:old.revision,noticeId:notice.id})).ok).toBe(true);
 expect(c.getSnapshot()!.responseNotices!.at(-1)!.readBy).toContain('united_states');expect(JSON.stringify(old)).toBe(before);
 for(const seat of ['germany','united_states'] as const){expect((await c.dispatch({type:'SET_VIEW',seat,expectedRevision:c.getSnapshot()!.revision})).ok).toBe(true);}
 const now=c.getSnapshot()!;expect(transition(now,{type:'SET_INTERRUPTS',seat:now.viewSeat,expectedRevision:now.revision,enabled:true}).ok).toBe(true);
 expect(c.getSnapshot()!.publicDiscardHistory!.germany).toEqual(old.publicDiscardHistory!.germany);
});
for(const balance of [false,true])it('British armaments only match their corrected phase, balance='+balance,()=>{
 const s=game();s.rules!.balanceEnabled=balance;s.activeSeat='united_kingdom';
 for(const id of ['UK-05','UK-07'])s.decks.united_kingdom.faceDown.push({id,definitionId:'prelude_'+id,deckOwner:'united_kingdom',country:'united_kingdom',balance});
 s.units.push({id:'invader',country:'germany',type:'army',regionId:'british_isles'});
 for(const tag of ['PHASE:SCORE','PHASE:DISCARD','ARMAMENT_ANYTIME']){
 const rs=preludeTriggers(s,{id:'f',currentEventId:'e'} as ResolutionFrame,{kind:'signal',tag,label:tag},'After');
 expect(rs.some(r=>r.sourceInstanceId==='UK-05')).toBe(tag==='PHASE:DISCARD');expect(rs.some(r=>r.sourceInstanceId==='UK-07')).toBe(tag==='PHASE:SCORE');
 }
});
for(const id of [161,198])it('first placement responses finish before choosing the same region again: '+id,()=>{
 const s=game(),country=id===161?'germany':'japan';s.activeSeat=s.viewSeat=s.operatorSeat=country;
 s.units=[{id:'base',country,type:'army',regionId:id===161?'germany':'japan'},{id:'navy',country,type:'navy',regionId:'sea_east_china'}];
 const card:CardInstance={id:'test',definitionId:'special_'+id,deckOwner:country,country};
 const es=id===161?fullCardEffects(s,card,[])!:fullTrigger(s,card,{kind:'action',country,action:'sea_battle',option:{regionId:'sea_east_china'} as any,label:'battle'},'After')!.effects!;
 const region=id===161?'eastern_europe':'eastern_china';
 s.decks.united_kingdom.active.push({id:'response',definitionId:'fixture',deckOwner:'united_kingdom',country:'united_kingdom'});
 const rule:TriggerRule={id:'remove-first',label:'消灭首次部队',sourceInstanceId:'response',owner:'united_kingdom',timing:'After',on:es[0].label,mandatory:false,source:'active',oncePerTurn:true,effects:[{kind:'action',country:'united_kingdom',action:'destroy',regions:[region],label:'消灭首次部队'}]};
 startResolution(s,'sequential',country,es,[rule]);answer(s,region);expect(s.resolution!.choice!.kind).toBe('TRIGGER');answer(s,'消灭首次部队');
 answer(s,s.resolution!.choice!.options[0].id);expect(s.units.some(u=>u.country===country&&u.regionId===region)).toBe(false);
 expect(s.resolution!.choice!.kind).toBe('SELECT');answer(s,'continue');expect(s.resolution!.choice!.kind).toBe('ACTION');answer(s,region);
 expect(s.units.some(u=>u.country===country&&u.regionId===region)).toBe(true);
});

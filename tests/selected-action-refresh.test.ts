import {it,expect} from 'vitest';
import {createGame,transition,SEATS} from '../src/core';
import {refreshSceneResolution} from '../src/core/game';
import {startResolution} from '../src/core/resolution';
import type {GameState,Command} from '../src/core';
function send(s:GameState,c:Record<string,unknown>){const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,guided:true,...c} as Command);if(!r.ok)throw Error(r.error);return r.state;}
function choose(s:GameState,ids:string[]){return send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids});}
function intercept(alternative=true,fee=false){
 let s=createGame('refresh',17,'FULL',false,false,true);s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];s.activeSeat=s.operatorSeat=s.viewSeat='germany';
 s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},...(alternative?[{id:'gi',country:'germany' as const,type:'army' as const,regionId:'italy'}]:[]),{id:'ga',country:'germany',type:'air',regionId:'germany'},{id:'uk',country:'united_kingdom',type:'army',regionId:'western_europe'},{id:'ua',country:'united_kingdom',type:'air',regionId:'western_europe'}];
 const d=s.decks.germany;d.drawPile.push(...d.hand.splice(0));const i=d.drawPile.findIndex(c=>c.definitionId==='land_battle'),card=d.drawPile.splice(i,1)[0];d.hand.push(card);let feeId='';
 if(fee){const c=d.drawPile.shift()!;d.hand.push(c);feeId=c.id;startResolution(s,'constructed paid battle','germany',[{kind:'cards',seat:'germany',from:'hand',to:'discardPile',min:1,max:1,fee:true,label:'fee'},{kind:'action',country:'germany',action:'land_battle',label:'attack'}],[],card.id,'discardPile',true);}
 else s=send(s,{type:'PLAY_CARD',cardId:card.id,effectIndices:[0],targetIds:[]});
 for(let n=0;n<20&&s.resolution?.choice?.kind!=='AIR_INTERCEPT';n++){const q=s.resolution!.choice!;const id=q.kind==='AIR_DEFENSE'?'yes':q.kind==='EFFECT_DECISION'?'execute':q.kind==='CARDS'?feeId:q.field==='regionId'?'western_europe':q.field==='defenderId'?'uk':q.field==='attackerId'?'g':q.options[0].id;s=choose(s,[id]);}
 expect(s.resolution!.choice!.kind).toBe('AIR_INTERCEPT');return {s,cardId:card.id,feeId};
}
it.each([true,false])('lost selected attacker with alternative=%s ends the effect without changing targets or replaying fees',alternative=>{
 const {s,cardId,feeId}=intercept(alternative,true);const notices=s.responseNotices!.length,paid=s.decks.germany.discardPile.filter(c=>c.id===feeId).length;expect(paid).toBe(1);
 s.units=s.units.filter(u=>u.id!=='g');const resolution=s.resolution!;refreshSceneResolution(s);
 expect(resolution.running).toBe(false);expect(resolution.choice).toBeNull();expect(resolution.events.some(e=>e.outcome==='invalid'&&e.effect?.kind==='action')).toBe(true);expect(s.units.some(u=>u.id==='uk')).toBe(true);expect(s.units.some(u=>u.id==='ua')).toBe(true);expect(s.decks.germany.discardPile.filter(c=>c.id===feeId)).toHaveLength(1);expect(s.decks.germany.discardPile.filter(c=>c.id===cardId)).toHaveLength(1);
 const after=JSON.stringify(s);refreshSceneResolution(s);expect(JSON.stringify(s)).toBe(after);expect(s.responseNotices!.filter(n=>n.title?.includes('空军')).length).toBeLessThanOrEqual(notices);
});
it.each(['defender_removed','defender_moved','region_blocked','attacker_moved'])('an invalid selected %s is not substituted with another legal plan',kind=>{
 const {s}=intercept();if(kind==='defender_removed'){s.units=s.units.filter(u=>u.id!=='uk');s.units.push({id:'fr',country:'france',type:'army',regionId:'western_europe'});}if(kind==='defender_moved')s.units.find(u=>u.id==='uk')!.regionId='british_isles';if(kind==='region_blocked')s.units.push({id:'own',country:'germany',type:'army',regionId:'western_europe'});if(kind==='attacker_moved')s.units.find(u=>u.id==='g')!.regionId='japan';
 const resolution=s.resolution!;refreshSceneResolution(s);expect(resolution.running).toBe(false);expect(resolution.events.some(e=>e.outcome==='invalid'&&e.effect?.kind==='action')).toBe(true);expect(s.units.some(u=>u.id==='ua')).toBe(true);if(kind==='defender_removed')expect(s.units.some(u=>u.id==='fr')).toBe(true);
});
it.each([true,false])('normal interception %s still follows the existing defense result',yes=>{let {s}=intercept();s=choose(s,[yes?'yes':'no']);expect(s.units.some(u=>u.id==='uk')).toBe(!yes);expect(s.units.some(u=>u.id==='ua')).toBe(false);expect(s.units.some(u=>u.id==='ga')).toBe(!yes);});

it('an already answered interception cannot retry forever when its required air plan disappears',()=>{
 const {s}=intercept();const resolution=s.resolution!,f=resolution.frames.find(f=>f.id===resolution.choice!.frameId)!;const e=f.effects[f.nextEffectIndex];if(e.kind!=='action')throw Error('not action');e.airIntercept=true;s.units=s.units.filter(u=>u.id!=='ga');refreshSceneResolution(s);expect(resolution.running).toBe(false);expect(resolution.events.some(e=>e.outcome==='invalid'&&e.effect?.kind==='action')).toBe(true);expect(s.units.some(u=>u.id==='uk')).toBe(true);
});

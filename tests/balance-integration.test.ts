import {expect,it} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {SEATS,type GameState} from '../src/core/types';
import {finishPrelude,markPreludeInstall} from '../src/core/prelude';
import {moveSceneCard} from '../src/core/sceneCards';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {balanceEffect} from '../src/core/balanceEffects';
import {boardOptions} from '../src/core/boardEffects';
import {validateState} from '../src/controller/saveFormat';
import {kamikazeEffects as statusActionEffects} from '../src/core/statusActions';
import type {Effect} from '../src/core/resolutionTypes';
function game(prelude=false){const s=createGame('integration',12,'FULL',prelude,true,true);if(prelude)finishPrelude(s);s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];for(const seat of SEATS){const d=s.decks[seat];d.drawPile.push(...d.hand.splice(0));}return s;}
function reply(s:GameState,ids:string[]){const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);}
function skip(s:GameState){for(let i=0;s.resolution?.running&&i<100;i++){const q=s.resolution!.choice!;expect(q).toBeTruthy();reply(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
it('first effective attack ends Soviet neutrality before post-battle industry, then cannot trigger a later attack',()=>{
 const s=game(true),armId='soviet_union:prelude_SU-18';moveSceneCard(s,'soviet_union',true,armId,'faceDown');markPreludeInstall(s,armId);
 const d=s.decks.soviet_union,i=d.drawPile.findIndex(c=>c.definitionId==='build_army');d.hand.push(...d.drawPile.splice(i,1));
 s.units=[{id:'de-home',country:'germany',type:'army',regionId:'germany'},{id:'de',country:'germany',type:'army',regionId:'eastern_europe'},{id:'su',country:'soviet_union',type:'army',regionId:'ukraine'}];
 const battle:Extract<Effect,{kind:'action'}>={kind:'action',country:'germany',action:'land_battle',label:'攻击乌克兰'};battle.option=boardOptions(s,battle).find(o=>o.defenderId==='su');expect(battle.option).toBeTruthy();
 startResolution(s,'攻击','germany',[battle],[]);
 expect(s.neutrality!.soviet_union.neutral).toBe(false);expect(s.units.some(u=>u.id==='su')).toBe(false);
 expect(s.resolution!.choice?.options.some(o=>o.label.includes('战时工业东迁'))).toBe(true);validateState(s);
 skip(s);const first=s.balanceFirstAttacks![armId];s.units.push({id:'su2',country:'soviet_union',type:'army',regionId:'ukraine'});const next:Extract<Effect,{kind:'action'}>={...battle,option:undefined};next.option=boardOptions(s,next).find(o=>o.defenderId==='su2');
 startResolution(s,'再次攻击','germany',[next],[]);expect(s.resolution?.choice?.options.some(o=>o.label.includes('战时工业东迁'))??false).toBe(false);expect(s.balanceFirstAttacks![armId]).toBe(first);skip(s);validateState(s);
});
it('revealed response remains visible through real command projection and save',()=>{
 const s=game(),d=s.decks.japan;for(const id of ['special_195','special_196']){const i=d.drawPile.findIndex(c=>c.definitionId===id);d.faceDown.push(...d.drawPile.splice(i,1));}
 startResolution(s,'Magic','united_states',[balanceEffect('japan','reveal-response')],[]);const shown=s.faceUpResponseIds![0],q=s.resolution!.choice!;
 const r=transition(s,{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:['hidden']});expect(r.ok).toBe(true);if(!r.ok)return;
 expect(r.state.faceUpResponseIds).toContain(shown);expect(r.state.publicCardIds).toContain(shown);validateState(r.state);
});
it('two basic plays do not reopen phase-start windows and still consume two separate standard plays',()=>{
 let s=game();s.activeSeat=s.viewSeat=s.operatorSeat='italy';s.basicPlaysRemaining=2;s.settings.ignoreOtherPlayerInterrupts=true;
 const d=s.decks.italy;for(let n=0;n<2;n++){const i=d.drawPile.findIndex(c=>c.definitionId==='build_army');d.hand.push(...d.drawPile.splice(i,1));}
 for(let n=0;n<2;n++){
  const card=s.decks.italy.hand.find(c=>c.definitionId==='build_army')!,effect:Extract<Effect,{kind:'action'}>={kind:'action',country:'italy',action:'build_army',label:'build'};
  const option=boardOptions(s,effect).find(o=>!s.units.some(u=>u.country==='italy'&&u.regionId===o.regionId));expect(option).toBeTruthy();
  let r=transition(s,{type:'PLAY_BASIC',seat:'italy',expectedRevision:s.revision,cardId:card.id,optionId:option!.id});expect(r.ok).toBe(true);if(!r.ok)return;s=r.state;
  for(let k=0;s.resolution?.running&&k<100;k++){const q=s.resolution!.choice!;r=transition(s,{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:q.options.slice(0,q.min).map(o=>o.id)});expect(r.ok).toBe(true);if(!r.ok)return;s=r.state;}
  expect(s.phase).toBe(n===0?'PLAY':'DISCARD');validateState(s);
 }
 expect(s.basicPlaysRemaining).toBe(0);
});
it('kamikaze air option excludes the fixed Moscow and USA distance rings and consumes a supplied Japanese aircraft',()=>{
 const s=game(),d=s.decks.japan,i=d.drawPile.findIndex(c=>c.definitionId==='special_247'),card=d.drawPile.splice(i,1)[0];d.active.push(card);s.activeSeat='japan';s.phase='AIR';
 s.units=[{id:'a',country:'japan',type:'army',regionId:'eastern_china'},{id:'air',country:'japan',type:'air',regionId:'eastern_china'},{id:'target',country:'soviet_union',type:'army',regionId:'vladivostok'}];
 const effects=statusActionEffects(s,card);expect(effects).toHaveLength(1);expect(effects[0]).toMatchObject({kind:'choose',options:[{effects:[{kind:'remove',unit:{id:'air'},fee:true},{kind:'action',targetIds:['target']}]}]});
});

it('new Italian deck saves keep dissolution and Suez without reserved Vichy cards',()=>{
 const s=game();expect(()=>validateState(structuredClone(s))).not.toThrow();const cards=Object.values(s.decks.italy).flat();
 expect(cards.some(c=>c.definitionId==='special_252')).toBe(false);expect(cards.some(c=>c.definitionId==='special_257')).toBe(true);expect(cards.some(c=>['special_250','special_251'].includes(c.definitionId))).toBe(false);
});

import {parseReplay} from '../src/actionReplay/codec';
import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {validateSession,validateState} from '../src/controller/saveFormat';
import type {SaveSession} from '../src/controller/saveFormat';
import {createGame,transition} from '../src/core/game';
import {specialCard} from '../src/core/cardCatalog';
import {preludeCardEffects,persistentHistory} from '../src/core/prelude';
import type {Command} from '../src/core/types';
import {SEATS} from '../src/core/types';

async function send(c:LocalGameController,command:Record<string,unknown>){const s=c.getSnapshot()!;expect(await c.dispatch({seat:s.operatorSeat,expectedRevision:s.revision,...command} as Command)).toEqual({ok:true});}
async function settle(c:LocalGameController){for(let i=0;c.getSnapshot()!.resolution?.running&&i<150;i++){const choice=c.getSnapshot()!.resolution!.choice!;expect(choice).toBeTruthy();await send(c,{type:'RESOLVE_ENGINE_CHOICE',choiceId:choice.id,ids:choice.options.slice(0,choice.min).map(v=>v.id)});}expect(c.getSnapshot()!.resolution?.running).toBe(false);}
async function play(c:LocalGameController){const s=c.getSnapshot()!,d=s.prelude!.decks[s.activeSeat];await send(c,{type:'SET_VIEW',seat:s.activeSeat});const cards=[...d.hand,...d.drawPile.slice(0,1)];const card=cards.find(v=>specialCard(v.definitionId)?.type==='军备')??cards[0];await send(c,{type:'PLAY_PRELUDE',cardId:card.id});await settle(c);}

it('makes prelude opening checkpoints, preserves big saves, and replaces national slots gradually in formal play',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'prelude-saves',seed:1940,mode:'FULL',prelude:true});
 expect(c.getSessionInfo().rounds).toMatchObject([{id:'prelude:round:1',stage:'prelude',round:1}]);expect(c.getSessionInfo().nations).toHaveLength(1);
 await send(c,{type:'SET_VIEW',seat:'japan'});expect(c.getSessionInfo().nations).toHaveLength(1);
 for(let i=0;i<6;i++)await play(c);
 expect(c.getSnapshot()!.prelude?.round).toBe(2);expect(c.getSessionInfo().rounds.map(cp=>cp.id)).toEqual(['prelude:round:1','prelude:round:2']);expect(c.getSessionInfo().nations).toHaveLength(6);
 const exported=await c.exportSave();await expect(parseReplay(exported)).resolves.toBeDefined();
 await c.loadCheckpoint('prelude:round:1');expect(c.getSnapshot()!.prelude).toMatchObject({turn:1,round:1,played:false});expect(c.getSessionInfo().rounds).toHaveLength(2);expect(c.checkReplay()).toBe(true);
 await c.importSave(exported);
 for(let i=0;c.getSnapshot()!.prelude?.active&&i<150;i++)await play(c);
 expect(c.getSnapshot()!.phase).toBe('SETUP');const preludeBig=c.getSessionInfo().rounds.map(cp=>cp.id);
 for(const seat of SEATS){await send(c,{type:'SET_VIEW',seat});await send(c,{type:'KEEP_OPENING',cardIds:c.getSnapshot()!.decks[seat].hand.slice(0,7).map(v=>v.id)});}await settle(c);
 expect(c.getSessionInfo().rounds.map(cp=>cp.id)).toEqual([...preludeBig,'round:1']);expect(c.getSessionInfo().nations.find(cp=>cp.seat==='germany')?.stage).toBeUndefined();expect(c.getSessionInfo().nations.filter(cp=>cp.stage==='prelude')).toHaveLength(5);
 for(let i=0;c.getSnapshot()!.activeSeat==='germany'&&i<40;i++){const s=c.getSnapshot()!;if(s.resolution?.running)await settle(c);else if(s.phase==='DISCARD')await send(c,{type:'DISCARD_HAND',cardIds:[]});else await send(c,{type:'ADVANCE_PHASE'});}await settle(c);
 expect(c.getSessionInfo().nations.filter(cp=>cp.stage==='prelude')).toHaveLength(4);expect(c.getSessionInfo().rounds.map(cp=>cp.id)).toContain('prelude:round:1');await expect(parseReplay(await c.exportSave())).resolves.toBeDefined();
 const restored=new LocalGameController();await restored.importSave(await c.exportSave());await restored.loadCheckpoint('prelude:round:2');expect(restored.getSnapshot()!.phase).toBe('PRELUDE');expect(restored.checkReplay()).toBe(true);
});

it('historical cards finish in their owner’s prelude discard, including extra top-card plays',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'history-discard',seed:7,mode:'FULL',prelude:true});
 for(let i=0;c.getSnapshot()!.prelude?.active&&i<100;i++){
  const s=c.getSnapshot()!,seat=s.activeSeat,d=s.prelude!.decks[seat],cards=[...d.hand,...d.drawPile.slice(0,1)];const card=cards.find(v=>specialCard(v.definitionId)?.type==='历史'&&!persistentHistory(v.definitionId))??cards[0];
  await send(c,{type:'SET_VIEW',seat});await send(c,{type:'PLAY_PRELUDE',cardId:card.id});await settle(c);
  if(specialCard(card.definitionId)?.type==='历史'&&!persistentHistory(card.definitionId)){expect(c.getSnapshot()!.prelude!.decks[seat].discardPile.some(v=>v.id===card.id)).toBe(true);expect(c.getSnapshot()!.decks[seat].removed.some(v=>v.id===card.id)).toBe(false);expect(c.getSnapshot()!.decks[seat].discardPile.some(v=>v.id===card.id)).toBe(false);}
 }
 expect(()=>validateState(c.getSnapshot())).not.toThrow();expect(c.checkReplay()).toBe(true);
});

it('keeps legacy replay deterministic and upgrades played history when importing an old save',async()=>{
 let s=createGame('legacy-prelude',4,'FULL',true);delete s.prelude!.historyDiscard;delete s.prelude!.round;
 const d=s.prelude!.decks.germany;const all=[...d.drawPile,...d.hand,...d.discardPile];const card=all.find(c=>c.definitionId==='prelude_DE-13')!;
 for(const zone of ['hand','drawPile','discardPile'] as const)d[zone]=d[zone].filter(c=>c.id!==card.id);d.hand.push(card);
 const base=structuredClone(s),commands:Command[]=[];const apply=(command:Command)=>{const result=transition(s,command);expect(result.ok).toBe(true);if(result.ok)s=result.state;commands.push(command);};
 expect(preludeCardEffects(s,card).zone).toBe('removed');apply({type:'PLAY_PRELUDE',seat:'germany',expectedRevision:s.revision,cardId:card.id});
 while(s.resolution?.running){const q=s.resolution.choice!;apply({type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:q.options.slice(0,q.min).map(v=>v.id)});}
 expect(s.decks.germany.removed.some(c=>c.id===card.id)).toBe(true);
 const old:SaveSession={format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state:s,rounds:[],nations:[],undo:[],replayBase:base,commands};expect(()=>validateSession(old)).not.toThrow();
 const controller=new LocalGameController();await controller.importSave(JSON.stringify(old));expect(controller.getSnapshot()!.prelude!.decks.germany.discardPile.some(c=>c.id===card.id)).toBe(true);expect(controller.getSnapshot()!.prelude!.historyDiscard).toBe(true);expect(controller.checkReplay()).toBe(true);await expect(parseReplay(await controller.exportSave())).resolves.toBeDefined();
});

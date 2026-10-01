import {stateHash} from '../src/actionReplay/state';
import {expect,it} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {moveSceneCard,sceneCards} from '../src/core/sceneCards';
import {validateState} from '../src/controller/saveFormat';
import {PRELUDE_CARDS} from '../src/core/cardCatalog';
import {SEATS,type GameState} from '../src/core/types';
async function setup(){const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'prelude-editor',seed:1940,mode:'FULL',prelude:true});return c;}
const snapshot=(c:LocalGameController)=>structuredClone(c.getSnapshot()!) as GameState;
it('edits negative tension and moves prelude cards without touching regular cards; undo and save retain zones',async()=>{
 const c=await setup(),before=snapshot(c),s=snapshot(c),id=s.prelude!.decks.germany.hand[0].id;
 s.prelude!.tension=-4;moveSceneCard(s,'germany',true,id,'drawTop');await c.editScene(s);
 expect(c.getSnapshot()!.prelude!.tension).toBe(-4);expect(c.getSnapshot()!.prelude!.decks.germany.drawPile[0].id).toBe(id);
 expect(c.getSnapshot()!.decks).toEqual(before.decks);expect(c.checkReplay()).toBe(true);
 const restored=new LocalGameController();await restored.importSave(await c.exportSave());expect(await stateHash(restored.getSnapshot()!)).toBe(await stateHash(c.getSnapshot()!));
 await c.undo();expect(c.getSnapshot()!.prelude).toEqual(before.prelude);
 await expect(c.editScene({...snapshot(c),prelude:{...snapshot(c).prelude!,tension:0.5}})).rejects.toThrow();
});
it('moves every prelude zone, keeps regular selector separate, and records newly installed armament',async()=>{
 const c=await setup(),s=snapshot(c),id=sceneCards(s,'germany',true).find(x=>PRELUDE_CARDS.find(d=>d.id===x.definitionId)?.type==='军备')!.id;
 for(const zone of ['drawBottom','discardPile','removed','hand','drawPile','faceDown'] as const){moveSceneCard(s,'germany',true,id,zone);validateState(s);}
 await c.editScene(s);expect(c.getSnapshot()!.prelude!.installed[id]).toBeDefined();
 expect(sceneCards(c.getSnapshot()!,'germany',false).some(c=>c.id===id)).toBe(false);
});
it('force end retains installed effects and normal hands, enters opening choice, and is undoable',async()=>{
 const c=await setup(),s=snapshot(c),arm=sceneCards(s,'germany',true).find(x=>x.definitionId==='prelude_DE-01')!;
 const treaty=sceneCards(s,'united_kingdom',true).find(x=>x.definitionId==='prelude_UK-17')!;
 moveSceneCard(s,'germany',true,arm.id,'faceDown');moveSceneCard(s,'united_kingdom',true,treaty.id,'active');await c.editScene(s);
 const before=snapshot(c);await c.editScene(before,{endPrelude:true});const after=c.getSnapshot()!;
 expect(after.phase).toBe('SETUP');expect(after.prelude!.active).toBe(false);expect(after.decks).toEqual(before.decks);
 for(const seat of SEATS){expect(after.prelude!.decks[seat].hand).toHaveLength(0);expect(after.prelude!.decks[seat].drawPile).toHaveLength(0);expect(after.decks[seat].hand).toHaveLength(12);}
 validateState(after);expect(c.checkReplay()).toBe(true);await c.undo();expect(c.getSnapshot()!.prelude).toEqual(before.prelude);
});
it('rejects ending prelude while a real effect is awaiting choice',async()=>{
 const c=await setup(),s=snapshot(c),card=sceneCards(s,'germany',true).find(x=>x.definitionId==='prelude_DE-20')!;
 moveSceneCard(s,'germany',true,card.id,'hand');await c.editScene(s);const current=c.getSnapshot()!;
 expect((await c.dispatch({type:'PLAY_PRELUDE',seat:'germany',expectedRevision:current.revision,cardId:card.id})).ok).toBe(true);
 expect(c.getSnapshot()!.resolution?.running).toBe(true);await expect(c.editScene(snapshot(c),{endPrelude:true})).rejects.toThrow('当前结算');
 expect(c.getSnapshot()!.phase).toBe('PRELUDE');
});

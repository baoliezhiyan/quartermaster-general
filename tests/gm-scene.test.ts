import {expect,it} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {responsePreset} from '../src/controller/responsePresets';
import type {GameState} from '../src/core';
it('GM edits pending resolution immediately and undo restores it; replay starts at edited baseline',async()=>{
 const c=new LocalGameController();await c.importSave(JSON.stringify(responsePreset('bletchley','gm-edit')));const original=structuredClone(c.getSnapshot()!) as GameState;
 const edit=structuredClone(original);edit.scores.germany=9;await c.editScene(edit);
 expect(c.getSnapshot()!.scores.germany).toBe(9);expect(c.getSnapshot()!.resolution!.choice!.seat).toBe('germany');expect(c.checkReplay()).toBe(true);
 const next=structuredClone(c.getSnapshot()!) as GameState;const cloud=next.decks.germany.hand.find(x=>x.definitionId==='special_142')!;next.decks.germany.hand=next.decks.germany.hand.filter(x=>x.id!==cloud.id);next.decks.germany.discardPile.push(cloud);await c.editScene(next);
 expect(c.getSnapshot()!.resolution?.choice?.options.some(x=>x.label==='云量')).not.toBe(true);expect(c.checkReplay()).toBe(true);
 await c.undo();expect(c.getSnapshot()!.decks.germany.hand.some(x=>x.id===cloud.id)).toBe(true);await c.undo();expect(c.getSnapshot()!.scores.germany).toBe(original.scores.germany);
});

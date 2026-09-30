import {expect,it} from 'vitest';
import {transition} from '../src/core';
import {responsePreset} from '../src/controller/responsePresets';
import {airDestinations,airMoveOptions} from '../src/core/actions';
import {playableCard,usableStatus} from '../src/ui/playAvailability';
it('air can pay one card to relocate in place; forced relocation excludes staying',()=>{
 const s=responsePreset('guided-battle','stay').state;s.phase='AIR';
 expect(airDestinations(s,'test:de-air')).not.toContain('germany');
 expect(airDestinations(s,'test:de-air',true)).toContain('germany');
 const option=airMoveOptions(s,'germany').find(o=>o.airId==='test:de-air'&&o.regionId==='germany')!;
 const before=s.decks.germany.hand.length;
 const result=transition(s,{type:'MOVE_AIR',seat:'germany',expectedRevision:s.revision,cardId:s.decks.germany.hand[0].id,optionId:option.id});
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.state.units.find(u=>u.id==='test:de-air')?.regionId).toBe('germany');expect(result.state.decks.germany.hand).toHaveLength(before-1);expect(result.state.phase).toBe('DISCARD');
});
it('ordinary play highlights playable cards and active status but not out-of-phase enhancements',()=>{
 const s=responsePreset('keep-calm','availability').state;
 expect(usableStatus(s,s.decks.germany.active.find(c=>c.definitionId==='special_135')!)).toBe(true);
 expect(playableCard(s,s.decks.germany.hand[0])).toBe(true);
 s.viewSeat='united_kingdom';expect(s.decks.united_kingdom.hand.some(c=>playableCard(s,c))).toBe(false);
 s.viewSeat='germany';s.phase='AIR';expect(s.decks.germany.hand.filter(c=>c.definitionId!=='air_power').some(c=>playableCard(s,c))).toBe(false);
});

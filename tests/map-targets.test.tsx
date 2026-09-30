import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGame } from '../src/core';
import { resolveChoice, startResolution } from '../src/core/resolution';
import { resolutionTargets } from '../src/ui/map/targetChoices';
import { TargetPicker } from '../src/ui/map/TargetPicker';

function construction() {
  const state = createGame('map-targets', 1940);
  state.status = 'PLAYING'; state.phase = 'PLAY';
  expect(startResolution(state, '建设测试', 'germany', [{kind:'action', label:'建设陆军', country:'germany', action:'build_army'}], [])).toBe(true);
  return state;
}

describe('map target interaction contract', () => {
  it('projects exact legal construction candidates without placing a unit; confirmation executes the rules', () => {
    const state = construction(), before = structuredClone(state);
    const targets = resolutionTargets(state);
    expect(targets.map(t => t.id)).toEqual(state.resolution!.choice!.options.map(o => o.id));
    expect(targets.some(t => t.regionId === 'eastern_europe')).toBe(true);
    expect(targets.some(t => t.regionId === 'moscow')).toBe(false);
    expect(state).toEqual(before);
    expect(resolveChoice(state, 'germany', state.resolution!.choice!.id, ['eastern_europe'])).toBe(true);
    expect(state.units.some(u => u.country === 'germany' && u.regionId === 'eastern_europe')).toBe(true);
    expect(resolutionTargets(state)).toEqual([]);
  });

  it('does not offer another player’s targets or accept obsolete choice IDs', () => {
    const state = construction();
    state.viewSeat = 'japan';
    expect(resolutionTargets(state)).toEqual([]);
    expect(resolveChoice(state, 'germany', 'obsolete-choice', ['eastern_europe'])).toBe(false);
  });

  it('maps unit choices to their actual locations without confusing national choices with regions', () => {
    const state = construction(), unit = state.units[0];
    state.resolution!.choice = {id:'units',kind:'EXTRA_TARGET',seat:'germany',prompt:'选择目标',min:1,max:3,options:[{id:unit.id,label:'目标部队'},{id:'japan',label:'日本玩家'}]};
    expect(resolutionTargets(state)).toEqual([{id:unit.id,label:'目标部队',regionId:unit.regionId}]);
  });

  it('requires a legal selected region and disambiguates multiple plans before enabling confirmation', () => {
    const options = [{id:'a',label:'方案甲',regionId:'germany'}];
    const render = (region:string|null, candidates=options) => renderToStaticMarkup(<TargetPicker options={candidates} pickedRegion={region} busy={false} onConfirm={()=>{}} onClear={()=>{}} />);
    expect(render(null)).toContain('disabled=""');
    expect(render('moscow')).toContain('disabled=""');
    expect(render('germany')).not.toContain('disabled=""');
    expect(render('germany',[...options,{id:'b',label:'方案乙',regionId:'germany'}])).toContain('此地区有多个方案');
    expect(render('germany',[...options,{id:'b',label:'方案乙',regionId:'germany'}])).toContain('disabled=""');
  });
});

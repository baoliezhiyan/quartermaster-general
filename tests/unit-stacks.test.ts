import { describe,it,expect } from 'vitest';
import { unitStacks } from '../src/ui/map/unitStacks';
import type { Unit } from '../src/core';

describe('map unit stacks',()=>{
  it.each(['army','navy'] as const)('covers same-country %s with air and restores it after air leaves',type=>{
    const base:Unit={id:'base',country:'germany',regionId:'r',type};
    const air:Unit={...base,id:'air',type:'air'};
    const ally:Unit={...base,id:'ally',country:'italy'};
    const units=Object.freeze([Object.freeze(base),Object.freeze(air),Object.freeze(ally)]);
    const stacks=unitStacks(units);
    expect(stacks).toHaveLength(2);
    expect(stacks[0].top.id).toBe('air');
    expect(stacks[0].members.map(u=>u.id)).toEqual(['base','air']);
    expect(unitStacks([base,ally])[0].top.id).toBe('base');
    const moved=unitStacks([base,{...air,regionId:'elsewhere'},ally]);
    expect(moved.find(s=>s.regionId==='r'&&s.country==='germany')?.top.id).toBe('base');
    expect(units).toHaveLength(3);
  });
  it('keeps all countries including independent forces in the detail projection',()=>{
    const units:Unit[]=(['united_kingdom','soviet_union','united_states','france','china'] as const).map(country=>({country,id:country,type:'army',regionId:'r'}));
    expect(unitStacks(units).flatMap(s=>s.members)).toHaveLength(5);
  });
});

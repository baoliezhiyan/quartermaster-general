import type { CountryId, Unit } from '../../core';

export const STACK_COUNTRIES: readonly CountryId[] = ['germany','japan','italy','united_kingdom','soviet_union','united_states','france','china'];
/** Display projection only: keep the complete units for details and supply status. */
export function unitStacks(units: readonly Readonly<Unit>[]) {
  const groups=new Map<string,Readonly<Unit>[]>();
  for(const unit of units){
    const key=`${unit.regionId}:${unit.country}`;
    const group=groups.get(key)??[];group.push(unit);groups.set(key,group);
  }
  return [...groups.entries()].map(([key,members])=>({key,regionId:members[0].regionId,country:members[0].country,
    top:members.find(u=>u.type==='air')??members[0],members,
  })).sort((a,b)=>a.regionId.localeCompare(b.regionId)||STACK_COUNTRIES.indexOf(a.country)-STACK_COUNTRIES.indexOf(b.country));
}

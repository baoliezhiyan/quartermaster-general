import { REGIONS, REGION_BY_ID } from './map';
import {mayPlace} from './neutrality';
import { allianceOf, reserve } from './basic';
import { adjacent, suppliedUnits } from './supply';
import type { CountryId, ReadState } from './types';
import { homeRegion } from './modifiers';

export interface PlacementRequest {
  country: CountryId;
  unitType: 'army' | 'navy';
  mode: 'build' | 'recruit';
  /** Recruit effects supply their allowed regions; an empty list allows nothing. */
  regionIds?: readonly string[];
}
export interface PlacementPlan {
  id: string; regionId: string; label: string;
  mode: 'build' | 'recruit'; unitType: 'army' | 'navy';
  country: CountryId; recycleId?: string; existingId?: string;
}
/** Enumerate complete removal + placement pairs against the post-removal board. */
export function placementPlans(state: ReadState, request: PlacementRequest): PlacementPlan[] {
  const { country, unitType: type, mode } = request;
  const own = state.units.filter(u => u.country === country && u.type === type);
  const stock = reserve(state,country,type), plans: PlacementPlan[] = [];
  for (const recycle of [undefined,...(stock === 0 ? own : [])]) {
    if(recycle&&state.turnFlags?.protected.includes(recycle.id))continue;
    const simulation = { ...state, units:state.units.filter(u => u.id !== recycle?.id) };
    const supplied = suppliedUnits(simulation);
    for (const region of REGIONS) {
      if(!mayPlace(state,country,region.id))continue;
      if (region.type !== (type === 'army' ? 'LAND' : 'SEA')) continue;
      if (request.regionIds && !request.regionIds.includes(region.id) || mode === 'recruit' && !request.regionIds) continue;
      if (simulation.units.some(u => u.regionId === region.id && allianceOf(u.country) !== allianceOf(country))) continue;
      const existing = own.find(u => u.regionId === region.id);
      if (existing && recycle || !existing && !recycle && stock <= 0) continue;
      if (mode === 'build') {
        if (region.id !== homeRegion(simulation,country) && !simulation.units.some(u => u.country === country && u.type !== 'air' && supplied.has(u.id) && adjacent(simulation,country,u.regionId,region.id))) continue;
        const candidate = existing ?? { id:'placement:candidate', country, type, regionId:region.id };
        if (!suppliedUnits({ ...simulation, units:existing ? simulation.units : [...simulation.units,candidate] }).has(candidate.id)) continue;
      }
      plans.push({ id:`${mode}:${region.id}:${recycle?.id ?? ''}`, mode, country, unitType:type, regionId:region.id, recycleId:recycle?.id, existingId:existing?.id,
        label:`${region.name}${existing ? '（原地重复，不消耗储备）' : recycle ? ` · 先回收${REGION_BY_ID[recycle.regionId].name}的部队` : '（使用储备）'}` });
    }
  }
  return plans;
}

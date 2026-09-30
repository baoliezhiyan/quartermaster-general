import { placementPlans } from './placement';
import {mayAttack,mayPlace} from './neutrality';
import { REGIONS, REGION_BY_ID } from './map';
import { adjacent, suppliedUnits } from './supply';
import { allianceOf, COUNTRY_NAMES, reserve } from './basic';
import type { CountryId, ReadState, Unit } from './types';

export interface BasicOption {
  id: string;
  regionId: string;
  label: string;
  mode: 'build' | 'battle' | 'deploy' | 'supremacy' | 'move';
  unitType?: Unit['type'];
  recycleId?: string;
  existingId?: string;
  attackerId?: string;
  defenderId?: string;
  defenderCountry?: CountryId;
  airId?: string;
  intercept?: boolean;
  replacement?:'recruit_army';
}
const regionName = (id: string) => REGION_BY_ID[id].name;
export function buildOptions(state: ReadState, country: CountryId, type: 'army' | 'navy'): BasicOption[] {
  return placementPlans(state,{ country, unitType:type, mode:'build' }).map(p=>({ ...p,mode:'build' as const }));
}
export function battleOptions(state: ReadState, country: CountryId, type: 'LAND' | 'SEA'): BasicOption[] {
  const supplied = suppliedUnits(state), options: BasicOption[] = [];
  for (const region of REGIONS.filter(r => r.type === type)) {
    if (state.units.some(u => u.regionId === region.id && allianceOf(u.country) === allianceOf(country))) continue;
    const targets = state.units.filter(u => u.regionId === region.id && u.type !== 'air');
    for (const defender of targets.length ? targets : [undefined]) {
      if(!mayAttack(state,country,defender?.country))continue;
      for (const attacker of state.units.filter(u => u.country === country && u.type !== 'air' && supplied.has(u.id) && adjacent(state,country,u.regionId,region.id))) {
        const defense = !state.turnFlags?.noAirDefense && defender && state.units.some(u => u.country === defender.country && u.regionId === region.id && u.type === 'air');
        const canIntercept = defense && state.units.some(u => u.country === country && u.regionId === attacker.regionId && u.type === 'air');
        for (const intercept of canIntercept ? [false,true] : [false]) {
          options.push({ id:`battle:${region.id}:${defender?.id ?? ''}:${attacker.id}:${intercept}`, mode:'battle', regionId:region.id, attackerId:attacker.id, defenderId:defender?.id, defenderCountry:defender?.country, intercept,
            label:`${region.name} · ${defender ? `攻击${COUNTRY_NAMES[defender.country]}` : '空地区'} · 从${regionName(attacker.regionId)}发起${defense ? intercept ? ' · 空军拦截' : ' · 不拦截，敌空军防御' : ''}` });
        }
      }
    }
  }
  return options;
}
export function airDestinations(state: ReadState, airId: string, allowStay=false): string[] {
  const air = state.units.find(u => u.id === airId);
  if (!air) return [];
  const supplied = suppliedUnits(state);
  return [...new Set(state.units.filter(u => u.country === air.country && u.type !== 'air' && supplied.has(u.id) && (allowStay||u.regionId !== air.regionId) && !state.units.some(a => a.id!==air.id && a.country === air.country && a.type === 'air' && a.regionId === u.regionId)).map(u => u.regionId))];
}
export function airMoveOptions(state: ReadState, country: CountryId): BasicOption[] {
  return state.units.filter(u => u.country === country && u.type === 'air').flatMap(air => airDestinations(state,air.id,true).map(regionId => ({
    id:`move:${air.id}:${regionId}`, regionId, mode:'move' as const, airId:air.id, label:`${regionName(air.regionId)} → ${regionName(regionId)}`,
  })));
}
export function airPowerOptions(state: ReadState, country: CountryId): BasicOption[] {
  const supplied = suppliedUnits(state), options: BasicOption[] = [];
  if (reserve(state,country,'air') > 0) {
    for (const regionId of new Set(state.units.filter(u => u.country === country && u.type !== 'air' && supplied.has(u.id)).map(u => u.regionId))) {
      if(!mayPlace(state,country,regionId))continue;
      if (state.units.some(u => u.country === country && u.type === 'air' && u.regionId === regionId)) continue;
      options.push({ id:`deploy:${regionId}`, mode:'deploy', regionId, label:`部署空军 · ${regionName(regionId)}` });
    }
  }
  for (const air of state.units.filter(u => u.type === 'air' && u.country === country)) {
    for (const enemy of state.units.filter(u => u.type === 'air' && allianceOf(u.country) !== allianceOf(country) && adjacent(state,country,air.regionId,u.regionId))) {
      if(!mayAttack(state,country,enemy.country))continue;
      options.push({ id:`supremacy:${air.id}:${enemy.id}`, mode:'supremacy', regionId:enemy.regionId, airId:air.id, defenderId:enemy.id, label:`争取制空权 · ${regionName(air.regionId)} → ${regionName(enemy.regionId)}的${COUNTRY_NAMES[enemy.country]}空军` });
    }
  }
  return options;
}
export function cardOptions(state: ReadState, cardId: string): BasicOption[] {
  if (state.status !== 'PLAYING' || state.pendingAir.length || state.pendingDiscard || state.resolution?.running || state.operatorSeat !== state.activeSeat) return [];
  const card = state.decks[state.activeSeat].hand.find(c => c.id === cardId);
  if (!card) return [];
  if (state.phase === 'AIR' && card.definitionId === 'air_power') return airPowerOptions(state,card.country);
  if (state.phase !== 'PLAY') return [];
  switch (card.definitionId) {
    case 'build_army': return buildOptions(state,card.country,'army');
    case 'build_navy': return buildOptions(state,card.country,'navy');
    case 'land_battle': return battleOptions(state,card.country,'LAND');
    case 'sea_battle': return battleOptions(state,card.country,'SEA');
    default: return [];
  }
}

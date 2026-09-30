import {measure} from '../controller/performanceProbe';
import { REGIONS, REGION_BY_ID, MAP, edgeKey } from './map';
import { allianceOf, phaseCountries, COUNTRY_NAMES } from './basic';
import type { Alliance, CountryId, ReadState, SeatId } from './types';
import { hasStatus, homeRegion, alwaysSupplied, supplySource, sharedSupply } from './modifiers';
import type { ModifierState } from './modifiers';

// Derived data never enters saves or network snapshots. Keys include every input
// read by adjacency/supply/scoring, so mutable effects, undo and cloned states work alike.
const pools=new Map<string,MapFacts>();
const LIMIT=64;
let builds=0,hits=0;
type MapFacts={controllers:Record<string,Alliance>;neighbors:Record<CountryId,Record<string,Set<string>>>;supplied:Set<string>;scores:Record<CountryId,number>};
const countries=Object.keys(COUNTRY_NAMES) as CountryId[];
export function resetMapCache(){pools.clear();builds=0;hits=0;}
export function mapCacheStats(){return {builds,hits,entries:pools.size};}
const mapModifiers=new Set([5,6,7,9,10,42,47,48,52,79,91,163,210,211,257].map(id=>`special_${id}`));
function mapKey(s:ModifierState){
 return JSON.stringify([s.units.map(u=>[u.id,u.country,u.type,u.regionId]),
  s.decks?Object.values(s.decks).map(d=>[...d.active,...d.resolving].filter(c=>mapModifiers.has(c.definitionId)).map(c=>[c.id,c.definitionId,c.country])):null,
  s.activeSeat,!!s.rules?.balanceEnabled,s.turnFlags?.suppressed,s.turnFlags?.supplied,s.turnFlags?.supplyCountries,s.turnFlags?.supplyRegions]);
}
function facts(state:ModifierState):MapFacts {
 const key=mapKey(state),cached=pools.get(key);
 if(cached){hits++;pools.delete(key);pools.set(key,cached);return cached;}
 const value=measure('map_rebuild',()=>{
  const controllers=Object.fromEntries(state.units.filter(u=>u.type==='army').map(u=>[u.regionId,allianceOf(u.country)]));
  const adjacency={} as Record<CountryId,Record<string,Set<string>>>;
  for(const alliance of ['axis','allies'] as const){
   const edges=new Set(MAP.baseEdges.map(([a,b])=>edgeKey(a,b)));
   for(const strait of MAP.straits)if((controllers[strait.landRegion]??strait.defaultController)===alliance)edges.add(edgeKey(strait.seaA,strait.seaB));
   const set=(a:string,b:string,on:boolean)=>{if(on)edges.add(edgeKey(a,b));else edges.delete(edgeKey(a,b));};
   if(hasStatus(state,210)&&alliance==='axis'){set('middle_east','balkans',true);set('sea_black','sea_mediterranean',true);}
   if(hasStatus(state,211))set('sea_north_sea','sea_mediterranean',alliance==='axis');
   if(state.rules?.balanceEnabled&&hasStatus(state,163))set('sea_baltic','sea_north_sea',alliance==='axis');
   if(state.rules?.balanceEnabled&&hasStatus(state,211))set('western_europe','north_africa',alliance==='axis');
   if(hasStatus(state,257)){if(alliance==='allies')set('north_africa','middle_east',false);set('sea_mediterranean','sea_arabian',alliance==='axis');}
   const graph=Object.fromEntries(REGIONS.map(r=>[r.id,new Set<string>()]));
   for(const edge of edges){const [a,b]=edge.split('|');graph[a].add(b);graph[b].add(a);}
   for(const country of countries.filter(c=>allianceOf(c)===alliance))adjacency[country]=graph;
  }
  const linked=(c:CountryId,a:string,b:string)=>adjacency[c][a]?.has(b)??false;
  return {controllers,neighbors:adjacency,supplied:calculateSupply(state,linked),scores:Object.fromEntries(countries.map(c=>[c,calculateScore(state,c)])) as Record<CountryId,number>};
 });
 builds++;pools.set(key,value);if(pools.size>LIMIT)pools.delete(pools.keys().next().value!);return value;
}
export function landControllers(state:Pick<ReadState,'units'>):Record<string,Alliance>{return {...facts(state).controllers};}
export function adjacent(state:ModifierState,country:CountryId,a:string,b:string):boolean{return facts(state).neighbors[country][a]?.has(b)??false;}
export function adjacentRegions(state:ModifierState,country:CountryId,region:string,include=false):string[]{
 const graph=facts(state).neighbors[country];return REGIONS.filter(r=>include&&r.id===region||graph[region]?.has(r.id)).map(r=>r.id);
}
// Copy the public Set: callers cannot accidentally poison shared derived data.
export function suppliedUnits(state:ModifierState):Set<string>{return new Set(facts(state).supplied);}
/** Least fixed point: unseeded cycles never supply themselves. Navy conditions are AND. */
function calculateSupply(state: ModifierState,linkedRegions:(country:CountryId,a:string,b:string)=>boolean): Set<string> {
  const bases = state.units.filter(u => u.type !== 'air');
  const supplied = new Set(bases.filter(u => state.turnFlags?.supplied.includes(u.id) || state.turnFlags?.supplyCountries.includes(u.country) || state.turnFlags?.supplyRegions.includes(`${u.country}:${u.regionId}`) || alwaysSupplied(state,u.country,u.type) || u.type === 'army' && supplySource(state,u.country,u.regionId,!!REGION_BY_ID[u.regionId]?.supply)).map(u => u.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of bases) {
      if (supplied.has(unit.id)) continue;
      const linked = bases.some(other => sharedSupply(state,unit.country,other.country) && supplied.has(other.id) && (linkedRegions(unit.country,unit.regionId,other.regionId) || other.country!==unit.country && other.regionId===unit.regionId));
      const armyAnchor = unit.type === 'army' || bases.some(other => other.type === 'army' && allianceOf(other.country) === allianceOf(unit.country) && linkedRegions(unit.country,unit.regionId,other.regionId));
      if (linked && armyAnchor) { supplied.add(unit.id); changed = true; }
    }
  }
  for (const air of state.units.filter(u => u.type === 'air')) {
    if (state.turnFlags?.supplied.includes(air.id) || alwaysSupplied(state,air.country,air.type) || bases.some(base => base.country === air.country && base.regionId === air.regionId && supplied.has(base.id))) supplied.add(air.id);
  }
  return supplied;
}
export function unsuppliedForPhase(state: ReadState, seat: SeatId): string[] {
  const countries = phaseCountries(seat), supplied = suppliedUnits(state);
  // One snapshot for every country in this phase, before any removals.
  return state.units.filter(u => countries.includes(u.country) && !supplied.has(u.id)).map(u => u.id);
}
export function countryScore(state:ReadState,country:CountryId):number{return facts(state).scores[country];}
function calculateScore(state: ModifierState, country: CountryId): number {
  const home = REGION_BY_ID[homeRegion(state,country)];
  const armies = state.units.filter(u => u.type === 'army');
  if (armies.some(u => u.regionId === home.id && allianceOf(u.country) !== allianceOf(country))) return 0;
  return REGIONS.filter(r => !(r.id==='moscow'&&hasStatus(state,42)) && !(r.id==='ukraine'&&(allianceOf(country)==='axis'||state.rules?.balanceEnabled)&&hasStatus(state,48)) && (r.supply || r.id==='siberia'&&hasStatus(state,42) || !state.rules?.balanceEnabled&&country==='china'&&r.id==='western_china'&&hasStatus(state,91))).reduce((sum,r) => {
    const occupants = armies.filter(u => u.regionId === r.id);
    if (!occupants.some(u => u.country === country)) return sum;
    return sum + (occupants.some(u => u.country !== country && allianceOf(u.country) === allianceOf(country)) ? 1 : 2);
  },0);
}
export function allianceScores(state: Pick<ReadState, 'scores' | 'axisBonus'>): Record<Alliance, number> {
  return Object.entries(state.scores).reduce((totals,[seat,score]) => {
    totals[allianceOf(seat as SeatId)] += score;
    return totals;
  },{ axis:state.axisBonus, allies:0 });
}

import type {ReadState,CountryId} from '../core/types';
import {REGIONS} from '../core/map';
import {COUNTRY_NAMES,reserve,allianceOf,seatOf} from '../core/basic';
import {adjacentRegions,suppliedUnits,landControllers,countryScore} from '../core/supply';
import {homeRegion,supplySource,alwaysSupplied,sharedSupply,hasStatus} from '../core/modifiers';
/** Only the formal public player projection is accepted here; no rule algorithms. */
export function mapFacts(s:ReadState){
 const countries=Object.keys(COUNTRY_NAMES) as CountryId[],supplied=suppliedUnits(s),controllers=landControllers(s);
 return {landControllers:controllers,countries:Object.fromEntries(countries.map(country=>[country,{
  name:COUNTRY_NAMES[country],seat:seatOf(country),alliance:allianceOf(country),homeRegion:homeRegion(s,country),
  boardScore:countryScore(s,country),
  homeOccupied:!!controllers[homeRegion(s,country)]&&controllers[homeRegion(s,country)]!==allianceOf(country),
  // Of the valid supply sources, only printed points, relocated Moscow and
  // original-rule Chinese Western China are also terrain scoring sites.
  scoringRegions:REGIONS.filter(r=>supplySource(s,country,r.id,r.supply)&&
    (r.supply||r.id==='siberia'&&hasStatus(s,42)||r.id==='western_china'&&country==='china'&&!s.rules?.balanceEnabled&&hasStatus(s,91))).map(r=>r.id),
  supplySources:REGIONS.filter(r=>supplySource(s,country,r.id,r.supply)).map(r=>r.id),
  alwaysSupplied:Object.fromEntries((['army','navy','air'] as const).map(type=>[type,alwaysSupplied(s,country,type)])),
  sharesSupplyWith:countries.filter(other=>sharedSupply(s,country,other)),
  adjacency:Object.fromEntries(REGIONS.map(r=>[r.id,adjacentRegions(s,country,r.id)])),
  reserve:Object.fromEntries((['army','navy','air'] as const).map(type=>[type,reserve(s,country,type)])),
 } ])),units:s.units.map(u=>({...u,supplied:supplied.has(u.id)})),temporarySupply:{units:s.turnFlags?.supplied??[],countries:s.turnFlags?.supplyCountries??[],regions:s.turnFlags?.supplyRegions??[]}};
}

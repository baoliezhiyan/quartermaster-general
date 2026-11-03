import type {ReadState,CountryId} from '../core/types';
import {REGIONS} from '../core/map';
import {COUNTRY_NAMES,reserve,allianceOf,seatOf} from '../core/basic';
import {adjacentRegions,suppliedUnits,landControllers} from '../core/supply';
import {homeRegion,supplySource,alwaysSupplied,sharedSupply} from '../core/modifiers';
/** Only the formal public player projection is accepted here; no rule algorithms. */
export function mapFacts(s:ReadState){
 const countries=Object.keys(COUNTRY_NAMES) as CountryId[],supplied=suppliedUnits(s);
 return {landControllers:landControllers(s),countries:Object.fromEntries(countries.map(country=>[country,{
  name:COUNTRY_NAMES[country],seat:seatOf(country),alliance:allianceOf(country),homeRegion:homeRegion(s,country),
  supplySources:REGIONS.filter(r=>supplySource(s,country,r.id,r.supply)).map(r=>r.id),
  alwaysSupplied:Object.fromEntries((['army','navy','air'] as const).map(type=>[type,alwaysSupplied(s,country,type)])),
  sharesSupplyWith:countries.filter(other=>sharedSupply(s,country,other)),
  adjacency:Object.fromEntries(REGIONS.map(r=>[r.id,adjacentRegions(s,country,r.id)])),
  reserve:Object.fromEntries((['army','navy','air'] as const).map(type=>[type,reserve(s,country,type)])),
 } ])),units:s.units.map(u=>({...u,supplied:supplied.has(u.id)})),temporarySupply:{units:s.turnFlags?.supplied??[],countries:s.turnFlags?.supplyCountries??[],regions:s.turnFlags?.supplyRegions??[]}};
}

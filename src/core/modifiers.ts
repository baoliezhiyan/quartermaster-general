import type { CountryId, ReadState } from './types';

export type ModifierState = Pick<ReadState,'units'> & Partial<Pick<ReadState,'decks'|'activeSeat'|'turnFlags'|'rules'>>;
const axis=(country:CountryId)=>['germany','italy','japan'].includes(country);
/** A resolving status retains its continuous rules until its actual final move. */
export function hasStatus(s:ModifierState,index:number):boolean {
  if(!s.decks) return false;
  const cards=Object.values(s.decks).flatMap(d=>[...d.active,...d.resolving]);
  const card=cards.find(c=>c.definitionId===`special_${index}`);
  if(!card)return false;
  if(s.turnFlags?.suppressed.includes(card.id))return false;
  if(axis(card.country) && s.activeSeat==='united_kingdom' && cards.some(c=>c.definitionId==='special_6'))return false;
  return true;
}
export function homeRegion(s:ModifierState,country:CountryId):string {
  const homes:Record<CountryId,string>={germany:'germany',united_kingdom:'british_isles',japan:'japan',soviet_union:'moscow',italy:'italy',united_states:'united_states',china:'eastern_china',france:'western_europe'};
  if(country==='soviet_union' && hasStatus(s,42))return 'siberia';
  if(country==='france' && hasStatus(s,5) && s.units.some(u=>u.type==='army'&&u.regionId==='western_europe'&&axis(u.country)))return 'british_isles';
  return homes[country];
}
export function alwaysSupplied(s:ModifierState,country:CountryId,type:string):boolean {
  return country==='france'&&hasStatus(s,9) || country==='soviet_union'&&type==='army'&&hasStatus(s,47) || country==='china'&&hasStatus(s,52);
}
export function supplySource(s:ModifierState,country:CountryId,id:string,printed:boolean):boolean {
  if(id==='moscow' && hasStatus(s,42))return false;
  if(id==='ukraine' && (axis(country)||s.rules?.balanceEnabled) && hasStatus(s,48))return false;
  return printed || id==='siberia'&&hasStatus(s,42)
    || country==='united_kingdom'&&id==='eastern_europe'&&hasStatus(s,7)
    || country==='france'&&id==='south_africa'&&hasStatus(s,10)
    || country==='china'&&id==='western_china'&&hasStatus(s,91);
}
export function sharedSupply(s:ModifierState,a:CountryId,b:CountryId):boolean {
  return a===b || (hasStatus(s,79)&&!s.rules?.balanceEnabled) && ['united_states','united_kingdom','france'].includes(a) && ['united_states','united_kingdom','france'].includes(b);
}

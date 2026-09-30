import {useId} from 'react';
import type {CountryId,Unit} from '../core';
import {COUNTRY_NAMES,UNIT_NAMES} from '../core/basic';
export function UnitArt({country,type,size=36,x,y}:{country:CountryId;type:Unit['type'];size?:number;x?:number;y?:number}){
 const clip=useId().replace(/:/g,'');
 if(country==='china'&&type==='navy')return null;
 return <svg className="unit-art" x={x} y={y} width={size} height={size} viewBox="0 0 500 500" role="img" aria-label={COUNTRY_NAMES[country]+UNIT_NAMES[type]}><title>{COUNTRY_NAMES[country]+UNIT_NAMES[type]}</title><defs><clipPath id={clip}><path d="M250 0 A250 250 0 1 1 250 500 A250 250 0 1 1 250 0 Z"/></clipPath></defs><image href={'/assets/units/'+country+'-'+type+'.png'} width="500" height="500" clipPath={'url(#'+clip+')'}/></svg>;
}

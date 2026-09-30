import {specialCard} from './cardCatalog';
const basic=new Set(['build_army','build_navy','land_battle','sea_battle','air_power']);
const compare=(a:string,b:string)=>a.localeCompare(b,'en',{numeric:true});
export const compareCardIdentity=(a:{definitionId:string;id:string},b:{definitionId:string;id:string})=>compare(a.definitionId,b.definitionId)||compare(a.id,b.id);
/** Display order only: never mutate a pile, membership, or the user's selected order. */
export function sortCardChoices<T extends {id:string;label:string}>(options:readonly T[]):T[]{
 const isCard=(o:T)=>basic.has(o.label)||!!specialCard(o.label,true);
 const sorted=options.filter(isCard).sort((a,b)=>compare(a.label,b.label)||compare(a.id,b.id));
 let index=0;return options.map(o=>isCard(o)?sorted[index++]:o);
}

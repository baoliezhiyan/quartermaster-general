import { REGIONS } from './map';
import { COUNTRY_NAMES, BASIC_NAMES, UNIT_NAMES } from './basic';
export const ACTION_NAMES:Record<string,string>={...BASIC_NAMES,recruit_army:'征召陆军',recruit_navy:'征召海军',air_deploy:'部署空军',air_move:'调度空军',destroy:'消灭部队'};
export function effectText(text:string):string {
  let result=text;
  for(const [id,name] of Object.entries({...Object.fromEntries(REGIONS.map(r=>[r.id,r.name])),...COUNTRY_NAMES,...ACTION_NAMES,...UNIT_NAMES}).sort((a,b)=>b[0].length-a[0].length))result=result.split(id).join(name);
  return result;
}

/** Country is the unit allegiance, not necessarily the player choosing the action. */
export function countryActionName(country:keyof typeof COUNTRY_NAMES,action:string):string {
 const name=COUNTRY_NAMES[country],label=ACTION_NAMES[action]??action;
 if(action==='destroy')return `${name}：消灭敌方部队`;
 if(['land_battle','sea_battle'].includes(action))return `${name}部队${label}`;
 return label.replace('陆军',name+'陆军').replace('海军',name+'海军').replace('空军',name+'空军');
}

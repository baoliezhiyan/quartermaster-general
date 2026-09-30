import {REGION_BY_ID} from './map';
import {adjacent,suppliedUnits} from './supply';
import {allianceOf} from './basic';
import {distanceWithin} from './fullCardEffects';
import type { ReadState, CardInstance } from './types';
import type { Effect } from './resolutionTypes';
import { hasStatus } from './modifiers';

export function statusActionEffects(s:ReadState,card:CardInstance):Effect[] {
  const id=Number(card.definitionId.replace('special_',''));
  if(s.activeSeat!==card.deckOwner||!hasStatus(s,id))return [];
  if(s.phase!=='PLAY')return [];
  const action=(action:'land_battle'|'build_army'|'recruit_army',regions?:string[]):Effect=>({kind:'action',country:card.country,action,regions,label:action});
  const pay:Effect={kind:'cards',seat:card.deckOwner,from:'hand',to:'discardPile',min:2,max:2,fee:true,label:'支付两张手牌（费用）'};
  const top:Effect={kind:'deckTop',seat:card.deckOwner,count:2,fee:true,label:'弃置牌库顶两张牌（费用）'};
  if(s.rules?.balanceEnabled&&id===163){const navy=s.units.find(u=>u.country==='germany'&&u.type==='navy'&&u.regionId==='sea_baltic');if(!navy)return [];return [{...top,count:2+(s.units.some(u=>u.type==='army'&&u.regionId==='scandinavia'&&allianceOf(u.country)==='allies')?1:0)},{kind:'action',country:'germany',action:'sea_battle',boundAttackerId:navy.id,label:'以波罗的海德国海军发起海战'}];}
  switch(id){
    case 1:return [pay,action('land_battle',['western_europe','italy'])];
    case 7:return [action('recruit_army',['eastern_europe'])];
    case 10:return [action('recruit_army',['south_africa'])];
    case 46:return [pay,{kind:'extraPlay',seat:card.deckOwner,from:'discardPile',filter:'build_army',label:'打出弃牌堆的一张建设陆军'}];
    case 52:return [action('recruit_army',['western_china','eastern_china','mongolia'])];
    case 91:return [action('recruit_army',s.rules?.balanceEnabled?['western_china','eastern_china']:['western_china'])];
    case 135:return [top,action('build_army')];
    case 215:return [top,action('land_battle')];
    default:return [];
  }
}

export function kamikazeEffects(s:ReadState,card:CardInstance):Effect[] {
   const supply=suppliedUnits(s),planes=s.units.filter(u=>u.country==='japan'&&u.type==='air'&&supply.has(u.id)&&s.units.some(v=>v.type!=='air'&&allianceOf(v.country)==='allies'&&adjacent(s,'japan',u.regionId,v.regionId)&&!distanceWithin(s,'japan','moscow',v.regionId,1)&&!distanceWithin(s,'japan','united_states',v.regionId,1)));
   return [{kind:'choose',seat:card.deckOwner,min:1,max:1,label:'选择移除的补给中日本空军',options:planes.map(unit=>({id:unit.id,label:REGION_BY_ID[unit.regionId].name,effects:[{kind:'remove' as const,unit:{...unit},supplied:true,cause:'card',fee:true,label:'移除日本空军'},{kind:'action' as const,country:'japan' as const,action:'destroy' as const,destroyTypes:['army','navy'] as const,targetIds:s.units.filter(v=>v.type!=='air'&&allianceOf(v.country)==='allies'&&adjacent(s,'japan',unit.regionId,v.regionId)&&!distanceWithin(s,'japan','moscow',v.regionId,1)&&!distanceWithin(s,'japan','united_states',v.regionId,1)).map(v=>v.id),label:'消灭相邻的同盟国部队'}]}))}];
}

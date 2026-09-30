import {fact} from './factObserver';
import { airMoveOptions, airPowerOptions, battleOptions } from './actions';
import type { BasicOption } from './actions';
import { placementPlans } from './placement';
import { allianceOf, COUNTRY_NAMES, UNIT_NAMES } from './basic';
import { REGION_BY_ID } from './map';
import type { GameState, ReadState } from './types';
import type { Effect } from './resolutionTypes';
import { hasStatus } from './modifiers';

export type BoardEffect=Extract<Effect,{kind:'action'}>;
export function boardOptions(s:ReadState,e:BoardEffect):BasicOption[] {
  let options:BasicOption[]=[];
  if(e.action==='build_army' || e.action==='build_navy' || e.action==='recruit_army' || e.action==='recruit_navy') {
    options=placementPlans(s,{country:e.country,unitType:e.action.endsWith('army')?'army':'navy',mode:e.action.startsWith('recruit')?'recruit':'build',regionIds:e.regions}).map(p=>({...p,mode:'build' as const}));
  } else if(e.action==='land_battle' || e.action==='sea_battle') options=battleOptions(s,e.country,e.action==='land_battle'?'LAND':'SEA');
  else if(e.action==='air_move') options=airMoveOptions(s,e.country);
  else if(e.action==='air_power' || e.action==='air_deploy') options=airPowerOptions(s,e.country).filter(o=>e.action!=='air_deploy' || o.mode==='deploy');
  else options=s.units.filter(u=>(e.destroyTypes??['army']).includes(u.type) && allianceOf(u.country)!==allianceOf(e.country)).map(u=>({id:`destroy:${u.id}`,mode:'battle',regionId:u.regionId,defenderId:u.id,label:`消灭${REGION_BY_ID[u.regionId].name}的${COUNTRY_NAMES[u.country]}${UNIT_NAMES[u.type]}`}));
  if(e.action==='build_army'&&e.country==='united_kingdom')for(const [id,region] of [[2,'australia'],[8,'india']] as const) {
    if(hasStatus(s,id))options.push(...placementPlans(s,{country:e.country,unitType:'army',mode:'recruit',regionIds:[region]}).map(p=>({...p,mode:'build' as const,replacement:'recruit_army' as const,label:`以征召代替建设 · ${p.label}`})));
  }
  return options.filter(o=>(!e.airMode||o.mode===e.airMode) && (!e.boundAttackerId||o.attackerId===e.boundAttackerId) && (!e.newOnly || !s.units.some(u=>u.country===e.country&&u.type===o.unitType&&u.regionId===o.regionId)) && (o.replacement || !e.regions || e.regions.includes(o.regionId)) && (!e.targetIds || !!o.defenderId && e.targetIds.includes(o.defenderId)));
}
function remove(s:GameState,id:string) {
  const u=s.units.find(u=>u.id===id); if(!u) return;
  s.units=s.units.filter(u=>u.id!==id);
  fact(s,'unit_removed','移除部队',{unit:u});
  if(u.type!=='air' && !s.units.some(b=>b.country===u.country && b.regionId===u.regionId && b.type!=='air')) s.pendingAir.push(...s.units.filter(a=>a.type==='air' && a.country===u.country && a.regionId===u.regionId && !s.pendingAir.includes(a.id)).map(a=>a.id));
}
export function applyBoardEffect(s:GameState,e:BoardEffect,queueRemoval?:(id:string)=>void):boolean {
  const o=boardOptions(s,e).find(o=>o.id===e.option?.id); if(!o) return false;
  e.option=o;
  if(o.replacement)e.action=o.replacement;
  const eliminate=(id:string)=>queueRemoval?queueRemoval(id):remove(s,id);
  const newId=()=>`unit:${s.revision}:${++s.resolution!.serial}`;
  if(o.mode==='build') {
    if(o.recycleId) remove(s,o.recycleId);
    const old=s.units.find(u=>u.country===e.country && u.type===o.unitType && u.regionId===o.regionId);
    const id=old?.id??newId();e.resultUnitId=id;
    if(!old) s.units.push({id,country:e.country,type:o.unitType!,regionId:o.regionId});
    s.events.push({type:'UNIT_PLACED',revision:s.revision,mode:e.action.startsWith('recruit')?'recruit':'build',country:e.country,unitId:id,regionId:o.regionId,repeated:!!old});
    // Preserve full plan metadata for consumers of the construction event.
    e.option=o;
    fact(s,e.action.startsWith('recruit')?'unit_recruited':'unit_built','部队进入地图',{country:e.country,option:o,unitId:id});
  } else if(o.mode==='deploy'){const unit={id:newId(),country:e.country,type:'air' as const,regionId:o.regionId};s.units.push(unit);fact(s,'unit_built','部署空军',{unit});}
  else if(o.mode==='move'){const unit=s.units.find(u=>u.id===o.airId)!,from=unit.regionId;unit.regionId=o.regionId;fact(s,'unit_moved','调度空军',{unit,from});}
  else if(o.mode==='supremacy') eliminate(o.defenderId!);
  else if(o.defenderId) {
    const defender=s.units.find(u=>u.id===o.defenderId)!;
    const defense=e.action==='destroy'||s.turnFlags?.noAirDefense||e.airDefense===false?undefined:s.units.find(u=>u.type==='air' && u.country===defender.country && u.regionId===defender.regionId);
    if(defense) {
      eliminate(defense.id);
      if(!o.intercept) return true;
      const attacker=s.units.find(u=>u.id===o.attackerId)!;
      const air=s.units.find(u=>u.type==='air' && u.country===e.country && u.regionId===attacker.regionId)!;
      eliminate(air.id);
    }
    eliminate(defender.id);
  }
  return true;
}

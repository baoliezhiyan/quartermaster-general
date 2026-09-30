import type { Command, ReadState } from '../../core';
import { REGION_BY_ID } from '../../core/map';
import { boardOptions } from '../../core/boardEffects';

export interface MapTarget { id: string; label: string; regionId: string }
export interface MapAction { key: string; prompt: string; options: (MapTarget & { command: Exclude<Command, { type: 'CREATE_GAME' }> })[]; customPrompt?:boolean; onRegion?:(id:string|null)=>void; onUnit?:(id:string)=>void; unitIds?:string[]; selectedRegion?:string|null; selectedUnitIds?:string[] }

/** Project only candidates offered by the current rules request onto the map. */
export function resolutionTargets(state: ReadState): MapTarget[] {
  const r = state.resolution, choice = r?.choice;
  if (!r?.running || !choice || choice.seat !== state.viewSeat) return [];
  if (!['ACTION', 'RELOCATE', 'EXTRA_TARGET','BUILD_ORDER'].includes(choice.kind)) return [];
  const frame = r.frames.find(f => f.id === choice.frameId);
  const effect = frame?.effects[frame.nextEffectIndex];
  const options = effect?.kind === 'action' && choice.field === 'option' ? boardOptions(state, { ...effect, regions:effect.regions ? [...effect.regions] : undefined, targetIds:effect.targetIds ? [...effect.targetIds] : undefined }) : [];
  return choice.options.flatMap(o => {
    const regionId = choice.kind==='BUILD_ORDER'?o.id.split('|')[1]:choice.kind === 'RELOCATE' || choice.field === 'regionId' ? o.id
      : state.units.find(u => u.id === o.id)?.regionId ?? options.find(v => v.id === o.id)?.regionId;
    return regionId && REGION_BY_ID[regionId] ? [{ ...o, regionId }] : [];
  });
}

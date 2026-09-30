import type { SeatId } from './types';

/** Frozen v0.3 PPO event curriculum; IDs, never card-name matching, define membership. */
export const TRAINING_EVENT_IDS_BY_SEAT: Record<SeatId,readonly string[]> = {
  germany:[166,154,155,152,150,158,162,161,160,159,157,156].map(n=>`special_${n}`),
  united_kingdom:[21,20,24,23,35,34,33,32,22,27,28,30,31].map(n=>`special_${n}`),
  japan:[],
  soviet_union:[61,64,65,113,68,69,66,63,67,62].map(n=>`special_${n}`),
  italy:[253,237,235,240,239,238,234,233,232,231].map(n=>`special_${n}`),
  united_states:[115,109,114,255,108,107,98,97,95,94,93,111,110].map(n=>`special_${n}`),
};
export const TRAINING_EVENT_IDS = new Set(Object.values(TRAINING_EVENT_IDS_BY_SEAT).flat());
export const TRAINING_COURSE_VERSION='ppo-events-v1';
export const TRAINING_OVERRIDES_VERSION='ppo-event-overrides-v1';

export const openSpecialCount=(remaining:number)=>remaining===0?0:Math.min(remaining,Math.max(6,Math.ceil(remaining*0.6)));
export const basicOpenProbability=(remaining:number)=>remaining>=4?1:remaining===3?0.9:remaining===2?0.7:remaining===1?0.4:0;

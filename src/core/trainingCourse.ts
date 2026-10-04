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

/** A2S1 adds only these balanced status/response cards (plus Steel Pact). */
export const TRAINING_SIGNAL_IDS_BY_SEAT:Record<SeatId,readonly string[]>={
  germany:[139,137,136,135,134,131,130,129,163].map(n=>`special_${n}`),
  united_states:[80,78,79,89,88,86,84,83].map(n=>`special_${n}`),
  japan:[201,200,199,198,197,196,195,194,193,192,177,176,175,174,190,189,188,183,184,187,185,186,171,172,173,178,249].map(n=>`special_${n}`),
  soviet_union:[58,55,44,52,42,50,59,60,56,54,57,43,46,48,47,51,45].map(n=>`special_${n}`),
  italy:[223,222,221,216,217,215,214,213,219,218,212,227].map(n=>`special_${n}`),
  united_kingdom:[17,11,16,12,14,2,8,3,1,4,18,19,5,9,10,7].map(n=>`special_${n}`),
};
export const TRAINING_A2S1_IDS_BY_SEAT:Record<SeatId,readonly string[]>=Object.fromEntries(
  Object.keys(TRAINING_EVENT_IDS_BY_SEAT).map(seat=>[seat,[...TRAINING_EVENT_IDS_BY_SEAT[seat as SeatId],
    ...TRAINING_SIGNAL_IDS_BY_SEAT[seat as SeatId]]])) as unknown as Record<SeatId,readonly string[]>;
export const TRAINING_A2S1_IDS=new Set(Object.values(TRAINING_A2S1_IDS_BY_SEAT).flat());
export const TRAINING_A2S1_COURSE_VERSION='ppo-signals-a2s1-v2';
export const TRAINING_A2S1_OVERRIDES_VERSION='ppo-signals-a2s1-overrides-v2';

export const openSpecialCount=(remaining:number)=>remaining===0?0:Math.min(remaining,Math.max(6,Math.ceil(remaining*0.6)));
export const basicOpenProbability=(remaining:number)=>remaining>=4?1:remaining===3?0.9:remaining===2?0.7:remaining===1?0.4:0;

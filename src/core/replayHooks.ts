import type {GameState} from './types';
export type ReplayBoundary='formal_start'|'round_end';
export interface ReplayHooks {
 boundary?:(s:GameState,boundary:ReplayBoundary,completedRound:number)=>boolean;
 shuffle?:(items:unknown[],s:Pick<GameState,'randomState'>)=>boolean;
}
let hooks:ReplayHooks|undefined;
export function withReplayHooks<T>(value:ReplayHooks,run:()=>T):T {
 if(hooks)throw Error('回放钩子不得嵌套');hooks=value;try{return run();}finally{hooks=undefined;}
}
export const replayBoundary=(s:GameState,b:ReplayBoundary,n:number)=>hooks?.boundary?.(s,b,n)??false;
export const injectReplayShuffle=(items:unknown[],s:Pick<GameState,'randomState'>)=>hooks?.shuffle?.(items,s)??false;
/** Unit identity must not depend on network revisions or viewing another seat. */
export function nextUnitId(s:GameState):string {
 let id:string;do{id=`unit:stable:${s.unitSerial=(s.unitSerial??0)+1}`;}while(s.units.some(u=>u.id===id));return id;
}

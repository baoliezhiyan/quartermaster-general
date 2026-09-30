import type {GameState} from './types';
export interface FactBoundary {code:string;text:string;details?:unknown;random?:{before:number;after:number;input:unknown[];output:unknown[]};}
type Listener=(state:GameState,boundary:FactBoundary)=>void;
let listener:Listener|undefined;
/** Synchronous transaction-local observation only. Never changes rules or RNG. */
export function observeFacts<T>(sink:Listener,run:()=>T):T{if(listener)throw Error('记录事务不能嵌套');listener=sink;try{return run();}finally{listener=undefined;}}
export function fact(s:GameState,code:string,text:string,details?:unknown){listener?.(s,{code,text,details});}
export function randomFact(s:Pick<GameState,'randomState'>,before:number,input:unknown[],output:unknown[]){if(listener&&'decks'in s)listener(s as GameState,{code:'random_resolved',text:'随机排列结果',random:{before,after:s.randomState,input,output}});}
export const recordingFacts=()=>!!listener;

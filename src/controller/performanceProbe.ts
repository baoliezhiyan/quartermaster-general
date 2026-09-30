export type PerformanceSample={name:string;ms:number;bytes?:number};
let sink:((sample:PerformanceSample)=>void)|undefined;
/** Opt-in diagnostics only; records timings and sizes, never game contents. */
export function setPerformanceSink(next:typeof sink){sink=next;}
export function measure<T>(name:string,run:()=>T):T {
 if(!sink)return run();const start=performance.now();try{return run();}finally{sink({name,ms:performance.now()-start});}
}
export async function measureAsync<T>(name:string,run:()=>Promise<T>):Promise<T>{
 if(!sink)return run();const start=performance.now();try{return await run();}finally{sink({name,ms:performance.now()-start});}
}

export function recordPerformance(sample:PerformanceSample){sink?.(sample);}

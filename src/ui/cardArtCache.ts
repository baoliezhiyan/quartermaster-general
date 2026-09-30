/** Only public artwork is persisted; game state and private card choices never enter this cache. */
export function createCardArtCache() {
 const loaded=new Map<string,string>(),pending=new Map<string,Promise<string>>();
 return {
  peek:(src:string)=>loaded.get(src),
  load(src:string):Promise<string> {
   if(loaded.has(src))return Promise.resolve(loaded.get(src)!);
   if(pending.has(src))return pending.get(src)!;
   const task=(async()=>{
    let cache:Cache|undefined;
    try{cache=await globalThis.caches?.open('qm-card-art-v1');}catch{/* Private browsing or quota restrictions. */}
    let response:Response|undefined;
    try{response=await cache?.match(src);}catch{/* Fall back to normal HTTP caching. */}
    if(!response){
     response=await fetch(src,{cache:'force-cache'});
     if(!response.ok||!response.headers.get('content-type')?.startsWith('image/'))throw new Error('Card artwork unavailable');
     try{await cache?.put(src,response.clone());}catch{/* Disk full must not prevent displaying cards. */}
    }
    const url=URL.createObjectURL(await response.blob());
    loaded.set(src,url);
    return url;
   })().finally(()=>pending.delete(src));
   pending.set(src,task);return task;
  },
 };
}
// One blob per artwork for this page, shared by every copy of that card, including remounts.
export const cardArtCache=createCardArtCache();

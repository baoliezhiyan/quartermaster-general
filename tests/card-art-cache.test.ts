import {afterEach,it,expect,vi} from 'vitest';
import {createCardArtCache} from '../src/ui/cardArtCache';
import {cardArt} from '../src/ui/cardArt';
afterEach(()=>vi.unstubAllGlobals());
it('deduplicates simultaneous artwork requests and reuses memory and persistent cache across page loads',async()=>{
 const disk=new Map<string,Response>();
 const cache={match:vi.fn(async(src:string)=>disk.get(src)?.clone()),put:vi.fn(async(src:string,r:Response)=>{disk.set(src,r);})};
 vi.stubGlobal('caches',{open:async()=>cache});
 const fetcher=vi.fn(async()=>new Response('image',{headers:{'content-type':'image/png'}}));vi.stubGlobal('fetch',fetcher);
 const a=createCardArtCache(),src='/assets/card-art/test.png?v=one';
 const [first,second]=await Promise.all([a.load(src),a.load(src)]);
 expect(first).toBe(second);expect(a.peek(src)).toBe(first);await a.load(src);expect(fetcher).toHaveBeenCalledTimes(1);
 const b=createCardArtCache();await b.load(src);expect(fetcher).toHaveBeenCalledTimes(1);
 await b.load('/assets/card-art/test.png?v=two');expect(fetcher).toHaveBeenCalledTimes(2);
 URL.revokeObjectURL(first);URL.revokeObjectURL(b.peek(src)!);URL.revokeObjectURL(b.peek('/assets/card-art/test.png?v=two')!);
});
it('remains usable when persistent storage is denied and retries failed image requests',async()=>{
 vi.stubGlobal('caches',{open:async()=>{throw Error('denied');}});
 const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:500})).mockImplementation(async()=>new Response('image',{headers:{'content-type':'image/png'}}));vi.stubGlobal('fetch',fetcher);
 const cache=createCardArtCache();await expect(cache.load('/test')).rejects.toThrow();
 const url=await cache.load('/test');expect(url).toMatch(/^blob:/);expect(fetcher).toHaveBeenCalledTimes(2);URL.revokeObjectURL(url);
});
it('versions card artwork by content rather than game state or release number',()=>{
 const first=cardArt({definitionId:'build_army',country:'germany'});
 expect(first.src).toMatch(/\?v=[a-f0-9]{64}$/);
 expect(cardArt({definitionId:'build_army',country:'germany'}).src).toBe(first.src);
});

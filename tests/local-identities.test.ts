import {it,expect} from 'vitest';
import {normalizeIdentities,identityLifetime} from '../src/ui/localIdentities';
it('expires at 48 hours and orders by creation rather than last connection',()=>{
 const now=identityLifetime+100,id=(n:string,createdAt:number)=>({id:n,name:n,token:n,createdAt});
 expect(normalizeIdentities([id('old',100),id('recent',now-1),id('earlier',now-10)],now).map(i=>i.id)).toEqual(['recent','earlier']);
});
it('migrates legacy records once without extending their life on subsequent reads',()=>{
 const old=[{id:'a',name:'a',token:'a'},{id:'b',name:'b',token:'b'}];
 const migrated=normalizeIdentities(old,1000);expect(migrated.map(i=>i.id)).toEqual(['b','a']);
 expect(normalizeIdentities(migrated,2000)).toEqual(migrated);
 expect(normalizeIdentities(migrated,1000+identityLifetime)).toEqual([]);
 expect(normalizeIdentities([null,{},'invalid'],1000)).toEqual([]);
});

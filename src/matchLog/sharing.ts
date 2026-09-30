import type {State} from './contract';
/** Share unchanged immutable subtrees in memory; wire snapshots remain complete. */
function reuse(previous:unknown,next:unknown):unknown {
 if(previous===next)return previous;
 if(!previous||!next||typeof previous!=='object'||typeof next!=='object'||Array.isArray(previous)!==Array.isArray(next))return next;
 const a=previous as Record<string,unknown>,b=next as Record<string,unknown>,keys=Object.keys(b);
 let same=Object.keys(a).length===keys.length;
 let result=b;
 for(const key of keys){
  const value=reuse(a[key],b[key]);
  if(value!==b[key]){
   if(result===b)result=(Array.isArray(next)?[...next]:{...b}) as Record<string,unknown>;
   result[key]=value;
  }
  if(!Object.hasOwn(a,key)||value!==a[key])same=false;
 }
 return same?previous:result;
}
export const shareFactState=(previous:State|undefined,next:State):State=>previous?reuse(previous,next) as State:next;

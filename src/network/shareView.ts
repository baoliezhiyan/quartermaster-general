/** Reuse equal JSON subtrees, including on full resync. Never mutates either input.
 * Compare own keys (not JSON text): undefined fields and removals stay distinct.
 */
export function shareView<T>(before:T,after:T):T {
 if(before===after)return before;
 if(!before||!after||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)!==Array.isArray(after))return after;
 const a=before as Record<string,unknown>,b=after as Record<string,unknown>;
 const keys=Object.keys(b);let equal=Object.keys(a).length===keys.length;
 const out:any=Array.isArray(after)?new Array(after.length):{};
 if(Array.isArray(before)&&Array.isArray(after)&&before.length!==after.length)equal=false;
 for(const key of keys){const value=Object.hasOwn(a,key)?shareView(a[key],b[key]):b[key];if(key==='__proto__')Object.defineProperty(out,key,{value,enumerable:true,writable:true,configurable:true});else out[key]=value;if(!Object.hasOwn(a,key)||value!==a[key])equal=false;}
 return equal?before:out;
}

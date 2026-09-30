export type Patch={op:'set'|'remove'|'append'|'truncate';path:(string|number)[];value?:unknown};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** JSON-compatible structural changes; immutable shared subtrees cost no traversal. */
export function diffValue(before:unknown,after:unknown,path:Patch['path']=[],out:Patch[]=[]):Patch[]{
 if(before===after)return out;
 if(Array.isArray(before)&&Array.isArray(after)){
  for(let i=0;i<Math.min(before.length,after.length);i++)diffValue(before[i],after[i],[...path,i],out);
  if(after.length>before.length)out.push({op:'append',path,value:after.slice(before.length)});
  if(after.length<before.length)out.push({op:'truncate',path,value:after.length});
 }else if(object(before)&&object(after)){
  for(const key of new Set([...Object.keys(before),...Object.keys(after)]))diffValue(before[key],after[key],[...path,key],out);
 }else out.push(after===undefined?{op:'remove',path}:{op:'set',path,value:after});
 return out;
}
/** Copy changed paths only. Neither the previous snapshot nor patch values are mutated. */
export function applyPatch<T>(base:T,patches:Patch[]):T{
 let result:unknown=base;
 for(const patch of patches){
  if(!patch||!Array.isArray(patch.path)||patch.path.some(k=>typeof k!=='string'&&typeof k!=='number'||['__proto__','constructor','prototype'].includes(String(k))))throw Error('无效增量路径');
  const change=(value:unknown,index:number):unknown=>{
   if(index===patch.path.length){
    if(patch.op==='set')return patch.value;
    if(patch.op==='remove')return undefined;
    if(!Array.isArray(value))throw Error('增量目标不是数组');
    if(patch.op==='append'&&Array.isArray(patch.value))return [...value,...patch.value];
    if(patch.op==='truncate'&&Number.isSafeInteger(patch.value)&&Number(patch.value)>=0&&Number(patch.value)<=value.length)return value.slice(0,Number(patch.value));
    throw Error('无效增量操作');
   }
   if(!value||typeof value!=='object')throw Error('增量路径不存在');
   const key=patch.path[index];
   if(Array.isArray(value)&&(!Number.isSafeInteger(key)||Number(key)<0||Number(key)>=value.length))throw Error('无效数组索引');
   const copy:any=Array.isArray(value)?[...value]:{...value};
   const next=change(copy[key],index+1);if(next===undefined)delete copy[key];else copy[key]=next;return copy;
  };
  result=change(result,0);
 }
 return result as T;
}

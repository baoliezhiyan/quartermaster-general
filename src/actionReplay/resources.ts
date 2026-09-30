import type {ResourceContents,ResourceOperation,ZoneRef} from './trainingContract';
export type Resources=Map<string,ResourceContents>;
export const zoneKey=(r:ZoneRef)=>r.seat+':'+r.zone;
export function applyResource(resources:Resources,operation:ResourceOperation,known:ReadonlySet<string>):Resources {
 const next=new Map([...resources].map(([k,v])=>[k,{...v,ids:[...v.ids]}]));
 const demand=(ok:unknown,text:string)=>{if(!ok)throw Error('训练牌区：'+text);};
 const get=(ref:ZoneRef)=>{const zone=next.get(zoneKey(ref));demand(zone,'未提供的牌区必须先用 set 初始化');return zone!;};
 const remove=(ref:ZoneRef,id:string)=>{const z=get(ref),i=z.ids.indexOf(id);demand(i>=0,'移除的实例不在来源牌区：'+id);z.ids.splice(i,1);};
 const add=(ref:ZoneRef,id:string,index?:number)=>{const z=get(ref);demand(known.has(id),'未知卡实例：'+id);demand(!z.ids.includes(id),'同一牌区内重复实例：'+id);const i=index??z.ids.length;demand(Number.isSafeInteger(i)&&i>=0&&i<=z.ids.length,'插入位置越界');z.ids.splice(i,0,id);};
 if(operation.op==='set'){
  demand(new Set(operation.ids).size===operation.ids.length&&operation.ids.every(id=>known.has(id)),'全量列表含未知或重复实例');
  next.set(zoneKey(operation),{seat:operation.seat,zone:operation.zone,visibility:operation.visibility,ids:[...operation.ids]});
 }else if(operation.op==='add')add(operation,operation.id,operation.index);
 else if(operation.op==='remove')remove(operation,operation.id);
 else {remove(operation.from,operation.id);add(operation.to,operation.id,operation.index);}
 return next;
}

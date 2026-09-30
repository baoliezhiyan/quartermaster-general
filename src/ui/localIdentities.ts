import type {Identity} from '../network/protocol';
export type LocalIdentity=Identity&{createdAt:number};
export const identityLifetime=48*60*60*1000;
export function normalizeIdentities(value:unknown,now=Date.now()):LocalIdentity[]{
 if(!Array.isArray(value))return [];
 return value.filter(i=>i&&typeof i.id==='string'&&typeof i.name==='string'&&typeof i.token==='string').map((i,index)=>({...i,createdAt:typeof i.createdAt==='number'&&Number.isFinite(i.createdAt)?i.createdAt:now-value.length+index})).filter(i=>now-i.createdAt<identityLifetime).sort((a,b)=>b.createdAt-a.createdAt);
}

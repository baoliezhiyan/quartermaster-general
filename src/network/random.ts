/** Independent of the deterministic game seed; uses fresh OS/browser entropy. */
export function randomSeed():number{return crypto.getRandomValues(new Uint32Array(1))[0];}
export function randomIndex(length:number):number{
 if(!Number.isInteger(length)||length<1||length>0x100000000)throw Error('Invalid random range');
 const limit=Math.floor(0x100000000/length)*length;let value:number;
 do{value=randomSeed();}while(value>=limit);
 return value%length;
}

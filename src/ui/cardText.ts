/** Preserve an entire outer card reference even when its name contains another 【name】. */
export function splitCardReferences(text:string):string[]{
 const parts:string[]=[];let start=0,depth=0;
 for(let i=0;i<text.length;i++){
  if(text[i]==='【'){if(depth===0){if(i>start)parts.push(text.slice(start,i));start=i;}depth++;}
  else if(text[i]==='】'&&depth>0){depth--;if(depth===0){parts.push(text.slice(start,i+1));start=i+1;}}
 }
 if(start<text.length)parts.push(text.slice(start));return parts;
}

import {useRef,useState} from 'react';
import type {DragEvent,PointerEvent} from 'react';

export function useHandOrder<T extends {id:string}>(key:string,cards:readonly T[]){
 const [orders,setOrders]=useState<Record<string,string[]>>({});
 const [target,setTarget]=useState<string|null>(null);
 const dragging=useRef<string|null>(null),suppressClick=useRef(false);
 let saved=orders[key];
 if(!saved){try{const value=JSON.parse(localStorage.getItem(key)??'[]');saved=Array.isArray(value)?value.filter(x=>typeof x==='string'):[];}catch{saved=[];}}
 const ids=[...saved.filter(id=>cards.some(c=>c.id===id)),...cards.filter(c=>!saved.includes(c.id)).map(c=>c.id)];
 const ordered=ids.map(id=>cards.find(c=>c.id===id)!);
 const origin=useRef<{x:number;y:number}|null>(null);
 const touch=useRef(false);
 const move=(id:string,direction:number)=>{const next=[...ids],a=next.indexOf(id),b=a+direction;if(a<0||b<0||b>=next.length)return;[next[a],next[b]]=[next[b],next[a]];setOrders(v=>({...v,[key]:next}));try{localStorage.setItem(key,JSON.stringify(next));}catch{}};
 const props=(id:string)=>({
  draggable:true,
  'data-swap-target':target===id||undefined,
  onPointerDown:(e:PointerEvent)=>{touch.current=e.pointerType!=='mouse';origin.current={x:e.clientX,y:e.clientY};suppressClick.current=false;e.stopPropagation();},
  onPointerMove:(e:PointerEvent)=>{if(origin.current&&Math.hypot(e.clientX-origin.current.x,e.clientY-origin.current.y)>8)suppressClick.current=true;},
  onPointerCancel:()=>{suppressClick.current=true;origin.current=null;},
  onClickCapture:(e:{preventDefault:()=>void;stopPropagation:()=>void})=>{if(suppressClick.current){e.preventDefault();e.stopPropagation();suppressClick.current=false;}},
  onDragStart:(e:DragEvent)=>{if(touch.current){e.preventDefault();return;}setTarget(null);dragging.current=id;suppressClick.current=true;e.stopPropagation();e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id);},
  onDragOver:(e:DragEvent)=>{if(dragging.current&&dragging.current!==id){e.preventDefault();setTarget(id);e.dataTransfer.dropEffect='move';}},
  onDragLeave:(e:DragEvent)=>{if(!(e.relatedTarget instanceof Node)||!e.currentTarget.contains(e.relatedTarget))setTarget(v=>v===id?null:v);},
  onDrop:(e:DragEvent)=>{e.preventDefault();e.stopPropagation();const from=dragging.current;setTarget(null);dragging.current=null;if(!from||from===id)return;const next=[...ids],a=next.indexOf(from),b=next.indexOf(id);if(a<0||b<0)return;[next[a],next[b]]=[next[b],next[a]];setOrders(v=>({...v,[key]:next}));try{localStorage.setItem(key,JSON.stringify(next));}catch{}dragging.current=null;},
  onDragEnd:()=>{dragging.current=null;setTarget(null);}
 });
 return {ordered,props,move};
}


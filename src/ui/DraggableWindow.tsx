import {useRef,useState} from 'react';
import type {HTMLAttributes,PointerEvent} from 'react';

/** Offsets are local presentation state, never part of the game or replay. */
export function DraggableWindow({children,style,...props}:HTMLAttributes<HTMLDivElement>){
 const root=useRef<HTMLDivElement>(null);
 const [offset,setOffset]=useState({x:0,y:0});
 const drag=useRef<{x:number;y:number;ox:number;oy:number;minX:number;maxX:number;minY:number;maxY:number}|undefined>(undefined);
 const down=(e:PointerEvent<HTMLDivElement>)=>{
  if(e.button!==0||!root.current)return;
  const box=root.current.getBoundingClientRect(),parent=root.current.offsetParent?.getBoundingClientRect();
  const bounds=parent??{left:0,top:0,right:innerWidth,bottom:innerHeight};
  drag.current={x:e.clientX,y:e.clientY,ox:offset.x,oy:offset.y,minX:offset.x+bounds.left-box.left,maxX:offset.x+bounds.right-box.right,minY:offset.y+bounds.top-box.top,maxY:offset.y+bounds.bottom-box.top-32};
  e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();e.stopPropagation();
 };
 const move=(e:PointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d)return;setOffset({x:Math.max(d.minX,Math.min(d.maxX,d.ox+e.clientX-d.x)),y:Math.max(d.minY,Math.min(d.maxY,d.oy+e.clientY-d.y))});e.stopPropagation();};
 return <div {...props} ref={root} style={{...style,translate:`${offset.x}px ${offset.y}px`}}>
  <div className="window-drag-handle" onPointerDown={down} onPointerMove={move} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>拖动窗口</div>
  {children}
 </div>;
}

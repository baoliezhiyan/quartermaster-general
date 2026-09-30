import { MAP_WIDTH } from './geometry';
export interface Point {x:number;y:number}
export function stepZoom(value:number,direction:number) {return Math.max(.5,Math.min(2,(Math.round(value*10)+direction)/10));}
export function isPanGesture(dx:number,dy:number) {return Math.hypot(dx,dy)>6;}
/** The world rectangle visible at centered 50% is the fixed camera boundary. */
export function clampPan(pan:Point,size:{width:number;height:number},zoom:number):Point {
  if(!size.width || zoom<=.5)return {x:0,y:0};
  const margin=1-.5/zoom;
  const x=MAP_WIDTH*margin,y=size.height/size.width*MAP_WIDTH*margin;
  return {x:Math.max(-x,Math.min(x,pan.x)),y:Math.max(-y,Math.min(y,pan.y))};
}

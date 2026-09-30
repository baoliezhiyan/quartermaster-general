import { describe,it,expect } from 'vitest';
import { clampPan,stepZoom,isPanGesture } from '../src/ui/map/camera';
import { MAP_WIDTH } from '../src/ui/map/geometry';
describe('v2 map camera',()=>{
  it('offers every ten-percent step from 50 to 200 without floating-point drift',()=>{
    let zoom=.5;const steps=[zoom];for(let n=0;n<15;n++){zoom=stepZoom(zoom,1);steps.push(zoom);}
    expect(steps).toEqual(Array.from({length:16},(_,i)=>(i+5)/10));
    expect(stepZoom(2,1)).toBe(2);expect(stepZoom(.5,-1)).toBe(.5);
    for(let n=0;n<15;n++)zoom=stepZoom(zoom,-1);expect(zoom).toBe(.5);
  });
  it.each([{width:1920,height:900},{width:700,height:1100}])('keeps the camera inside the same world rectangle at every zoom: %o',size=>{
    for(let i=5;i<=20;i++) {
      const z=i/10,scale=size.width/MAP_WIDTH*z;
      const limit=clampPan({x:1e8,y:1e8},size,z);
      expect(limit.x+size.width/2/scale).toBeCloseTo(MAP_WIDTH);
      expect(limit.y+size.height/2/scale).toBeCloseTo(size.height/size.width*MAP_WIDTH);
      expect(clampPan({x:-1e8,y:-1e8},size,z)).toEqual({x:limit.x===0?0:-limit.x,y:limit.y===0?0:-limit.y});
    }
    expect(clampPan({x:120,y:-40},size,.5)).toEqual({x:0,y:0});
    expect(clampPan({x:0,y:0},size,1)).toEqual({x:0,y:0});
  });
  it('tolerates small click movement and recognizes drags',()=>{
    expect(isPanGesture(3,3)).toBe(false);expect(isPanGesture(6,0)).toBe(false);
    expect(isPanGesture(5,5)).toBe(true);expect(isPanGesture(-7,0)).toBe(true);
  });
});

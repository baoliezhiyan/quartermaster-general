import {describe,it,expect} from 'vitest';
import {localPointer,compactLayout} from '../src/ui/deviceLayout';
describe('manual screen rotation coordinates',()=>{
 const box={left:20,top:100,right:220};
 it('keeps normal pointer coordinates relative to the viewport',()=>expect(localPointer(box,70,140,false)).toEqual({x:50,y:40}));
 it('maps rotated top-right to logical origin and lower-left to opposite corner',()=>{expect(localPointer(box,220,100,true)).toEqual({x:0,y:0});expect(localPointer(box,20,900,true)).toEqual({x:800,y:200});});
 it('maps downward physical drag to rightward logical drag without flipping pan',()=>{const a=localPointer(box,150,200,true),b=localPointer(box,150,260,true);expect({x:b.x-a.x,y:b.y-a.y}).toEqual({x:60,y:0});});
 it('keeps a wide low-height viewport compact, while allowing explicit desktop',()=>{expect(compactLayout(1300,390)).toBe(true);expect(compactLayout(1300,390,'desktop')).toBe(false);expect(compactLayout(1500,900)).toBe(false);});
});

import {describe,it,expect} from 'vitest';
import {localPointer,compactLayout} from '../src/ui/deviceLayout';
describe('browser orientation coordinates',()=>{
 const box={left:20,top:100,right:220};
 it('keeps normal pointer coordinates relative to the viewport',()=>expect(localPointer(box,70,140)).toEqual({x:50,y:40}));
 it('keeps a wide low-height viewport compact, while allowing explicit desktop',()=>{expect(compactLayout(1300,390)).toBe(true);expect(compactLayout(1300,390,'desktop')).toBe(false);expect(compactLayout(1500,900)).toBe(false);});
});

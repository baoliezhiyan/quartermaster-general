import {useEffect,useSyncExternalStore} from 'react';
export type LayoutPreference='auto'|'desktop'|'compact';
export function compactLayout(width:number,height:number,preference:LayoutPreference='auto') {return preference==='compact'||preference==='auto'&&(width<1200||height<650);}
const listeners=new Set<()=>void>();
let preference:LayoutPreference='auto';
try {const saved=localStorage.getItem('qm:layout');if(saved==='desktop'||saved==='compact')preference=saved;}catch{}
let rotated=false;
export const isLayoutRotated=()=>rotated;
export function layoutSize(){return rotated?{width:window.visualViewport?.height??innerHeight,height:innerWidth}:{width:innerWidth,height:window.visualViewport?.height??innerHeight};}
export function localPointer(box:{left:number;top:number;right:number},x:number,y:number,rotate=rotated){return rotate?{x:y-box.top,y:box.right-x}:{x:x-box.left,y:y-box.top};}
const snapshot=()=>typeof window==='undefined'?false:compactLayout(layoutSize().width,layoutSize().height,preference);
const notify=()=>listeners.forEach(f=>f());
function subscribe(f:()=>void){listeners.add(f);window.addEventListener('resize',f);return()=>{listeners.delete(f);window.removeEventListener('resize',f);};}
export function useRotatedLayout(){return useSyncExternalStore(subscribe,isLayoutRotated,()=>false);}
export function useCompactLayout(){return useSyncExternalStore(subscribe,snapshot,()=>false);}
export function LayoutControl(){const compact=useCompactLayout();useEffect(()=>{document.documentElement.dataset.layout=compact?'compact':'desktop';},[compact]);return <label className="layout-control">布局 <select aria-label="界面布局" defaultValue={preference} onChange={e=>{preference=e.target.value as LayoutPreference;try{localStorage.setItem('qm:layout',preference);}catch{}notify();document.documentElement.dataset.layout=snapshot()?'compact':'desktop';}}><option value="auto">自动</option><option value="desktop">桌面</option><option value="compact">紧凑</option></select></label>;}
/** Manual CSS rotation does not depend on Screen Orientation API support. */
export function DeviceShell(){const compact=useCompactLayout(),turned=useRotatedLayout();useEffect(()=>{document.documentElement.dataset.layout=compact?'compact':'desktop';},[compact]);useEffect(()=>{const update=()=>{const root=document.documentElement,v=window.visualViewport;root.style.setProperty('--physical-height',`${v?.height??innerHeight}px`);root.style.setProperty('--physical-width',`${innerWidth}px`);root.style.setProperty('--visible-height',`${layoutSize().height}px`);root.style.setProperty('--layout-width',`${layoutSize().width}px`);};update();window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);return()=>{window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);};},[turned]);return <button className="orientation-toggle" aria-pressed={turned} onClick={async()=>{if(document.fullscreenElement)await document.exitFullscreen().catch(()=>{});rotated=!rotated;document.documentElement.dataset.rotated=String(rotated);notify();window.dispatchEvent(new Event('resize'));}}>切换横竖屏</button>;}

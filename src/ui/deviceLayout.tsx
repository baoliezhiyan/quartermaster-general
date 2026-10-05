import {useEffect,useSyncExternalStore} from 'react';
export type LayoutPreference='auto'|'desktop'|'compact';
export function compactLayout(width:number,height:number,preference:LayoutPreference='auto') {return preference==='compact'||preference==='auto'&&(width<1200||height<650);}
const listeners=new Set<()=>void>();
let preference:LayoutPreference='auto';
try {const saved=localStorage.getItem('qm:layout');if(saved==='desktop'||saved==='compact')preference=saved;}catch{}
const snapshot=()=>typeof window==='undefined'?false:compactLayout(innerWidth,innerHeight,preference);
const notify=()=>listeners.forEach(f=>f());
function subscribe(f:()=>void){listeners.add(f);window.addEventListener('resize',f);return()=>{listeners.delete(f);window.removeEventListener('resize',f);};}
export function useCompactLayout(){return useSyncExternalStore(subscribe,snapshot,()=>false);}
export function LayoutControl(){const compact=useCompactLayout();useEffect(()=>{document.documentElement.dataset.layout=compact?'compact':'desktop';},[compact]);return <label className="layout-control">布局 <select aria-label="界面布局" defaultValue={preference} onChange={e=>{preference=e.target.value as LayoutPreference;try{localStorage.setItem('qm:layout',preference);}catch{}notify();document.documentElement.dataset.layout=snapshot()?'compact':'desktop';}}><option value="auto">自动</option><option value="desktop">桌面</option><option value="compact">紧凑</option></select></label>;}
/** Sets presentation metrics only; device orientation never blocks entry. */
export function DeviceShell(){const compact=useCompactLayout();useEffect(()=>{document.documentElement.dataset.layout=compact?'compact':'desktop';},[compact]);useEffect(()=>{const update=()=>{const v=window.visualViewport;document.documentElement.style.setProperty('--visible-height',`${v?.height??innerHeight}px`);};update();window.visualViewport?.addEventListener('resize',update);return()=>window.visualViewport?.removeEventListener('resize',update);},[]);return null;}

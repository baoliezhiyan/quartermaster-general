import {useSyncExternalStore} from 'react';
let hidden=false;
try{hidden=localStorage.getItem('qm:hide-card-art')==='true';}catch{}
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const useCardArtHidden=()=>useSyncExternalStore(subscribe,()=>hidden,()=>false);
export function toggleCardArt(){hidden=!hidden;try{localStorage.setItem('qm:hide-card-art',String(hidden));}catch{}listeners.forEach(listener=>listener());}

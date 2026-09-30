import {useEffect,useState} from 'react';
import type {ReadState} from '../core';
import {COUNTRY_NAMES} from '../core/basic';

type Notice=NonNullable<ReadState['neutralityNotices']>[number];
type Inbox={known:string[];pending:Notice[]};
/** Notifications are per user/browser, never commands or shared game revisions. */
export function updateNeutralityInbox(previous:Inbox|undefined,notices:readonly Notice[]):Inbox {
 if(!previous)return {known:notices.map(n=>n.id),pending:[]};
 return {known:notices.map(n=>n.id),pending:[...previous.pending,...notices.filter(n=>!previous.known.includes(n.id))].filter(n=>notices.some(v=>v.id===n.id))};
}
export function NeutralityNotice({state,identity,replay}:{state:ReadState|null;identity:string;replay:boolean}){
 const key=state?`qm-neutrality-notices:${identity}:${state.gameId}`:'';
 const [inbox,setInbox]=useState<{key:string;value:Inbox}>();
 const notices=state?.neutralityNotices;
 useEffect(()=>{
  if(!key||replay)return;
  setInbox(current=>{
   let previous=current?.key===key?current.value:undefined;
   if(!previous)try{const saved=JSON.parse(localStorage.getItem(key)??'null');if(saved&&Array.isArray(saved.known)&&Array.isArray(saved.pending))previous=saved;}catch{/* Storage can be disabled. */}
   const value=updateNeutralityInbox(previous,notices??[]);
   try{localStorage.setItem(key,JSON.stringify(value));}catch{/* Keep this tab usable without storage. */}
   return {key,value};
  });
 },[key,notices,replay]);
 const notice=!replay&&inbox?.key===key?inbox.value.pending[0]:undefined;
 if(!notice)return null;
 const dismiss=()=>setInbox(current=>{
  if(!current||current.key!==key)return current;
  const value={...current.value,pending:current.value.pending.filter(n=>n.id!==notice.id)};
  try{localStorage.setItem(key,JSON.stringify(value));}catch{/* No game-state writes. */}
  return {key,value};
 });
 return <section className="response-notice neutrality-notice" role="alertdialog" aria-label="参战通知"><h3>{COUNTRY_NAMES[notice.seat]}已结束中立</h3><p>{notice.reason}。</p><button onClick={dismiss}>知道了</button></section>;
}

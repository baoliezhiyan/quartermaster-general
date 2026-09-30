import {useEffect,useState} from 'react';
import type {ReadState,SeatId} from '../core';
import type {RoomInfo} from '../network/protocol';
import type {RoomAccess} from '../controller/GameController';
import {COUNTRY_NAMES} from '../core/basic';
export function BoundCountrySwitch({room,state,busy,choose}:{room:RoomInfo;state:ReadState;busy:boolean;choose:(a:RoomAccess)=>void}){
 const [seen,setSeen]=useState<Set<string>>(()=>new Set());
 const attention=room.bindingAttention??[],current=room.access.kind==='player'?room.access.seat:null;
 const signature=attention.map(a=>a.key).join('|');
 useEffect(()=>{setSeen(old=>{const next=new Set(old);for(const a of attention)if(a.seat===current)next.add(a.key);return next;});},[signature,current]);
 if(room.access.kind!=='player'||(room.bindings?.length??0)<2)return null;
 const pending=attention.filter(a=>a.kind!=='turn'&&a.seat!==current&&!seen.has(a.key));
 const acknowledge=(seat?:SeatId)=>setSeen(old=>new Set([...old,...attention.filter(a=>!seat||a.seat===seat).map(a=>a.key)]));
 return <><div className="bound-country-switch" aria-label="绑定国家快捷切换">{room.bindings!.filter(s=>s!==current).map(seat=><button disabled={busy} key={seat} onClick={()=>choose({kind:'player',seat})}>切换到{COUNTRY_NAMES[seat]}{state.activeSeat===seat&&state.phase!=='SETUP'&&<strong> · 回合中</strong>}</button>)}</div>{pending.length>0&&<div className="bound-country-notice" role="status">{pending.map(a=><p key={a.key}>{a.kind==='attack'?a.text:a.kind==='response'?`${COUNTRY_NAMES[a.seat]}有需要处理的操作${a.text?'：'+a.text:'，请切换视角'}`:`游戏进入${COUNTRY_NAMES[a.seat]}回合，请切换视角`}</p>)}<button onClick={()=>acknowledge()}>知道了</button></div>}</>;
}

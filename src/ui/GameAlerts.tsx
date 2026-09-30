import {useEffect,useRef,useState} from 'react';
import type {ReadState} from '../core';
import type {RoomInfo} from '../network/protocol';
import {COUNTRY_NAMES} from '../core/basic';
export function TurnEntryNotice({state,room,enabled}:{state:ReadState;room?:RoomInfo;enabled:boolean}){
 const [seen,setSeen]=useState<Set<string>>(()=>new Set());
 const current=room?.access.kind==='player'?room.access.seat:!room?state.viewSeat:null;
 const controlled=current?[current,...(room?.bindings??[])]:[];
 const key=`${state.gameId}:${state.prelude?.active?'prelude:'+state.prelude.turn:'round:'+state.round}:${state.activeSeat}`;
 const previous=useRef(current);
 useEffect(()=>{if(previous.current!==current&&current===state.activeSeat)setSeen(old=>new Set([...old,key]));previous.current=current;},[current,key,state.activeSeat]);
 if(!enabled||state.status!=='PLAYING'||state.phase==='SETUP'||!controlled.includes(state.activeSeat)||seen.has(key))return null;
 return <section className="bound-country-notice" role="status" aria-label="回合开始通知"><p>已进入{COUNTRY_NAMES[state.activeSeat]}的{state.prelude?.active?'序章':''}回合{current!==state.activeSeat?'，请切换视角':''}。</p><button onClick={()=>setSeen(old=>new Set([...old,key]))}>知道了</button></section>;
}
export function VictoryNotice({state}:{state:ReadState}){
 const [closed,setClosed]=useState('');const key=`${state.gameId}:${state.winner}:${state.victoryReason}`;
 if(state.status!=='FINISHED'||!state.winner||closed===key)return null;
 return <section className="victory-notice" role="dialog" aria-label="游戏结束"><p>游戏结束</p><h2>{state.winner==='axis'?'轴心国':'同盟国'}获胜</h2><p>{state.victoryReason==='TWENTY_ROUNDS'?'20 轮对局结束':'美国回合结束，领先至少 30 分'}</p><button onClick={()=>setClosed(key)}>知道了</button></section>;
}

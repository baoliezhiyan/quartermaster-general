import {publicActiveCards} from '../core/publicActiveCards';
import {useEffect,useRef,useState} from 'react';
import type {ReadState,SeatId} from '../core';
import {SEATS} from '../core';
import {COUNTRY_NAMES} from '../core/basic';
import {regularCatalog,specialCard} from '../core/cardCatalog';
import {persistentHistory} from '../core/prelude';
import type {RoomInfo} from '../network/protocol';
import {PublicGameLog} from './PublicGameLog';
import type {ReactNode} from 'react';
export function RoomRecord({state,room,request,infoSeat,onInfoSeat,replay,visible=true,onUnread}:{visible?:boolean;onUnread?:(count:number)=>void;state:ReadState;room?:RoomInfo;request?:(method:string,...args:unknown[])=>Promise<unknown>;infoSeat?:SeatId|null;onInfoSeat?:(seat:SeatId)=>void;replay?:ReactNode}){
 const [chat,setChat]=useState(false),[text,setText]=useState(''),[sending,setSending]=useState(false),[error,setError]=useState('');
 const list=useRef<HTMLDivElement>(null),atBottom=useRef(true),messages=room?.chat??[];
 const [readMessages,setReadMessages]=useState(()=>new Set((room?.chat??[]).map(m=>m.id)));
 const unread=chat&&visible?0:messages.filter(m=>!readMessages.has(m.id)).length;
 useEffect(()=>{if(chat&&visible)setReadMessages(new Set(messages.map(m=>m.id)));},[chat,visible,room?.chat]);
 useEffect(()=>{if(chat&&atBottom.current&&list.current)list.current.scrollTop=list.current.scrollHeight;},[chat,messages]);
 useEffect(()=>{onUnread?.(unread);},[unread,onUnread]);
 async function act(method:string,...args:unknown[]){if(!request||sending)return false;setSending(true);setError('');try{await request(method,...args);return true;}catch(e){setError(String(e));return false;}finally{setSending(false);}}
 return <section aria-label={replay?'回放记录':chat?'房间聊天':'对局记录'}>
  <div className="record-heading"><h3>{replay?'回放记录':chat?'房间聊天':'对局记录'}</h3>{chat&&room?.access.kind==='gm'&&<button className="chat-clear" disabled={sending||!messages.length} onClick={()=>void act('chatClear')}>清空聊天</button>}</div>
  <div className="public-record-layout room-record-layout">
   {replay??(chat?<div className="public-game-log chat-messages" ref={list} aria-live="polite" onScroll={e=>{const el=e.currentTarget;atBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<60;}}>{messages.length?messages.map(m=><article className="chat-message" data-tone={m.tone??0} key={m.id}><header><strong>{m.name}（{m.seats.map((name,index)=>{const country=SEATS.find(seat=>name===COUNTRY_NAMES[seat]||name===COUNTRY_NAMES[seat]+'观察者');return <span key={index}>{index>0?'、':''}<span className={country?'country-name':undefined} data-country={country}>{name}</span></span>;})}）</strong>{room?.access.kind==='gm'&&<button className="chat-delete" aria-label={`删除${m.name}的消息`} disabled={sending} onClick={()=>void act('chatDelete',m.id)}>×</button>}</header><div>{m.text}</div></article>):<p>暂无聊天消息。</p>}</div>:<PublicGameLog key={state.gameId} entries={state.publicLog} balance={!!state.rules?.balanceEnabled}/>)}
   <div className="public-country-buttons" aria-label="六国公开信息">{SEATS.map(id=>{const d=state.decks[id],active=publicActiveCards(state,id),armaments=state.publicArmamentCounts?.[id]??d.faceDown.filter(c=>specialCard(c.definitionId,c.balance)?.type==='军备').length;const responses=d.faceDown.length-armaments,treaties=active.filter(c=>persistentHistory(c.definitionId,!!c.balance)).length;return <div className="country-record-summary" key={id}><button className="country-name" data-country={id} aria-pressed={infoSeat===id} onClick={()=>onInfoSeat?.(id)}>{COUNTRY_NAMES[id]}</button><small>局势：{active.length-treaties}</small>{treaties>0&&<small>条约：{treaties}</small>}{(responses>0||regularCatalog(!!state.rules?.balanceEnabled,!!state.rules?.neutralityEnabled).some(c=>c.deckOwner===id&&c.type==='响应'))&&<small>响应：{responses}</small>}{(state.prelude?.active||armaments>0)&&<small>军备：{armaments}</small>}</div>;})}</div>
   {room&&request&&<><button className="chat-switch" onClick={()=>{atBottom.current=true;setChat(v=>!v);setError('');}}>{chat?'对局记录':'房间聊天'}{unread>0&&<span className="chat-unread" aria-label={`${unread} 条未读聊天消息`}>{unread}</span>}</button><div className="chat-composer">{chat&&<form onSubmit={async e=>{e.preventDefault();if(await act('chatSend',text)){setText('');atBottom.current=true;}}}><input aria-label="聊天消息" placeholder="输入消息…" value={text} disabled={!room.connected} onChange={e=>setText(Array.from(e.target.value).slice(0,300).join(''))}/><button disabled={sending||!room.connected||!text.trim()}>发送</button></form>}{error&&<small role="alert">{error}</small>}</div></>}
  </div>
 </section>;
}

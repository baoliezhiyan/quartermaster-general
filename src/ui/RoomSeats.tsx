import {SEATS} from '../core';
import {SEAT_INFO} from '../data/seats';
import type {RoomInfo} from '../network/protocol';
import type {RoomAccess} from '../controller/GameController';
export function RoomSeats({room,replay,busy,choose,release,drawCountry,binding}:{room:RoomInfo;replay:boolean;busy:boolean;choose:(a:RoomAccess)=>void;release:(id:string)=>void;drawCountry:()=>void;binding:(seat:typeof SEATS[number],bind:boolean)=>void}){
 const equal=(a:RoomAccess,b:RoomAccess)=>JSON.stringify(a)===JSON.stringify(b);
 const seats:RoomAccess[]=[...SEATS.map(seat=>({kind:'player' as const,seat})),{kind:'gm'}];
 const observers:RoomAccess[]=[...SEATS.map(seat=>({kind:'observer' as const,seat})),{kind:'public'}];
 return <section className="seats-section room-seats" aria-label="房间座位"><h3>房间座位</h3>{[seats,observers].map((row,index)=><div className="seat-list" key={index}>{row.map((a,i)=>{
  const members=room.members.filter(m=>equal(m.access,a)||a.kind==='player'&&m.bindings?.includes(a.seat)),occupant=members[0],exclusive=index===0;
  const title=a.kind==='gm'?'GM':a.kind==='public'?'通用观察者':SEAT_INFO[a.seat].name+(a.kind==='observer'?'观察者':'');
  const bound=a.kind==='player'&&!!occupant?.bindings?.includes(a.seat),mine=occupant?.id===room.userId,gm=room.access.kind==='gm';
  const allowed=!(room.bindings?.length)||a.kind==='gm'||a.kind==='player'&&room.bindings.includes(a.seat);
  const canBind=a.kind==='player'&&!replay&&!busy&&(bound?(mine||gm):!gm&&(!occupant||mine)&&(equal(room.access,a)||!!room.bindings?.length));
  return <div key={i} className="room-seat-cell"><button className={`seat ${equal(room.access,a)?'selected':''}`} aria-pressed={equal(room.access,a)} disabled={busy||!allowed||a.kind==='player'&&replay||exclusive&&!!occupant&&!mine} onClick={()=>choose(a)}><span className="seat-number">0{i+1}</span><span className="seat-name">{title}<small>{exclusive?occupant?`${occupant.name} · ${occupant.online?'在线':'离线'}`:'空位':`${members.length} 人`}</small></span></button>{a.kind==='player'&&<button className="seat-binding" title={`${bound?'解绑':'绑定'}${title}`} aria-label={`${bound?'解绑':'绑定'}${title}`} disabled={!canBind} onClick={()=>binding(a.seat,!bound)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>{bound&&<path d="M3 3l18 18" strokeWidth="3"/>}</svg></button>}</div>;
 })}</div>)}{room.access.kind==='public'&&!replay&&<button className="draw-country" disabled={busy||!room.connected} onClick={drawCountry}>抽取国家</button>}{room.access.kind==='gm'&&room.members.filter(m=>!m.online&&m.access.kind==='player').map(m=><button key={m.id} onClick={()=>release(m.id)}>释放离线席位 · {m.name}</button>)}</section>;
}

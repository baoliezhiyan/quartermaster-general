import {createPortal} from 'react-dom';
import {CardFace} from '../ui/CardFace';
import {logCard} from '../ui/PublicGameLog';
import {splitCardReferences} from '../ui/cardText';
import {cardName} from '../core/basic';
import type {CardInstance} from '../core/types';
import {useEffect,useState} from 'react';
import type {ReplayView} from './ReplayController';
import type {RoomAccess} from '../controller/GameController';
import {COUNTRY_NAMES} from '../core/basic';
import {SEATS} from '../core/types';
import {displayOption} from './player';
export function ReplayRecord({controller,exit,choose,access}:{controller:ReplayView;exit:()=>void;choose:(a:RoomAccess)=>void;access:RoomAccess}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[playing,setPlaying]=useState(false);
 const [preview,setPreview]=useState<Pick<CardInstance,'definitionId'|'country'|'balance'>|null>(null);
 useEffect(()=>{void controller.describe().catch(e=>setError(String(e)));},[controller]);
 useEffect(()=>setPreview(null),[access]);
 const index=controller.entries.findIndex(e=>e.id===controller.selectedId?.split('@')[0]);
 const full=access.kind==='gm',own='seat'in access?access.seat:null;
 const prompt=controller.getSnapshot().resolution?.choice;
 async function seek(id:string|null,after=false){setBusy(true);setError('');try{await controller.seek(id,after);}catch(e){setPlaying(false);setError(String(e));}finally{setBusy(false);}}
 useEffect(()=>{if(!playing||busy)return;const timer=setTimeout(()=>{if(index+1>=controller.entries.length)setPlaying(false);else void seek(controller.entries[index+1].id);},1200);return()=>clearTimeout(timer);},[playing,busy,index]);
 return <div className="public-game-log action-replay-record">
  <div className="replay-controls"><select aria-label="回放视角" value={access.kind==='gm'?'gm':access.kind==='public'?'public':access.seat} onChange={e=>choose(e.target.value==='gm'?{kind:'gm'}:e.target.value==='public'?{kind:'public'}:{kind:'observer',seat:e.target.value as typeof SEATS[number]})}><option value="gm">全知视角</option><option value="public">公共视角</option>{SEATS.map(s=><option key={s} value={s}>{COUNTRY_NAMES[s]}</option>)}</select><button onClick={()=>{setPlaying(false);exit();}}>退出回放</button>
  <button disabled={busy||index<0} onClick={()=>void seek(index>0?controller.entries[index-1].id:null)}>上一步</button><button disabled={busy||index+1>=controller.entries.length} onClick={()=>void seek(controller.entries[index+1].id)}>下一步</button><button onClick={()=>setPlaying(v=>!v)}>{playing?'暂停':'播放'}</button>
  <button disabled={busy||!controller.selectedId} aria-pressed={!controller.after} onClick={()=>void seek(controller.selectedId,false)}>选择前</button><button disabled={busy||!controller.selectedId} aria-pressed={controller.after} onClick={()=>void seek(controller.selectedId,true)}>结算后</button>
  <select aria-label="按轮定位" value="" onChange={e=>void seek(e.target.value)}><option value="">按轮定位</option>{controller.entries.filter((e,i,a)=>!a.slice(0,i).some(v=>v.stage===e.stage&&v.round===e.round)).map(e=><option key={e.id} value={e.id}>{e.stage==='prelude'?'序章':e.stage==='opening'?'起手':`第 ${e.round} 轮`}</option>)}</select></div>
  {full&&<select aria-label="查看国家" value={controller.getSnapshot().viewSeat} onChange={e=>void controller.dispatch({type:'SET_VIEW',seat:e.target.value as typeof SEATS[number],expectedRevision:controller.getSnapshot().revision})}>{SEATS.map(s=><option key={s} value={s}>{COUNTRY_NAMES[s]} · 全知查看</option>)}</select>}
  {busy&&<p role="status">正在推导回放…</p>}{error&&<p role="alert">{error}</p>}
  {controller.getSnapshot().resolution?.choice&&<p className="replay-historical-prompt">历史选择：{controller.getSnapshot().resolution!.choice!.prompt}</p>}
  {prompt&&<details><summary>当时的可选项（只读）</summary><ul>{prompt.options.map(o=><li key={o.id}>{displayOption(o.label)}</li>)}</ul></details>}
  {full&&controller.player.details.length>0&&<details><summary>本动作的选择与子效果</summary>{controller.player.details.map(d=><button key={d.id} disabled={busy} onClick={()=>void seek(d.id)}>{d.label}</button>)}</details>}
  {controller.entries.map(e=>{const phrases=(controller.narratives.get(e.id)??[]).filter(p=>full||p.public||p.owner===own);const title=full||own===e.seat?e.summary:`${COUNTRY_NAMES[e.seat]}的${e.kind==='response'?'响应':'操作'}`;const text=[title,...phrases.map(p=>p.text).filter(Boolean)].join('；');const cards=phrases.flatMap(p=>p.cards);return <div role="button" tabIndex={busy?-1:0} className="replay-entry" key={e.id} aria-current={controller.selectedId===e.id?'step':undefined} onKeyDown={event=>{if(event.target===event.currentTarget&&['Enter',' '].includes(event.key)){event.preventDefault();if(!busy)void seek(e.id);}}} onClick={()=>{if(!busy){setPlaying(false);void seek(e.id);}}}><small>{e.stage==='prelude'?'序章':`第 ${e.round} 轮`} · {COUNTRY_NAMES[e.seat]}</small><br/>{splitCardReferences(text).map((part,i)=>{const c=part.startsWith('【')?(cards.find(c=>'【'+((c as any).__replayCard?.name??cardName(c))+'】'===part)??logCard(part.slice(1,-1),e.seat,e.stage==='prelude'?0:e.round,text,!!controller.getSnapshot().rules?.balanceEnabled)):undefined;return c?<button key={i} className="card-index-link" onClick={event=>{event.stopPropagation();setPlaying(false);setPreview(c);}}>{part}</button>:<span key={i}>{part}</span>;})}</div>;})}
  {preview&&createPortal(<div className="card-index-window log-card-dialog" role="dialog" aria-label="卡牌索引"><button className="card-index-close" aria-label="关闭卡牌索引" onClick={()=>setPreview(null)}>×</button><div className="hand-card"><CardFace card={preview}/></div></div>,document.fullscreenElement??document.body)}
 </div>;
}

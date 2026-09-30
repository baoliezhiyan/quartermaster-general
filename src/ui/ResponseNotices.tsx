import {splitCardReferences} from './cardText';
import {useState} from 'react';
import type {Command,ReadState} from '../core';
import {cardName,COUNTRY_NAMES} from '../core/basic';
import {CardFace} from './CardFace';

export function ResponseNotices({state,busy,dispatch,readOnly=false}:{state:ReadState;busy:boolean;dispatch:(c:Command)=>Promise<void>;readOnly?:boolean}) {
 const [dismissed,setDismissed]=useState<string[]>([]);
 const pending=(state.responseNotices??[]).filter(n=>n.recipients.includes(state.viewSeat)&&!n.readBy.includes(state.viewSeat)&&!dismissed.includes(`${state.gameId}:${state.viewSeat}:${n.id}`));
 const notice=pending.find(n=>n.title==='受到攻击')??pending[0];
 const [index,setIndex]=useState<{key:string;id:string}|null>(null);
 if(!notice)return null;
 const key=`${state.gameId}:${state.viewSeat}:${notice.id}`;
 const indexed=index?.key===key?notice.cards.find(c=>c.id===index.id):undefined;
 return <>
  <section className="response-notice" role="alertdialog" aria-label={notice.title??'响应结果'}>
   <h3>{COUNTRY_NAMES[state.viewSeat]} · {notice.title??'响应结果'}{pending.length>1?`（待查看 ${pending.length} 条）`:''}</h3>
   <p>{splitCardReferences(notice.text).map((part,i)=>{const c=notice.cards.find(c=>`【${cardName(c)}】`===part);return c?<button className="card-index-link" aria-label={cardName(c)} key={i} onClick={()=>setIndex({key,id:c.id})}>{part}</button>:part;})}</p>
   <button disabled={busy} onClick={()=>readOnly?setDismissed(v=>[...v,key]):dispatch({type:'ACK_RESPONSE_NOTICE',seat:state.viewSeat,expectedRevision:state.revision,noticeId:notice.id})}>{notice.title==='确认翻牌'?'确认翻牌':notice.title==='翻牌结果'?'确认，已看完':'知道了'}</button>
  </section>
  {indexed&&<div className="card-index-window" role="dialog" aria-label="卡牌索引"><button className="card-index-close" aria-label="关闭卡牌索引" onClick={()=>setIndex(null)}>×</button><div className="hand-card"><CardFace card={indexed}/></div></div>}
 </>;
}

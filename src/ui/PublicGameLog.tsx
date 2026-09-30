import {splitCardReferences} from './cardText';
import {memo,useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ALL_SPECIAL_CARDS,PRELUDE_CARDS,NEUTRALITY_CARDS,BALANCE_CARDS} from '../core/cardCatalog';
import {BASIC_NAMES,COUNTRY_NAMES} from '../core/basic';
import type {CardInstance,ReadState,SeatId} from '../core';
import {CardFace} from './CardFace';
type PreviewCard=Pick<CardInstance,'definitionId'|'country'|'balance'>;
const catalog=[...ALL_SPECIAL_CARDS,...PRELUDE_CARDS,...NEUTRALITY_CARDS];
const cardsByName=new Map<string,typeof catalog>();
for(const card of catalog)cardsByName.set(card.name,[...(cardsByName.get(card.name)??[]),card]);

/** Resolve only names already in the public text, never inspect hidden game zones. */
export function logCard(name:string,seat:SeatId,round:number,text:string,balance=false):PreviewCard|undefined{
 const basic=Object.entries(BASIC_NAMES).find(([,value])=>value===name);
 if(basic)return {definitionId:basic[0],country:seat};
 let matches=(balance?balancedByName:cardsByName).get(name)??[];
 const owned=matches.filter(c=>c.deckOwner===seat);if(owned.length)matches=owned;
 const explicitType=['历史','军备','事件','增强','响应','状态','经济战'].find(type=>text.includes(type+'【'+name+'】'));
 const typed=matches.filter(c=>c.type===explicitType);if(typed.length)matches=typed;
 if(matches.length>1){const phase=matches.filter(c=>round===0?c.id.startsWith('prelude_'):!c.id.startsWith('prelude_'));if(phase.length)matches=phase;}
 const d=matches[0];return d?{definitionId:d.id,country:d.country,balance}:undefined;
}

const balancedByName=new Map<string,typeof catalog>();
for(const card of [...catalog.filter(c=>!BALANCE_CARDS.some(v=>v.id===c.id)),...BALANCE_CARDS])balancedByName.set(card.name,[...(balancedByName.get(card.name)??[]),card]);

const countryNames=Object.entries(COUNTRY_NAMES);
const countryPattern=new RegExp('('+countryNames.map(([,name])=>name).sort((a,b)=>b.length-a.length).join('|')+')','g');
export function coloredCountries(text:string){return text.split(countryPattern).map((part,i)=>{const country=countryNames.find(([,name])=>name===part)?.[0];return country?<span key={i} className="country-name" data-country={country}>{part}</span>:part;});}
export function PublicGameLog({entries,balance=false}: {entries:ReadState['publicLog'];balance?:boolean}){
 const [card,setCard]=useState<PreviewCard|null>(null),close=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement|null>(null);
 const [portalHost,setPortalHost]=useState<Element|null>(null);
 useEffect(()=>{const update=()=>setPortalHost(document.fullscreenElement);update();document.addEventListener('fullscreenchange',update);return()=>document.removeEventListener('fullscreenchange',update);},[]);
 const openCard=useCallback((card:PreviewCard,button:HTMLButtonElement)=>{opener.current=button;setCard(card);},[]);
 const dismiss=()=>{setCard(null);opener.current?.focus();};
 useEffect(()=>{if(!card)return;close.current?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setCard(null);opener.current?.focus();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[card]);
 return <><div className="public-game-log" role="log">{entries?.length?entries.map((e,i)=><LogEntry key={i} entry={e} balance={balance} open={openCard}/>).reverse():<p>暂无公开行动记录。</p>}</div>
 {card&&createPortal(<div className="card-index-window log-card-dialog" role="dialog" aria-label="卡牌索引"><button ref={close} className="card-index-close" aria-label="关闭卡牌索引" onClick={dismiss}>×</button><div className="hand-card"><CardFace card={card}/></div></div>,portalHost??document.body)}</>;
}

// Append-only log indices stay stable when displaying newest first. Compare the
// full display inputs, so undo/replacement of a row cannot leave stale text.
const LogEntry=memo(function LogEntry({entry:e,balance,open}:{entry:NonNullable<ReadState['publicLog']>[number];balance:boolean;open:(card:PreviewCard,button:HTMLButtonElement)=>void}){
 return <p><small>{e.round===0?'序章':`第 ${e.round} 轮`}</small> {splitCardReferences(e.text).map((part,j)=>{const c=part.startsWith('【')?logCard(part.slice(1,-1),e.seat,e.round,e.text,balance):undefined;return c?<button key={j} className="card-index-link" onClick={event=>open(c,event.currentTarget)}>{part}</button>:<span key={j}>{part.startsWith('【')?part:coloredCountries(part)}</span>;})}</p>;
},(a,b)=>a.entry.text===b.entry.text&&a.entry.round===b.entry.round&&a.entry.seat===b.entry.seat&&a.balance===b.balance&&a.open===b.open);

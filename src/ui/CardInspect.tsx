import {useState,useRef} from 'react';
import {createPortal} from 'react-dom';
import {CardFace} from './CardFace';
import {cardName} from '../core/basic';
import type {CardInstance} from '../core';
export function CardInspect({card}:{card:CardInstance}){const [open,setOpen]=useState(false),button=useRef<HTMLButtonElement>(null);return <><button ref={button} className="touch-card-detail" aria-label={`查看${cardName(card)}详情`} onClick={e=>{e.stopPropagation();setOpen(true);}}>详情</button>{open&&createPortal(<div className="touch-card-dialog" role="dialog" aria-modal="true" aria-label="卡牌详情" onKeyDown={e=>{if(e.key==='Escape')setOpen(false);}}><button autoFocus onClick={()=>setOpen(false)}>关闭详情</button><div className="hand-card"><CardFace card={card}/></div></div>,button.current?.closest('.game-map')??document.body)}</>;}

import { canExecuteEffects } from '../core/resolution';
import { useState } from 'react';
import type { Command, ReadState } from '../core';
import { specialCard } from '../core/cardCatalog';
import { barbarossaTargets, cardEffects } from '../core/specialCards';
import { cardTargetChoices } from '../core/extraCards';
import { COUNTRY_NAMES, cardName } from '../core/basic';
import { REGION_BY_ID } from '../core/map';
import { effectText } from '../core/effectNames';

export function CardPlayForm({state,cardId,busy,dispatch}: {state:ReadState;cardId:string;busy:boolean;dispatch:(c:Command)=>Promise<void>}) {
  const [targets,setTargets]=useState<string[]>([]);
  const [excluded,setExcluded]=useState<number[]>([]);
  const card=state.decks[state.activeSeat].hand.find(c=>c.id===cardId)!;
  const d=specialCard(card.definitionId,card.balance),effects=cardEffects(state,card,targets);
  const selected=effects.flatMap((_,i)=>excluded.includes(i)?[]:[i]);
  const targetSeats=d?.sourceIndex===162?[]:cardTargetChoices(state,card) as (keyof typeof COUNTRY_NAMES)[];
  return <div className="action-options"><p>已选择：{cardName(card)}</p>
    {d?.type==='增强'?<p>增强牌须在规定时点从弹出的触发窗口打出，不能占用普通出牌行动。</p>:<>
    {targetSeats.map(s=><label key={s}><input type="radio" name="economic-target" checked={targets[0]===s} onChange={()=>{setTargets([s]);setExcluded([]);}} />{COUNTRY_NAMES[s]}</label>)}
    {d?.sourceIndex===162 && <div><p>选择至多 3 支苏联陆军，按点击顺序逐次发起战斗。各次重新选择发起部队。</p>{barbarossaTargets(state).map(id=>{const u=state.units.find(u=>u.id===id)!;return <label key={id}><input type="checkbox" checked={targets.includes(id)} disabled={!targets.includes(id)&&targets.length>=3} onChange={()=>{setTargets(v=>v.includes(id)?v.filter(x=>x!==id):[...v,id]);setExcluded([]);}} />{REGION_BY_ID[u.regionId].name}{targets.includes(id)?`（第 ${targets.indexOf(id)+1} 次）`:''}</label>;})}</div>}
    {effects.length>1 && <div><p>可取消独立效果；保留的效果按牌面顺序结算。</p>{effects.map((e,i)=><label key={i}><input type="checkbox" checked={selected.includes(i)} disabled={e.fee} onChange={()=>setExcluded(v=>v.includes(i)?v.filter(j=>j!==i):[...v,i])} />{effectText(e.label)}</label>)}</div>}
    <button className="primary" disabled={busy || !selected.length || !canExecuteEffects(state,effects.filter((_,i)=>selected.includes(i))) || card.definitionId==='air_power'&&state.phase!=='AIR'} onClick={()=>dispatch({type:'PLAY_CARD',seat:state.activeSeat,expectedRevision:state.revision,cardId,effectIndices:selected,targetIds:targets})}>{d?.type==='响应'?'暗置此响应牌':d?.type==='状态'?'打出此状态牌':'打出并选择合法行动'}</button>
    {!effects.length && <p>请先选择卡牌要求的目标；没有合法效果时不能打出，也不会消耗此牌。</p>}
    </>}
  </div>;
}

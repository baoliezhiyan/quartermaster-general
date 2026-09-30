import {sortCardChoices} from '../core/cardChoiceOrder';
import type { Dispatch, SetStateAction } from 'react';
import { resolutionTargets } from './map/targetChoices';
import { TargetPicker } from './map/TargetPicker';
import { CardFace, choiceCard } from './CardFace';
import { useState } from 'react';
import type { Command, ReadState } from '../core';
import { COUNTRY_NAMES, cardName } from '../core/basic';
import { RESOLUTION_SCENARIOS } from '../core/resolutionScenarios';
import { effectText } from '../core/effectNames';

export function ResolutionPanel({state,dispatch,busy,pickedRegion,onClear,compact=false,mapSelectedIds=[],setMapSelectedIds}: {state:ReadState;dispatch:(c:Command)=>Promise<void>;busy:boolean;pickedRegion?:string|null;onClear?:()=>void;compact?:boolean;mapSelectedIds?:string[];setMapSelectedIds?:Dispatch<SetStateAction<string[]>>}) {
  const [localSelected,setLocalSelected]=useState<string[]>([]);
  const r=state.resolution, choice=r?.choice;
  const mapTargets=resolutionTargets(state);
  const multiMap=mapTargets.length>0 && !!choice && choice.max>1 && !!setMapSelectedIds;
  const selected=multiMap?mapSelectedIds:localSelected;
  const setSelected=multiMap?setMapSelectedIds!:setLocalSelected;
  const common={seat:state.viewSeat,expectedRevision:state.revision};
  const choose=(ids:string[])=>choice && dispatch({type:'RESOLVE_ENGINE_CHOICE',...common,choiceId:choice.id,ids});
  const blocked=busy || state.status!=='PLAYING' || !!state.pendingDiscard || !!state.pendingAir.length || state.mode!=='BASIC_DEBUG' || state.viewSeat!==state.activeSeat || !!r?.running;
  if(r?.running&&choice&&state.viewSeat!==choice.seat)return <section className="turn-panel" aria-label="等待其他玩家回应"><h3>等待其他玩家回应中</h3><p>当前暂停：{r.scenario}。对方回答前不会继续执行。</p></section>;
  return <section className="turn-panel" aria-label={state.mode!=='BASIC_DEBUG'?'卡牌结算':'第五步结算器'}>
    <div className="section-heading"><h3>{state.mode!=='BASIC_DEBUG'?'卡牌结算与选择':'第五步 · 结算器纵向切片'}</h3><span>{r?.running?'等待选择':state.mode!=='BASIC_DEBUG'?'结算完成':'可试玩六个裁决示例'}</span></div>
    {state.mode==='BASIC_DEBUG' && <details open={!r}><summary>选择裁决示例</summary><p>示例牌用于验证时序，会改变当前调试局的牌库或分数，不推进回合。它们不是正式卡池；重开示例仅清理旧示例牌。</p>{RESOLUTION_SCENARIOS.map(v=><div className="turn-actions" key={v.id}><button disabled={blocked} onClick={()=>dispatch({type:'START_RESOLUTION_SCENARIO',...common,scenarioId:v.id})}>{v.name}</button><span>{v.hint}</span></div>)}</details>}
    {r && <>{!compact && <><p><strong>{r.scenario}</strong> · {r.running?'结算中':'已完成'}</p><p aria-label="实际执行顺序">实际执行顺序：{r.trace.map(effectText).join(' → ') || '尚未应用效果'}</p></>}
    {choice && <div className="engine-choice"><h4>{COUNTRY_NAMES[choice.seat]} · {effectText(choice.prompt)}</h4>{state.viewSeat!==choice.seat ? <button onClick={()=>dispatch({type:'SET_VIEW',seat:choice.seat,expectedRevision:state.revision})}>返回需要选择的玩家</button> : choice.kind==='TRIGGER' ? <>
      <p>选择较早时点的效果会关闭其下方较深的窗口；已开始的卡牌剩余效果仍会完成。</p>
      <div className="card-grid">{sortCardChoices(choice.options).map(o=>{
        const w=r.windows.find(w=>w.id===o.windowId)!, event=r.events.find(e=>e.id===w.originEventId)!;
        const rule=r.rules.find(rule=>o.id===`${w.id}/${rule.id}`);
        const card=rule && rule.source!=='system'?Object.values(state.decks).flatMap(d=>[...d.hand,...d.active,...d.faceDown]).find(c=>c.id===rule.sourceInstanceId):undefined;
        const hint=`${o.label} · ${event.label}的${w.timing==='Before'?'生效前':'生效后'}时点${w.id!==choice.windowId?'（祖先）':''}`;
        return <button className={card?'hand-card':'selection-option'} key={o.id} disabled={busy} onClick={()=>choose([o.id])}>{card?<CardFace card={card} hint={hint} />:hint}</button>;
      })}</div>
      <button disabled={busy} onClick={()=>choose([])}>{choice.seat===r.owner?'不再触发，结束本国当前时点':'不响应'}</button>
    </> : mapTargets.length>0 && choice.max===1 ? <TargetPicker key={`${choice.id}:${pickedRegion}`} options={mapTargets} pickedRegion={pickedRegion??null} busy={busy} onConfirm={id=>choose([id])} onClear={()=>onClear?.()} /> : choice.kind==='REALLOCATE' ? <div className="card-grid">{sortCardChoices(choice.options).map(o=>{const card=choiceCard(state,o);return <button key={o.id} className={card?'hand-card':'selection-option'} disabled={busy} onClick={()=>choose([o.id])}>{card?<CardFace card={card} hint="选择取得此牌" />:cardName({definitionId:o.label})}</button>;})}</div> : ['ACTION','RELOCATE'].includes(choice.kind) ? <div className="action-options">{choice.options.filter(o=>!pickedRegion || !choice.options.some(v=>v.id===pickedRegion) || o.id===pickedRegion).map(o=><button key={o.id} disabled={busy} onClick={()=>choose([o.id])}>{o.label}</button>)}</div> : <>{multiMap && <p>点击绿色地区选择目标，再次点击可取消；黄色地区按点击顺序结算。也可使用下方选项。</p>}<p>{choice.kind==='ORDER_MANDATORY_TRIGGERS'?'按希望的顺序依次点击全部效果；再次点击可移出顺序。':['EFFECTS','EXTRA_EFFECTS'].includes(choice.kind)?'选择至少一项效果；费用不能跳过。':`选择 ${choice.min===choice.max?choice.min:`${choice.min} 至 ${choice.max}`} 项（已选 ${selected.length} 项），如有顺序要求，请按顺序点击。`}</p><div className={['FORCE_HAND','PAY_COST','CARDS','EXTRA_CARD'].includes(choice.kind)?'card-grid':'choice-grid'}>{sortCardChoices(choice.options).map((o,index)=>{
      const card=['FORCE_HAND','PAY_COST','CARDS','EXTRA_CARD'].includes(choice.kind)?choiceCard(state,o):undefined;
      const picked=selected.includes(o.id), hint=picked?`✓ 已选第 ${selected.indexOf(o.id)+1} 项`:`第 ${index+1} 项`;
      return <button className={`${card?'hand-card':'selection-option'}${picked?' selected':''}`} key={o.id} disabled={busy} aria-pressed={picked} onClick={()=>setSelected(ids=>ids.includes(o.id)?ids.filter(id=>id!==o.id):[...ids,o.id])}>{card?<CardFace card={card} hint={hint} />:<>{['ORDER_MANDATORY_TRIGGERS','EFFECTS','EXTRA_EFFECTS','SELECT','EXTRA_TARGET'].includes(choice.kind)?effectText(o.label):cardName({definitionId:o.label})}<small>{hint}</small></>}</button>;
    })}</div><button className="primary" disabled={busy || (selected.length<Math.max(1,choice.min) || selected.length>choice.max)} onClick={()=>choose(selected)}>{choice.kind==='ORDER_MANDATORY_TRIGGERS'?'确认必发顺序':'确认选择'}</button>{(choice.canSkip||choice.min===0)&&<button disabled={busy} onClick={()=>choose([])}>跳过</button>}</> }</div>}
    <details><summary>查看结算帧、窗口与卡牌去向</summary><ol>{r.frames.map(f=><li key={f.id}>【{f.source}】：{f.status==='COMPLETE'?'完成':f.status==='WAITING_CHOICE'?'等待选择':f.status==='WAITING_RESPONSE'?'等待响应':'处理中'} · 效果 {Math.min(f.nextEffectIndex+1,f.effects.length)}/{f.effects.length}</li>)}</ol><p>保留的时点：{r.windows.filter(w=>!w.closed).map(w=>r.events.find(e=>e.id===w.originEventId)?.label).join('、')||'无'}</p><p>结算中卡牌：{Object.values(state.decks).flatMap(d=>d.resolving).map(cardName).join('、')||'无'}</p></details></>}
  </section>;
}

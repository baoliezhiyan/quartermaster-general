import { CardFace } from './CardFace';
import { useEffect, useState } from 'react';
import type { Command, CountryId, ReadState, SeatId } from '../core';
import { SEATS } from '../core';
import { COUNTRY_NAMES, UNIT_NAMES, reserve } from '../core/basic';
import { placementPlans } from '../core/placement';
import { REGIONS } from '../core/map';

export function RulesLab({ state, dispatch, busy }: { state: ReadState; dispatch: (c: Command) => Promise<void>; busy: boolean }) {
  useEffect(()=>{ setSelected([]); },[state.revision]);
  const [target,setTarget] = useState<SeatId>(state.activeSeat);
  const [count,setCount] = useState(3);
  const [selected,setSelected] = useState<string[]>([]);
  const [country,setCountry] = useState<CountryId>(state.activeSeat);
  const [unitType,setUnitType] = useState<'army' | 'navy'>('army');
  const [mode,setMode] = useState<'build' | 'recruit'>('recruit');
  const [regionId,setRegionId] = useState('');
  const [cost,setCost] = useState(0);
  const choice = state.pendingDiscard;
  const seat = choice?.seat ?? state.activeSeat;
  const hand = state.decks[seat].hand;
  const common = { seat:state.viewSeat,expectedRevision:state.revision };
  const locked = busy || !!state.resolution?.running || state.status !== 'PLAYING' || state.viewSeat !== seat || !!state.pendingAir.length;
  const selection = <div className="card-grid">{hand.map((c,index)=><button className={`hand-card${selected.includes(c.id) ? ' selected' : ''}`} key={c.id} aria-pressed={selected.includes(c.id)} disabled={locked} onClick={()=>setSelected(ids=>ids.includes(c.id) ? ids.filter(id=>id!==c.id) : [...ids,c.id])}><CardFace card={c} hint={selected.includes(c.id) ? `✓ 已选择 · 第 ${index+1} 张` : `第 ${index+1} 张`} /></button>)}</div>;
  if (choice) return <section className="turn-panel" aria-label="强制弃牌选择"><h3>{COUNTRY_NAMES[choice.seat]}必须弃置手牌</h3><p>要求 {choice.count} 张，实际需选 {Math.min(choice.count,hand.length)} 张。由手牌所属玩家选择，不能跳过；缺额不扣分。</p>{selection}<button className="primary" disabled={locked || selected.length !== Math.min(choice.count,hand.length)} onClick={()=>dispatch({ type:'RESOLVE_FORCED_DISCARD',...common,cardIds:selected })}>确认强制弃牌（已选 {selected.length} 张）</button>{state.viewSeat !== seat && <button onClick={()=>dispatch({type:'SET_VIEW',seat,expectedRevision:state.revision})}>返回弃牌玩家</button>}</section>;
  const plans = placementPlans(state,{ country,unitType,mode,regionIds:[regionId] });
  const validCount = Number.isSafeInteger(count) && count >= 0 && count <= 100;
  const validCost = Number.isSafeInteger(cost) && cost >= 0;
  const effect = (operation: 'pay' | 'force' | 'top' | 'draw') => dispatch({ type:'DEBUG_DECK',...common,operation,target:operation === 'pay' ? seat : target,count,cardIds:selected });
  return <details className="turn-panel rules-lab"><summary>第四步规则试验：牌库与兵模</summary><p>试验会改变当前调试局，不推进阶段。这里模拟费用与效果，尚未绑定特殊牌。正常游戏操作仍在上方。</p>
    <fieldset disabled={locked}><legend>牌库操作</legend><label>目标牌库 <select aria-label="试验目标牌库" value={target} onChange={e=>setTarget(e.target.value as SeatId)}>{SEATS.map(s=><option key={s} value={s}>{COUNTRY_NAMES[s]}</option>)}</select></label> <label>张数 <input aria-label="试验张数" type="number" min="0" max="100" value={count} onChange={e=>setCount(Number(e.target.value))} /></label>
    <p>目标手牌 {state.decks[target].hand.length} 张，牌库 {state.decks[target].drawPile.length} 张。弃牌库顶将扣 {validCount ? Math.max(0,count-state.decks[target].drawPile.length) : '—'} 分，计入{COUNTRY_NAMES[target]}；摸牌不足不扣分。</p>
    <div className="turn-actions"><button disabled={!validCount} onClick={()=>effect('force')}>强制目标弃手牌</button><button disabled={!validCount} onClick={()=>effect('top')}>弃目标牌库顶</button><button disabled={!validCount} onClick={()=>effect('draw')}>目标摸牌</button></div>
    <p>主动费用由{COUNTRY_NAMES[seat]}支付，选择下方手牌（已选 {selected.length} 张）。{count > 0 && !hand.length ? '无手牌，不能发动。' : hand.length < count ? '手牌不足，不能支付该费用。' : ''}</p>{selection}<button disabled={!validCount || hand.length < count || selected.length !== count} onClick={()=>effect('pay')}>支付 {count} 张费用</button></fieldset>
    <fieldset disabled={locked}><legend>建设 / 征召完整方案</legend><label>兵模国家 <select aria-label="兵模国家" value={country} onChange={e=>setCountry(e.target.value as CountryId)}>{Object.entries(COUNTRY_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label> <select aria-label="兵种" value={unitType} onChange={e=>setUnitType(e.target.value as 'army'|'navy')}><option value="army">陆军</option><option value="navy">海军</option></select> <select aria-label="放置方式" value={mode} onChange={e=>setMode(e.target.value as 'build'|'recruit')}><option value="recruit">征召</option><option value="build">建设</option></select> <select aria-label="试验放置地区" value={regionId} onChange={e=>setRegionId(e.target.value)}><option value="">选择目标地区</option>{REGIONS.filter(r=>r.type===(unitType==='army'?'LAND':'SEA')).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select> <label>弃牌费用 <input aria-label="放置弃牌费用" type="number" min="0" value={cost} onChange={e=>setCost(Number(e.target.value))} /></label>
    <p>{COUNTRY_NAMES[country]}{UNIT_NAMES[unitType]}储备 {reserve(state,country,unitType)}。征召仅限所选地区，不要求建设补给条件；建设会重新检查补给。费用使用上方所选手牌。</p>
    {regionId && !plans.length && <p>没有完整合法方案：不能支付费用，也不会回收兵模。</p>}
    {reserve(state,country,unitType) === 0 && <p>储备为零：原地重复不需回收；新放置只列出回收后仍可完成的方案。</p>}
    <div className="action-options">{plans.map(p=><button key={p.id} disabled={!validCost || selected.length !== Math.min(cost,hand.length) || cost > 0 && !hand.length} onClick={()=>dispatch({type:'DEBUG_PLACEMENT',...common,country,unitType,mode,regionId,optionId:p.id,cost,cardIds:selected})}>{p.label}</button>)}</div></fieldset>
  </details>;
}

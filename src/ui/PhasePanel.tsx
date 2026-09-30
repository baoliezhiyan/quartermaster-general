import { PHASE_NAMES, TURN_PHASES } from '../core';
import type { Command, ReadState } from '../core';
import { COUNTRY_NAMES } from '../core/basic';
import type { ReactNode } from 'react';

export function PhasePanel({ state, busy, dispatch, undo, record, panels, readOnly=false }: { state:ReadState; busy:boolean; dispatch:(c:Command)=>Promise<void>; undo?:ReactNode; record?:ReactNode; panels?:ReactNode;readOnly?:boolean }) {
  const blocked = busy || state.status!=='PLAYING' || state.viewSeat!==state.activeSeat || !!state.resolution?.running || !!state.pendingDiscard || !!state.pendingAir.length;
  const canAdvance = (state.phase!=='TURN_START_WINDOW' || state.mode==='BASIC_DEBUG') && !['PRELUDE','SETUP','DISCARD'].includes(state.phase) && state.status!=='FINISHED';
  const label = state.phase==='DRAW'?'结束回合，下一国':state.phase==='PLAY'?'不出牌，扣 1 分并继续':state.phase==='AIR'?'结束空军阶段，检查补给':state.phase==='TURN_START_WINDOW'?'结束回合开始窗口':`继续至${PHASE_NAMES[TURN_PHASES[TURN_PHASES.indexOf(state.phase)+1]]}阶段`;
  return <section className="map-phase-panel" aria-label="阶段与推进">
    <h3>{state.prelude?.active?`序章 · ${COUNTRY_NAMES[state.activeSeat]} · 紧张度 ${state.prelude.tension}`:state.phase==='SETUP' ? `${COUNTRY_NAMES[state.viewSeat]} · 起手选择` : `第 ${state.round} 轮 · ${COUNTRY_NAMES[state.activeSeat]} · ${PHASE_NAMES[state.phase]}`}</h3>
    {!state.prelude?.active&&<ol className="phase-strip">{TURN_PHASES.filter(p=>p!=='TURN_START_WINDOW').map(p=><li key={p} aria-current={state.phase===p?'step':undefined}>{PHASE_NAMES[p]}</li>)}</ol>}
    {!readOnly && canAdvance && <button className="primary" disabled={blocked} onClick={()=>dispatch({type:'ADVANCE_PHASE',seat:state.viewSeat,expectedRevision:state.revision})}>{label}</button>}
    {!readOnly&&!state.prelude?.active&&state.prelude&&state.decks[state.viewSeat].faceDown.some(c=>['prelude_UK-07','prelude_US-04','prelude_DE-09',...(state.rules?.balanceEnabled?['prelude_SU-06']:[])].includes(c.definitionId))&&<button disabled={blocked} onClick={()=>dispatch({type:'ARMAMENT_WINDOW',seat:state.viewSeat,expectedRevision:state.revision})}>回合内军备</button>}
    {panels}
    <div className="phase-right-actions"><div className="phase-undo">{undo}</div><div className="map-panel-buttons">{record}</div></div>
  </section>;
}

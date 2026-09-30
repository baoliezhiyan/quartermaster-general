import {neutralityDiscardPenalty} from '../core/neutrality';
import type { MapAction } from './map/targetChoices';
import {mayReallocate} from '../core/neutrality';
import { CardPlayForm } from './CardPlayForm';
import { CardFace } from './CardFace';
import { statusActionEffects } from '../core/statusActions';
import { canExecuteEffects } from '../core/resolution';
import { useEffect, useMemo, useState } from 'react';
import { PHASE_NAMES, SEATS } from '../core';
import type { Command, ReadState } from '../core';
import { BASIC_NAMES, REALLOCATION_CARD_IDS, COUNTRY_NAMES, cardName } from '../core/basic';
import { airDestinations, airMoveOptions, cardOptions } from '../core/actions';
import { REGION_BY_ID } from '../core/map';

export function TurnPanel({ state, dispatch, busy, onMapAction, pickedRegion, choiceCards={}, chosenCards=[], onChoiceCard, onPlayCard, playCardId }: {
  state: ReadState; dispatch: (command: Command) => Promise<void>; busy: boolean;
  onMapAction: (action: MapAction | null) => void; pickedRegion: string | null;
  choiceCards?:Record<string,string[]>; chosenCards?:string[]; onChoiceCard?:(id:string)=>void; onPlayCard?:(id:string)=>void; playCardId?:string|null;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [cardId, setCardId] = useState('');
  const [moveAir, setMoveAir] = useState(false);
  const [takeCardId, setTakeCardId] = useState('');
  const seat = state.viewSeat, deck = state.decks[seat];
  const active = seat === state.activeSeat;
  const setup = state.phase === 'SETUP';
  const multi = setup || state.phase === 'DISCARD' || state.phase === 'TURN_START_WINDOW';
  const canOperate = !busy && !state.resolution?.running && !state.pendingDiscard && state.status !== 'FINISHED' && (setup || active || !!state.pendingAir.length);
  const options = useMemo(() => moveAir && state.phase === 'AIR' && active ? airMoveOptions(state,seat) : state.mode!=='BASIC_DEBUG' ? [] : cardOptions(state,cardId),[state,cardId,moveAir,active,seat]);
  const destinations = useMemo(() => state.pendingAir.length ? airDestinations(state,state.pendingAir[0]) : [],[state]);
  useEffect(() => {
    const common = { seat, expectedRevision:state.revision };
    const choices = destinations.length ? destinations.map(regionId => ({ id:regionId, regionId, label:REGION_BY_ID[regionId].name, command:{ type:'RELOCATE_AIR' as const,...common,regionId } }))
      : cardId ? options.map(o => ({ ...o,command:{ type:moveAir?'MOVE_AIR' as const:'PLAY_BASIC' as const,...common,cardId,optionId:o.id } })) : [];
    onMapAction(choices.length && !state.resolution?.running ? { key:`${state.gameId}:${state.revision}:${cardId}:${moveAir}`, prompt:destinations.length?'选择空军免费强制调度目的地':'选择地图目标并确认行动', options:choices } : null);
  },[onMapAction,options,destinations,cardId,moveAir,seat,state.revision,state.gameId,state.resolution?.running]);
  const common = { seat, expectedRevision:state.revision };
  const toggle = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids,id]);
  const filtered = pickedRegion && options.some(o => o.regionId === pickedRegion) ? options.filter(o => o.regionId === pickedRegion) : options;
  const ended = state.status === 'FINISHED';
  return <section className="turn-panel" aria-label="回合与手牌">
    <div className="section-heading"><h3>{setup ? `${COUNTRY_NAMES[seat]} · 起手选择 · 已完成 ${state.setupCompleted.length}/6` : `第 ${state.round} 轮 · ${COUNTRY_NAMES[state.activeSeat]} · ${PHASE_NAMES[state.phase]}`}</h3><span>{state.mode==='FULL'?'完整牌组':state.mode==='REPRESENTATIVE'?'代表牌小牌组':'基础牌调试局'}</span></div>
    {ended ? <p className="victory-message">{state.winner === 'axis' ? '轴心国' : '同盟国'}获胜。{state.victoryReason === 'AXIS_LEAD' ? '美国计分结束时领先至少 30 分。' : '20 轮结束，轴心国额外加 0.5 分。'}</p> : <>
      {!setup && !active && !state.resolution?.running && !state.pendingAir.length && <p className="turn-notice">正在查看{COUNTRY_NAMES[seat]}；当前应由{COUNTRY_NAMES[state.activeSeat]}操作。<button onClick={() => dispatch({ type:'SET_VIEW',seat:state.activeSeat,expectedRevision:state.revision })}>返回当前行动国</button></p>}
      {setup && <div className="turn-actions"><p>{state.setupCompleted.includes(seat) ? '这个国家已完成起手选择。' : '点击保留 7 张，其余 5 张进入弃牌堆。起手选择不扣分。'}</p><button className="primary" disabled={!canOperate || selected.length !== 7 || state.setupCompleted.includes(seat)} onClick={() => dispatch({ type:'KEEP_OPENING',...common,cardIds:selected })}>保留所选 {selected.length}/7 张</button>{state.setupCompleted.length > 0 && <span>已完成起手选择：{SEATS.filter(s => state.setupCompleted.includes(s)).map(s => COUNTRY_NAMES[s]).join('、')}</span>}</div>}
      {state.pendingAir.length > 0 ? <div className="turn-actions"><p>请选择空军的免费强制调度目的地。</p>{destinations.map(regionId => <button key={regionId} disabled={busy} onClick={() => dispatch({ type:'RELOCATE_AIR',...common,regionId })}>{REGION_BY_ID[regionId].name}</button>)}</div> : <>
        {state.mode === 'BASIC_DEBUG' && state.phase === 'TURN_START_WINDOW' && active && mayReallocate(state,state.viewSeat) && <div className="turn-actions"><p>可选资源再分配：支付 3 张弃手牌费用（必须足额支付；不足3张不能发动），从牌库取 1 张建设或战斗基本牌，也可取得空中力量。本调试局尚无特殊牌回合开始效果。</p><select aria-label="资源再分配取得的卡牌" value={takeCardId} onChange={e => setTakeCardId(e.target.value)} disabled={state.redistributed}><option value="">选择基本牌</option>{REALLOCATION_CARD_IDS.map(id => {
          const name = BASIC_NAMES[id];
          const card = deck.drawPile.find(c => c.definitionId === id);
          return card ? <option key={id} value={card.id}>{name}（剩余 {deck.drawPile.filter(c => c.definitionId === id).length}）</option> : null;
        })}</select><button disabled={!canOperate || state.redistributed || deck.hand.length < 3 || selected.length !== 3 || !takeCardId} onClick={() => dispatch({ type:'REDISTRIBUTE',...common,cardIds:selected,takeCardId })}>{state.redistributed ? '本回合已再分配' : `弃所选 ${selected.length}/3 张并取得卡牌`}</button></div>}
        {state.phase === 'PLAY' && active && <p className="turn-notice">{state.mode!=='BASIC_DEBUG'?'可打出一张基本牌、事件或经济战牌，或部署状态、暗置响应；增强牌在对应时点询问。也可不出牌并扣 1 分，结束出牌阶段。':'可打出一张基本牌并选择合法行动，也可不出牌并扣 1 分，结束出牌阶段。'}</p>}
        {!onPlayCard&&state.phase==='PLAY'&&active&&state.mode!=='BASIC_DEBUG'&&deck.active.filter(card=>canExecuteEffects(state,statusActionEffects(state,card))).map(card=><button key={card.id} disabled={!canOperate} onClick={()=>dispatch({type:'STATUS_ACTION',...common,cardId:card.id})}>用【{cardName(card)}】代替本阶段出牌</button>)}
        {state.phase === 'AIR' && active && <div className="turn-actions"><p>可打出空中力量，或弃一张手牌调度空军。</p><label><input type="checkbox" checked={moveAir} onChange={e => { setMoveAir(e.target.checked); setCardId(''); }} /> 弃牌调度空军</label></div>}
        {state.phase === 'DISCARD' && active && <div className="turn-actions"><p>{neutralityDiscardPenalty(state,state.activeSeat)?'美国中立期间，弃牌阶段不弃牌扣1分。':'选择要弃置的手牌，也可选择不弃牌，不扣分。'}</p><button className="primary" disabled={!canOperate || !selected.length} onClick={() => dispatch({ type:'DISCARD_HAND',...common,cardIds:selected })}>弃置所选 {selected.length} 张并摸牌</button><button disabled={!canOperate} onClick={() => dispatch({ type:'DISCARD_HAND',...common,cardIds:[] })}>{neutralityDiscardPenalty(state,state.activeSeat)?'不弃牌并摸牌（扣1分）':'不弃牌并摸牌'}</button></div>}
      </>}
    </>}
    <div className="section-heading hand-heading"><h3>{COUNTRY_NAMES[seat]}手牌</h3><span>手牌 {deck.hand.length} · 牌库 {deck.drawPile.length} · 弃牌 {deck.discardPile.length}</span></div>
    {!onPlayCard && cardId && active && !multi && state.mode!=='BASIC_DEBUG' && !moveAir && <CardPlayForm key={cardId} state={state} cardId={cardId} busy={busy} dispatch={dispatch} />}
    <div className="card-grid">{deck.hand.map(card => {
      const enabled = canOperate && !state.pendingAir.length && (setup ? !state.setupCompleted.includes(seat) : active && (multi || state.phase === 'PLAY' || state.phase === 'AIR'));
      const offered=!!choiceCards[card.id];
      const picked = offered?chosenCards.includes(card.id):multi ? selected.includes(card.id) : (playCardId??cardId) === card.id;
      return <button key={card.id} className={`hand-card${offered?' available-card':''}${picked ? ' selected' : ''}`} aria-pressed={picked} aria-label={`${cardName(card)}，${card.id}`} disabled={!enabled&&!offered} onClick={() => offered ? onChoiceCard?.(card.id) : multi ? toggle(card.id) : onPlayCard&&!moveAir ? onPlayCard(card.id) : setCardId(cardId === card.id ? '' : card.id)}><CardFace card={card} hint={picked ? offered&&state.resolution?.choice&&state.resolution.choice.max>1?'第 '+(chosenCards.indexOf(card.id)+1)+' 项':'✓ 已选择' : enabled||offered ? '点击选择' : '查看牌面'} /></button>;
    })}</div>
    {!deck.hand.length && <p className="empty-note">当前没有手牌。</p>}
    {!onPlayCard && cardId && active && !multi && (state.mode==='BASIC_DEBUG' || moveAir) && <div className="action-options"><p>{options.length ? '地图已标出合法地区；也可直接选择下列行动。' : '当前没有可执行的合法行动；未消耗此牌。'}{pickedRegion && options.some(o => o.regionId === pickedRegion) ? ` 当前筛选：${REGION_BY_ID[pickedRegion].name}。` : ''}</p>{filtered.map(option => <button key={option.id} disabled={!canOperate} onClick={() => dispatch({ type:moveAir ? 'MOVE_AIR' : 'PLAY_BASIC',...common,cardId,optionId:option.id })}>{option.label}</button>)}</div>}
  </section>;
}

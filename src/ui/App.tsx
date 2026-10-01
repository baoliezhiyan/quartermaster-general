import {openReplay} from '../actionReplay/openReplay';
import type {ReplayView} from '../actionReplay/ReplayController';
import {ReplayRecord} from '../actionReplay/ReplayRecord';
import {RoomRecord} from './RoomRecord';
import {VERSION as GAME_VERSION} from '../actionReplay/state';
import {regularCatalog,preludeCatalog} from '../core/cardCatalog';
import {TurnEntryNotice,VictoryNotice} from './GameAlerts';
import {BoundCountrySwitch} from './BoundCountrySwitch';
import {randomSeed,randomIndex} from '../network/random';
import {RoomSeats} from './RoomSeats';
import {NetworkGameController} from '../network/NetworkGameController';
import {pendingResponseSeats,waitingResponseSeats} from '../core/resolution';
import type {RoomAccess} from '../controller/GameController';
import {PublicCountryInfo} from './PublicCountryInfo';
import { TableHand } from './TableHand';
import { playableCard,usableStatus } from './playAvailability';
import { MapPanelContent, panelLabel, visibleMapPanels } from './MapPanels';
import { GuidedPrompt } from './GuidedPrompt';
import { ResponseNotices } from './ResponseNotices';
import {NeutralityNotice} from './NeutralityNotice';
import { guidedChoices } from './guidedChoices';
import { barbarossaTargets } from '../core/specialCards';
import type { MapPanel } from './MapPanels';
import { LocalTools, UndoButton, saveReplay } from './LocalTools';
import { PhasePanel } from './PhasePanel';
import { resolutionTargets } from './map/targetChoices';
import type { MapAction } from './map/targetChoices';

import { ResolutionPanel } from './ResolutionPanel';
import { RulesLab } from './RulesLab';
import { useMemo,useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SEATS } from '../core';
import type { Command } from '../core';
import type { GameController } from '../controller/GameController';
import { allianceScores } from '../core/supply';
import { SEAT_INFO } from '../data/seats';
import { GameMap } from './map/GameMap';
import { TurnPanel } from './TurnPanel';
import './turn.css';

export function App({ controller: liveController }: { controller: GameController }) {
  const previousAccess=useRef<RoomAccess|null>(null);
  const [factReplay,setFactReplay]=useState<ReplayView|null>(null);
  const [replayError,setReplayError]=useState('');
  useEffect(()=>{const open=(event:Event)=>{setReplayError('');void openReplay((event as CustomEvent<string>).detail).then(a=>{previousAccess.current=liveController.getSessionInfo().room?.access??{kind:'gm'};setFactReplay(a);setAccess({kind:'gm'});setRecordOpen(true);}).catch(e=>setReplayError(String(e)));};window.addEventListener('qm-open-replay',open);return()=>window.removeEventListener('qm-open-replay',open);},[]);
  const controller:GameController=factReplay??liveController;
  const state = useSyncExternalStore(controller.subscribe,controller.getSnapshot);
  const sessionInfo=useSyncExternalStore(controller.subscribe,controller.getSessionInfo);
  const room=sessionInfo.room;
  const [infoSeat,setInfoSeat]=useState<typeof SEATS[number]|null>(null);
  const [localAccess,setAccess]=useState<RoomAccess>({kind:'player',seat:controller.getSnapshot()?.viewSeat??'germany'});
  const access=room?.access??localAccess;
  const replayMode=sessionInfo.replayMode;
  const isGM=access.kind==='gm',readOnly=replayMode||access.kind==='observer'||access.kind==='public',isPublic=access.kind==='public';
  const [replayOpen,setReplayOpen]=useState(false);
  useEffect(()=>{if(replayMode){if(!room){setAccess({kind:'gm'});controller.setRoomAccess({kind:'gm'});}setReplayOpen(true);}else setReplayOpen(false);},[controller,replayMode]);
  useEffect(()=>{if(replayOpen&&replayMode&&isGM)void controller.loadReplayEntries?.().catch(e=>setError(String(e)));},[controller,replayOpen,replayMode,isGM,room?.epoch]);
  useEffect(()=>{if(!room)controller.setRoomAccess(access);},[controller,access]);
  useEffect(()=>{const s=controller.getSnapshot();if(!factReplay&&!room&&s&&(!replayMode||access.kind==='observer')&&(access.kind==='player'||access.kind==='observer')&&s.viewSeat!==access.seat)void controller.dispatch({type:'SET_VIEW',seat:access.seat,expectedRevision:s.revision});},[controller,state?.gameId,access,replayMode]);
  const waitingSeats=useMemo(()=>state&&!readOnly?waitingResponseSeats(state,state.viewSeat):[],[state,readOnly]);
  const isWaiting=!!state&&!readOnly&&(state.resolution?.waiting??waitingSeats.length>0);
  const responseSeats=useMemo(()=>isGM&&!replayMode&&state?pendingResponseSeats(state):[],[state,isGM,replayMode]);
  const [gmReturnSeat,setGMReturnSeat]=useState<typeof SEATS[number]|null>(null);
  const previousGMView=useRef(state);
  useEffect(()=>{
    const previous=previousGMView.current;previousGMView.current=state;
    if(!isGM||replayMode||!state||!previous||state.gameId!==previous.gameId||state.round!==previous.round||state.activeSeat!==previous.activeSeat){setGMReturnSeat(null);return;}
    setGMReturnSeat(original=>{
      if(original)return state.viewSeat===original?null:original;
      if(state.viewSeat!==previous.viewSeat&&pendingResponseSeats(previous).includes(state.viewSeat))return previous.viewSeat;
      return null;
    });
  },[isGM,state,replayMode]);
  const [seed,setSeed] = useState('1940');
  const [enablePrelude,setEnablePrelude] = useState(true);
  const [enableNeutrality,setEnableNeutrality] = useState(true);
  const [enableBalance,setEnableBalance] = useState(true);
  const [submitting,setBusy] = useState(false);
  const busy=submitting||!!room&&!room.connected||!!room?.sceneLocked&&!isGM;
  const submittingRef=useRef(false);
  const [error,setError] = useState('');
  const [newGameOpen,setNewGameOpen] = useState(false);
  const [mapAction,setMapAction] = useState<MapAction | null>(null);
  const [pickedRegion,setPickedRegion] = useState<string | null>(null);
  const [mapSelectedIds,setMapSelectedIds] = useState<string[]>([]);
  const [focusCard,setFocusCard]=useState<string|null>(null);
  const [playCardId,setPlayCardId]=useState<string|null>(null);
  const [playTargets,setPlayTargets]=useState<string[]>([]);
  const projection=useMemo(()=>state&&!readOnly?guidedChoices(state):{cards:{} as Record<string,string[]>,panels:new Set<MapPanel>(),ordered:false},[state,readOnly]);
  const currentChoice=state?.resolution?.running?state.resolution.choice:null;
  const toggleChoice=(id:string)=>setMapSelectedIds(ids=>ids.includes(id)?ids.filter(v=>v!==id):(currentChoice?.max??1)===1?[id]:ids.length<(currentChoice?.max??1)?[...ids,id]:ids);
  const selectCard=(id:string)=>{const options=projection.cards[id];if(options?.length===1){setFocusCard(null);toggleChoice(options[0]);}else if(options?.length){setFocusCard(v=>v===id?null:id);setMapSelectedIds([]);}else{setPlayCardId(v=>v===id?null:id);setPlayTargets([]);}};
  const chosenCards=Object.keys(projection.cards).filter(id=>projection.cards[id].some(v=>mapSelectedIds.includes(v))||id===focusCard).sort((a,b)=>mapSelectedIds.findIndex(id=>projection.cards[a].includes(id))-mapSelectedIds.findIndex(id=>projection.cards[b].includes(id)));
  const choosingBarbarossa=!!state&&!currentChoice&&!!playCardId&&state.decks[state.viewSeat].hand.some(c=>c.id===playCardId&&c.definitionId==='special_162');
  const legalUnitIds=readOnly?[]:mapAction?.customPrompt&&mapAction.key.startsWith(`${state?.gameId}:${state?.viewSeat}:`)?mapAction.unitIds??[]:state?choosingBarbarossa?barbarossaTargets(state):currentChoice?.seat===state.viewSeat?currentChoice.options.filter(o=>state.units.some(u=>u.id===o.id)).map(o=>o.id):[]:[];
  const selectUnit=(id:string)=>{if(busy)return;if(mapAction?.customPrompt&&mapAction.onUnit){mapAction.onUnit(id);return;}if(choosingBarbarossa)setPlayTargets(ids=>ids.includes(id)?ids.filter(v=>v!==id):ids.length<3?[...ids,id]:ids);else toggleChoice(id);};
  const [recordOpen,setRecordOpen]=useState(true);
  const [leftPanel,setLeftPanel] = useState<MapPanel | null>('hand');
  useEffect(()=>{setLeftPanel(isPublic?null:state?.prelude?.active?'prelude-hand':'hand');setPlayCardId(null);setPlayTargets([]);},[state?.gameId,state?.prelude?.active,access.kind,'seat' in access?access.seat:null]);

  const activeMapAction = mapAction && state && (mapAction.customPrompt||mapAction.options[0]?.command.expectedRevision===state.revision) ? mapAction : null;
  const mapTargets = readOnly?[]:state?.resolution?.running ? (state.resolution.choice?.seat===state.viewSeat?resolutionTargets(state):[]) : activeMapAction?.options ?? [];
  const legalRegions = [...new Set(mapTargets.map(o=>o.regionId))];
  const mapActive = !!state?.resolution?.running || !!activeMapAction;
  const mapRef = useRef<HTMLDivElement>(null);
  const draftScope=state?`${room?.epoch??''}:${state.gameId}:${access.kind}:${state.viewSeat}:${state.round}:${state.phase}:${state.phase==='SETUP'?state.setupCompleted.includes(state.viewSeat):state.activeSeat}`:'';
  const choiceKey = `${draftScope}:${state?.resolution?.running?state.resolution.choice?.id:mapAction?.key??''}`;
  useEffect(()=>{setPickedRegion(null);setMapSelectedIds([]);setFocusCard(null);setPlayCardId(null);setPlayTargets([]);if(choiceKey){const first=projection.panels.values().next().value;if(first)setLeftPanel(first);}},[choiceKey,state?.viewSeat]);
  useEffect(()=>{
    if(!state)return;
    const offered=new Set(currentChoice?.options.map(o=>o.id)??[]);
    setMapSelectedIds(ids=>ids.every(id=>offered.has(id))?ids:ids.filter(id=>offered.has(id)));
    setFocusCard(id=>id&& !projection.cards[id]?null:id);
    setPlayCardId(id=>id&&![...state.decks[state.viewSeat].hand,...state.decks[state.viewSeat].active].some(c=>c.id===id)?null:id);
    setPickedRegion(id=>id&&!legalRegions.includes(id)?null:id);
  },[state]);
  const previousPanelState=useRef(state);
  useEffect(()=>{
    const previous=previousPanelState.current;previousPanelState.current=state;
    if(!readOnly&&state&&previous&&state.gameId===previous.gameId&&state.activeSeat===previous.activeSeat&&state.viewSeat===previous.viewSeat&&state.viewSeat===state.activeSeat&&!previous.redistributed&&state.redistributed)setLeftPanel('hand');
  },[state,readOnly]);
  useEffect(()=>{if(mapActive) mapRef.current?.scrollIntoView({block:'start',behavior:'smooth'});},[mapActive]);
  const multiMapChoice = !!state?.resolution?.choice && state.resolution.choice.max>1 && mapTargets.length>0;
  const chooseMapRegion = (id:string|null) => {
    if(busy)return;
    if(activeMapAction?.onRegion){activeMapAction.onRegion(id);return;}
    if(currentChoice&&!id){setMapSelectedIds([]);setPickedRegion(null);return;}
    if(currentChoice&&id){const options=mapTargets.filter(o=>o.regionId===id);if(options.length===1){toggleChoice(options[0].id);setPickedRegion(id);return;}}
    if(multiMapChoice && id) {
      const options=mapTargets.filter(o=>o.regionId===id);
      if(options.length===1) setMapSelectedIds(ids=>ids.includes(options[0].id)?ids.filter(v=>v!==options[0].id):ids.length<state!.resolution!.choice!.max?[...ids,options[0].id]:ids);
    }
    setPickedRegion(id);
  };
  const seat = state ? SEAT_INFO[state.viewSeat] : null;
  const totals = state ? allianceScores(state) : null;
  const dispatch = async (command: Command) => {
    if(readOnly&&command.type!=='SET_VIEW'&&!(replayMode&&command.type==='CREATE_GAME'))return;
    if(submittingRef.current||busy)return;
    submittingRef.current=true;setBusy(true); setError('');
    try {
      const result = await controller.dispatch(command);
      if (!result.ok) setError(result.error === 'STALE_REVISION' ? '局面已更新，请重新选择。' : result.error === 'WRONG_OPERATOR' ? '请切换至当前需要操作的国家。' : '此行动当前不合法，请重新选择卡牌或目标。');
      else { setPickedRegion(null); setMapAction(null); }
    } catch(e) { setError(String(e)); }
    finally { submittingRef.current=false;setBusy(false); }
  };
  const chooseAccess=(next:RoomAccess)=>{
    if(factReplay){factReplay.setRoomAccess(next);setAccess(next);setInfoSeat(null);return;}
    if(replayMode&&next.kind==='player')return;
    controller.setRoomAccess(next);setAccess(next);setMapAction(null);setInfoSeat(null);setError('');setNewGameOpen(false);
    if(!room&&state&&(next.kind==='player'||next.kind==='observer'))void dispatch({type:'SET_VIEW',seat:next.seat,expectedRevision:state.revision});
  };
  const drawCountry=async()=>{if(submittingRef.current||busy)return;submittingRef.current=true;setBusy(true);setError('');try{
   if(room)await (controller as NetworkGameController).drawCountry();else chooseAccess({kind:'player',seat:SEATS[randomIndex(SEATS.length)]});
   setMapAction(null);setInfoSeat(null);setNewGameOpen(false);
  }catch(e){setError(String(e));}finally{submittingRef.current=false;setBusy(false);}};
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const numericSeed = Number(seed);
    if (!seed.trim() || !Number.isInteger(numericSeed) || numericSeed < 0 || numericSeed > 0xffffffff) { setError('请输入 0 到 4294967295 之间的整数种子。'); return; }
    await dispatch({ type:'CREATE_GAME',gameId:crypto.randomUUID(),seed:numericSeed,mode:'FULL',prelude:enablePrelude,neutrality:enableNeutrality,balance:enableBalance });
    setNewGameOpen(false);
  };

  if(!sessionInfo.ready) return <main><p role="status">正在恢复本地存档…</p></main>;
  return <div className="app-shell">

    <header className="topbar"><div className="brand"><img className="brand-logo" src="/assets/brand-logo.png" alt="战场军需官" width="627" height="210" /></div><button hidden={!!room&&!isGM} disabled={readOnly} className="topbar-new-game secondary" onClick={()=>{setNewGameOpen(true);requestAnimationFrame(()=>document.getElementById("new-game-form")?.scrollIntoView({block:"center",behavior:"smooth"}));}}>新建对局</button><div className="build-label"><span className="status-dot" />{replayMode?'回放模式 · 只读':room?'多人联机 · 同一房间':'本地单人 · 六国操作'}<span className="version">v{GAME_VERSION}</span></div></header>
    <main>
      {replayError&&<p role="alert" className="error">{replayError}</p>}
      <div className="workspace">
        <div ref={mapRef} className="map-workspace"><GameMap onStandardView={()=>setRecordOpen(true)} legalUnitIds={legalUnitIds} selectedUnitIds={activeMapAction?.customPrompt?activeMapAction.selectedUnitIds??[]:choosingBarbarossa?playTargets:mapSelectedIds} onChooseUnit={selectUnit} scoreboard={totals && <div className="map-scoreboard" aria-label="阵营总分"><span>轴心国 <strong>{totals.axis}</strong></span><span>同盟国 <strong>{totals.allies}</strong></span></div>} alliance={seat?.alliance ?? 'axis'} game={state} legalRegions={legalRegions} selectedRegion={activeMapAction?.customPrompt?activeMapAction.selectedRegion??null:multiMapChoice?null:pickedRegion} selectedRegions={multiMapChoice?mapTargets.filter(o=>mapSelectedIds.includes(o.id)).map(o=>o.regionId):[]} onChooseRegion={chooseMapRegion} targeting={mapTargets.length>0} footer={state?<PhasePanel record={<button aria-pressed={recordOpen} onClick={()=>setRecordOpen(v=>!v)}>对局记录</button>} panels={<div className="map-panel-buttons">{visibleMapPanels(state,isPublic,!!factReplay).filter(([id])=>id!=='record').map(([id])=><button key={id} className={(projection.panels.has(id)||(id==='hand'&&state.decks[state.viewSeat].hand.some(c=>playableCard(state,c)))||(id==='active'&&state.decks[state.viewSeat].active.some(c=>usableStatus(state,c))))?"panel-available":""} aria-pressed={leftPanel===id} onClick={()=>{setReplayOpen(false);setLeftPanel(p=>p===id?null:id);}}>{panelLabel(state,id)}</button>)}{replayMode&&!factReplay&&isGM&&<><button aria-pressed={replayOpen} onClick={()=>setReplayOpen(v=>!v)}>详细回放记录</button><button disabled={busy} onClick={()=>{setBusy(true);void saveReplay(`军需官-回放节点${sessionInfo.replayCursor}-存档.json`,controller.exportReplayNodeSave()).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>导出当前对局为存档</button></>}</div>} state={state} busy={busy} readOnly={readOnly} dispatch={dispatch} undo={!readOnly&&<UndoButton controller={controller} busy={busy} setBusy={setBusy} />} />:undefined}>
    {room?.sceneLocked&&<div role="status" style={{position:'absolute',top:8,left:8,zIndex:100,background:'#fff9de',padding:12}}>GM已锁定场景，正在编辑。{isGM?'完成后请解锁。':'请稍候。'}</div>}<NeutralityNotice state={state} identity={room?.userId??'local'} replay={replayMode}/>
          {state&&<><TurnEntryNotice state={state} room={room??undefined} enabled={!replayMode&&!readOnly}/>{!factReplay&&<VictoryNotice state={state}/>}</>}
          {state&&room&&<BoundCountrySwitch room={room} state={state} busy={busy} choose={chooseAccess}/>}
          {state&&((isGM&&(responseSeats.length>0||gmReturnSeat))||isWaiting)&&<div className="gm-response-switch" aria-label="响应进度">{isGM&&gmReturnSeat&&<button disabled={busy} onClick={()=>dispatch({type:'SET_VIEW',seat:gmReturnSeat,expectedRevision:state.revision})}>返回{SEAT_INFO[gmReturnSeat].name}继续操作</button>}{isGM&&responseSeats.filter(id=>id!==gmReturnSeat).map(id=><button key={id} disabled={busy||state.viewSeat===id} onClick={()=>dispatch({type:'SET_VIEW',seat:id,expectedRevision:state.revision})}>切换到{SEAT_INFO[id].name}</button>)}{isWaiting&&<span className="response-waiting" role="status">等待其他玩家响应{isGM?`：${waitingSeats.map(id=>SEAT_INFO[id].name).join('、')}`:'中'}</span>}</div>}
          {state && !isPublic && <div className={`map-hand-dock${leftPanel==='hand'&&state.mode!=='BASIC_DEBUG'?' table-hand-dock':leftPanel==='prelude-hand'?' prelude-hand-dock':['deck','discard','prelude-deck','prelude-discard','resource-pool'].includes(leftPanel??'')?' catalog-dock':leftPanel==='reserve'?' reserve-dock':leftPanel==='record'?' record-dock':''}`} hidden={!leftPanel} data-collapsed={!leftPanel} aria-label="地图资料窗口">
            {!isPublic&&<div hidden={leftPanel!=='hand'}>{(readOnly||state.mode!=='BASIC_DEBUG')?<TableHand readOnly={readOnly} key={`table:${draftScope}:${!!state.resolution?.running}`} state={state} busy={busy} dispatch={dispatch} choiceCards={projection.cards} chosenCards={chosenCards} onChoiceCard={selectCard} onPlayCard={selectCard} playCardId={playCardId} onMapAction={setMapAction} revealHand={()=>setLeftPanel('hand')}/>:<TurnPanel key={`turn:${state.gameId}:${state.revision}`} state={state} dispatch={dispatch} busy={busy} onMapAction={setMapAction} pickedRegion={pickedRegion}/>}</div>}
            {leftPanel && leftPanel!=='hand' && <MapPanelContent replay={!!factReplay} readOnly={readOnly} infoSeat={infoSeat} onInfoSeat={id=>setInfoSeat(v=>v===id?null:id)} dispatch={dispatch} busy={busy} panel={leftPanel} state={state} choiceCards={projection.cards} chosenCards={[...chosenCards,...(playCardId?[playCardId]:[])]} onCard={selectCard} />}
          </div>}
          {state&&recordOpen&&<div className="map-hand-dock record-dock" aria-label="对局记录窗口">{factReplay?<RoomRecord state={state} infoSeat={infoSeat} onInfoSeat={id=>setInfoSeat(v=>v===id?null:id)} replay={<ReplayRecord controller={factReplay} access={access} choose={chooseAccess} exit={()=>{setFactReplay(null);setAccess(previousAccess.current??{kind:"gm"});setInfoSeat(null);setLeftPanel("hand");}}/>}/>:<MapPanelContent panel="record" room={room} roomRequest={room?(method,...args)=>(controller as NetworkGameController).request(method,...args):undefined} state={state} readOnly={readOnly} infoSeat={infoSeat} onInfoSeat={id=>setInfoSeat(v=>v===id?null:id)} dispatch={dispatch} busy={busy}/>}</div>}
          {state&&replayMode&&!factReplay&&isGM&&replayOpen&&<section className="replay-record-dock" aria-label="详细回放记录"><h3>详细回放记录</h3><div className="replay-record-list">{sessionInfo.replayEntries.map(entry=><button key={entry.index} disabled={busy} aria-current={entry.index===sessionInfo.replayCursor?'step':undefined} onClick={()=>{setBusy(true);setError('');void controller.seekReplay(entry.index).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}><small>第 {entry.round} 轮</small> {entry.text}</button>)}</div></section>}
          {state && !readOnly && <GuidedPrompt state={state} selected={mapSelectedIds} toggle={toggleChoice} focusCard={focusCard} playCardId={playCardId} playTargets={playTargets} setPlayTargets={setPlayTargets} busy={busy} dispatch={dispatch} cancelPlay={()=>{setPlayCardId(null);setPlayTargets([]);}} />}
          {!readOnly&&activeMapAction&&!activeMapAction.customPrompt&&!currentChoice&&!playCardId&&<div className="guided-prompt"><p>{activeMapAction.prompt}</p>{activeMapAction.options.filter(o=>o.regionId===pickedRegion).map(o=><button key={o.id} aria-pressed={mapSelectedIds.includes(o.id)} onClick={()=>setMapSelectedIds(ids=>ids.includes(o.id)?[]:[o.id])}>{o.label}</button>)}<div><button disabled={busy||!activeMapAction.options.some(o=>o.regionId===pickedRegion&&(mapSelectedIds.includes(o.id)||activeMapAction.options.filter(v=>v.regionId===pickedRegion).length===1))} onClick={()=>{const option=activeMapAction.options.find(o=>o.regionId===pickedRegion&&(mapSelectedIds.includes(o.id)||activeMapAction.options.filter(v=>v.regionId===pickedRegion).length===1));if(option)void dispatch(option.command);}}>确认</button></div></div>}
          {state&&infoSeat&&<PublicCountryInfo state={state} seat={infoSeat} onClose={()=>setInfoSeat(null)}/>}
          {state&&!factReplay&&!isPublic&&<ResponseNotices readOnly={readOnly} state={state} busy={busy} dispatch={dispatch}/>}
          {submitting&&<div className="submission-status" role="status">提交中，请稍候…</div>}
          {error && <div className="guided-error" role="alert">{error}</div>}
        </GameMap>      {room?<RoomSeats binding={(seat,bind)=>void (controller as NetworkGameController).request('binding',seat,bind).catch(e=>setError(String(e)))} drawCountry={()=>void drawCountry()} room={room} replay={replayMode} busy={busy} choose={chooseAccess} release={id=>void (controller as NetworkGameController).request('release',id).catch(e=>setError(String(e)))}/>:<section className="seats-section room-seats" aria-label="房间座位"><div className="section-heading"><h3>房间座位</h3></div><div className="seat-list">{SEATS.map((id,index) => <button key={id} className={`seat ${access.kind==='player' && access.seat === id ? 'selected' : ''}`} disabled={!state || busy || replayMode} aria-pressed={access.kind==='player' && access.seat === id} onClick={() => {chooseAccess({kind:'player',seat:id});}}><span className="seat-number">0{index+1}</span><span className="country-dot" style={{ backgroundColor:SEAT_INFO[id].color }} /><span className="seat-name">{SEAT_INFO[id].name}<small>{SEAT_INFO[id].alliance === 'axis' ? '轴心国' : '同盟国'}{state?.phase === 'SETUP' && state.setupCompleted.includes(id) ? ' · 起手完成' : ''}</small></span><span className="seat-score">{state ? state.scores[id] : '—'}<small>分</small></span></button>)}<button className={`seat ${isGM?'selected':''}`} aria-pressed={isGM} disabled={busy} onClick={()=>chooseAccess({kind:'gm'})}><span className="seat-number">07</span><span className="seat-name">GM</span></button></div><div className="seat-list observer-seats" aria-label="观察者座位">{SEATS.map((id,index)=><button key={id} disabled={!state||busy} className={`seat ${access.kind==='observer'&&access.seat===id?'selected':''}`} aria-pressed={access.kind==='observer'&&access.seat===id} onClick={()=>chooseAccess({kind:'observer',seat:id})}><span className="seat-number">0{index+1}</span><span className="seat-name">{SEAT_INFO[id].name}观察者</span></button>)}<button disabled={!state||busy} className={`seat ${isPublic?'selected':''}`} aria-pressed={isPublic} onClick={()=>chooseAccess({kind:'public'})}><span className="seat-number">07</span><span className="seat-name">通用观察者</span></button></div>{isPublic&&!replayMode&&<button disabled={busy||!state} onClick={()=>void drawCountry()}>抽取国家</button>}</section>}{isGM&&<LocalTools controller={liveController} state={state} busy={busy} setBusy={setBusy} replayActive={!!factReplay} onExitReplay={()=>{setFactReplay(null);setAccess(previousAccess.current??{kind:'gm'});setInfoSeat(null);setLeftPanel('hand');}} />}</div>
        {(isGM||!room)&&(!state || newGameOpen || (!!error && !mapActive)) && <aside className="side-panel">
          {!state || newGameOpen ? <form onSubmit={create} className="setup-form" id="new-game-form"><p className="eyebrow">NEW OPERATION</p><h3>{state ? '建立另一场对局' : '创建新游戏'}</h3><label htmlFor="seed">随机种子</label><input id="seed" inputMode="numeric" value={seed} onChange={e => setSeed(e.target.value)} /><button type="button" className="secondary random-seed" aria-label="随机种子" disabled={busy} onClick={()=>setSeed(String(randomSeed()))}><span aria-hidden="true">🎲</span> 随机种子</button><div className="setting"><div><label className="prelude-option"><input type="checkbox" checked={enablePrelude} disabled={busy} onChange={e=>setEnablePrelude(e.target.checked)}/> 开启序章</label><label className="prelude-option"><input type="checkbox" checked={enableNeutrality} disabled={busy} onChange={e=>setEnableNeutrality(e.target.checked)}/> 开启中立规则</label><label className="prelude-option"><input type="checkbox" checked={enableBalance} disabled={busy} onChange={e=>setEnableBalance(e.target.checked)}/> 平衡补丁</label>{enablePrelude?`含 ${preludeCatalog(enableBalance).length} 张序章牌、`:"含 "}{regularCatalog(enableBalance,enableNeutrality).length} 张常规特殊牌与 134 张基本牌<small>允许其他国家可选响应</small></div></div><button className="primary" type="submit" disabled={busy}>{busy ? '正在创建…' : '创建新游戏'} →</button>{state && <button type="button" className="secondary full" onClick={() => setNewGameOpen(false)}>保留当前对局</button>}</form> : null}
          {error && <p role="alert" className="error">{error}</p>}
        </aside>}
      </div>


      {!readOnly&&state?.mode==='BASIC_DEBUG' && <RulesLab key={state.gameId} state={state} dispatch={dispatch} busy={busy} />}
      {state?.mode==='BASIC_DEBUG' && !state.resolution?.running && <ResolutionPanel key={`resolution:${state.gameId}:${state.revision}`} pickedRegion={pickedRegion} state={state} dispatch={dispatch} busy={busy} />}
    </main>
  </div>;
}

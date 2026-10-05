import {useCompactLayout} from './deviceLayout';
import {CardInspect} from './CardInspect';
import {neutralityDiscardPenalty} from '../core/neutrality';
import {airActionOptions} from '../core/phaseAvailability';
import {useHandOrder} from './useHandOrder';
import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {CSSProperties} from 'react';
import type {Command,ReadState} from '../core';
import {COUNTRY_NAMES,cardName} from '../core/basic';
import {seatAirMoveOptions} from '../core/actions';
import {CardResponseToggle} from './CardResponseToggle';
import {CardFace} from './CardFace';
import {playableCard} from './playAvailability';
import type {MapAction} from './map/targetChoices';

export function TableHand({state,busy,dispatch,choiceCards,chosenCards,onChoiceCard,onPlayCard,playCardId,onMapAction,revealHand,readOnly=false}:{state:ReadState;busy:boolean;readOnly?:boolean;dispatch:(c:Command)=>Promise<void>;choiceCards:Record<string,string[]>;chosenCards:string[];onChoiceCard:(id:string)=>void;onPlayCard:(id:string)=>void;playCardId:string|null;onMapAction:(a:MapAction|null)=>void;revealHand:()=>void}) {
 const [sorting,setSorting]=useState(false);
 const compact=useCompactLayout();
 useEffect(()=>{if(!compact)setSorting(false);},[compact]);
 const ref=useRef<HTMLElement>(null),[portal,setPortal]=useState<Element|null>(null);
 useEffect(()=>{setPortal(ref.current?.closest('.map-stage')??null);},[]);
 const [selected,setSelected]=useState<string[]>([]),[step,setStep]=useState<'ask'|'normal'|'source'|'destination'|'fee'>('ask');
 const [airId,setAirId]=useState<string|null>(null),[destination,setDestination]=useState<string|null>(null);
 const seat=state.viewSeat,deck=state.decks[seat];
 const handOrder=useHandOrder(`qm:hand-order:${state.gameId}:${seat}`,deck.hand);
 const free=!readOnly&&!busy&&!state.resolution?.running&&!state.pendingDiscard&&!state.pendingAir.length&&state.status!=='FINISHED';
 const own=seat===state.activeSeat;
 const setup=state.phase==='SETUP'&&!state.setupCompleted.includes(seat);
 const discard=own&&state.phase==='DISCARD';
 const air=own&&state.phase==='AIR';
 const moves=useMemo(()=>seatAirMoveOptions(state,seat),[state,seat]);
 const airOptions=useMemo(()=>airActionOptions(state),[state]);
 const playable=useMemo(()=>new Set(deck.hand.filter(card=>playableCard(state,card)).map(card=>card.id)),[state]);
 const [airChoice,setAirChoice]=useState<string|null>(null);
 useEffect(()=>{setStep(state.airAction==='move'?'source':'ask');setSelected([]);setAirId(null);setDestination(null);},[state.airAction]);
 const movable=state.units.filter(u=>moves.some(o=>o.airId===u.id));
 useEffect(()=>{
  setSelected(ids=>ids.every(id=>deck.hand.some(c=>c.id===id))?ids:ids.filter(id=>deck.hand.some(c=>c.id===id)));
  if(airId&&!moves.some(o=>o.airId===airId)){setAirId(null);setDestination(null);setSelected([]);setStep('source');}
  else if(destination&&!moves.some(o=>o.airId===airId&&o.regionId===destination)){setDestination(null);setStep('destination');}
 },[state]);
 const common={seat,expectedRevision:state.revision};
 const toggle=(id:string,max:number)=>setSelected(ids=>ids.includes(id)?ids.filter(v=>v!==id):max===1?[id]:ids.length<max?[...ids,id]:ids);
 useEffect(()=>{if(free&&(setup||discard||air&&(step==='fee'||state.airAction==='deploy'||state.airAction==='supremacy')))revealHand();},[setup,discard,step,free]);
 useEffect(()=>{
  if(busy)return;
  if(!free||!air||state.airAction!=='move'||!['source','destination','fee'].includes(step)){onMapAction(null);return;}
  const units=state.units.filter(u=>moves.some(o=>o.airId===u.id));
  const choices=step==='source'?units.map(u=>({id:u.id,regionId:u.regionId,label:'选择空军',command:{type:'MOVE_AIR' as const,...common,cardId:'',optionId:''}})):moves.filter(o=>o.airId===airId).map(o=>({...o,command:{type:'MOVE_AIR' as const,...common,cardId:selected[0]??'',optionId:o.id}}));
  onMapAction({key:`${state.gameId}:${state.viewSeat}:air:${step}`,prompt:'空军调度',customPrompt:true,options:choices,unitIds:step==='source'?units.map(u=>u.id):[],selectedUnitIds:step==='source'&&airId?[airId]:[],selectedRegion:step==='source'?units.find(u=>u.id===airId)?.regionId:destination,
   onUnit:id=>setAirId(old=>old===id?null:id),onRegion:id=>{if(step==='source'){const unit=units.find(u=>u.regionId===id);setAirId(old=>unit?(old===unit.id?null:unit.id):null);}else if(step==='destination')setDestination(old=>old===id?null:id);}
  });
 },[state,free,air,step,airId,destination,selected,moves,onMapAction]);
 let prompt=null;
 if(free&&setup)prompt=<><p>{COUNTRY_NAMES[seat]}起手：从 {deck.hand.length} 张中保留 {Math.min(7,deck.hand.length)} 张（已选 {selected.length}/{Math.min(7,deck.hand.length)}）</p><button disabled={selected.length!==Math.min(7,deck.hand.length)} onClick={()=>dispatch({type:'KEEP_OPENING',...common,cardIds:selected})}>确认</button></>;
 else if(free&&discard)prompt=<><p>当前为弃牌阶段（已选 {selected.length} 张）</p><button onClick={()=>dispatch({type:'DISCARD_HAND',...common,cardIds:[]})}>{neutralityDiscardPenalty(state,state.activeSeat)?'不弃牌（扣1分）':'不弃牌'}</button><button disabled={!selected.length} onClick={()=>dispatch({type:'DISCARD_HAND',...common,cardIds:selected})}>确认</button></>;
 else if(free&&air&&!playCardId){
  if(!state.airAction)prompt=<><p>请选择本次空军行动</p><div className="guided-options">{airOptions.map(o=><button key={o.id} disabled={!o.enabled} aria-pressed={airChoice===o.id} onClick={()=>setAirChoice(o.id)}>{o.label}</button>)}</div><div><button disabled={!airOptions.some(o=>o.id===airChoice&&o.enabled)} onClick={()=>dispatch({type:'SELECT_AIR_ACTION',...common,action:airChoice as 'move'|'deploy'|'supremacy'})}>确认</button><button onClick={()=>dispatch({type:'ADVANCE_PHASE',...common})}>跳过</button></div></>;
  else if(state.airAction!=='move')prompt=<><p>请选择一张手牌中的空军力量，{state.airAction==='deploy'?'部署空军':'夺取制空权'}</p><button onClick={()=>dispatch({type:'SELECT_AIR_ACTION',...common,action:null})}>返回</button></>;
  else if(step==='ask'||step==='source')prompt=<><p>请选择要调度的空军</p><button disabled={!airId} onClick={()=>{setDestination(null);setStep('destination');}}>确认</button><button onClick={()=>dispatch({type:'SELECT_AIR_ACTION',...common,action:null})}>返回</button></>;
  else if(step==='destination')prompt=<><p>请选择调度目的地（可原地调度）</p><button disabled={!destination} onClick={()=>{setSelected([]);setStep('fee');}}>确认</button><button onClick={()=>{setStep('source');setDestination(null);}}>返回</button></>;
  else prompt=<><p>请选择弃置 1 张手牌，确认调度</p><button disabled={selected.length!==1||!movable.some(u=>u.id===airId)} onClick={()=>{const option=moves.find(o=>o.airId===airId&&o.regionId===destination);if(option)dispatch({type:'MOVE_AIR',...common,cardId:selected[0],optionId:option.id});}}>确认</button><button onClick={()=>{setSelected([]);setStep('destination');}}>返回</button></>;
 }
 const training=(state as ReadState&{trainingReplay?:{available:string[]}}).trainingReplay;
 if(training&&!training.available.includes(seat+':hand'))return <section ref={ref} className="table-hand" aria-label="回合与手牌"><p>手牌未提供或在当前视角下不可见。</p></section>;
 return <section ref={ref} className="table-hand" aria-label="回合与手牌">
  {!training&&<button className="touch-sort-toggle" onClick={()=>setSorting(v=>!v)}>{sorting?'完成整理':'整理手牌'}</button>}
  <div className="card-grid" style={{'--hand-columns':Math.min(7,Math.max(1,deck.hand.length))} as CSSProperties}>{(training?deck.hand:handOrder.ordered).map((card,index)=>{
   const offered=!!choiceCards[card.id],selecting=setup||discard||air&&step==='fee';
   const usable=playable.has(card.id)&&(!air||state.airAction==='deploy'||state.airAction==='supremacy');
   const available=!readOnly&&(offered||free&&(selecting||usable));
   const picked=offered?chosenCards.includes(card.id):selecting?selected.includes(card.id):playCardId===card.id;
   return <div className="card-shell" {...(training?{}:handOrder.props(card.id))} key={card.id} style={(setup||state.prelude?.active)&&deck.hand.length===12?{gridRow:index<5?1:2,gridColumn:index<5?index+2:index-4}:undefined}><button className={`hand-card${available?' available-card':''}${picked?' selected':''}`} aria-label={`${cardName(card)}，${card.id}`} aria-pressed={picked} disabled={!available||busy||sorting} onClick={()=>offered?onChoiceCard(card.id):selecting?toggle(card.id,setup?7:air?1:deck.hand.length):onPlayCard(card.id)}><CardFace card={card} hint={picked?'✓ 已选择':undefined}/></button><CardInspect card={card}/>{sorting&&!training&&<div className="touch-sort-actions"><button aria-label="向前移动" onClick={()=>handOrder.move(card.id,-1)}>←</button><button aria-label="向后移动" onClick={()=>handOrder.move(card.id,1)}>→</button></div>}{!readOnly&&<CardResponseToggle state={state} card={card} dispatch={dispatch} busy={busy}/>}</div>;
  })}</div>
  {portal&&prompt&&createPortal(<fieldset disabled={busy} style={{border:0,margin:0}} className="guided-prompt hand-phase-prompt" aria-label="手牌阶段操作">{prompt}</fieldset>,portal)}
 </section>;
}

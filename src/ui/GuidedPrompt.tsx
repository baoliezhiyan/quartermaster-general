import {sortCardChoices} from '../core/cardChoiceOrder';
import {DraggableWindow} from './DraggableWindow';
import {coversCost} from '../core/cardCosts';
import { useState } from 'react';
import type { Command,ReadState } from '../core';
import { CardFace,choiceCard } from './CardFace';
import { effectText } from '../core/effectNames';
import { cardEffects } from '../core/specialCards';
import { cardTargetChoices } from '../core/extraCards';
import { COUNTRY_NAMES,cardName } from '../core/basic';
import { specialCard } from '../core/cardCatalog';
import { findCard,triggerContext } from './triggerContext';
import { statusActionEffects } from '../core/statusActions';
import { guidedChoices } from './guidedChoices';
import { resolutionTargets } from './map/targetChoices';
import {boardOptions} from '../core/boardEffects';
import {isNeutral} from '../core/neutrality';

export function GuidedPrompt({state,selected,toggle,focusCard,playCardId,playTargets,setPlayTargets,busy,dispatch,cancelPlay}:{state:ReadState;selected:string[];toggle:(id:string)=>void;focusCard:string|null;playCardId:string|null;playTargets:string[];setPlayTargets:(ids:string[])=>void;busy:boolean;dispatch:(c:Command)=>Promise<void>;cancelPlay:()=>void}) {
 const r=state.resolution,c=r?.running?r.choice:null,common={seat:state.viewSeat,expectedRevision:state.revision};
 const [index,setIndex]=useState<{key:string;id:string}|null>(null);
 const indexKey=`${state.gameId}:${state.viewSeat}:${c?.id??playCardId}`;
 const indexed=index?.key===indexKey?findCard(state,index.id):undefined;
 const link=(card:NonNullable<ReturnType<typeof findCard>>)=><button className="card-index-link" onClick={()=>setIndex({key:indexKey,id:card.id})}>{cardName(card)}</button>;
 const indexWindow=indexed?<div className="card-index-window" role="dialog" aria-label="卡牌索引"><button className="card-index-close" aria-label="关闭卡牌索引" onClick={()=>setIndex(null)}>×</button><div className="hand-card"><CardFace card={indexed}/></div></div>:null;
 if(c&&c.seat!==state.viewSeat)return null;
 if(!c){
  const deck=state.decks[state.viewSeat],card=[...deck.hand,...deck.active].find(c=>c.id===playCardId);
  if(!card)return null;
  const active=deck.active.some(c=>c.id===card.id),targets=active?[]:cardTargetChoices(state,card),barbarossa=card.definitionId==='special_162';
  const effects=active?statusActionEffects(state,card):cardEffects(state,card,playTargets).map(e=>e.kind==='action'&&e.action==='air_power'&&state.airAction&&state.airAction!=='move'?{...e,airMode:state.airAction}:e);
  const blockedByNeutrality=effects.some(e=>e.kind==='action'&&isNeutral(state,e.country)&&!boardOptions(state,e).length&&boardOptions({...state,neutrality:undefined},e).length>0);
  return <><div className="guided-prompt"><p>{barbarossa?'请选择至多三支苏联陆军，按点击顺序攻击':targets.length?'请选择目标国家':<>确认{active?'使用':'打出'}{specialCard(card.definitionId,card.balance)?.type??'基本牌'} {link(card)}</>}</p>
   {!barbarossa&&targets.map(id=><button aria-pressed={playTargets.includes(id)} key={id} onClick={()=>setPlayTargets(playTargets.includes(id)?[]:[id])}>{COUNTRY_NAMES[id as keyof typeof COUNTRY_NAMES]}</button>)}
   {blockedByNeutrality&&<small>中立限制：不能向中立对象发起战斗或夺取制空权；美国还不能在不列颠群岛、莫斯科及其相邻地区建设、征召或部署空军。没有合法目标的效果将略过。</small>}
   <div><button disabled={busy||!effects.length||targets.length>0&&!playTargets.length} onClick={()=>active?dispatch({type:'STATUS_ACTION',...common,guided:true,cardId:card.id}):dispatch({type:'PLAY_CARD',...common,guided:true,cardId:card.id,effectIndices:effects.map((_,i)=>i),targetIds:playTargets})}>确认</button><button disabled={busy} onClick={cancelPlay}>跳过</button></div>
  </div>{indexWindow}</>;
 }
 const projection=guidedChoices(state),targets=resolutionTargets(state);
 const choose=(ids:string[])=>dispatch({type:'RESOLVE_ENGINE_CHOICE',...common,guided:true,choiceId:c.id,ids});
 const unitChoice=c.options.some(o=>state.units.some(u=>u.id===o.id));
 const cardIds=Object.keys(projection.cards);
 const statusSearch=c.kind==='SELECT'&&c.prompt==='检视常规牌库顶十张，选择状态牌';
 const preludeChoices=c.kind==='SELECT'&&c.options.some(o=>o.label.startsWith('prelude_'));
 const feeFrame=r!.frames.find(f=>f.id===c.frameId),feeEffect=feeFrame?.effects[feeFrame.nextEffectIndex];
 const requirements=c.requirements??(feeEffect?.kind==='cards'?feeEffect.requirements:undefined);
 const feeValid=!requirements||coversCost(state.decks[common.seat].hand.filter(card=>selected.includes(card.id)),requirements);
 const generic=(!targets.length&&!unitChoice&&!cardIds.length)||c.field==='option';
 const represented=new Set(Object.values(projection.cards).flat());
 const loose=c.options.filter(o=>!represented.has(o.id)&&!targets.some(t=>t.id===o.id)&&!state.units.some(u=>u.id===o.id));
 const immediate=c.kind==='EFFECT_DECISION';
 const canSkip=c.kind==='TRIGGER'||c.canSkip||c.min===0;
 const required=Math.max(1,c.min);
 const context=triggerContext(state,selected);
 const source=findCard(state,r!.frames.find(f=>f.id===c.frameId)?.cardId??r!.rules.find(rule=>rule.id===c.triggerId)?.sourceInstanceId);
 const plain=effectText(c.prompt);
 const name=source?cardName(source):'';
 const prompt=c.kind==='TRIGGER'?<>{context.before}{context.card&&link(context.card)}{context.after}</>:source&&plain.includes(name)?<>{plain.slice(0,plain.indexOf(name))}{link(source)}{plain.slice(plain.indexOf(name)+name.length)}</>:plain;
 const alternatives=focusCard?(projection.cards[focusCard]??[]):[];
 if(c.kind==='SELECT'&&c.prompt==='选择弃置一张明置响应，或随机弃一张未公开响应')return <DraggableWindow className="guided-sort-window" role="dialog" aria-label="选择弃置响应"><p>{c.prompt}</p><div className="card-grid">{sortCardChoices(c.options).filter(o=>o.id!=='hidden').map(o=>{const card=choiceCard(state,o);return <button key={o.id} className="hand-card" disabled={busy} onClick={()=>choose([o.id])}>{card?<CardFace card={card}/>:o.label}</button>;})}</div>{c.options.some(o=>o.id==='hidden')&&<button disabled={busy} onClick={()=>choose(['hidden'])}>随机弃置一张未公开响应</button>}</DraggableWindow>;
 if(c.batchResponse){
  return <div className="guided-prompt" role="dialog" aria-label="计分状态批量响应"><p>{c.batchResponse==='before'?'以下计分状态即将生效，选择要响应的卡牌':'以下计分状态已结算，选择要响应的卡牌'}</p><div className="guided-options">{sortCardChoices(c.options).map(o=><button key={o.id} disabled={busy} onClick={()=>choose([o.id])}>{o.label}</button>)}</div><button disabled={busy} onClick={()=>choose([])}>全部跳过</button></div>;
 }
 if(c.kind==='EXTRA_CARD'&&feeEffect?.kind==='extraPlay'&&feeEffect.returnOnSkip&&c.options.length===1){
  const option=c.options[0],card=choiceCard(state,option);
  return <DraggableWindow className="guided-sort-window" role="dialog" aria-label="是否打出翻出的卡牌"><p>是否打出这张牌？</p>{card&&<div className="hand-card"><CardFace card={card}/></div>}<div><button disabled={busy} onClick={()=>choose([option.id])}>确认打出</button><button disabled={busy} onClick={()=>choose([])}>{feeEffect.shuffleOnSkip?'不打出，放回并洗混牌库':'放回牌库顶'}</button></div></DraggableWindow>;
 }

 return <>
  <div className="guided-prompt" aria-label="当前操作"><p>{prompt}</p>
   {(!preludeChoices&&generic&&!immediate||alternatives.length>1||loose.length>0&&!immediate&&!preludeChoices)&&<div className="guided-options">{(alternatives.length>1?c.options.filter(o=>alternatives.includes(o.id)):generic?c.options:loose).map(o=><button key={o.id} aria-pressed={selected.includes(o.id)} disabled={busy} onClick={()=>c.kind==='AIR_DEFENSE'||c.kind==='AIR_INTERCEPT'?choose([o.id]):toggle(o.id)}>{effectText(o.label)}{selected.includes(o.id)&&c.max>1?` ${selected.indexOf(o.id)+1}`:''}</button>)}</div>}
   {c.max>1&&<small>已选 {selected.length}/{c.max}</small>}
   {!['AIR_DEFENSE','AIR_INTERCEPT'].includes(c.kind)&&<div><button disabled={busy||!feeValid||!immediate&&(selected.length<required||selected.length>c.max)} onClick={()=>choose(immediate?['execute']:selected)}>确认</button>{canSkip&&<button disabled={busy} onClick={()=>choose([])}>跳过</button>}</div>}
  </div>
  {(projection.ordered||preludeChoices)&&<DraggableWindow className="guided-sort-window" aria-label={statusSearch?'选择状态牌':preludeChoices?'序章卡牌选择':'候选卡牌选择'}><div className="card-grid">{sortCardChoices(c.options).map(o=>{const card=choiceCard(state,o);return card?<button className={`hand-card${selected.includes(o.id)?' selected':''}`} key={o.id} disabled={busy} onClick={()=>toggle(o.id)}><CardFace card={card} hint={selected.includes(o.id)?`第 ${selected.indexOf(o.id)+1} 张`:feeEffect?.kind==='cards'&&feeEffect.order?'点击排序':'点击选择'}/></button>:null;})}</div></DraggableWindow>}
  {indexWindow}
 </>;
}


import {RoomRecord} from './RoomRecord';
import type {RoomInfo} from '../network/protocol';
import type { CardInstance, Command, ReadState, SeatId } from '../core';
import {PreludeHand} from './PreludeHand';
import {UnitArt} from './UnitArt';
import { BASIC_NAMES, COUNTRY_NAMES, UNIT_NAMES, phaseCountries, reserve } from '../core/basic';
import { specialCard } from '../core/cardCatalog';
import { CardResponseToggle } from './CardResponseToggle';
import { CardFace } from './CardFace';
import { activePanelCards } from './triggerContext';
import { usableStatus } from './playAvailability';

export const MAP_PANELS = [ ['hand','手牌'], ['reserve','兵模储备'], ['discard','弃牌堆'], ['deck','牌库'], ['active','持续生效与暗置卡牌'], ['record','对局记录'], ['prelude-hand','序章手牌'], ['prelude-discard','序章弃牌堆'], ['prelude-deck','序章牌库'], ['resource-pool','资源池'] ] as const;
export type MapPanel = typeof MAP_PANELS[number][0];
/** Reserved adapter view field; standard game recordings contain six empty lists. */
export function replayPoolCards(state:ReadState):readonly CardInstance[]{return (state as ReadState&{resourcePool?:Partial<Record<SeatId,CardInstance[]>>}).resourcePool?.[state.viewSeat]??[];}
export function visibleMapPanels(state:ReadState,isPublic=false,replay=false) {
 return MAP_PANELS.filter(([id])=>(!isPublic||id==='record'||id==='resource-pool'&&replay)&&(id!=='resource-pool'||replay)&&(!id.startsWith('prelude-')||!!state.prelude?.active||replay));
}
export function panelCount(state:ReadState,panel:MapPanel):number|undefined {
 const d=state.decks[state.viewSeat],p=state.prelude?.decks[state.viewSeat];
 return panel==='resource-pool'?replayPoolCards(state).length:panel==='deck'?d.drawPile.length:panel==='discard'?(state.publicDiscardCounts?.[state.viewSeat]??d.discardPile.length):panel==='prelude-deck'?p?.drawPile.length:panel==='prelude-discard'?p?.discardPile.length:undefined;
}
export function panelLabel(state:ReadState,panel:MapPanel) {
 const label=MAP_PANELS.find(p=>p[0]===panel)![1],count=panelCount(state,panel);
 return count===undefined?label:`${label}(${count})`;
}
// Sort a copy by catalog code only. Never expose the shuffled order or instance IDs.
export function catalogCards(cards:readonly CardInstance[]) {
 const basics=Object.keys(BASIC_NAMES);
 const order=(c:CardInstance)=>specialCard(c.definitionId,c.balance)?.sourceIndex ?? basics.indexOf(c.definitionId)-100;
 return [...cards].sort((a,b)=>order(a)-order(b)||a.country.localeCompare(b.country)||a.definitionId.localeCompare(b.definitionId));
}
export function MapPanelContent({panel,state,choiceCards={},chosenCards=[],onCard,dispatch,busy,infoSeat,onInfoSeat,readOnly=false,room,roomRequest,replay=false}:{replay?:boolean;room?:RoomInfo;roomRequest?:(method:string,...args:unknown[])=>Promise<unknown>;readOnly?:boolean;infoSeat?:SeatId|null;onInfoSeat?:(seat:SeatId)=>void;dispatch:(c:Command)=>Promise<void>;busy:boolean;panel:Exclude<MapPanel,'hand'>;state:ReadState;choiceCards?:Record<string,string[]>;chosenCards?:string[];onCard?:(id:string)=>void}) {
 if(panel==='record')return <RoomRecord state={state} room={room} request={roomRequest} infoSeat={infoSeat} onInfoSeat={onInfoSeat}/>;
 if(panel==='prelude-hand')return state.prelude?<PreludeHand state={state} busy={busy} readOnly={readOnly} dispatch={dispatch}/>:null;
 const deck=state.decks[state.viewSeat],prelude=state.prelude?.decks[state.viewSeat];
 const cards=panel==='resource-pool'?replayPoolCards(state):panel==='deck'?(replay?deck.drawPile:catalogCards(deck.drawPile)):panel==='discard'?deck.discardPile:panel==='active'?activePanelCards(state):panel==='prelude-deck'?(replay?prelude?.drawPile??[]:catalogCards(prelude?.drawPile??[])):panel==='prelude-discard'?prelude?.discardPile??[]:[];
 const hint=(id:string)=>chosenCards.includes(id)&&state.resolution?.choice&&state.resolution.choice.max>1?`第 ${chosenCards.indexOf(id)+1} 项`:panel==='active'?(deck.resolving.some(c=>c.id===id)?'持续生效 · 结算中':deck.active.some(c=>c.id===id)?'持续生效':'已暗置'):undefined;
 return <section aria-label={MAP_PANELS.find(p=>p[0]===panel)![1]}>
   <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}><h3>{COUNTRY_NAMES[state.viewSeat]+' · '}{MAP_PANELS.find(p=>p[0]===panel)![1]}</h3>{panelCount(state,panel)!==undefined&&<span>{MAP_PANELS.find(p=>p[0]===panel)![1]} {panelCount(state,panel)} 张</span>}</div>
   {panel==='reserve' && <div className="reserve-art">{phaseCountries(state.viewSeat).map(country=><div className="reserve-country" key={country} aria-label={COUNTRY_NAMES[country]+'兵模储备'}>{(['army','navy','air'] as const).map(type=><div className="reserve-unit-row" key={type} aria-label={COUNTRY_NAMES[country]+UNIT_NAMES[type]+'储备 '+reserve(state,country,type)}>{Array.from({length:Math.max(0,reserve(state,country,type))},(_,i)=><UnitArt key={i} country={country} type={type}/>)}</div>)}</div>)}</div>}
   {['deck','discard','active','prelude-deck','prelude-discard','resource-pool'].includes(panel) && <div className="card-grid">{cards.map(card=><div className="card-shell" key={card.id}><button className={`hand-card${choiceCards[card.id]||panel==='active'&&usableStatus(state,card)?' available-card':''}${chosenCards.includes(card.id)?' selected':''}`} disabled={readOnly||!choiceCards[card.id]&&!(panel==='active'&&onCard&&usableStatus(state,card))} onClick={()=>onCard?.(card.id)} key={card.id}><CardFace card={card} hint={hint(card.id)}/></button>{!readOnly&&!panel.startsWith('prelude-')&&<CardResponseToggle state={state} card={card} dispatch={dispatch} busy={busy}/>}</div>)}</div>}
 </section>;
}

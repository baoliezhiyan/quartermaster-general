import {publicActiveCards} from '../core/publicActiveCards';
import type { ReadState } from '../core';
import { COUNTRY_NAMES, UNIT_NAMES } from '../core/basic';
import { specialCard } from '../core/cardCatalog';
import { ACTION_NAMES, effectText } from '../core/effectNames';
import { REGION_BY_ID } from '../core/map';

export function findCard(state:ReadState,id?:string) {
 return [...Object.values(state.prelude?.decks??{}).flatMap(d=>[...d.hand,...d.drawPile,...d.discardPile]),...Object.values(state.decks).flatMap(d=>[...d.hand,...d.drawPile,...d.discardPile,...d.active,...d.faceDown,...d.resolving,...d.removed])].find(c=>c.id===id);
}
export function triggerContext(state:ReadState,selected:readonly string[]=[]) {
 const r=state.resolution,c=r?.choice;
 if(!r||!c)return {before:'',after:''};
 const option=c.options.find(o=>selected.includes(o.id));
 const w=r.windows.find(w=>w.id===(option?.windowId??c.windowId));
 const event=r.events.find(e=>e.id===w?.originEventId);
 const frame=r.frames.find(f=>f.id===event?.frameId);
 const card=findCard(state,frame?.cardId),e=event?.effect;
 const suffix='，您有可用触发效果。';
 const phaseNames:Record<string,string>={TURN_START:'回合开始',TURN_START_WINDOW:'回合开始',PLAY:'出牌阶段开始',AIR:'空军阶段开始',SUPPLY:'补给阶段开始',SCORE:'计分阶段开始',DISCARD:'弃牌阶段开始',DRAW:'摸牌阶段开始'};
 if(e?.kind==='signal'&&e.tag.startsWith('PHASE:'))return {before:`当前阶段为${phaseNames[e.tag.slice(6)]??effectText(event!.label)}`,after:suffix};
 if(e?.kind==='signal'&&card){
  const type=specialCard(card.definitionId,card.balance)?.type??'基本牌';
  const verb=e.tag==='INSTALL'?'部署了':type==='状态'?'使用了':'打出了';
  return {before:`${COUNTRY_NAMES[frame!.owner]}${verb}${type} `,card,after:(e.tag==='CARD_EFFECT_DONE'?' 的效果已结算':'')+suffix};
 }
 let reason=effectText(event?.label??c.prompt);
 const region=(id?:string)=>id?REGION_BY_ID[id]?.name??id:'';
 if(e?.kind==='action')reason=`${COUNTRY_NAMES[e.country]}${w?.timing==='Before'?'即将':'已'}${ACTION_NAMES[e.action]??effectText(e.action)}${region(e.option?.regionId??e.selection?.regionId)?`（${region(e.option?.regionId??e.selection?.regionId)}）`:''}`;
 if(e?.kind==='action'&&e.option?.mode==='supremacy')reason=`${COUNTRY_NAMES[e.country]}${w?.timing==='Before'?'即将争夺':'已争夺'}制空权（${region(e.option.regionId)}）`;
 if(e?.kind==='remove')reason=`${COUNTRY_NAMES[e.unit.country]}在${region(e.unit.regionId)}的${UNIT_NAMES[e.unit.type]}${w?.timing==='Before'?'即将被移除':'被移除'}`;
 if(e?.kind==='deckTop'||e?.kind==='draw'||e?.kind==='forceHand')reason=`${COUNTRY_NAMES[e.seat]}${w?.timing==='Before'?'即将':'已'}${e.kind==='deckTop'?'弃置牌库顶':e.kind==='draw'?'摸':'弃置手牌'} ${e.count} 张${e.fee?'（支付费用）':''}`;
 if(e?.kind==='score')reason=`${COUNTRY_NAMES[e.seat]}${w?.timing==='Before'?'即将':'已'}${e.amount<0?'扣除':'获得'} ${Math.abs(e.amount)} 分`;
 if(card&&frame)return {before:`${COUNTRY_NAMES[frame.owner]}使用${specialCard(card.definitionId,card.balance)?.type??'基本牌'} `,card,after:`：${reason}${suffix}`};
 return {before:reason,after:suffix};
}

/** Active statuses remain visible while their effects occupy a resolution frame. */
export function activePanelCards(state:ReadState) {
 const d=state.decks[state.viewSeat];
 const active=publicActiveCards(state,state.viewSeat);
 // Zone transfers are engine bookkeeping, not a request to reorder the panel.
 // Sort copies by stable catalog/instance keys; never mutate engine card order.
 const stable=(a:typeof d.active[number],b:typeof d.active[number])=>(specialCard(a.definitionId,a.balance)?.sourceIndex??0)-(specialCard(b.definitionId,b.balance)?.sourceIndex??0)||a.definitionId.localeCompare(b.definitionId)||a.id.localeCompare(b.id);
 return [...active.sort(stable),...[...d.faceDown].sort(stable)];
}

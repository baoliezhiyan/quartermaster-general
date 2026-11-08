import type {ReadState} from '../core';
import {COUNTRY_NAMES,UNIT_NAMES} from '../core/basic';
import {REGION_BY_ID} from '../core/map';
import {effectText} from '../core/effectNames';

/** Labels only the event being selected; the focused card already identifies the effect. */
export function triggerTimingLabel(state:ReadState,option:{windowId?:string;timingLabel?:string}):string {
 if(option.timingLabel)return option.timingLabel;
 const r=state.resolution,w=r?.windows.find(v=>v.id===option.windowId),event=r?.events.find(v=>v.id===w?.originEventId),e=event?.effect;
 const region=(id?:string)=>id?(REGION_BY_ID[id]?.name??effectText(id)):'';
 if(e?.kind==='action'){
  const place=region(e.option?.regionId??e.selection?.regionId);
  const actions:Record<string,string>={build_army:'建陆',build_navy:'建海',recruit_army:'征召陆军',recruit_navy:'征召海军',land_battle:'陆战',sea_battle:'海战',air_deploy:'部署空军',air_move:'调度空军',destroy:'消灭部队'};
  const action=e.option?.mode==='supremacy'?'争夺制空权':e.action==='air_power'?(e.option?.mode==='move'?'调度空军':'部署空军'):actions[e.action]??effectText(e.action);
  return `${place||COUNTRY_NAMES[e.country]}${action}`;
 }
 if(e?.kind==='remove')return `${region(e.unit.regionId)}${UNIT_NAMES[e.unit.type]}移除`;
 if(e?.kind==='deckTop')return `${COUNTRY_NAMES[e.seat]}弃牌库顶`;
 if(e?.kind==='forceHand')return `${COUNTRY_NAMES[e.seat]}弃手牌`;
 if(e?.kind==='draw')return `${COUNTRY_NAMES[e.seat]}摸牌`;
 if(e?.kind==='score')return `${COUNTRY_NAMES[e.seat]}${e.amount<0?'扣分':'得分'}`;
 if(e?.kind==='signal'){
  const phases:Record<string,string>={TURN_START:'回合开始',TURN_START_WINDOW:'回合开始',EARLY_TURN_START:'回合开始',PLAY:'出牌阶段',AIR:'空军阶段',SUPPLY:'补给阶段',SCORE:'计分阶段',SCORE_STATUS:'计分阶段',DISCARD:'弃牌阶段',DRAW:'摸牌阶段'};
  if(e.tag.startsWith('PHASE:'))return phases[e.tag.slice(6)]??effectText(event!.label);
  const signals:Record<string,string>={CARD_EFFECT:'卡牌生效',CARD_EFFECT_DONE:'卡牌效果结算',CARD_PLAYED:'打出卡牌',STANDARD_CARD_PLAYED:'标准出牌',INSTALL:'放置卡牌',ARMAMENT:'发动军备',ARMAMENT_ANYTIME:'回合内军备'};
  if(signals[e.tag])return signals[e.tag];
 }
 return effectText(event?.label??'触发时点');
}

import {transition,SEATS,PHASE_NAMES} from '../core';
import type {GameState,CardInstance} from '../core';
import {COUNTRY_NAMES,UNIT_NAMES,cardName} from '../core/basic';
import {REGION_BY_ID} from '../core/map';
import {validateState,ZONES} from './saveFormat';
import type {RecoveryRecord,RecoveryStep} from './saveFormat';
export interface ReplayFile {format:'quartermaster-replay';version:1;appVersion?:string;rulesVersion:string;gameId:string;seed:number;exportedAt?:string;record:RecoveryRecord}
export interface ReplayEntry {index:number;round:number;text:string}
const zoneNames:Record<string,string>={preludeHand:'序章手牌',preludeDeck:'序章牌库',preludeDiscard:'序章弃牌',drawPile:'牌库',hand:'手牌',discardPile:'弃牌堆',faceDown:'暗置',active:'持续生效',resolving:'结算中',removed:'移出游戏'};
function cards(s:GameState){
 const result:Record<string,{card:CardInstance;seat:typeof SEATS[number];zone:string}>={};
 for(const seat of SEATS){for(const zone of ZONES)for(const card of s.decks[seat][zone])result[card.id]={card,seat,zone};
 if(s.prelude)for(const zone of ['hand','drawPile','discardPile'] as const)for(const card of s.prelude.decks[seat][zone])result[card.id]={card,seat,zone:({hand:'preludeHand',drawPile:'preludeDeck',discardPile:'preludeDiscard'})[zone]};}
 return result;
}
function details(before:GameState,after:GameState):string[] {
 const result:string[]=[],old=cards(before),next=cards(after);
 const moved=new Map<string,CardInstance[]>();
 for(const [id,to] of Object.entries(next)){const from=old[id];if(from&&from.zone!==to.zone){const key=`${COUNTRY_NAMES[to.seat]}：${zoneNames[from.zone]} → ${zoneNames[to.zone]}`;moved.set(key,[...(moved.get(key)??[]),to.card]);}}
 for(const [label,items] of moved)result.push(`${label}：${items.map(c=>`【${cardName(c)}】`).join('、')}。`);
 for(const seat of SEATS){if(before.scores[seat]!==after.scores[seat])result.push(`${COUNTRY_NAMES[seat]}分数 ${before.scores[seat]} → ${after.scores[seat]}。`);const a=before.decks[seat].drawPile.map(c=>c.id),b=after.decks[seat].drawPile.map(c=>c.id);if(a.length===b.length&&a.every(id=>b.includes(id))&&a.some((id,i)=>b[i]!==id))result.push(`${COUNTRY_NAMES[seat]}牌库顺序已调整。`);}
 for(const u of before.units){const v=after.units.find(v=>v.id===u.id);if(!v)result.push(`${COUNTRY_NAMES[u.country]}${UNIT_NAMES[u.type]}从${REGION_BY_ID[u.regionId]?.name??u.regionId}移除。`);else if(v.regionId!==u.regionId)result.push(`${COUNTRY_NAMES[u.country]}${UNIT_NAMES[u.type]}从${REGION_BY_ID[u.regionId]?.name}移动至${REGION_BY_ID[v.regionId]?.name}。`);}
 for(const u of after.units)if(!before.units.some(v=>v.id===u.id))result.push(`${COUNTRY_NAMES[u.country]}在${REGION_BY_ID[u.regionId]?.name??u.regionId}部署${UNIT_NAMES[u.type]}。`);
 const fresh=after.events.slice(before.events.length).flatMap(e=>e.type==='RULE_EVENT'?[e.text]:[]);result.push(...fresh);
 return [...new Set(result)];
}
function describe(step:RecoveryStep,before:GameState,after:GameState):string {
 if(step.kind==='restore')return [`${step.reason}（第 ${after.round} 轮 · ${COUNTRY_NAMES[after.activeSeat]} · ${PHASE_NAMES[after.phase]}）。`,...details(before,after)].join('\n');
 const c=step.command;if(c.type==='SET_VIEW'||c.type==='ACK_RESPONSE_NOTICE'&&!before.resolution?.revealGroup?.items.some(i=>i.requestId===c.noticeId||i.resultId===c.noticeId))return '';
 const all={...cards(before),...cards(after)},name=(id:string)=>all[id]?`【${cardName(all[id].card)}】`:REGION_BY_ID[id]?.name??id;
 const who='seat' in c?COUNTRY_NAMES[c.seat]:'';
 let action:string;
 switch(c.type){
 case 'ACK_RESPONSE_NOTICE':action=`${who}确认${before.responseNotices?.find(n=>n.id===c.noticeId)?.title??'翻牌'}。`;break;
 case 'PLAY_PRELUDE':action=`${who}打出序章牌${name(c.cardId)}。`;break;
 case 'DISCARD_PRELUDE_TOP':action=`${who}弃置序章牌库顶${before.prelude?.decks[c.seat].drawPile[0]?name(before.prelude.decks[c.seat].drawPile[0].id):''}。`;break;
 case 'KEEP_OPENING':action=`${who}保留起手：${c.cardIds.map(name).join('、')}。`;break;
 case 'PLAY_CARD':case 'PLAY_BASIC':action=`${who}打出${name(c.cardId)}。`;break;
 case 'SELECT_AIR_ACTION':action=`${who}${c.action?`选择空军行动：${({move:'调度空军',deploy:'部署空军',supremacy:'夺取制空权'})[c.action]}`:'返回空军行动选择'}。`;break;
 case 'STATUS_ACTION':action=`${who}发动${name(c.cardId)}。`;break;
 case 'SET_CARD_RESPONSE':action=`${who}${c.enabled?'允许':'停用'}${name(c.cardId)}的响应。`;break;
 case 'RESOLVE_ENGINE_CHOICE':{const choice=before.resolution?.choice;const labels=c.ids.map(id=>{const option=choice?.options.find(o=>o.id===id);return all[id]?name(id):option?.label??name(id);});action=`${who}${c.ids.length?'选择：'+labels.join('、'):'结束本次响应或选择'}。`;break;}
 case 'ADVANCE_PHASE':action=`${who}完成${PHASE_NAMES[before.phase]}阶段。`;break;
 case 'DISCARD_HAND':case 'RESOLVE_FORCED_DISCARD':action=`${who}${c.cardIds.length?'弃置：'+c.cardIds.map(name).join('、'):'结束弃牌选择'}。`;break;
 case 'MOVE_AIR':case 'RELOCATE_AIR':action=`${who}调度空军。`;break;
 case 'REDISTRIBUTE':action=`${who}进行资源重整，交出${c.cardIds.map(name).join('、')}，取回${name(c.takeCardId)}。`;break;
 case 'SET_INTERRUPTS':action=`${who}${c.enabled?'允许':'关闭'}其他国家可选响应。`;break;
 default:action=`${who}执行操作 ${c.type}。`;
 }
 return [action,...details(before,after)].join('\n');
}
function apply(state:GameState,step:RecoveryStep):GameState {
 if(step.kind==='restore')return structuredClone(step.state);
 const result=transition(state,step.command);if(!result.ok)throw new Error(`回放操作不合法：${result.error}`);return result.state;
}
export function replayStateAt(file:ReplayFile,index:number):GameState {
 if(!Number.isInteger(index)||index<0||index>file.record.steps.length)throw new Error('回放节点不存在。');
 let start=0,state=structuredClone(file.record.initial);
 for(let i=index-1;i>=0;i--){const step=file.record.steps[i];if(step.kind==='restore'){state=structuredClone(step.state);start=i+1;break;}}
 for(let i=start;i<index;i++)state=apply(state,file.record.steps[i]);return state;
}
export function prepareReplay(value:unknown):{file:ReplayFile;entries:ReplayEntry[];final:GameState} {
 const v=value as ReplayFile;
 if(!v||v.format!=='quartermaster-replay'||v.version!==1||v.rulesVersion!=='1.4.0'||!v.record||typeof v.record.fromCreation!=='boolean'||!Array.isArray(v.record.steps)||v.record.steps.length>100000)throw new Error('不是受支持的对局回放文件。');
 validateState(v.record.initial);const initial=v.record.initial;
 if(v.gameId!==initial.gameId||v.seed!==initial.seed)throw new Error('回放种子或对局编号不一致。');
 let state=structuredClone(initial);const entries:ReplayEntry[]=[{index:0,round:initial.round,text:`${v.record.fromCreation?'创建对局':'已有局面起点'} · 种子 ${v.seed}。`}];
 for(let i=0;i<v.record.steps.length;i++){
  const step=v.record.steps[i];if(!step||!['command','restore'].includes(step.kind))throw new Error('回放记录结构损坏。');
  if(step.kind==='restore'){if(typeof step.reason!=='string')throw new Error('回放修正记录损坏。');validateState(step.state);}else if(!step.command||typeof step.command.type!=='string'||step.command.type==='CREATE_GAME')throw new Error('回放命令结构损坏。');
  const next=apply(state,step);if(next.gameId!==v.gameId||next.seed!==v.seed||next.mode!==initial.mode)throw new Error('回放记录混入了其他对局。');
  const text=describe(step,state,next);if(text)entries.push({index:i+1,round:next.round,text});state=next;
 }
 validateState(state);
 if(entries.at(-1)!.index!==v.record.steps.length)entries.push({index:v.record.steps.length,round:state.round,text:'记录结束时的局面。'});
 return {file:structuredClone(v),entries,final:state};
}

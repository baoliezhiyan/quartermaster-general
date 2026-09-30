import {triggerCandidate} from './triggerIndex';
import {preludeTriggers} from './preludeTriggers';
import {mayReallocate} from './neutrality';
import { COUNTRY_NAMES, reallocationCost } from './basic';
import { SPECIAL_CARDS, specialCard } from './cardCatalog';
import { SEATS } from './types';
import type { CardInstance, GameState, ReadState, SeatId } from './types';
import type { Effect, ResolutionFrame, TriggerRule } from './resolutionTypes';
import { adjacent, adjacentRegions, suppliedUnits } from './supply';
import { withinPrintedDistance } from './map';
import { fullCardEffects } from './fullCardEffects';
import { fullTrigger } from './fullCardTriggers';

const action=(country:CardInstance['country'],a:Extract<Effect,{kind:'action'}>['action'],regions?:string[]):Effect=>({kind:'action',country,action:a,regions,label:`${COUNTRY_NAMES[country]} · ${({build_army:'建设陆军',build_navy:'建设海军',recruit_army:'征召陆军',recruit_navy:'征召海军',land_battle:'发起陆战',sea_battle:'发起海战',air_power:'空军行动',air_deploy:'部署空军',air_move:'调度空军',destroy:'消灭部队'})[a]}`});
const deckTop=(seat:SeatId,count:number,fee=false):Effect=>({kind:'deckTop',seat,count,fee,label:`${COUNTRY_NAMES[seat]}弃牌库顶 ${count} 张${fee?'（费用）':''}`});
const score=(seat:SeatId,amount:number):Effect=>({kind:'score',seat,amount,label:`${COUNTRY_NAMES[seat]}获得 ${amount} 分`});
const around=(s:ReadState,c:CardInstance['country'],id:string)=>adjacentRegions(s,c,id,true);
function within(_s:ReadState,_c:CardInstance['country'],a:string,b:string,n:number):boolean {
  return withinPrintedDistance(a,b,n);
}
export function barbarossaTargets(s:ReadState):string[] {
  return s.units.filter(u=>u.country==='soviet_union' && u.type==='army' && s.units.some(a=>a.country==='germany' && a.type==='army' && adjacent(s,'germany',a.regionId,u.regionId))).map(u=>u.id);
}
export function cardEffects(s:ReadState,card:CardInstance|ReadState['decks']['germany']['hand'][number],targets:string[]=[]):Effect[] {
  const full=fullCardEffects(s,card,targets);
  if(full!==undefined){
    // Training-only event overrides. The production card effects above remain intact.
    if(s.trainingCourse?.version==='ppo-events-v1'){
      if(['special_113','special_255'].includes(card.definitionId))return full.slice(0,-1);
      if(card.definitionId==='special_94')return full.map(effect=>effect.kind==='choose'?{
        ...effect,options:effect.options.map(option=>({
          ...option,effects:option.effects.filter(child=>child.kind!=='draw'),
        })),
      }:effect);
    }
    return full;
  }
  const c=card.country;
  switch(card.definitionId) {
    case 'build_army':case 'build_navy':case 'land_battle':case 'sea_battle':case 'air_power':return [action(c,card.definitionId)];
    case 'special_23':return [action(c,'recruit_army',['southeast_asia']),action(c,'recruit_navy',['sea_south_china'])];
    case 'special_25':return ['germany','italy'].includes(targets[0])?[deckTop(targets[0] as SeatId,4)]:[];
    case 'special_65':return [action(c,'recruit_army',['ross_region']),action(c,'recruit_army',['eastern_europe'])];
    case 'special_104': {
      const supplied=suppliedUnits(s);
      const allowed=s.units.some(u=>u.country==='united_states' && u.type==='navy' && supplied.has(u.id) && within(s,c,'japan',u.regionId,3));
      return [...(allowed?[deckTop('japan',1)]:[]),score('united_states',3)];
    }
    case 'special_114':return [action('china','build_army')];
    case 'special_158':return [action(c,'land_battle',['western_europe']),action(c,'build_army',['western_europe'])];
    case 'special_162':return targets.length>0 && targets.length<=3 && new Set(targets).size===targets.length && targets.every(id=>barbarossaTargets(s).includes(id))?targets.map(id=>({...action(c,'land_battle'),targetIds:[id]} as Effect)):[];
    case 'special_164':return ['united_kingdom','soviet_union','united_states'].includes(targets[0])?[deckTop(targets[0] as SeatId,1),score('germany',2)]:[];
    case 'special_235':return [action('germany','recruit_army',['north_africa']),action('germany','recruit_navy',['sea_mediterranean'])];
    case 'special_243':return [deckTop('united_kingdom',2)];
    default: {
      const d=specialCard(card.definitionId,card.balance);
      return d && ['状态','响应'].includes(d.type)?[{kind:'signal',tag:'INSTALL',label:`${d.type==='状态'?'部署状态':'暗置响应'}：${d.name}`}]:[];
    }
  }
}

/** Bind current event context to real card handlers once when its window opens. */
export function realTriggers(s:GameState,frame:ResolutionFrame,e:Effect,timing:'Before'|'After',includePrelude=true,orderPhaseScores=true,sourceInstanceId?:string):TriggerRule[] {
  if(s.mode==='BASIC_DEBUG') return [];
  const lateScore=e.kind==='signal'&&e.tag==='PHASE:SCORE_STATUS';
  if(lateScore&&e.kind==='signal')e={...e,tag:'PHASE:SCORE'};
  const rules:TriggerRule[]=includePrelude?preludeTriggers(s,frame,e,timing,sourceInstanceId):[];
  const region=e.kind==='action'?e.option?.regionId:undefined;
  const phase=(p:string)=>e.kind==='signal' && e.tag===`PHASE:${p}`;
  // The frozen PPO courses contain only four basics and one-shot events. None
  // supplies a persistent/response/enhancement trigger; retain system rules below.
  if(!s.trainingBasicOnly&&!s.trainingCourse) for(const owner of SEATS) for(const card of [...s.decks[owner].active,...s.decks[owner].hand,...s.decks[owner].faceDown,...s.decks[owner].resolving]) {
    if(sourceInstanceId&&card.id!==sourceInstanceId)continue;
    if(!triggerCandidate(card.definitionId,e,timing))continue;
    const d=specialCard(card.definitionId,card.balance); if(!d) continue;
    if(s.prelude?.active&&['响应','军备'].includes(d.type))continue;
    if(timing==='Before') {
      const extra=fullTrigger(s,card,e,timing,frame);
      if(extra)rules.push({id:`${card.id}:${frame.currentEventId}`,scopeId:d.id,boundEventId:frame.currentEventId!,label:d.name,sourceInstanceId:card.id,owner,timing,on:e.label,mandatory:false,source:d.type==='状态'?'active':d.type==='响应'?'response':'enhancement',faceDownEnhancement:d.type==='增强'&&s.decks[owner].faceDown.some(c=>c.id===card.id),effects:[],...extra});
      continue;
    }
    let effects:Effect[]=[],cost=0,once=false,mandatory=false,finalZone:TriggerRule['finalZone'];
    const own=owner===s.activeSeat;
    switch(d.sourceIndex) {
      case 13:if(own && s.phase==='PLAY' && !frame.parentEventId && e.kind==='signal' && e.tag==='STANDARD_CARD_PLAYED') {
        const played=s.decks[owner].resolving.find(c=>c.id===frame.cardId),type=played&&specialCard(played.definitionId,played.balance)?.type;
        if(played&&played.id!==card.id&&played.definitionId!=='air_power'&&type!=='增强')effects=[{kind:'frameChange',frameId:frame.id,finalZone:'drawPile',cancel:type==='状态'||type==='响应',label:'将刚刚标准打出的牌洗入牌库'}];
      } break;
      case 36:if(own && phase('SCORE')) { effects=[action('united_kingdom','recruit_army',['eastern_europe'])];cost=s.rules?.balanceEnabled?1:2; }break;
      case 41:if(own && phase('AIR')) effects=[action('france','air_deploy')];break;
      case 51:if(e.kind==='action' && e.country==='soviet_union' && e.action==='land_battle' && region) {effects=[action('soviet_union','land_battle',[region])];cost=1;once=true;}break;
      case 59:if(own && phase('TURN_START_WINDOW')) effects=[action('soviet_union','recruit_army',around(s,'soviet_union','moscow')),action('soviet_union','destroy',['moscow'])];break;
      case 77:case 125:if(own && phase('AIR')) effects=[action('china','air_power')];break;
      case 83:if(e.kind==='action' && e.country==='united_states' && e.action==='build_army') {effects=[deckTop(owner,1,true),action('united_states','build_army')];once=true;}break;
      case 90:if(e.kind==='action' && (e.country==='china' && ['build_army','recruit_army'].includes(e.action) || e.action==='land_battle' && e.option?.defenderCountry==='china')) {effects=[{kind:'forceHand',seat:'japan',count:1,label:'抗日义勇军：日本弃 1 张手牌'}];mandatory=true;}break;
      case 129:if(own && phase('TURN_START_WINDOW')) {effects=[deckTop(owner,1,true),action('germany','recruit_army',['germany'])];once=true;}break;
      case 134:if(e.kind==='action' && e.country==='germany' && e.action==='land_battle' && region) {effects=[deckTop(owner,1,true),action('germany','land_battle',around(s,'germany',region))];once=true;}break;
      case 136:if(e.kind==='action' && e.country==='germany' && e.action==='land_battle' && region) {effects=[deckTop(owner,1,true),action('germany','build_army',[region])];once=true;}break;
      case 171:if(own && phase('SCORE') && s.units.filter(u=>u.country==='japan' && u.type==='navy').length>=3) {effects=[score(owner,1)];mandatory=true;}break;
      case 188:if(own && phase('PLAY')) effects=[action('japan','recruit_army',['southeast_asia'])];break;
      case 201:if(e.kind==='action' && e.country==='japan' && e.action==='land_battle' && region) effects=[action('japan','land_battle',around(s,'japan',region))];break;
      case 213:if(own && phase('SCORE')) {effects=[score(owner,s.units.filter(u=>u.country==='italy' && u.type==='navy').length)];mandatory=true;}break;
      case 224:if(own && phase('SCORE')) effects=[action('italy','recruit_army',['south_africa'])];break;
    }
    const extra=fullTrigger(s,card,e,timing,frame);
    if(extra) {
      rules.push({id:`${card.id}:${frame.currentEventId}`,scopeId:d.id,boundEventId:frame.currentEventId!,label:d.name,sourceInstanceId:card.id,owner,timing,on:e.label,mandatory:false,source:d.type==='状态'?'active':d.type==='响应'?'response':'enhancement',faceDownEnhancement:d.type==='增强'&&s.decks[owner].faceDown.some(c=>c.id===card.id),effects:[],...extra});
      continue;
    }
    if(!effects.length) continue;
    rules.push({id:`${card.id}:${frame.currentEventId}`,scopeId:d.id,boundEventId:frame.currentEventId!,label:d.name,sourceInstanceId:card.id,owner,timing,on:e.label,mandatory,source:d.type==='状态'?'active':d.type==='响应'?'response':'enhancement',faceDownEnhancement:d.type==='增强'&&s.decks[owner].faceDown.some(c=>c.id===card.id),effects,cost,oncePerTurn:once,finalZone});
  }
  if(!sourceInstanceId && timing==='After' && phase('TURN_START_WINDOW') && !s.redistributed && mayReallocate(s,s.activeSeat)) rules.push({id:`resource:${frame.currentEventId}`,scopeId:'resource',label:'资源重整',sourceInstanceId:'resource',owner:s.activeSeat,timing,on:e.label,mandatory:false,source:'system',cost:reallocationCost(s),effects:[{kind:'reallocate',seat:s.activeSeat,label:'取得基本牌（含空中力量）并洗牌'}]});
  // Recompute scoring candidates only after every earlier phase effect has settled.
  const scoring=(r:TriggerRule)=>r.source==='active'&&r.effects.length>0&&r.effects.every(x=>x.kind==='score'&&!x.fee);
  return !orderPhaseScores?rules:lateScore?rules.filter(scoring):phase('SCORE')?rules.filter(r=>!scoring(r)):rules;
}
export const representativeCount=SPECIAL_CARDS.length;



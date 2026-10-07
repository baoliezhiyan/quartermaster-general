import {kamikazeEffects} from './statusActions';
import { countryActionName } from './effectNames';
import {balanceEffect} from './balanceEffects';
import { allianceOf, seatOf } from './basic';
import { near } from './fullCardEffects';
import { REGIONS } from './map';
import { suppliedUnits } from './supply';
import { specialCard } from './cardCatalog';
import { distanceWithin } from './fullCardEffects';
import { homeRegion } from './modifiers';
import type { CardInstance, GameState } from './types';
import type { Effect, TriggerRule, ResolutionFrame } from './resolutionTypes';

export function fullTrigger(s:GameState,card:CardInstance,e:Effect,timing:'Before'|'After',frame?:ResolutionFrame):Partial<TriggerRule>|undefined {
  const id=Number(card.definitionId.replace('special_','')),c=card.country,owner=card.deckOwner;
  const own=owner===s.activeSeat,region=e.kind==='action'?e.option?.regionId:undefined;
  const phase=(p:string)=>own&&e.kind==='signal'&&e.tag===`PHASE:${p}`;
  const action=(country:CardInstance['country'],action:Extract<Effect,{kind:'action'}>['action'],regions?:string[]):Effect=>({kind:'action',country,action,regions,label:`${regions?.length?'在'+regions.map(id=>REGIONS.find(r=>r.id===id)?.name).join('、')+'：':''}${countryActionName(country,action)}`});
  const a=(act:Extract<Effect,{kind:'action'}>['action'],regions?:string[])=>action(c,act,regions);
  const is=(...actions:string[])=>e.kind==='action'&&e.country===c&&actions.includes(e.action);
  // Lazily compute geography only for a handler that actually uses it.
  let aroundCache:string[]|undefined,adjCache:string[]|undefined;
  const around=()=>aroundCache??=(region?near(s,c,region):[]),adj=()=>adjCache??=(region?near(s,c,region,false):[]);
  const top=(count=1):Effect=>({kind:'deckTop',seat:owner,count,fee:true,label:`弃置牌库顶 ${count} 张（费用）`});
  const count=(type:string,regions?:string[])=>s.units.filter(u=>u.country===c&&u.type===type&&(!regions||regions.includes(u.regionId))).length;
  const score=(amount:number):Partial<TriggerRule>=>({effects:[{kind:'score',seat:owner,amount,label:`获得 ${amount} 分`}],mandatory:true});
  const extra=(effects:Effect[],cost=0,costRequirements?:string[],oncePerTurn=false):Partial<TriggerRule>=>({effects,cost,costRequirements,oncePerTurn});
  const remove=(units:GameState['units'],label='选择要移除的部队'):Effect=>({kind:'choose',seat:owner,min:1,max:1,label,options:units.map(unit=>({id:unit.id,label:`${REGIONS.find(r=>r.id===unit.regionId)?.name} · ${unit.type}`,effects:[{kind:'remove',unit:{...unit},supplied:suppliedUnits(s).has(unit.id),cause:'card',label}]}))});
  if(s.rules?.balanceEnabled&&id===227)return;
  if(s.rules?.balanceEnabled&&id===226){return timing==='After'&&phase('EARLY_TURN_START')?extra([balanceEffect(owner,'two-basic-plays')]):undefined;}
  if(s.rules?.balanceEnabled&&id===145&&!(timing==='After'&&phase('DISCARD')))return;
  if(s.rules?.balanceEnabled&&timing==='After'){

    if(id===247&&phase('SUPPLY'))return extra(kamikazeEffects(s,card));
    if(id===258&&phase('PLAY'))return extra([balanceEffect(owner,'advanced-technology')]);
    if(id===259&&phase('SCORE'))return extra([top(1),{kind:'extraPlay',seat:owner,from:'hand',filter:'状态',label:'快速生产：打出一张手牌中的状态卡'}]);
    if(id===79&&phase('SCORE'))return score(new Set(s.units.filter(u=>u.type==='army'&&allianceOf(u.country)==='allies'&&['eastern_europe','south_africa','latin_america','western_china'].includes(u.regionId)).map(u=>u.regionId)).size);
    if(id===85&&phase('DISCARD'))return extra([{kind:'cards',seat:owner,from:'hand',to:'drawPile',min:1,max:2,bottom:true,remember:'bottomed',label:'将一至两张手牌放到牌库底'},balanceEffect(owner,'draw-bottomed')],0,undefined,true);
    if(id===132&&phase('PLAY'))return extra([balanceEffect(owner,'scry')],0,undefined,true);
    if(id===87&&phase('DISCARD')&&s.decks[owner].hand.length>=1&&s.decks[owner].hand.some(c=>specialCard(c.definitionId,c.balance)?.type==='经济战'))return extra([balanceEffect(owner,'bomber-economy')],0,undefined,true);
    if(id===178&&is('land_battle')&&region==='vladivostok')return extra([a('build_army',[region]),a('land_battle',around())]);
    if(id===246&&phase('PLAY'))return extra([top(2),a('land_battle',['western_europe'])]);
    if(id===145&&phase('DISCARD')&&count('navy',['sea_baltic']))return extra([a('build_navy',['sea_north_sea'])],1,['build_navy']);
    if(id===248&&phase('TURN_START_WINDOW')){const regions=[...(count('army',['eastern_china'])?['vladivostok']:[]),...(count('army',['vladivostok'])?['eastern_china']:[])];return regions.length?extra([a('build_army',regions)]):undefined;}
    if(id===249&&phase('TURN_START_WINDOW'))return extra([a('destroy',['hawaii']),balanceEffect('united_states','end-neutrality')]);
  }
  if(timing==='Before') {
    const sourceCard=frame?.cardId?Object.values(s.decks).flatMap(d=>d.resolving).find(c=>c.id===frame.cardId):undefined;
    const source=sourceCard?specialCard(sourceCard.definitionId,sourceCard.balance):undefined;
    if(e.kind==='signal'&&e.tag==='CARD_EFFECT'&&frame&&source&&sourceCard) {
      if(id===15&&source.type==='经济战'&&allianceOf(source.country)==='axis')return extra([{kind:'frameChange',frameId:frame.id,cancel:true,label:'取消经济战卡全部效果'}]);
      if(id===37&&source.type==='状态'&&allianceOf(source.country)==='axis')return {...extra([{kind:'flag',flag:'suppressed',ids:[sourceCard.id],label:'本回合此状态无效'},{kind:'frameChange',frameId:frame.id,cancel:true,label:'停止该状态本次效果'}],1),atomic:true};
      if(id===39&&source.type==='增强'&&allianceOf(source.country)==='axis')return extra([{kind:'frameChange',frameId:frame.id,cancel:true,label:'此增强卡无效'}],1);
    }
    if(e.kind==='deckTop'&&!e.fee&&source?.type==='经济战'&&frame) {
      const change=(delta:number):Effect=>({kind:'countChange',eventId:frame.currentEventId!,delta,label:`经济战弃牌数量调整 ${delta>=0?'+':''}${delta}`});
      switch(id) {
        case 87:if(!s.rules?.balanceEnabled&&source.country===c)return {...extra([change(2)]),mandatory:true};break;
        case 121:if(source.country===c)return extra([change(s.units.filter(u=>u.country===c&&u.type==='air'&&distanceWithin(s,c,homeRegion(s,e.seat),u.regionId,2)).length)]);break;
        case 128:if(source.name.includes('潜艇'))return extra([change(count('army',['scandinavia'])?(s.rules?.balanceEnabled?4:3):2)]);break;
        case 133:if(e.seat===owner||s.rules?.balanceEnabled&&e.seat==='italy')return {...extra([change(-3)]),mandatory:true};break;
        case 144:if(source.country===c&&source.name.includes('潜艇'))return extra([top(),a('sea_battle')]);break;
        case 149:if(source.country===c)return extra([{kind:'deckTop',seat:'united_kingdom',count:2*s.units.filter(u=>u.country===c&&u.type==='air'&&distanceWithin(s,c,'british_isles',u.regionId,2)).length,label:'轰炸伦敦：英国额外弃牌'}]);break;
        case 220:if(e.seat===owner)return extra([change(-5)]);break;
        case 226:if(e.seat===owner)return {...extra([remove(s.units.filter(u=>u.country==='italy'&&u.type==='air'),'移除意大利空军作为费用'),change(-e.count)]),atomic:true};break;
        case 230:if(source.country==='germany'&&source.name.includes('潜艇'))return extra([change(3)]);break;
      }
    }
    const protect=(ids:string[])=>extra([{kind:'flag',flag:'protected',ids,label:'本回合这些部队不会被移除'}]);
    if(e.kind==='remove') {
      const u=e.unit;
      switch(id) {
        case 55:if(((s.rules?.balanceEnabled)||!own)&&u.country===c&&u.type==='army'&&['siberia','kazakhstan'].includes(u.regionId))return protect(s.units.filter(v=>v.country===c&&v.type==='army'&&['siberia','kazakhstan'].includes(v.regionId)).map(v=>v.id));break;
        case 11:if(u.country===c&&u.type==='army'&&e.supplied)return protect([u.id]);break;
        case 14:if(u.country===c&&u.type!=='air'&&near(s,c,'british_isles').includes(u.regionId))return protect([u.id]);break;
        case 16:if(['united_states','united_kingdom'].includes(u.country)&&u.type==='navy'&&e.supplied)return protect([u.id]);break;
        case 18:if(u.country==='france'&&u.type==='army')return protect([u.id]);break;
        case 54:case 56:case 60:if(u.country===c&&u.type==='army'&&u.regionId===({54:'ukraine',56:'moscow',60:'ross_region'}[id]))return protect([u.id]);break;
        case 58:if(u.country===c&&u.type==='army'&&['moscow','ukraine'].includes(u.regionId))return extra([a('recruit_army',['siberia']),a('recruit_army',['kazakhstan'])]);break;
        case 195:if(u.country===c&&u.type==='army'&&e.supplied&&['eastern_china','western_china','vladivostok','mongolia'].includes(u.regionId))return protect([u.id]);break;
        case 200:if(u.country===c&&u.type==='navy'&&e.supplied)return protect([u.id]);break;
        case 222:if(allianceOf(u.country)==='axis'&&u.type==='army'&&u.regionId==='italy')return protect([u.id]);break;
      }
    }
    if(e.kind==='action'&&['land_battle','sea_battle'].includes(e.action)) {
      const defender=s.units.find(u=>u.id===e.option?.defenderId);
      if(defender) {
        const tax=(n:number):Partial<TriggerRule>=>({effects:[{kind:'deckTop',seat:seatOf(e.country),count:n,label:`攻击方弃牌库顶 ${n} 张`}],mandatory:true});
        switch(id) {
          case 254:if(s.rules?.balanceEnabled&&defender.country==='france'&&defender.type==='army'&&defender.regionId==='western_europe')return extra([{kind:'remove',unit:{...defender},supplied:suppliedUnits(s).has(defender.id),cause:'card',label:'撤离法国陆军'},action('france','recruit_army',['british_isles'])],1);break;
          case 53:if(defender.country===c&&defender.type==='army')return extra([{kind:'choose',seat:seatOf(e.country),min:1,max:1,label:'重型坦克：攻击方弃四张手牌，否则此战斗不移除守军',options:[{id:'protect',label:'不支付，守军不被移除',effects:[{kind:'flag',flag:'battleProtected',ids:[defender.id],label:'本次战斗保护守军'}]},{id:'pay',label:'弃四张手牌，继续战斗',effects:[{kind:'cards',seat:seatOf(e.country),from:'hand',to:'discardPile',min:4,max:4,fee:true,label:'攻击方支付四张手牌'},{kind:'trace',label:'攻击方已支付，继续战斗'}]}]}]);break;
          case 86:if(defender.country===c&&defender.type==='navy'&&(s.rules?.balanceEnabled?REGIONS.some(r=>r.id===defender.regionId&&r.type==='SEA')&&near(s,c,'sea_central_pacific').includes(defender.regionId):suppliedUnits(s).has(defender.id)))return {...extra([top(2),{kind:'flag',flag:'battleProtected',ids:[defender.id],label:'本次战斗不移除该海军'}],0,undefined,true),oncePerRound:false};break;
          case 126:if(defender.country==='germany'&&defender.type==='army')return {effects:[{kind:'deckTop',seat:e.decisionSeat??frame?.owner??seatOf(e.country),count:2,label:'攻击决策方弃牌库顶 2 张'}],mandatory:true};break;
          case 127:if(defender.regionId==='germany'&&allianceOf(defender.country)==='axis'&&defender.type==='army')return tax(3);break;
          case 138:if(defender.regionId==='western_europe'&&allianceOf(defender.country)==='axis'&&defender.type==='army')return {...tax(3),oncePerTurn:true};break;
          case 207:if(defender.country===c&&defender.type==='army')return extra([{kind:'flag',flag:'battleProtected',ids:[defender.id],label:'此战斗不会移除该陆军'}],1,['响应']);break;
          case 219:if(defender.country==='italy'&&defender.type==='army'&&near(s,c,'italy').includes(defender.regionId))return extra([{kind:'flag',flag:'battleProtected',ids:[defender.id],label:'此战斗不会移除该陆军'}]);break;
        }
      }
    }
    if((id===2||id===8)&&is('build_army')&&e.kind==='action'&&!e.option?.replacement)return {...extra([{kind:'cancel',label:'以征召代替本次建设'},a('recruit_army',[id===2?'australia':'india'])]),atomic:true};
    return;
  }
  switch(id) {
    case 256:if(phase('TURN_START_WINDOW'))return {...extra([{kind:'cards',seat:owner,from:'hand',to:'drawPile',min:0,max:s.decks[owner].hand.filter(c=>c.id!==card.id).length,allowedIds:s.decks[owner].hand.filter(c=>c.id!==card.id).map(c=>c.id),bottom:true,order:true,label:'将任意数量手牌置于牌库底'},balanceEffect(owner,'draw-to-seven')]),atomic:true};break;
    case 3:if(phase('SCORE'))return score(Number(count('navy',['sea_north_atlantic'])>0)+Number(count('army',['canada'])>0));break;
    case 4:if(is('sea_battle'))return extra([a('sea_battle',around())],2,undefined,true);break;
    case 17:if(e.kind==='signal'&&e.tag==='CARD_EFFECT_DONE'){const completed=e.completedFrameId?s.resolution?.frames.find(f=>f.id===e.completedFrameId):frame;const target=s.decks.germany.resolving.find(c=>c.id===completed?.cardId);if(completed&&target&&specialCard(target.definitionId,target.balance)?.type==='状态')return extra([{kind:'frameChange',frameId:completed.id,finalZone:'discardPile',label:'将已结算的德国状态弃置'}]);}break;
    case 45:if(s.phase==='PLAY'&&(s.resolutionVersion===3&&is('build_army')||e.kind==='signal'&&e.tag==='CARD_PLAYED')&&frame?.cardId&&s.decks.soviet_union.resolving.some(c=>c.id===frame.cardId&&c.definitionId==='build_army'))return extra([{kind:'frameChange',frameId:frame.id,finalZone:'hand',label:'建设陆军返回手牌'}]);break;
    case 12:case 57:case 196:case 218:if(e.kind==='action'&&region) {
      const placed=[...s.events].reverse().find(v=>v.type==='UNIT_PLACED'&&v.regionId===region&&v.country===e.country);
      if(placed?.type!=='UNIT_PLACED')break;
      const unit=s.units.find(u=>u.id===placed.unitId);if(!unit)break;
      const qualifies=id===12?e.action==='build_army'&&allianceOf(e.country)==='axis'&&['india','australia','canada'].includes(region)
        :id===57?e.action==='build_army'&&allianceOf(e.country)==='axis'&&near(s,c,'moscow').includes(region)
        :id===196?e.action==='build_navy'&&allianceOf(e.country)==='allies'&&s.units.some(u=>u.country==='japan'&&u.type!=='air'&&near(s,c,region,false).includes(u.regionId))
        :e.action==='build_army'&&e.country==='soviet_union'&&s.units.some(u=>['united_kingdom','united_states'].includes(u.country)&&u.type==='army'&&near(s,c,region,false).includes(u.regionId));
      if(qualifies)return {...extra([{kind:'remove',unit:{...unit},supplied:suppliedUnits(s).has(unit.id),cause:'destroy',label:'消灭刚刚建设的部队'}]),placementPriority:true};
    }break;
    case 55:if((s.rules?.balanceEnabled)||!own)return;return extra([{kind:'flag',flag:'protected',ids:s.units.filter(u=>u.country===c&&u.type==='army'&&['siberia','kazakhstan'].includes(u.regionId)).map(u=>u.id),label:'本回合保护西伯利亚和哈萨克斯坦的苏联陆军'}]);
    case 19:if(e.kind==='action'&&e.action==='land_battle'&&['united_states','france','united_kingdom'].includes(e.country)&&region&&['north_africa','south_africa','middle_east','western_europe'].includes(region))return extra([a('recruit_army',[region])]);break;
    case 38:if(phase('SCORE'))return extra([a('recruit_army',['north_africa','middle_east','southeast_asia','indonesia'])],s.rules?.balanceEnabled?1:2);break;
    case 40:case 209:if(phase(id===40?'PLAY':'DISCARD'))return extra([remove(s.units.filter(u=>u.type==='air'&&allianceOf(u.country)!==allianceOf(c)&&s.units.some(v=>v.country===c&&v.type==='air'&&near(s,c,v.regionId,false).includes(u.regionId))))],id===40?(s.rules?.balanceEnabled?1:2):0);break;
    case 43:if(is('land_battle'))return extra([a('land_battle',around())],2,undefined,true);break;
    case 44:if(is('build_army'))return extra([a('land_battle',adj())],2,s.rules?.balanceEnabled?['land_battle|build_army','land_battle|build_army']:['land_battle','build_army']);break;
    case 50:if(own&&is('build_army'))return extra([a('build_army')],1,['build_army'],true);break;
    case 70:if(is('air_deploy','air_move','air_power')&&e.kind==='action'&&e.option?.mode!=='supremacy')return extra([a('build_army',adj())],1,['build_army']);break;
    case 71:if(is('land_battle','sea_battle')&&region&&['ross_region','eastern_europe','ukraine','balkans'].includes(region))return extra([a('build_army',[region])],1,['build_army']);break;
    case 72:if(phase('DISCARD'))return extra([{kind:'cards',seat:owner,from:'discardPile',to:'hand',min:Math.min(2,s.decks[owner].discardPile.filter(c=>c.definitionId==='build_army').length),max:2,filter:'build_army',label:'从弃牌堆取回两张建设陆军（不足取全部）'}]);break;
    case 74:if(phase('DISCARD'))return extra([{kind:'cards',seat:owner,from:'discardPile',to:'faceDown',min:1,max:1,filter:'响应',label:'选择一张响应牌暗置'}],1,['build_army']);break;
    case 75:if(phase('SCORE'))return extra([a('destroy',['moscow','ross_region'])],3,['build_army','*','*']);break;
    case 76:if(phase('PLAY'))return {...extra([remove(s.units.filter(u=>u.country===c&&u.type==='army'),'移除一支苏联陆军'),a('build_army')],1,['build_army']),atomic:true};break;
    case 73:if(e.kind==='remove'&&e.unit.country==='soviet_union'&&e.unit.type==='army'&&!s.units.some(u=>u.country==='soviet_union'&&u.type==='army'))return extra([a('destroy',near(s,c,'moscow'))],1,['build_army']);break;
    case 78:if(is('build_navy')&&region?.includes('pacific'))return extra([top(),a('land_battle',adj())]);break;
    case 80:if(is('build_navy'))return extra([top(),a('build_army',adj())],0,undefined,true);break;
    case 84:if(is('build_navy'))return extra([top(),a('build_navy')],0,undefined,true);break;
    case 85:if(phase('DISCARD'))return extra([{kind:'cards',seat:owner,from:'hand',to:'drawPile',min:1,max:2,bottom:true,label:'选择一至两张手牌置于牌库底'}],0,undefined,true);break;
    case 88:if(is('land_battle')&&region&&s.units.some(u=>u.country===c&&u.type==='navy'&&adj().includes(u.regionId)))return extra([top(),a('build_army',[region])],0,undefined,true);break;
    case 89:if(is('sea_battle')&&region)return extra([top(),a('build_navy',[region])],0,undefined,true);break;
    case 116:if(phase('AIR'))return extra([action('united_kingdom','air_deploy')]);break;
    case 117:if(phase('SCORE'))return extra([top(),a('air_deploy',near(s,c,'sea_central_pacific'))]);break;
    case 118:if(is('land_battle','sea_battle')&&e.kind==='action'&&region)return extra([a(e.action,[region])],1,['经济战']);break;
    case 120:if(phase('SCORE'))return extra([top(),a('recruit_army',near(s,c,'sea_central_pacific',false))]);break;
    case 119:if(is('air_deploy','air_move','air_power')&&e.kind==='action'&&e.option?.mode!=='supremacy')return extra([top(),a('destroy',adj())]);break;
    case 122:if(phase('DISCARD'))return extra([top(2),{kind:'cards',seat:'united_kingdom',from:'discardPile',to:'faceDown',min:1,max:1,filter:'响应',label:'英国从弃牌堆选择一张响应并暗置'}]);break;
    case 123:if(phase('PLAY'))return extra([{kind:'cards',seat:owner,from:'hand',to:'faceDown',min:1,max:1,filter:'增强',label:'选择一张增强暗置，仍须满足原触发条件与费用'}]);break;
    case 124:if(is('build_navy')&&region?.includes('pacific'))return extra([top(),{kind:'choose',seat:owner,min:1,max:1,label:'选择额外建设海军或陆军',options:['build_navy','build_army'].map(act=>({id:act,label:act,effects:[a(act as 'build_army',adj())]}))}]);break;
    case 130:if(is('build_army'))return extra([top(2),a('build_army',adj())],0,undefined,true);break;
    case 131:if(phase('SCORE'))return score(count('navy',['sea_baltic'])?1+Number(count('army',['scandinavia'])>0):0);break;
    case 132:if(phase('PLAY'))return extra([{kind:'cards',seat:owner,from:'drawPile',to:'drawPile',min:Math.min(4,s.decks[owner].drawPile.length),max:4,topCount:4,order:true,label:'依次选择牌库顶四张牌，第一张为新的牌库顶'}],0,undefined,true);break;
    case 137:if(is('build_army'))return extra([top(),a('land_battle',adj())],0,undefined,true);break;
    case 139:if(phase('SCORE'))return score(count('army',['ukraine','kazakhstan','ross_region']));break;
    case 140:if(e.kind==='remove'&&e.unit.country==='italy'&&e.unit.type==='air'&&e.cause==='air_power') {
      const parent=s.resolution?.events.find(v=>v.id===frame?.parentEventId)?.effect;
      const attacker=parent?.kind==='action'?s.units.find(u=>u.id===parent.option?.airId):undefined;
      if(attacker&&allianceOf(attacker.country)==='allies')return extra([remove([attacker],'消灭发起夺取制空权的同盟国空军')]);
    }break;
    case 141:if(is('build_navy'))return extra([top(),a('sea_battle',['sea_north_sea','sea_north_atlantic','sea_mid_atlantic'])]);break;
    case 143:if(phase('PLAY'))return extra([top(),a('land_battle',[...new Set(s.units.filter(u=>u.country===c&&u.type==='air').flatMap(u=>near(s,c,u.regionId,false)))])]);break;
    case 142:if(phase('PLAY'))return extra([{kind:'flag',flag:'noAirDefense',ids:[],label:'本回合禁止空军防御'}]);break;
    case 145:if(phase('PLAY')&&s.units.some(u=>u.country===c&&u.type==='air'))return extra([{kind:'flag',flag:'supplyCountries',ids:[c],label:'本回合德国部队获得补给'}]);break;
    case 146:if(is('air_deploy','air_move','air_power')&&e.kind==='action'&&e.option?.mode!=='supremacy')return extra([top(),a('land_battle',adj())]);break;
    case 147:if(phase('SCORE'))return extra([top(),a('recruit_army',['scandinavia']),{kind:'extraPlay',seat:owner,from:'hand',mention:'斯堪的纳维亚',label:'额外打出正文涉及斯堪的纳维亚的牌'}]);break;
    case 148:if(phase('PLAY'))return {...extra([{kind:'cards',seat:owner,from:'active',to:'discardPile',min:1,max:1,fee:true,label:'弃置一张生效中的德国状态牌'},{kind:'extraPlay',seat:owner,from:'hand',filter:'状态',label:'打出一张手牌中的状态牌'}]),atomic:true};break;
    case 172:if(phase('SCORE'))return score(count('army',['vladivostok'])+count('army',['siberia']));break;
    case 173:if(phase('SCORE'))return score(Number(count('navy',['sea_central_pacific'])>0));break;
    case 174:if(phase('SCORE'))return score(Number(!s.units.some(u=>u.type==='army'&&u.regionId==='hawaii'&&allianceOf(u.country)==='allies')));break;
    case 175:if(phase('SCORE'))return score(Number(count('army',['iwo_jima','philippines'])>0));break;
    case 176:if(phase('SCORE'))return score(count('army',['indonesia','new_guinea','southeast_asia']));break;
    case 177:if(phase('SCORE'))return score(count('army',['hawaii','canada','new_zealand'])?2:0);break;
    case 179:if(e.kind==='signal'&&e.tag==='CARD_PLAYED'&&frame?.cardId===card.id)return {...extra([{kind:'frameChange',frameId:frame.id,finalZone:'hand',label:'气球炸弹返回手牌'}],s.rules?.balanceEnabled?4:3),source:'system'};break;
    case 183:case 184:case 193:case 198:if(is(id===198?'sea_battle':'build_navy')){const act=id===183?'land_battle':id===184?'sea_battle':'build_army';return extra([a(act,adj()),a(act,adj())]);}break;
    case 185:if(is('land_battle')&&region==='india')return extra([a('build_army',['india'])]);break;
    case 186:if(phase('PLAY'))return extra([a('sea_battle')]);break;
    case 187:if(phase('PLAY'))return extra([a('land_battle',near(s,c,'eastern_china'))]);break;
    case 189:if(phase('PLAY'))return extra([a('recruit_army',['eastern_china'])]);break;
    case 190:if(phase('PLAY'))return extra([{...a('destroy'),targetIds:s.units.filter(u=>u.country==='china'&&u.type==='army').map(u=>u.id)} as Effect]);break;
    case 191:if(own&&(!s.rules?.balanceEnabled||phase('TURN_START_WINDOW'))){const regions=s.rules?.balanceEnabled?[...new Set([...near(s,c,'sea_east_china'),...near(s,c,'sea_south_china')])]:near(s,c,'sea_central_pacific');return extra([{kind:'flag',flag:'supplyRegions',ids:regions.map(id=>`japan:${id}`),label:s.rules?.balanceEnabled?'本回合东海、南海及与其任一相邻的日本部队有补给':'本回合中太平洋及相邻日本部队有补给'}]);}break;
    case 192:if(is('sea_battle'))return extra([a('sea_battle'),a('land_battle',s.rules?.balanceEnabled?REGIONS.filter(r=>r.type==='LAND'&&r.id!=='united_states').map(r=>r.id):undefined)]);break;
    case 194:if(phase('TURN_START_WINDOW'))return extra([a('recruit_navy',near(s,c,'sea_north_pacific'))]);break;
    case 197:if(is('land_battle')&&region==='southeast_asia')return extra([a('sea_battle',['sea_south_china']),a('recruit_army',['southeast_asia'])]);break;
    case 199:if(is('land_battle')&&region&&near(s,c,'eastern_china').includes(region))return extra([a('build_army',[region]),a('land_battle',near(s,c,'eastern_china'))]);break;
    case 202:if(phase('PLAY'))return extra([a('air_deploy',s.units.filter(u=>u.country===c&&u.type==='navy'&&suppliedUnits(s).has(u.id)).map(u=>u.regionId))],1,['响应']);break;
    case 203:if(e.kind==='action'&&e.country===c&&e.option?.mode==='supremacy'&&region&&near(s,c,'sea_central_pacific').includes(region))return extra([a(REGIONS.find(r=>r.id===region)?.type==='SEA'?'sea_battle':'land_battle',[region])],1,['响应']);break;
    case 204:if(phase('SCORE'))return {...score(s.units.filter(u=>u.country===c&&u.type==='navy'&&u.regionId.includes('pacific')).length),mandatory:false};break;
    case 205:if(is('air_deploy','air_move','air_power')&&e.kind==='action'&&e.option?.mode!=='supremacy'&&region&&REGIONS.find(r=>r.id===region)?.type==='SEA')return extra([{kind:'choose',seat:owner,min:1,max:1,label:'选择陆战或海战',options:['land_battle','sea_battle'].map(act=>({id:act,label:act,effects:[a(act as 'land_battle',adj())]}))}],1,['响应']);break;
    case 206:if(phase('SCORE'))return extra([a('recruit_army',['indonesia','new_guinea','iwo_jima','philippines'])],1,['响应']);break;
    case 208:if(is('build_navy'))return extra([a('build_navy')],1,['响应']);break;
    case 212:if(phase('SCORE'))return score(Number(count('army',['western_europe'])>0));break;
    case 214:if(phase('SCORE'))return score(['north_africa','south_africa','middle_east'].filter(r=>s.units.some(u=>u.type==='army'&&u.regionId===r&&allianceOf(u.country)==='axis')).length);break;
    case 216:if(phase('SCORE'))return score(count('army',['ross_region','ukraine']));break;
    case 217:if(phase('SCORE'))return score(Number(count('army',['balkans'])>0));break;
    case 225:if(phase('SCORE'))return {...score(count('navy')),mandatory:false};break;
    case 227:if(!own)break;return {...extra([{kind:'cards',seat:'germany',from:'hand',to:'discardPile',min:0,max:5,remember:'steel',label:'德国选择弃置零至五张手牌'},{kind:'randomReturn',seat:'italy',countFrom:'steel',label:'意大利随机从弃牌堆将相同数量的牌置于牌库顶'}]),atomic:true};
    case 221:case 223:if(e.kind==='remove'&&e.supplied&&e.unit.type==='army'&&e.unit.country===(id===221?'germany':'italy'))return extra([action(id===221?'italy':'germany','recruit_army',[e.unit.regionId])]);break;
    case 228:if(phase('PLAY')){const regions=s.units.filter(u=>u.country===c&&u.type==='navy').map(u=>u.regionId);return extra([{kind:'choose',seat:owner,min:1,max:1,label:'选择部署或免费调度空军',options:['air_deploy','air_move'].map(act=>({id:act,label:act,effects:[a(act as 'air_deploy',regions)]}))}],1);}break;
    case 229:if(phase('SCORE'))return extra([a('recruit_army',['middle_east'])]);break;
  }
}

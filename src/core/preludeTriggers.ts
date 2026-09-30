import {triggerCandidate} from './triggerIndex';
import {REGIONS} from './map';
import {balanceEffect} from './balanceEffects';
import {copiedStatusRules} from './copiedStatus';
import type {GameState,SeatId,CountryId} from './types';
import type {Effect,ResolutionFrame,TriggerRule} from './resolutionTypes';
import {SEATS} from './types';
import {specialCard} from './cardCatalog';
import {allianceOf,seatOf} from './basic';
import {near,distanceWithin} from './fullCardEffects';
import {suppliedUnits} from './supply';
import {homeRegion} from './modifiers';
import {isPrelude,preludeEffect} from './prelude';

export function preludeTriggers(s:GameState,frame:ResolutionFrame,e:Effect,timing:'Before'|'After',sourceInstanceId?:string):TriggerRule[]{
 if(!s.prelude)return [];
 const rules:TriggerRule[]=[];
 for(const seat of SEATS)for(const card of [...s.decks[seat].faceDown,...s.decks[seat].active]){
  if(sourceInstanceId&&card.id!==sourceInstanceId)continue;
  if(!isPrelude(card)||!triggerCandidate(card.definitionId,e,timing))continue;
  const d=specialCard(card.definitionId,card.balance)!,id=d.id.slice(8),military=d.type==='军备';
  if(military&&s.prelude.active)continue;
  const b=!!s.rules?.balanceEnabled;
  const c:CountryId=seat,own=seat===s.activeSeat;
  const phase=(p:string)=>own&&timing==='After'&&e.kind==='signal'&&e.tag===`PHASE:${p}`;
  const action=e.kind==='action'?e:undefined,region=action?.option?.regionId;
  const defender=action&&s.units.find(u=>u.id===action.option?.defenderId);
  const battle=!!action&&['land_battle','sea_battle'].includes(action.action);
  const mine=(name:string)=>timing==='After'&&action?.country===seat&&action.action===name;
  const attacked=timing==='Before'&&battle&&defender?.country===seat;
  const placed=action&&s.units.find(u=>u.id===action.resultUnitId)|| (region? [...s.events].reverse().flatMap(v=>v.type==='UNIT_PLACED'&&v.regionId===region?[s.units.find(u=>u.id===v.unitId)]:[]).find(Boolean):undefined);
  const a=(act:Extract<Effect,{kind:'action'}>['action'],regions?:string[]):Effect=>({kind:'action',country:c,action:act,regions,label:`${d.name}：${act}`});
  const score=(amount:number):Effect=>({kind:'score',seat,amount,label:`${d.name}：获得 ${amount} 分`});
  const top=(target:SeatId,count:number):Effect=>({kind:'deckTop',seat:target,count,label:`${d.name}：弃置牌库顶 ${count} 张`});
  const choose=(effects:Effect[]):Effect=>({kind:'choose',seat,min:1,max:1,label:d.name,options:effects.map((e,i)=>({id:String(i),label:e.label,effects:[e]}))});
  const protect=(once=false):Effect=>({kind:'flag',flag:once?'battleProtected':'protected',ids:defender?[defender.id]:[],label:d.name});
  const remove=(u:NonNullable<typeof placed>):Effect=>({kind:'remove',unit:{...u},supplied:suppliedUnits(s).has(u.id),cause:'destroy',label:`${d.name}：消灭新建部队`});
  const replaceArmy=()=>b?balanceEffect(seat,'armament-rebuild',region??(e.kind==='remove'?e.unit.regionId:undefined)):choose(s.units.filter(u=>u.country===seat&&u.type==='army').map(u=>({kind:'choose',seat,min:1,max:1,label:`移除${REGIONS.find(r=>r.id===u.regionId)?.name??'所选地区'}陆军后重建`,options:[{id:u.id,label:'移除并重建',effects:[remove(u),a('build_army',region?[region]:e.kind==='remove'?[e.unit.regionId]:[])]}]} as Effect)));
  let effects:Effect[]=[],copyFees:string[]|undefined;
  switch(id){
  case 'DE-01':if(attacked&&defender?.type==='army')effects=[{kind:'forceHand',seat:seatOf(action!.country),count:3,label:d.name}];break;
  case 'DE-02':if(phase('SCORE'))effects=[a('sea_battle')];break;
  case 'DE-03':if(phase('TURN_START_WINDOW'))effects=[...(s.units.filter(u=>u.country===seat&&u.type!=='air'&&u.regionId!=='british_isles'&&distanceWithin(s,c,'british_isles',u.regionId,2)).length>=2?[top('united_kingdom',4)]:[]),score(b?2:1)];break;
  case 'DE-04':if(phase('TURN_START_WINDOW'))effects=[...(s.units.some(u=>u.country===seat&&u.type!=='air'&&near(s,c,'sea_north_atlantic').includes(u.regionId))?[top('united_states',b?4:3)]:[]),score(b?4:3)];break;
  case 'DE-05':case 'SU-07':if(mine('land_battle'))effects=[a('land_battle',[region!])];break;
  case 'DE-06':if(phase('TURN_START_WINDOW'))effects=[...(s.units.some(u=>u.country===seat&&u.type==='army'&&near(s,c,'sea_north_sea',false).includes(u.regionId))?[top('united_kingdom',3)]:[]),score(2)];break;
  case 'DE-07':if(attacked&&region==='germany'&&defender?.type==='army')effects=[protect()];break;
  case 'DE-08':if(phase('SCORE'))effects=[a('build_army',['eastern_europe'])];break;
  case 'DE-09':{copyFees=s.decks.germany.hand.filter(c=>copiedStatusRules(s,frame,e,timing,c).length>0).map(c=>c.id);if(copyFees.length)effects=[{kind:'copyStatus',seat,eventId:frame.currentEventId!,timing,label:'替代物资：选择可在此时点发动的弃牌状态'}];}break;
  case 'DE-10':if(phase('TURN_START_WINDOW'))effects=[...(s.units.some(u=>u.country===seat&&u.type==='army'&&u.regionId==='scandinavia'&&suppliedUnits(s).has(u.id))?[choose((['united_kingdom','soviet_union','united_states'] as SeatId[]).map(v=>top(v,b?3:2)))]:[]),score(3)];break;
  case 'DE-11':if(phase('SCORE'))effects=[a('land_battle')];break;
  case 'DE-12':if(mine('land_battle'))effects=[a('build_army',[region!])];break;
  case 'UK-03':if(phase('SCORE'))effects=[a(b?'recruit_army':'build_army',['canada'])];break;
  case 'UK-04':if(timing==='Before'&&e.kind==='signal'&&e.tag==='ARMAMENT'&&allianceOf(frame.owner)==='axis')effects=[{kind:'frameChange',frameId:frame.id,cancel:true,finalZone:'removed',label:'秘密情报机构：取消军备，免除费用'}];break;
  case 'UK-05':if(phase('SCORE'))effects=[a('destroy',['british_isles'])];break;
  case 'UK-06':if(phase('SCORE'))effects=[{kind:'cards',seat,from:'hand',to:'discardPile',min:1,max:1,filter:'build_army',fee:true,label:'额外支付一张建设陆军'},a('recruit_army',['australia','india','south_africa'])];break;
  case 'UK-07':case 'US-04':if(own&&timing==='After'&&e.kind==='signal'&&(e.tag==='ARMAMENT_ANYTIME'||e.tag.startsWith('PHASE:')))effects=[choose([score(1),a('air_deploy',id==='UK-07'?['australia','new_zealand','canada','south_africa']:undefined)])];break;
  case 'UK-10':if(phase('SUPPLY'))effects=[{kind:'flag',flag:'supplyCountries',ids:['united_kingdom','france'],label:d.name}];break;
  case 'JP-01':if(phase('SCORE')&&s.units.some(u=>u.country===seat&&u.type==='navy'&&u.regionId==='sea_north_pacific'))effects=[score(4)];break;
  case 'JP-02':if(phase('SCORE')&&s.units.some(u=>u.country===seat&&u.type==='army'&&u.regionId==='hawaii'))effects=[...(b?[score(2),{kind:'cards' as const,seat,from:'hand' as const,to:'faceDown' as const,filter:'响应',min:1,max:1,label:'暗置一张响应'}]:[score(4)])];break;
  case 'JP-03':if(phase('SCORE'))effects=[a('build_navy')];break;
  case 'JP-04':if(timing==='Before'&&battle&&defender&&allianceOf(defender.country)==='axis'&&near(s,c,'sea_east_china',false).includes(defender.regionId))effects=[protect(true)];break;
  case 'JP-05':if(mine('sea_battle'))effects=[a('sea_battle',near(s,c,region!))];break;
  case 'JP-06':if(phase('SCORE'))effects=[{kind:'cards',seat,from:'hand',to:'faceDown',filter:'响应',min:1,max:1,label:'暗置常规手牌响应'}];break;
  case 'JP-08':if(mine('build_navy'))effects=[a('sea_battle',near(s,c,region!,false))];break;
  case 'JP-09':if(phase('SCORE'))effects=[a('recruit_army',['iwo_jima','new_guinea'])];break;
  case 'SU-01':if(mine('land_battle'))effects=[replaceArmy()];break;
  case 'SU-03':if(timing==='After'&&e.kind==='remove'&&e.unit.country===seat&&e.unit.type==='army'&&e.cause==='land_battle')effects=[replaceArmy()];break;
  case 'SU-04':if(phase('SCORE'))effects=[choose([a('land_battle',['scandinavia']),a('build_army',['scandinavia'])])];break;
  case 'SU-06':if(attacked&&action?.action==='land_battle'&&s.units.some(u=>u.country===seat&&u.type==='navy'&&near(s,c,region!,false).includes(u.regionId)))effects=[protect()];break;
  case 'SU-15':if(attacked&&action?.action==='land_battle'&&action.country==='japan')effects=[protect()];break;
  case 'SU-16':if(timing==='After'&&battle&&action?.country==='germany'&&action.option?.defenderCountry===seat&&!s.prelude.wars.slice(s.prelude.installedWar?.[card.id]??0).some(w=>w.attacker===seat&&w.defender==='germany'))effects=[a('recruit_army',near(s,c,'moscow'))];break;
  case 'IT-02':if(phase('SCORE'))effects=[a('recruit_army',['north_africa'])];break;
  case 'IT-03':if(phase('SCORE'))effects=[a('build_army',['italy'])];break;
  case 'IT-04':if(phase('SCORE'))effects=[a('recruit_army',['south_africa'])];break;
  case 'IT-05':if(phase('SCORE'))effects=[a('destroy',['balkans'])];break;
  case 'IT-06':if(phase('SCORE'))effects=[a('build_navy',['sea_mediterranean'])];break;
  case 'IT-07':if(phase('SCORE')&&!s.units.some(u=>u.type==='army'&&allianceOf(u.country)==='allies'&&u.regionId==='middle_east'))effects=[top('united_kingdom',4)];break;
  case 'US-01':if(phase('TURN_START_WINDOW')){const targets=(['germany','japan','italy'] as SeatId[]).filter(v=>s.units.some(u=>u.country===seat&&u.type!=='air'&&near(s,c,homeRegion(s,v),false).includes(u.regionId)));effects=[...(targets.length?[choose(targets.map(v=>top(v,4)))]:[]),score(2)];}break;
  case 'US-02':if(phase('SCORE'))effects=[a('recruit_navy',near(s,c,'sea_east_pacific'))];break;
  case 'US-05':if(phase('TURN_START_WINDOW'))effects=[preludeEffect(seat,'wartime-hand')];break;
  case 'US-16':if(phase('SCORE'))effects=[a('recruit_army',['philippines'])];break;
  }
  if(timing==='After'&&action&&placed){
   const axis=allianceOf(action.country)==='axis',build=action.action==='build_army',navy=action.action==='build_navy';
   const hit=id==='UK-01'&&axis&&['build_navy','recruit_navy'].includes(action.action)&&['sea_south_china','sea_arabian'].includes(region!)
    ||id==='UK-02'&&axis&&['build_army','recruit_army'].includes(action.action)&&region==='western_europe'&&(b||(s.events.slice(s.prelude.installedEvent?.[card.id]??0).find(v=>v.type==='UNIT_PLACED'&&v.regionId===region&&allianceOf(v.country)==='axis')===[...s.events].reverse().find(v=>v.type==='UNIT_PLACED'&&v.unitId===placed.id)))
    ||id==='UK-08'&&axis&&navy&&region==='sea_north_sea'||id==='UK-09'&&axis&&build&&region==='southeast_asia'
    ||id==='JP-07'&&!axis&&['build_army','recruit_army'].includes(action.action)&&region==='eastern_china'
    ||id==='IT-01'&&!axis&&navy&&region==='sea_mediterranean'||id==='US-03'&&action.country==='japan'&&build&&['eastern_china','western_china'].includes(region!);
   if(hit){effects=[remove(placed)];
    if(b&&id==='UK-02')effects=[{kind:'choose',seat:seatOf(action.country),min:1,max:1,label:'斯通尼战役：弃置3张手牌保留陆军，或不支付并消灭此陆军',options:[
     {id:'destroy',label:'不支付，消灭此陆军',effects:[remove(placed)]},
     {id:'pay',label:'弃置3张手牌，保留此陆军',effects:[{kind:'cards',seat:seatOf(action.country),from:'hand',to:'discardPile',min:3,max:3,fee:true,label:'斯通尼战役：弃置3张手牌'},{kind:'trace',label:'已支付3张手牌，此陆军不被斯通尼战役消灭'}]}
    ]}];
   }
  }
  if(!military&&timing==='Before'&&battle&&action){
   const opponent=id==='JP-14'?'soviet_union':id==='SU-08'?'japan':id==='SU-10'?'germany':undefined;
   if(opponent&&action.country===opponent&&defender?.country===seat){const broken=s.prelude.wars.slice(s.prelude.installedWar?.[card.id]??0).some(w=>w.attacker===seat&&w.defender===opponent);effects=[score(broken?0:id==='JP-14'?2:4)];}
   if(id==='UK-17'&&action.country==='italy'&&s.round===1&&!s.prelude.active)effects=[score(4)];
  }
  if(b){
   const install:Effect={kind:'cards',seat,from:'hand',to:'faceDown',filter:'响应',min:1,max:1,label:'暗置一张手牌响应'};
   if(id==='SU-04'&&phase('SCORE'))effects=[choose([a('build_army',['scandinavia']),a('recruit_army',['scandinavia'])])];
   if(id==='SU-07'&&mine('land_battle')&&region)effects=[a('land_battle',near(s,c,region))];
   if(id==='US-16'&&phase('SCORE'))effects=[a('recruit_army',['philippines','iwo_jima','indonesia'])];
   if(id==='SU-06')effects=own&&timing==='After'&&e.kind==='signal'&&(e.tag==='ARMAMENT_ANYTIME'||e.tag.startsWith('PHASE:'))?[choose([ {kind:'action',country:'france',action:'air_deploy',label:'法国部署一支空军'},{kind:'action',country:'soviet_union',action:'air_deploy',label:'苏联部署一支空军'}])]:[];
   if(id==='SU-18'&&timing==='After'&&action&&s.balanceFirstAttacks?.[card.id]===`${s.balanceResolutionSerial}:${frame.currentEventId}`)effects=[balanceEffect(seat,'relocate-industry')];
   if(id==='UK-10')effects=phase('TURN_START_WINDOW')?[balanceEffect(seat,'exile-government')]:[];
   if(id==='UK-07'&&effects.length)effects=[score(1),a('air_deploy',['australia','india','canada','south_africa'])];
   if(id==='JP-01'){const seas=new Set(s.units.filter(u=>u.country===seat&&u.type==='navy'&&['sea_north_pacific','sea_central_pacific','sea_south_pacific','sea_east_pacific','sea_southeast_pacific'].includes(u.regionId)).map(u=>u.regionId));effects=phase('SCORE')&&seas.size>=2?[score(2),install]:[];}
   if(id==='IT-07'&&phase('SCORE'))effects=[...(!s.units.some(u=>u.type==='army'&&allianceOf(u.country)==='allies'&&u.regionId==='middle_east')?[top('united_kingdom',2)]:[]),score(3)];
   if(id==='IT-12'&&phase('SCORE'))effects=[{...a('destroy',['north_africa','south_africa']),destroyTypes:['army','navy']} as Effect];
   if(id==='IT-15'&&!s.prelude.active&&s.round===1&&phase('TURN_START_WINDOW'))effects=[balanceEffect(seat,'italian-ambition')];
   if(id==='US-01')effects=effects.map(effect=>effect.kind==='choose'?{...effect,options:effect.options.map(o=>({...o,effects:o.effects.map(v=>v.kind==='deckTop'?{...v,count:5}:v)}))}:effect);
   if(id==='SU-16'&&effects.length)effects=[choose([install,...effects])];
   if(id==='DE-01'&&effects.length){const attacker=action!.decisionSeat??frame.owner;effects=[{kind:'choose',seat:attacker,min:1,max:1,label:'88毫米防空炮：弃三张手牌继续攻击，或本次无法移除守军',options:[{id:'protect',label:'不支付，本次守军不被移除',effects:[protect(true)]},{id:'pay',label:'支付三张手牌',effects:[{kind:'cards',seat:attacker,from:'hand',to:'discardPile',min:3,max:3,fee:true,label:'支付三张手牌'},{kind:'trace',label:'继续攻击'}]}]}];}
  }
  if(!effects.length)continue;
  const fee:Effect={kind:'cards',seat,from:'hand',to:'discardPile',min:id==='UK-06'&&!b?2:1,max:id==='UK-06'&&!b?2:1,strictFee:true,publicDiscard:!!copyFees,remember:b&&['SU-01','SU-03'].includes(id)?'armament-cost':undefined,allowedIds:b&&['SU-01','SU-03'].includes(id)&&!s.units.some(u=>u.country===seat&&u.type==='army'&&u.regionId!==(region??(e.kind==='remove'?e.unit.regionId:undefined)))?s.decks[seat].hand.filter(c=>c.definitionId==='build_army').map(c=>c.id):copyFees,requirements:b&&id==='UK-02'?['land_battle']:id==='UK-06'?(b?['build_army']:['*','build_army']):undefined,fee:true,label:b&&id==='UK-02'?'军备费用：弃一张发起陆战':b&&id==='UK-06'?'军备费用：弃一张建设陆军':id==='UK-06'?'军备费用：弃两张手牌，其中至少一张建设陆军':'军备通用费用：弃一张常规手牌'};
  if(id==='UK-06')effects=effects.slice(1);
  rules.push({id:`${card.id}:${frame.currentEventId}:${timing}`,placementPriority:timing==='After'&&!!action&&['build_army','build_navy','recruit_army','recruit_navy'].includes(action.action)&&(id==='UK-02'||effects.some(effect=>effect.kind==='remove'||effect.kind==='action'&&effect.action==='destroy')),scopeId:d.id,boundEventId:frame.currentEventId!,label:d.name,sourceInstanceId:card.id,owner:seat,timing,on:e.label,mandatory:!military,source:military?'response':'active',finalZone:'removed',minHand:military?(id==='UK-06'&&!b?2:1):0,atomic:true,effects:military?[{kind:'signal',tag:'ARMAMENT',label:`发动军备【${d.name}】`},fee,...effects]:effects});
 }
 return rules;
}

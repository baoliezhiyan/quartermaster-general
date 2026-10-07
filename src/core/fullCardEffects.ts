import { countryActionName } from './effectNames';
import {specialCard} from './cardCatalog';
import {balanceEffect} from './balanceEffects';
import { allianceOf,cardName } from './basic';
import { adjacentRegions, suppliedUnits } from './supply';
import { REGIONS, withinPrintedDistance } from './map';
import { homeRegion } from './modifiers';
import type { CardInstance, ReadState, SeatId } from './types';
import type { Effect } from './resolutionTypes';

const act=(country:CardInstance['country'],action:Extract<Effect,{kind:'action'}>['action'],regions?:string[]):Extract<Effect,{kind:'action'}>=>({kind:'action',country,action,regions,label:`${regions?.length?'在'+regions.map(id=>REGIONS.find(r=>r.id===id)?.name).join('、')+'：':''}${countryActionName(country,action)}`});
const top=(seat:SeatId,count:number):Effect=>({kind:'deckTop',seat,count,label:`${seat}弃牌库顶 ${count} 张`});
const points=(seat:SeatId,amount:number):Effect=>({kind:'score',seat,amount,label:`获得 ${amount} 分`});
export const near=(s:ReadState,c:CardInstance['country'],id:string,include=true)=>adjacentRegions(s,c,id,include);
export function distanceWithin(_s:ReadState,_c:CardInstance['country'],a:string,b:string,n:number):boolean {
  return withinPrintedDistance(a,b,n);
}
/** Explicit handlers; text is display/source data, never an executable rule parser. */
export function fullCardEffects(s:ReadState,card:CardInstance,targets:string[]):Effect[]|undefined {
  const c=card.country,seat=card.deckOwner,id=Number(card.definitionId.replace('special_',''));
  const a=(action:Extract<Effect,{kind:'action'}>['action'],regions?:string[])=>act(c,action,regions);
  const own=s.units.filter(u=>u.country===c);
  const count=(type:string,regions?:string[])=>own.filter(u=>(type==='base'?u.type!=='air':u.type===type)&&(!regions||regions.includes(u.regionId))).length;
  const axisArmy=(regions:string[])=>s.units.some(u=>u.type==='army'&&allianceOf(u.country)==='axis'&&regions.includes(u.regionId));
  const alliedNavy=(region:string)=>s.units.some(u=>u.type==='navy'&&allianceOf(u.country)==='allies'&&u.regionId===region);
  const range=(home:string,n:number,type='army')=>own.some(u=>(type==='base'?u.type!=='air':u.type===type)&&distanceWithin(s,c,home,u.regionId,n));
  const choose=(effects:Effect[],max=1):Effect=>({kind:'choose',seat,min:1,max,options:effects.map((e,i)=>({id:String(i),label:e.label,effects:[e]})),label:`选择 1 至 ${max} 项行动`});
  const removeChoice=(target:SeatId,units:ReadState['units']):Effect=>({kind:'choose',seat:target,min:1,max:1,autoSingle:true,label:units.length?'选择移除自己的部队，或弃牌库顶两张':'没有可移除的部队，必须弃置牌库顶两张',options:[{id:'discard',label:'弃牌库顶两张',effects:[top(target,2)]},...units.map(unit=>({id:unit.id,label:`移除${REGIONS.find(r=>r.id===unit.regionId)?.name}的部队`,effects:[{kind:'remove' as const,unit:{...unit},supplied:suppliedUnits(s).has(unit.id),cause:'economic',label:'经济战：移除部队'}]}))]});
  if(s.rules?.balanceEnabled){
    const choose=(effects:Effect[][]):Effect=>({kind:'choose',seat,min:1,max:1,label:'选择卡牌效果',options:effects.map((effects,i)=>({id:String(i),label:effects.map(e=>e.label).join('；'),effects}))});
    const returnSource=(filter:string):Effect=>({kind:'choose',seat,min:0,max:1,label:`可选择弃置一张【${cardName({definitionId:filter})}】，将本牌洗回牌库`,options:[{id:'return',label:'支付并洗回',effects:[{kind:'cards',seat,from:'hand',to:'discardPile',filter,min:1,max:1,fee:true,label:'支付'+cardName({definitionId:filter})},balanceEffect(seat,'return-source')]}]});
    switch(id){
      case 178:return [{kind:"signal",tag:"INSTALL",label:"暗置响应：满洲攻略"}];
      case 227:return [{kind:"cards",seat,from:"hand",to:"discardPile",min:2,max:2,fee:true,label:"弃置两张手牌"},{kind:"cards",seat,from:"hand",to:"faceDown",filter:"响应",min:1,max:1,label:"从剩余手牌中暗置一张响应；没有响应则略过"},{kind:"extraPlay",seat:"germany",from:"hand",filter:"状态",allowSkip:true,label:"德国可打出一张手牌中的状态牌"},{kind:"signal",tag:"STEEL_PACT_COMPLETE",label:"钢铁条约结算完成"}];
      case 113:return [{...act('china','recruit_army',['eastern_china','western_china','mongolia']),bindAs:'new-china'},{...act('china','land_battle'),fromBinding:'new-china',bindAttacker:true,decisionSeat:seat},returnSource('land_battle')];
      case 255:return [{...act('china','land_battle'),bindAs:'xiangxi-battle'},balanceEffect(seat,'build-battle-region'),returnSource('build_army')];

      case 91:return [{kind:'signal',tag:'INSTALL',label:'部署重庆国民政府'},act('china','recruit_army',['western_china'])];
      case 92:return [balanceEffect('japan','reveal-response')];
      case 241:return [balanceEffect('soviet_union','reveal-response')];
      case 27:case 28:return [choose([[a('build_navy')],[a('sea_battle')]])];
      case 33:case 35:return [choose([[a('build_army')],[a('land_battle')]])];
      case 29:return [a('land_battle'),{kind:'cards',seat,from:'drawPile',to:'hand',min:0,max:1,allowedIds:s.decks[seat].drawPile.filter(c=>(specialCard(c.definitionId,c.balance)?.country??c.country)==='france').map(c=>c.id),label:'可选择一张法国牌加入手牌'}];
      case 61:return [a('recruit_army',['siberia']),a('land_battle',near(s,c,'siberia'))];
      case 64:return [a('recruit_army',['kazakhstan','vladivostok']),a('build_army',['moscow','siberia'])];
      case 65:return [a('recruit_army',['eastern_europe']),a('recruit_army',['ukraine'])];
      case 79:case 163:case 247:case 251:return [{kind:'signal',tag:'INSTALL',label:'部署状态'}];
      case 154:return [a('build_navy',['sea_baltic']),...(s.units.some(u=>u.type==='army'&&['germany','soviet_union'].includes(u.country)&&u.regionId==='ross_region')?[a('recruit_army',['scandinavia']),{kind:'extraPlay' as const,seat,from:'hand' as const,mention:'斯堪的纳维亚',label:'额外打出涉及斯堪的纳维亚的手牌'}]:[])];
      case 166:return [{...a('destroy',['scandinavia']),destroyTypes:['army','navy']} as Effect,a('build_navy',['sea_baltic']),{kind:'extraPlay',seat,from:'hand',mention:'斯堪的纳维亚',allowSkip:true,label:'可额外打出涉及斯堪的纳维亚的手牌'}];
      case 179:return [points(seat,3)];
      case 180:return [points(seat,2*count('air',near(s,c,'western_china'))),top('united_states',2)];
      case 110:return [{kind:'rebuild',country:c,selective:true,label:'战区移动：选择收回任意数量美国陆军及最多一支海军'}];
      case 258:return []; // Enhancement: available only through its PLAY-start trigger.
      case 260:return [{kind:'choose',seat,min:1,max:1,label:`${specialCard(card.definitionId,card.balance)?.name}：选择一张状态卡打出`,options:(['drawPile','discardPile'] as const).flatMap(from=>s.decks[seat][from].filter(v=>specialCard(v.definitionId,v.balance)?.type==='状态').map(v=>({id:v.id,label:v.definitionId,effects:[{kind:'extraPlay' as const,seat,from,selectedCardId:v.id,onlyCardIds:[v.id],label:'打出所选状态卡'}]})))}];
      case 252:return [{kind:'cards',seat,from:'hand',to:'discardPile',min:3,max:3,fee:true,label:'弃置3张手牌'},act('germany','recruit_army',['western_europe']),act('germany','recruit_army',['italy'])];
      case 253:return [{...a('destroy',['sea_north_sea']),destroyTypes:['navy']} as Effect];
    }
  }
  switch(id) {
    case 20:return [a('recruit_army',['india','australia','canada'])];
    case 21:return [a('recruit_army',['south_africa']),a('recruit_navy',['sea_south_atlantic','sea_arabian'])];
    case 22:return [a('destroy',['eastern_europe'])];
    case 24:return [a('destroy',['balkans']),a('recruit_army',['balkans'])];
    case 26:return (['germany','italy'] as const).map(target=>removeChoice(target,s.units.filter(u=>u.country===target&&u.type==='navy'&&u.regionId==='sea_mediterranean')));
    case 27:case 28:return [a('build_navy')];
    case 29:case 113:return [a('land_battle')];
    case 30:return [choose(['western_europe','south_africa','north_africa'].map(r=>a('recruit_army',[r])),2)];
    case 31:return [a('recruit_army',['indonesia']),a('recruit_army',['new_guinea']),a('recruit_navy',['sea_south_china'])];
    case 33:case 35:return [a('build_army')];
    case 32:return [choose([a('recruit_army',['western_europe']),a('land_battle',['western_europe'])])];
    case 34:return [a('recruit_army',['south_africa','north_africa','madagascar','southeast_asia','new_guinea','middle_east'])];
    case 61:return [a('recruit_army',['mongolia']),a('land_battle',['vladivostok','eastern_china'])];
    case 64:return [a('recruit_army',near(s,c,'siberia'))];
    case 62:return [choose(s.units.filter(u=>u.type==='army'&&allianceOf(u.country)==='axis'&&near(s,c,'moscow').includes(u.regionId)).map(u=>({...a('destroy',[u.regionId]),targetIds:[u.id]} as Effect)),2)];
    case 63:case 110:case 156:return [{kind:'rebuild',country:c,label:'收回全部陆军，然后依次重新建设全部被收回的陆军'}];
    case 66:return [a('destroy',['balkans']),choose([a('recruit_army',['balkans']),act('united_kingdom','recruit_army',['balkans'])])];
    case 67:return [a('recruit_army',['vladivostok']),a('land_battle',['eastern_china'])];
    case 68:return [a('build_navy',['sea_east_china']),a('land_battle',['japan'])];
    case 69:return [a('destroy',['eastern_china','western_china'])];
    case 93:return [act('soviet_union','recruit_army',['ross_region']),act('soviet_union','build_army')];
    case 94:return [{kind:'choose',seat,min:1,max:1,label:'选择获得武器援助的同盟国',options:(['united_kingdom','soviet_union'] as const).map(seat=>({id:seat,label:seat,effects:[{kind:'extraPlay',seat,from:'hand',label:'可额外打出一张手牌'},{kind:'draw',seat,count:1,label:'摸一张牌'}]}))}];
    case 96:return [{kind:'extraPlay',seat,from:'discardPile',label:'从弃牌堆打出一张牌'}];
    case 92:return [{kind:'cards',seat:'japan',from:'faceDown',to:'discardPile',min:1,max:1,label:'选择一张暗置响应弃置，不公开牌面'}];
    case 241:return [{kind:'cards',seat:'soviet_union',from:'faceDown',to:'discardPile',min:1,max:1,random:true,label:'意大利随机弃置一张苏联的暗置响应，不公开牌面'}];
    case 95:case 97:{const home=id===95?'new_zealand':'hawaii';return [a('recruit_army',[home]),a('build_navy',near(s,c,home,false))];}
    case 99:return range('japan',2,'navy')?[top('japan',4)]:[];
    case 98:return [{kind:'choose',seat:'united_kingdom',min:1,max:2,label:'选择建设项目，按希望的顺序点击',options:[{id:'army',label:'英国建设陆军',effects:[act('united_kingdom','build_army')]},{id:'navy',label:'英国建设海军',effects:[act('united_kingdom','build_navy')]}]}];
    case 100:case 102:{const target=targets[0] as SeatId;return ['germany','italy','japan'].includes(target)&&range(homeRegion(s,target),id===100?1:3,id===100?'base':'army')?[top(target,id===100?7:4)]:[];}
    case 101:return range(homeRegion(s,'germany'),3)?[top('germany',5)]:[];
    case 103:return range(homeRegion(s,'italy'),2)?[top('italy',4)]:[];
    case 106:return [top('japan',2*own.filter(u=>u.type==='navy'&&distanceWithin(s,c,'japan',u.regionId,2)).length)];
    case 107:return [{...a('build_navy',REGIONS.filter(r=>r.type==='SEA'&&r.id.includes('pacific')).map(r=>r.id)),bindAs:'built-navy'} as Effect,{...a('sea_battle'),fromBinding:'built-navy'} as Effect];
    case 105:return (['germany','italy','japan'] as const).map(target=>removeChoice(target,s.units.filter(u=>u.country===target&&u.type!=='air')));
    case 108:return [a('build_army',['latin_america']),a('build_navy',['sea_mid_atlantic','sea_south_atlantic'])];
    case 111:return [a('build_army',['western_europe']),a('land_battle',['germany','italy'])];
    case 109:return [choose((['united_kingdom','france','united_states','soviet_union','china'] as const).flatMap(country=>[act(country,'recruit_army',near(s,c,homeRegion(s,country))),act(country,'recruit_navy',near(s,c,homeRegion(s,country)))]))];
    case 115:return s.units.some(u=>u.type==='army'&&u.regionId==='southeast_asia'&&allianceOf(u.country)==='allies')?[choose([a('recruit_army',['eastern_china','western_china']),a('destroy',['eastern_china','western_china'])])]:[];
    case 112:return [top('japan',2*own.filter(u=>u.type==='army'||u.type==='air').length)];
    case 152:return [a('build_navy',['sea_north_sea']),a('land_battle',['british_isles'])];
    case 150:return [{...top(seat,1),fee:true},a('recruit_army',['eastern_europe']),{kind:'extraPlay',seat,from:'hand',label:'额外打出一张手牌'}];
    case 151:return [{kind:'extraPlay',seat,from:'drawPile',filter:'状态',label:'从牌库选择一张状态牌打出'}];
    case 154:return s.units.some(u=>u.type==='army'&&['germany','soviet_union'].includes(u.country)&&u.regionId==='ross_region')?[a('build_navy',['sea_baltic']),a('recruit_army',['scandinavia']),{kind:'extraPlay',seat,from:'hand',mention:'斯堪的纳维亚',label:'额外打出正文明确涉及斯堪的纳维亚的牌'}]:[];
    case 155:return [a('build_navy',['sea_black']),a('recruit_army',['middle_east'])];
    case 153:if(s.rules?.balanceEnabled)return [{kind:'cards',seat,from:'drawPile',to:'hand',min:Math.min(2,s.decks[seat].drawPile.length),max:2,label:'从牌库检索2张牌加入手牌'},balanceEffect(seat,'discard-to-seven')];return [{kind:'cards',seat,from:'drawPile',to:'hand',min:0,max:2,label:'选择至多两张牌加入手牌（可不选）'},{kind:'cards',seat,from:'hand',to:'discardPile',min:1,max:1,fee:true,deferredFee:true,label:'弃置一张手牌'}];
    case 157:case 237:return [points(seat,own.filter(u=>u.type!=='air'&&u.regionId!==(id===157?'germany':'italy')).length)];
    case 159:return [act('italy','recruit_army',['balkans']),a('destroy',['ukraine'])];
    case 160:return [choose(['build_army','build_navy','land_battle','sea_battle'].map(action=>a(action as 'build_army')))];
    case 161:return [choose(near(s,c,'germany').filter(r=>REGIONS.find(x=>x.id===r)?.type==='LAND').map(r=>a('recruit_army',[r])),2)];
    case 163:return axisArmy(['scandinavia'])&&axisArmy(['ross_region'])?[top('soviet_union',5),points(seat,1)]:s.resolutionVersion===3?[points(seat,1)]:[];
    case 165:return ['united_kingdom','soviet_union','united_states'].includes(targets[0])?[top(targets[0] as SeatId,2),points(seat,2)]:[];
    case 166:return count('army',['western_europe'])?[points(seat,3),top('united_kingdom',1)]:[];
    case 167:return [points(seat,count('base',near(s,c,'scandinavia'))),top('soviet_union',2)];
    case 168:return [top('united_kingdom',alliedNavy('sea_north_sea')?2:3),points(seat,1)];
    case 169:return [points(seat,count('navy')),top('united_states',2)];
    case 170:return [points(seat,count('base',near(s,c,'sea_north_sea',false))),top('united_kingdom',2)];
    case 178:return [points(seat,own.filter(u=>u.regionId==='sea_east_china'&&u.type!=='army').length),top('soviet_union',1)];
    case 179:return [points(seat,1)];
    case 180:return [points(seat,count('air',near(s,c,'western_china'))),top('united_states',2)];
    case 181:return [points(seat,2*count('navy',near(s,c,'sea_east_pacific'))),top('united_states',2)];
    case 182:return [points(seat,2*count('navy',near(s,c,'sea_arabian'))),top('united_kingdom',2)];
    case 231:return [a('destroy',['north_africa'])];
    case 232:return [a('destroy',['middle_east'])];
    case 233:return [a('build_army',['western_europe','north_africa']),a('build_navy',['sea_mediterranean','sea_north_sea'])];
    case 234:return [a('recruit_navy',['sea_mediterranean']),act('germany','recruit_navy',['sea_mediterranean'])];
    case 238:return [a('recruit_army',['ukraine']),a('recruit_army',['ross_region'])];
    case 239:return [a('recruit_army',['north_africa']),a('recruit_navy',['sea_arabian'])];
    case 240:return [a('destroy',['balkans']),act('germany','recruit_army',['balkans'])];
    case 236:return !s.resolutionVersion?(['germany','italy','japan'] as const).map(seat=>({kind:'randomPlay',seat,label:'随机展示弃牌堆一张牌，可打出基本、状态或经济战，否则置于牌库顶'})):[{kind:'randomPlay',seat:'italy',group:['germany','italy','japan'],label:'三国分别确认翻牌，全部查看后依次选择是否打出'}];
    case 242:return s.units.some(u=>u.country==='united_kingdom'&&u.type==='army'&&distanceWithin(s,c,'ukraine',u.regionId,2))?[top('soviet_union',2),points(seat,1)]:[];
    case 244:return [points(seat,count('navy')),top('united_kingdom',1)];
    case 245:return [top('united_kingdom',alliedNavy('sea_mediterranean')?1:2),points(seat,1)];
    default:return undefined;
  }
}

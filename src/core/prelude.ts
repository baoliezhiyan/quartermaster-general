import {fact} from './factObserver';
import {discardDeckTop} from './decks';
import {inspectTen} from './inspectCards';
import {addResponseNotice} from './responseNotices';
import {balanceEffect} from './balanceEffects';
import {preludeCatalog,specialCard} from './cardCatalog';
import {checkNeutralityTurn} from './neutrality';
import {SEATS} from './types';
import type {GameState,ReadState,SeatId,CountryId,CardInstance} from './types';
import type {Effect,ResolutionFrame,FinalZone} from './resolutionTypes';
import {COUNTRY_NAMES,cardName,shuffle} from './basic';
import {near} from './fullCardEffects';
import {publicRecord} from './publicHistory';

export const isPrelude=(c:{definitionId:string})=>c.definitionId.startsWith('prelude_');
export const persistentHistory=(id:string,balance=false)=>['neutrality_united_states_status','neutrality_soviet_union_status','prelude_UK-17','prelude_JP-14','prelude_SU-08','prelude_SU-10'].includes(id)||balance&&id==='prelude_IT-15';
export function initializePrelude(s:GameState){
 const decks=Object.fromEntries(SEATS.map(seat=>{
  const drawPile=preludeCatalog(!!s.rules?.balanceEnabled).filter(d=>d.deckOwner===seat).map(d=>({id:`${seat}:${d.id}`,definitionId:d.id,deckOwner:seat,country:d.country,...(s.rules?.balanceEnabled?{balance:true}:{})}));
  const discardPile:CardInstance[]=[],hand:CardInstance[]=[];
  return [seat,{drawPile,hand,discardPile}];
 })) as NonNullable<GameState['prelude']>['decks'];
 s.prelude={historyDiscard:true,round:1,active:true,turn:1,tension:0,played:false,discarded:0,decks,installed:{},wars:[]};
 s.phase='PRELUDE';s.status='PLAYING';
 fact(s,'card_moved','准备序章牌库');
 for(const seat of SEATS){const d=decks[seat];shuffle(d.drawPile,s);d.discardPile=d.drawPile.splice(0,2);fact(s,'card_moved','序章初始化弃两张',{seat,cardIds:d.discardPile.map(c=>c.id)});d.hand=d.drawPile.splice(0,2);fact(s,'card_moved','序章初始化抽两张',{seat,cardIds:d.hand.map(c=>c.id)});}
 publicRecord(s,'germany','序章开始：各国序章牌库弃两张、抽两张；常规起手暂不选留。');
}
export function finishPrelude(s:GameState){
 const p=s.prelude;if(!p?.active)throw new Error('当前不在序章阶段。');
 if(s.resolution?.running)throw new Error('请先完成当前结算，再结束序章。');
 s.turnFlags=undefined;if(s.resolution)s.resolution.turnUses={};
 for(const seat of SEATS){const d=p.decks[seat];d.discardPile.push(...d.hand.splice(0),...d.drawPile.splice(0));}
 p.active=false;s.status='SETUP';s.phase='SETUP';s.activeSeat=s.viewSeat=s.operatorSeat='germany';s.setupCompleted=[];
 publicRecord(s,'germany',`序章结束，紧张度 ${p.tension}。各国从当前常规手牌保留至多七张。`);
}
export function finishPreludeTurn(s:GameState){
 const p=s.prelude;if(!p?.active||!p.played||s.resolution?.running)return;
 s.turnFlags=undefined;if(s.resolution)s.resolution.turnUses={};
 const d=p.decks[s.activeSeat];d.discardPile.push(...d.hand.splice(0));
 if(p.tension>=10||SEATS.every(seat=>!p.decks[seat].drawPile.length&&!p.decks[seat].hand.length)){
  finishPrelude(s);return;
 }
 d.hand.push(...d.drawPile.splice(0,2));p.played=false;p.discarded=0;p.turn++;
 for(let i=0;i<6;i++){s.activeSeat=SEATS[(SEATS.indexOf(s.activeSeat)+1)%6];if(s.activeSeat==='germany'&&p.round!==undefined)p.round++;const next=p.decks[s.activeSeat];if(next.hand.length||next.drawPile.length)break;}
 s.viewSeat=s.operatorSeat=s.activeSeat;
 checkNeutralityTurn(s);
}
export function preludeEffect(seat:SeatId,op:string,count=0,cardId?:string):Effect{
 const labels:Record<string,string>={'spanish-burn':'逐张查看序章牌库顶，决定是否弃置（至多3张）','spanish-pay':'弃置当前序章牌库顶','spanish-settle':'意大利弃置相同数量的序章牌库顶','picnic-uk':'英国可先弃置一张序章手牌，再打出另一张序章手牌；请选择要弃置的牌，或跳过','picnic-pay':'弃置选定的英国序章手牌','play-hand-required':'英国：请选择并打出另一张序章手牌','play-hand-or-top':'美国继续序章操作：可弃置牌库顶，并再打出一张序章牌','purge-double':'可逐张弃置序章牌库顶，每张获得2分','tension':'调整紧张度','discard':`弃置序章牌库顶 ${count} 张`,'shuffle':'洗混序章牌库','shuffle-normal':'洗混常规牌库','arm-from-deck':'从序章牌库选择军备并暗置','unplayed-from-discard':'苏联：从序章弃牌堆选择一张未打出过的牌并打出','play-discard':'打出所选序章弃牌','arm-from-discard':'从序章弃牌选择军备并暗置','install-deck':'暗置所选军备','install-discard':'暗置所选军备','play-hand':'选择一张序章手牌打出（可以跳过）','play-top':'打出序章牌库顶','play-selected':'打出所选序章牌','purge':'逐张弃置序章牌库顶并获得分数','inspect-status':'检视常规牌库顶十张，选择状态牌','play-status':'打出所选状态牌','bottom-seven':'选择7张手牌置于牌库底','wartime-hand':'生产线调至战时状态：调整手牌','draw-to-seven':'补至七张手牌','draw-if-installed':'暗置成功后抽一张','draw-bottomed':'补回相同数量手牌'};
 return {kind:'prelude',seat,op,count,cardId,label:labels[op]??op};
}
export function historyEffects(s:ReadState,card:CardInstance):Effect[]{
 const id=card.definitionId.slice(8),seat=card.deckOwner,c=seat;
 const a=(action:Extract<Effect,{kind:'action'}>['action'],regions?:string[],country:CountryId=c):Effect=>({kind:'action',country,action,regions,label:`${COUNTRY_NAMES[country]} ${action}`});
 const score=(amount:number):Effect=>({kind:'score',seat,amount,label:`获得 ${amount} 分`});
 const top=(target:SeatId,n:number)=>preludeEffect(target,'discard',n);
 const choose=(effects:Effect[]):Effect=>({kind:'choose',seat,min:1,max:1,options:effects.map((e,i)=>({id:String(i),label:e.label,effects:[e]})),label:'选择历史牌效果'});
 const installResponse=():Effect[]=>[{kind:'cards',seat,from:'hand',to:'faceDown',filter:'响应',min:1,max:1,remember:'installed-response',label:'选择常规响应并暗置'},preludeEffect(seat,'draw-if-installed')];
 const own=s.units.filter(u=>u.country===seat);
 if(s.rules?.balanceEnabled){switch(id){
  case 'US-10':return [preludeEffect('united_kingdom','picnic-uk'),preludeEffect('united_states','play-hand-or-top')];
  case 'SU-19':return [a('recruit_army',['ukraine'])];
  case 'SU-14':return [{kind:'cards',seat,from:'hand',to:'discardPile',min:1,max:1,fee:true,label:'支付一张常规手牌'},balanceEffect(seat,'inspect-response')];
  case 'JP-13':return [a('destroy',['eastern_china'])];
  case 'JP-16':return [top('united_states',2),top('united_kingdom',2),score(2)];
  case 'JP-11':return [top('united_kingdom',4),score(2)];
  case 'JP-19':return [a('recruit_army',['eastern_china'])];
  case 'SU-02':case 'IT-16':return [preludeEffect(seat,'purge-double',2)];
  case 'IT-08':return [top('soviet_union',3),score(2)];
  case 'US-08':return (['germany','japan','italy'] as SeatId[]).map(v=>top(v,2));
  case 'US-06':return [preludeEffect('soviet_union','unplayed-from-discard',1)];
  case 'US-14':return [top('japan',4)];
  case 'IT-09':return [...(['united_kingdom','soviet_union','united_states'] as SeatId[]).map(v=>top(v,1)),score(2)];
  case 'IT-14':return [score(2)];
  case 'IT-15':return [{kind:'signal',tag:'INSTALL',label:'正面放置条约【意大利雄心】'}];
 }}
 switch(id){
 case 'DE-13':return [a('recruit_army',['italy'])];case 'DE-14':case 'UK-11':return [a('recruit_army',['eastern_europe'])];
 case 'DE-15':return [score(own.filter(u=>u.type!=='air').length)];case 'DE-16':return [preludeEffect(seat,'arm-from-deck',2),preludeEffect(seat,'shuffle')];
 case 'DE-17':case 'US-11':return [a('build_navy')];
 case 'DE-18':return (['united_kingdom','soviet_union','united_states'] as SeatId[]).map(v=>top(v,3));
 case 'DE-19':case 'US-09':return [preludeEffect(seat,'inspect-status'),preludeEffect(seat,'shuffle-normal')];
 case 'DE-20':return [choose([score(1),a('air_deploy')])];
 case 'UK-12':case 'UK-13':return [choose([a('recruit_army',id==='UK-12'?['north_africa','middle_east']:['south_africa']),a('recruit_army',id==='UK-12'?['north_africa','middle_east']:['south_africa'],'france')])];
 case 'UK-14':return [choose([a('recruit_navy',near(s,c,'british_isles')),a('air_deploy',near(s,c,'british_isles'))])];
 case 'UK-15':return [a('recruit_navy',['sea_north_sea','sea_north_atlantic','sea_mid_atlantic'])];
 case 'UK-16':case 'US-15':return [score(2)];
 case 'UK-17':case 'JP-14':case 'SU-08':case 'SU-10':return [{kind:'signal',tag:'INSTALL',label:'正面放置历史条约'}];
 case 'UK-18':return [a('build_army',['western_europe'])];case 'UK-19':return [preludeEffect(seat,'play-top'),preludeEffect(seat,'play-top')];
 case 'UK-20':return [a('destroy',['eastern_europe'])];
 case 'JP-10':return [choose([score(1),a('air_deploy',own.filter(u=>u.type==='army').map(u=>u.regionId))])];
 case 'JP-11':return [top('united_kingdom',5)];case 'SU-19':return [a('recruit_army',['ukraine'])];
  case 'JP-12':case 'SU-14':return installResponse();
 case 'JP-13':return [choose([a('destroy',['eastern_china']),a('recruit_army',['eastern_china'])])];
 case 'JP-15':return [a('recruit_navy',['sea_east_china','sea_north_pacific','sea_central_pacific'])];
 case 'JP-16':return [top('united_states',2),top('united_kingdom',2),score(1)];
 case 'JP-17':return [score(own.filter(u=>u.type!=='air'&&near(s,c,'sea_east_china').includes(u.regionId)).length)];
 case 'JP-18':return [{kind:'cards',seat,from:'hand',to:'drawPile',min:0,max:s.decks[seat].hand.length,bottom:true,order:true,remember:'bottomed',label:'按顺序选择要置于常规牌库底的手牌'},preludeEffect(seat,'draw-bottomed')];
 case 'SU-02':case 'IT-16':return [preludeEffect(seat,'purge',3)];
 case 'SU-05':return [top(seat,1),preludeEffect(seat,'play-top'),score(1)];
 case 'SU-09':return [a('recruit_army',['kazakhstan'])];
 case 'SU-11':return [preludeEffect(seat,'spanish-burn',3),preludeEffect(seat,'spanish-settle')];
 case 'SU-12':return [a('recruit_army',['ross_region'])];case 'SU-13':return [a('recruit_army',near(s,c,'moscow',false))];
 case 'SU-17':{const regions=['eastern_china','western_china'].filter(r=>!s.units.some(u=>u.type==='army'&&u.regionId===r));return [choose([a('recruit_army',regions,'soviet_union'),a('recruit_army',regions,'china')])];}
 case 'IT-08':return [top('soviet_union',4),score(1)];case 'IT-09':return [...(['united_kingdom','soviet_union','united_states'] as SeatId[]).map(v=>top(v,2)),score(1)];
 case 'IT-10':return [top('united_states',1),score(1)];case 'IT-11':return [top(seat,1),a('build_army',['balkans'])];
 case 'IT-12':return [{...a('destroy',['south_africa']),destroyTypes:['army','navy']} as Effect];case 'IT-13':return [top(seat,1),a('build_navy',['sea_mediterranean'])];case 'IT-14':return [score(1)];
 case 'IT-15':return [score(own.filter(u=>u.type!=='air'&&u.regionId!=='italy').length)];
 case 'US-06':return [choose([a('recruit_army',['western_china'],'soviet_union'),a('recruit_army',['western_china'],'china')])];
 case 'US-07':return [preludeEffect('united_kingdom','arm-from-discard',1)];case 'US-12':return [preludeEffect(seat,'arm-from-discard',1)];
 case 'US-08':return (['germany','italy','japan'] as SeatId[]).map(v=>top(v,1));case 'US-10':return [preludeEffect('united_kingdom','play-hand')];
 case 'US-13':return [top('japan',1)];case 'US-14':return [top('japan',2)];
 default:throw Error(`Missing history handler: ${id}`);
 }
}

export function markPreludeInstall(s:GameState,id:string){const p=s.prelude!;if(s.balanceFirstAttacks)delete s.balanceFirstAttacks[id];p.installed[id]=s.revision;(p.installedWar??={})[id]=p.wars.length;(p.installedEvent??={})[id]=s.events.length;}
export function takePreludeCard(s:GameState,seat:SeatId,id:string){
 const d=s.prelude!.decks[seat];let card:CardInstance|undefined;
 for(const zone of ['hand','drawPile'] as const){const i=d[zone].findIndex(c=>c.id===id);if(i>=0){card=d[zone].splice(i,1)[0];break;}}
 if(!card)return;
 s.decks[seat].hand.push(card);markPreludeInstall(s,id);
 return card;
}
export function preludeCardEffects(s:GameState,card:CardInstance):{effects:Effect[];zone:FinalZone}{
 const d=specialCard(card.definitionId,card.balance)!;
 if(d.type==='军备')return {effects:[{kind:'signal',tag:'INSTALL',label:'暗置军备'}],zone:'faceDown'};
 return {effects:[{...preludeEffect(card.deckOwner,'tension',d.tension??0),label:`紧张度 ${(d.tension??0)>=0?'+':''}${d.tension}`},...historyEffects(s,card)],zone:persistentHistory(d.id,!!card.balance)?'active':s.prelude?.historyDiscard?'discardPile':'removed'};
}

/** Runtime operations expand into ordinary serializable effects and choices. */
export function applyPreludeEffect(s:GameState,f:ResolutionFrame,e:Extract<Effect,{kind:'prelude'}>,push:(card:CardInstance,effects:Effect[],zone:FinalZone)=>void){
 const p=s.prelude!,d=p.decks[e.seat],seat=e.seat;
 const insert=(effects:Effect[])=>f.effects.splice(f.nextEffectIndex+1,0,...effects);
 const pick=(cards:CardInstance[],op:string,max:number,optional=false)=>insert([{kind:'choose',seat,min:optional?0:Math.min(max,cards.length),max:Math.min(max,cards.length),label:e.label,options:cards.map(c=>({id:c.id,label:c.definitionId,effects:[preludeEffect(seat,op,0,c.id)]}))}]);
 switch(e.op){
 case 'tension':p.tension+=e.count;publicRecord(s,seat,`紧张度 ${e.count>=0?'+':''}${e.count}，当前 ${p.tension}。`);break;
 case 'discard':{
  const cards=d.drawPile.splice(0,e.count);d.discardPile.push(...cards);
  const missing=p.active&&f.owner!==seat?Math.max(0,e.count-cards.length):0;
  const regular=s.decks[seat].drawPile.slice(0,missing);
  const result=missing?discardDeckTop(s,seat,missing,f.owner,false):{discarded:0,lost:0};
  const text=`${COUNTRY_NAMES[seat]}因牌效弃置 ${cards.length} 张序章牌库顶牌`+(missing?`，不足部分改为弃置 ${result.discarded} 张正式牌库顶牌`:'')+(result.lost?`；正式牌库不足，扣 ${result.lost} 分`:'');
  publicRecord(s,seat,text+'。');
  const names=(list:CardInstance[])=>list.map(c=>`【${cardName(c)}】`).join('、');
  addResponseNotice(s,[seat],text+'。'+(cards.length?'序章牌：'+names(cards)+'。':'')+(regular.length?'正式牌：'+names(regular)+'。':''),[...cards,...regular],'序章弃牌结果');
  const event=s.resolution?.events.find(v=>v.id===f.currentEventId);if(event){event.resultText=text;event.detailedNoticeSeats=[seat];}break;
 }
 case 'shuffle':shuffle(d.drawPile,s);break;case 'shuffle-normal':shuffle(s.decks[seat].drawPile,s);break;
 case 'arm-from-deck':pick(d.drawPile.filter(c=>specialCard(c.definitionId,c.balance)?.type==='军备'),'install-deck',e.count);break;
 case 'unplayed-from-discard':pick(d.discardPile.filter(c=>!Object.hasOwn(p.installed,c.id)),'play-discard',1,true);break;
 case 'play-discard':{const i=d.discardPile.findIndex(c=>c.id===e.cardId&&!Object.hasOwn(p.installed,c.id));if(i>=0){const card=d.discardPile.splice(i,1)[0];s.decks[seat].hand.push(card);markPreludeInstall(s,card.id);const v=preludeCardEffects(s,card);push(card,v.effects,v.zone);}break;}
 case 'arm-from-discard':pick(d.discardPile.filter(c=>specialCard(c.definitionId,c.balance)?.type==='军备'),'install-discard',e.count,seat!==f.owner);break;
 case 'install-deck':case 'install-discard':{const z=e.op==='install-deck'?d.drawPile:d.discardPile,i=z.findIndex(c=>c.id===e.cardId);if(i>=0){const c=z.splice(i,1)[0];s.decks[seat].faceDown.push(c);markPreludeInstall(s,c.id);publicRecord(s,seat,`${COUNTRY_NAMES[seat]}暗置一张军备。`);}break;}
 case 'picnic-uk':if(d.hand.length>=2)pick(d.hand,'picnic-pay',1,true);break;
 case 'picnic-pay':{const i=d.hand.findIndex(c=>c.id===e.cardId);if(i>=0){d.discardPile.push(...d.hand.splice(i,1));insert([preludeEffect(seat,'play-hand-required')]);}break;}
 case 'play-hand-required':pick(d.hand,'play-selected',1);break;
 case 'play-hand-or-top':if(s.activeSeat===seat){p.played=!d.hand.length&&!d.drawPile.length;p.discarded=0;publicRecord(s,seat,'美国继续序章操作，可重新弃置序章牌库顶，并再打出一张序章牌。');}else pick([...d.hand,...d.drawPile.slice(0,1)],'play-selected',1);break;
 case 'play-hand':pick(d.hand,'play-selected',1,true);break;
 case 'play-top':case 'play-selected':{const id=e.op==='play-top'?d.drawPile[0]?.id:e.cardId;if(id){const c=takePreludeCard(s,seat,id);if(c){const v=preludeCardEffects(s,c);push(c,v.effects,v.zone);}}break;}
 case 'spanish-burn':if(e.count>0&&d.drawPile.length)insert([{kind:'choose',seat,min:0,max:1,label:`当前序章牌库顶：【${cardName(d.drawPile[0])}】。是否弃置？还可弃${e.count}张；跳过则停止`,options:[{id:'discard',label:'弃置当前顶牌',effects:[preludeEffect(seat,'spanish-pay'),preludeEffect(seat,'spanish-burn',e.count-1)]}]}]);break;
 case 'spanish-pay':if(d.drawPile.length){(f.memory??={})['spanish-burned']??=[];f.memory['spanish-burned'].push(d.drawPile[0].id);insert([preludeEffect(seat,'discard',1)]);}break;
 case 'spanish-settle':{const count=f.memory?.['spanish-burned']?.length??0;if(count)insert([preludeEffect('italy','discard',count)]);break;}
 case 'purge-double':if(e.count>0&&d.drawPile.length)insert([{kind:'choose',seat,min:0,max:1,label:'可逐张弃置序章顶牌，每张获得2分',options:[{id:'discard',label:'弃置顶牌并获得2分',effects:[preludeEffect(seat,'discard',1),{kind:'score',seat,amount:2,label:'获得2分'},preludeEffect(seat,'purge-double',e.count-1)]}]}]);break;
 case 'purge':if(e.count>0&&d.drawPile.length)insert([{kind:'choose',seat,min:0,max:1,label:`可弃置顶牌【${specialCard(d.drawPile[0].definitionId,d.drawPile[0].balance)?.name}】得 1 分，或停止（还可弃 ${e.count} 张）`,options:[{id:'discard',label:'弃置当前顶牌，获得1分',effects:[preludeEffect(seat,'discard',1),{kind:'score',seat,amount:1,label:'弃置序章顶牌得1分'},preludeEffect(seat,'purge',e.count-1)]}]}]);break;
 case 'inspect-status':pick(inspectTen(s,seat,'状态').filter(c=>specialCard(c.definitionId,c.balance)?.type==='状态'),'play-status',1);break;
 case 'play-status':{const z=s.decks[seat].drawPile,i=z.findIndex(c=>c.id===e.cardId);if(i>=0){const c=z.splice(i,1)[0];s.decks[seat].hand.push(c);push(c,[{kind:'signal',tag:'INSTALL',label:'部署常规状态'}],'active');}break;}
 case 'wartime-hand':if(s.rules?.balanceEnabled){insert([{kind:'draw',seat,count:Math.max(0,14-s.decks[seat].hand.length),label:'将手牌摸至14张'},preludeEffect(seat,'bottom-seven')]);break;}insert([{kind:'cards',seat,from:'hand',to:'drawPile',min:0,max:s.decks[seat].hand.length,bottom:true,order:true,label:'按顺序选择置于牌库底的手牌'},preludeEffect(seat,'draw-to-seven')]);break;
 case 'bottom-seven':{const count=Math.min(7,s.decks[seat].hand.length);insert([{kind:'cards',seat,from:'hand',to:'drawPile',min:count,max:count,bottom:true,order:true,label:'按顺序选择7张手牌置于牌库底'}]);break;}
 case 'draw-to-seven':insert([{kind:'draw',seat,count:Math.max(0,7-s.decks[seat].hand.length),label:'补至七张手牌'}]);break;
 case 'draw-if-installed':if(f.memory?.['installed-response']?.length)insert([{kind:'draw',seat,count:1,label:'成功暗置响应后摸1张常规牌'}]);break;
 case 'draw-bottomed':insert([{kind:'draw',seat,count:f.memory?.bottomed?.length??0,label:'抽回等量常规手牌'}]);break;
 default:throw Error(`Unknown prelude operation: ${e.op}`);
 }
}

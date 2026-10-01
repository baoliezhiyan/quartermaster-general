import {REGIONS} from './map';
import {suppliedUnits} from './supply';
import {inspectTen} from './inspectCards';
import type {Effect,ResolutionFrame} from './resolutionTypes';
import type {GameState,SeatId} from './types';
import {publicRecord} from './publicHistory';
import {shuffle} from './basic';
import {specialCard} from './cardCatalog';
import {endNeutrality} from './neutrality';
import {revealPublic,revealDiscardedCards} from './publicHistory';
const labels:Record<string,string>={'shuffle-deck':'洗混牌库','armament-rebuild':'按军备费用执行陆军建设','italian-ambition':'意大利雄心：选择打出手牌状态，或从牌库打出得分状态','italian-ambition-deck':'从牌库打出最靠顶的得分状态','discard-to-seven':'弃置手牌直至不超过7张','draw-to-seven':'抽牌直至手牌达到7张','draw-bottomed':'抽回等量手牌','end-neutrality':'结束中立','return-source':'将本牌洗入牌库','scry':'检视并排列牌库顶四张牌','scry-top':'排列剩余顶牌','exile-government':'打出流亡政府','relocate-industry':'战时工业东迁','inspect-response':'检视牌库顶十张并暗置响应','inspect-take':'选择剩余检视牌','reveal-response':'公开并选择弃置响应','build-battle-region':'在刚才战斗的地区建设陆军','two-basic-plays':'本回合可标准打出至多两张基本牌','bomber-economy':'选择额外打出的经济战并支付费用'};
export const balanceEffect=(seat:SeatId,op:string,cardId?:string):Effect=>({kind:'balance',seat,op,cardId,label:labels[op]??op});
/** Dynamic choices expand into the ordinary effect queue; they never bypass response windows. */
export function applyBalanceEffect(s:GameState,f:ResolutionFrame,e:Extract<Effect,{kind:'balance'}>){
 const deck=s.decks[e.seat],insert=(effects:Effect[])=>f.effects.splice(f.nextEffectIndex+1,0,...effects);
 const next=(op:string,cardId?:string)=>balanceEffect(e.seat,op,cardId);
 const action=(country:SeatId|'france',region:string):Effect=>({kind:'action',country,action:'recruit_army',regions:[region],label:'征召陆军'});
 switch(e.op){
 case 'armament-rebuild':{
  const paid=(f.memory?.['armament-cost']??[]).some(id=>deck.discardPile.some(c=>c.id===id&&c.definitionId==='build_army'));
  const build:Effect={kind:'action',country:e.seat,action:'build_army',regions:e.cardId?[e.cardId]:[],label:'在战斗地区建设苏联陆军'};
  if(paid){revealDiscardedCards(s,e.seat,deck.discardPile.filter(c=>(f.memory?.['armament-cost']??[]).includes(c.id)&&c.definitionId==='build_army'));insert([build]);}
  else insert([{kind:'choose',seat:e.seat,min:1,max:1,label:'选择移除另一支苏联陆军，再在战斗地区建设陆军',options:s.units.filter(u=>u.country===e.seat&&u.type==='army'&&u.regionId!==e.cardId).map(u=>({id:u.id,label:REGIONS.find(r=>r.id===u.regionId)?.name??u.regionId,effects:[{kind:'remove',unit:{...u},supplied:suppliedUnits(s).has(u.id),cause:'card',label:'移除另一支苏联陆军'},build]}))}]);
  break;
 }
 case 'shuffle-deck':shuffle(deck.drawPile,s);break;
 case 'italian-ambition':insert([{kind:'choose',seat:e.seat,min:1,max:1,label:'意大利雄心：选择打出状态的方式',options:[
  {id:'hand',label:'打出手牌中的一张状态牌',effects:[{kind:'extraPlay',seat:e.seat,from:'hand',filter:'状态',label:'意大利雄心：选择并打出一张手牌中的状态牌'}]},
  {id:'deck',label:'从牌库打出最靠近牌库顶的得分状态',effects:[next('italian-ambition-deck')]}
 ]}]);break;
 case 'italian-ambition-deck':{const card=deck.drawPile.find(c=>{const d=specialCard(c.definitionId,c.balance);return d?.type==='状态'&&d.country==='italy'&&!['special_215','special_210','special_211','special_257'].includes(c.definitionId);});
  if(card)insert([{kind:'extraPlay',seat:e.seat,from:'drawPile',selectedCardId:card.id,onlyCardIds:[card.id],indices:[0],label:`意大利雄心：打出【${specialCard(card.definitionId,card.balance)!.name}】`}]);
  else {publicRecord(s,e.seat,'意大利雄心：牌库中没有符合条件的得分状态牌。');}break;}
 case 'discard-to-seven':{const count=Math.max(0,deck.hand.length-7);if(count)insert([{kind:'cards',seat:e.seat,from:'hand',to:'discardPile',min:count,max:count,label:`弃置${count}张手牌，使手牌不超过7张`}]);break;}
 case 'draw-to-seven':insert([{kind:'draw',seat:e.seat,count:Math.max(0,7-deck.hand.length),label:'抽牌直至手牌达到7张'}]);break;
 case 'build-battle-region':{const battle=f.effects.find(v=>v.kind==='action'&&v.bindAs==='xiangxi-battle');if(battle?.kind==='action'&&battle.option?.regionId&&s.resolution?.events.some(v=>v.frameId===f.id&&v.applied&&!v.cancelled&&v.effect?.kind==='action'&&v.effect.bindAs==='xiangxi-battle'))insert([{kind:'action',country:'china',action:'build_army',regions:[battle.option.regionId],label:'在战斗地区建设中国陆军'}]);break;}
 case 'two-basic-plays':s.basicPlaysRemaining=2;break;
 case 'bomber-economy':insert([{kind:'choose',seat:e.seat,min:1,max:1,label:'选择要额外打出的经济战',options:deck.hand.filter(c=>specialCard(c.definitionId,c.balance)?.type==='经济战').map(card=>({id:card.id,label:card.definitionId,effects:[{kind:'deckTop',seat:e.seat,count:2,fee:true,label:'弃置牌库顶两张作为费用'},{kind:'extraPlay',seat:e.seat,from:'hand',onlyCardIds:[card.id],label:'打出选定的经济战'}]}))}]);break;
 case 'draw-bottomed':insert([{kind:'draw',seat:e.seat,count:f.memory?.bottomed?.length??0,label:'抽取等量手牌'}]);break;
 case 'end-neutrality':if(e.seat==='united_states'||e.seat==='soviet_union')endNeutrality(s,e.seat,'卡牌效果解除中立');break;
 case 'return-source':insert([{kind:'frameChange',frameId:f.id,finalZone:'drawPile',label:'将本牌洗回牌库'}]);break;
 case 'scry':{const ids=deck.drawPile.slice(0,4).map(c=>c.id);f.memory??={};f.memory.scry=ids;insert([{kind:'cards',seat:e.seat,from:'drawPile',to:'drawPile',allowedIds:ids,min:0,max:ids.length,bottom:true,order:true,remember:'scry-bottom',label:'依次选择放到牌库底的牌，其余留在顶端。无论置于顶或底，排序数字越小越靠近牌库顶'},next('scry-top')]);break;}
 case 'scry-top':{const ids=(f.memory?.scry??[]).filter(id=>!f.memory?.['scry-bottom']?.includes(id));insert([{kind:'cards',seat:e.seat,from:'drawPile',to:'drawPile',allowedIds:ids,min:ids.length,max:ids.length,order:true,label:'依次排列留在牌库顶的牌，排序数字越小越靠近牌库顶'}]);break;}
 case 'exile-government':{
  const choices=(['hand','drawPile'] as const).flatMap(from=>deck[from].filter(c=>['special_5','special_9'].includes(c.definitionId)).map(c=>({id:c.id,label:`${from==='hand'?'手牌':'牌库'}：${specialCard(c.definitionId,c.balance)!.name}`,effects:[{kind:'extraPlay' as const,seat:e.seat,from,selectedCardId:c.id,onlyCardIds:[c.id],label:'打出所选法国状态'},...(from==='hand'?[action('france',c.definitionId==='special_5'?'british_isles':'south_africa')]:[])]})));
  insert([{kind:'choose',seat:e.seat,min:1,max:1,label:'选择从手牌或牌库打出流亡政府或自由法国；从手牌打出另征召法国陆军',options:choices}]);break;
 }
 case 'relocate-industry':{
  const definitionId='special_42';
  const hand=deck.hand.find(c=>c.definitionId===definitionId),draw=deck.drawPile.find(c=>c.definitionId===definitionId),effects:Effect[]=[];
  if(hand||draw)effects.push({kind:'extraPlay',seat:e.seat,from:hand?'hand':'drawPile',onlyCardIds:[(hand??draw)!.id],label:'打出指定状态牌'});
  effects.push(action('soviet_union','siberia'));
  insert(effects);break;
 }
 case 'inspect-response':{const ids=inspectTen(s,e.seat,'响应').map(c=>c.id);f.memory??={};f.memory.inspected=ids;insert([{kind:'cards',seat:e.seat,from:'drawPile',to:'faceDown',allowedIds:ids,filter:'响应',min:1,max:1,label:'选择检视牌中的一张响应暗置'},next('inspect-take')]);break;}
 case 'inspect-take':insert([{kind:'cards',seat:e.seat,from:'drawPile',to:'hand',allowedIds:f.memory?.inspected??[],min:1,max:1,shuffle:true,label:'从剩余检视牌中选择一张加入手牌'}]);break;
 case 'reveal-response':{
  const responses=deck.faceDown.filter(c=>specialCard(c.definitionId,c.balance)?.type==='响应');if(!responses.length)break;
  const hidden=responses.filter(c=>!s.faceUpResponseIds?.includes(c.id));shuffle(hidden,s);
  if(hidden.length){(s.faceUpResponseIds??=[]).push(hidden[0].id);revealPublic(s,[hidden[0]]);(f.memory??={}).revealedResponses=[hidden[0].id];}
  const shown=responses.filter(c=>s.faceUpResponseIds?.includes(c.id)),remaining=responses.filter(c=>!s.faceUpResponseIds?.includes(c.id));
  insert([{kind:'choose',seat:f.owner,min:1,max:1,label:'选择弃置一张明置响应，或随机弃一张未公开响应',options:[...shown.map(c=>({id:c.id,label:c.definitionId,effects:[{kind:'cards' as const,seat:e.seat,from:'faceDown' as const,to:'discardPile' as const,allowedIds:[c.id],min:1,max:1,random:true,label:'弃置所选明置响应'}]})),...(remaining.length?[{id:'hidden',label:'随机弃置一张未公开响应',effects:[{kind:'cards' as const,seat:e.seat,from:'faceDown' as const,to:'discardPile' as const,allowedIds:remaining.map(c=>c.id),min:1,max:1,random:true,label:'随机弃置未公开响应'}]}]:[])]}]);break;
 }
 default:throw new Error(`Unknown balance operation: ${e.op}`);
 }
}

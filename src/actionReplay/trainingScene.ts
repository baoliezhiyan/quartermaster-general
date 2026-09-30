import {createGame} from '../core/game';
import {boardOptions,applyBoardEffect} from '../core/boardEffects';
import type {BoardEffect} from '../core/boardEffects';
import {reserve,COUNTRY_NAMES,UNIT_NAMES} from '../core/basic';
import {REGION_BY_ID} from '../core/map';
import {suppliedUnits} from '../core/supply';
import {specialCard} from '../core/cardCatalog';
import {SEATS} from '../core/types';
import type {GameState} from '../core/types';
import type {TrainingArchive,TrainingScene,TrainingCard,SceneEffect} from './trainingContract';
import {hash} from './state';
export function validateSceneUnits(s:GameState){
 const ids=new Set<string>(),positions=new Set<string>();
 for(const u of s.units){const region=REGION_BY_ID[u.regionId],key=u.country+':'+u.type+':'+u.regionId;
  if(!region||ids.has(u.id)||positions.has(key)||u.type!=='air'&&region.type!==(u.type==='army'?'LAND':'SEA')||reserve(s,u.country,u.type)<0)throw Error('训练场面兵模非法：'+u.id);
  ids.add(u.id);positions.add(key);
 }
}
export function createTrainingScene(scene:TrainingScene,gameId:string,cards:Map<string,TrainingCard>):GameState {
 const s=createGame(gameId,1,'FULL',false,false,scene.balance);
 for(const seat of SEATS)s.decks[seat]={hand:[],drawPile:[],discardPile:[],active:[],faceDown:[],removed:[],resolving:[]};
 s.units=structuredClone(scene.units);s.scores={...scene.scores};s.round=scene.round;s.phase=scene.phase;s.activeSeat=scene.activeSeat;s.operatorSeat=scene.activeSeat;s.viewSeat=scene.activeSeat;
 s.status='PLAYING';s.setupCompleted=[...SEATS];s.events=[];s.publicLog=[];s.randomState=1;s.unitSerial=0;
 for(const seat of SEATS)for(const cardId of scene.activeCards?.[seat]??[])applyScene(s,{kind:'status',seat,cardId,operation:'install'},cards);
 validateSceneUnits(s);return s;
}
export async function trainingSceneHash(s:GameState){return hash({units:s.units,scores:s.scores,round:s.round,phase:s.phase,activeSeat:s.activeSeat,unitSerial:s.unitSerial??0,active:Object.fromEntries(SEATS.map(seat=>[seat,s.decks[seat].active.map(c=>c.id)])),turnFlags:s.turnFlags??null});}
export function applyScene(s:GameState,e:SceneEffect,cards:Map<string,TrainingCard>):string {
 if(e.kind==='board'){
  const effect:BoardEffect={kind:'action',label:'训练记录场面动作',country:e.country,action:e.action,airDefense:e.airDefense, ...(e.action==='destroy'?{destroyTypes:['army','navy'] as ('army'|'navy')[]}: {})};
  const options=boardOptions(s,effect).filter(o=>o.regionId===e.regionId&&(['attackerId','defenderId','airId','recycleId','mode'] as const).every(k=>e[k]===undefined||e[k]===o[k]));
  if(options.length!==1)throw Error('训练场面动作不合法或目标不唯一：'+e.action+' / '+e.regionId);
  const option=options[0],defender=s.units.find(u=>u.id===option.defenderId);effect.option=option;
  const before=new Set(s.units.map(u=>u.id));if(!applyBoardEffect(s,effect))throw Error('训练场面动作执行失败');
  const created=s.units.filter(u=>!before.has(u.id));
  if(e.newUnitId){if(created.length!==1||s.units.some(u=>u.id===e.newUnitId&&u!==created[0]))throw Error('新兵模 ID 与实际建设不一致');const old=created[0].id;created[0].id=e.newUnitId;for(const event of s.events)if(event.type==='UNIT_PLACED'&&event.unitId===old)event.unitId=e.newUnitId;}
  validateSceneUnits(s);
  const verbs={build_army:'建设陆军',build_navy:'建设海军',recruit_army:'征召陆军',recruit_navy:'征召海军',land_battle:'发起陆战',sea_battle:'发起海战',air_deploy:'部署空军',air_move:'调度空军',air_power:'执行空中力量',destroy:'消灭部队'};
  return COUNTRY_NAMES[e.country]+'在<'+REGION_BY_ID[e.regionId].name+'>'+verbs[e.action]+(defender?'（目标：'+COUNTRY_NAMES[defender.country]+UNIT_NAMES[defender.type]+'）':'');
 }
 if(e.kind==='score'){s.scores[e.seat]+=e.amount;return COUNTRY_NAMES[e.seat]+(e.amount>=0?'获得':'失去')+Math.abs(e.amount)+'分';}
 if(e.kind==='remove'){
  const u=s.units.find(u=>u.id===e.unitId);if(!u)throw Error('待移除兵模不存在');
  if(e.reason==='supply'&&suppliedUnits(s).has(u.id))throw Error('不能以失去补给为由移除仍有补给的兵模');
  s.units=s.units.filter(v=>v.id!==u.id);s.pendingAir=s.pendingAir.filter(id=>id!==u.id);
  return '移除<'+REGION_BY_ID[u.regionId].name+'>'+COUNTRY_NAMES[u.country]+UNIT_NAMES[u.type];
 }
 if(e.kind==='supply'){
  if(e.unitIds.some(id=>!s.units.some(u=>u.id===id)))throw Error('补给目标不存在');
  s.turnFlags??={protected:[],battleProtected:[],supplied:[],supplyCountries:[],supplyRegions:[],suppressed:[],noAirDefense:false};
  s.turnFlags.supplied=[...new Set([...s.turnFlags.supplied,...e.unitIds])];return '指定部队在本回合获得补给';
 }
 const card=cards.get(e.cardId),definition=card&&specialCard(card.definitionId,card.balance);
 if(!card||card.deckOwner!==e.seat||definition?.type!=='状态')throw Error('持续状态必须映射到本客户端已支持的状态规则');
 const active=s.decks[e.seat].active,index=active.findIndex(c=>c.id===card.id);
 if(e.operation==='install'){if(index>=0)throw Error('重复安装状态');active.push({...card});}
 else {if(index<0)throw Error('移除的状态不存在');active.splice(index,1);}
 return COUNTRY_NAMES[e.seat]+(e.operation==='install'?'打出':'弃置')+'【'+card.name+'】';
}
export const trainingCards=(a:TrainingArchive)=>new Map(a.header.cards.map(c=>[c.id,c]));

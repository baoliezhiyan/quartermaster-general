import {BASIC_NAMES,BASIC_COUNTS,COUNTRY_NAMES} from '../core/basic';
import {specialCard} from '../core/cardCatalog';
import {SEATS,type GameState,type SeatId,type CountryId} from '../core/types';
import {createTrainingScene,applyScene,trainingSceneHash} from '../actionReplay/trainingScene';
import {parseTrainingReplay,sealTraining} from '../actionReplay/trainingCodec';
import {TrainingController} from '../actionReplay/TrainingController';
import {ENGINE,VERSION} from '../actionReplay/state';
import type {TrainingHeader,TrainingStart,TrainingStep,TrainingCard,SceneEffect,
  ResourceZone,ResourceContents,ResourceOperation} from '../actionReplay/trainingContract';

type Frame={round:number;phase:GameState['phase'];activeSeat:SeatId;units:GameState['units'];
  scores:GameState['scores'];unitSerial:number;turnFlags:GameState['turnFlags']|null;
  activeCards:Record<SeatId,string[]>;
  resources:Record<SeatId,Record<ResourceZone,string[]>>;
  resolutionEvents:Array<{id:string;applied:boolean;ended?:boolean;effect?:any}>;
  resolutionScenario:string|null};
type Commit={commandType:string;seat:SeatId;cardId?:string;responseCardId?:string;before:Frame;after:Frame;
  cardOutcomes?:{id:string;outcome:'resolved'|'cancelled';appliedEffects:number}[];
  boardEvents:Array<{type:string;revision:number;country:CountryId;action:string;
    regionId:string;attackerId?:string;defenderId?:string;airId?:string;
    recycleId?:string;mode?:string;newUnitId?:string;airDefense?:boolean}>};
type RawRow={recordType?:string;type?:string;seed?:number;trainingMetadata?:Record<string,unknown>;
  seat?:SeatId;activeSeat?:SeatId;choiceKind?:string;
  snapshot?:{state:GameState;header:{seed:number;mode:'A'|'B';cardSet:'events'|'basics';
    courseVersion:string;overridesVersion:string;eventIds:string[];buildFingerprint:string;
    configHash:string;mapVersion:string;
    gameId:string}};
  replayCommits?:Commit[];action?:{label?:string;cardId?:string;choiceIds?:string[]};info?:unknown;
  termination?:string;winner?:string;round?:number;decisions?:number;
  scores?:Record<SeatId,number>;allianceScores?:{axis:number;allies:number}};
const zones=['hand','drawPile','discardPile','resourcePool'] as const;
const basicText:Record<string,string>={build_army:'建设一支陆军。',build_navy:'建设一支海军。',
  land_battle:'发起一次陆战。',sea_battle:'发起一次海战。',air_power:'执行一次空军行动。'};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(step:number,why:string):never=>{throw Error(`训练回放转换在动作 ${step} 停止：${why}`);};
function frame(s:GameState):Frame{return {round:s.round,phase:s.phase,activeSeat:s.activeSeat,
  units:s.units,scores:s.scores,unitSerial:s.unitSerial??0,turnFlags:s.turnFlags??null,
  activeCards:Object.fromEntries(SEATS.map(seat=>[seat,s.decks[seat].active.map(c=>c.id)])) as Frame['activeCards'],
  resources:Object.fromEntries(SEATS.map(seat=>{const d=s.decks[seat];return [seat,{hand:[],
    drawPile:[...d.hand,...d.drawPile].map(c=>c.id),
    discardPile:[...d.discardPile,...d.resolving,...d.removed,...d.active,...d.faceDown].map(c=>c.id),
    resourcePool:s.trainingCourse?.mode==='B'?s.trainingCourse.openIds[seat]:[]}];
  })) as unknown as Frame['resources'],
  resolutionEvents:s.resolution?.events??[],resolutionScenario:s.resolution?.scenario??null};}
function sceneProjection(s:GameState){return {units:s.units,scores:s.scores,round:s.round,phase:s.phase,
  activeSeat:s.activeSeat,unitSerial:s.unitSerial??0,
  activeCards:Object.fromEntries(SEATS.map(seat=>[seat,s.decks[seat].active.map(c=>c.id)])),
  turnFlags:s.turnFlags??null};}
function frameProjection(f:Frame){return {units:f.units,scores:f.scores,round:f.round,phase:f.phase,
  activeSeat:f.activeSeat,unitSerial:f.unitSerial,activeCards:f.activeCards,turnFlags:f.turnFlags};}
function cardsFrom(s:GameState):TrainingCard[]{const byId=new Map<string,TrainingCard>();
  for(const seat of SEATS)for(const zone of ['hand','drawPile','discardPile','active','faceDown','resolving','removed'] as const)
    for(const card of s.decks[seat][zone]){
      const definition=specialCard(card.definitionId,card.balance);
      const basic=BASIC_NAMES[card.definitionId as keyof typeof BASIC_NAMES];
      if(!definition&&!basic)throw Error('训练卡面缺少定义：'+card.definitionId);
      byId.set(card.id,{...card,name:definition?.name??basic,type:definition?.type??'基本牌',
        text:definition?.text??basicText[card.definitionId]});
    }
  return [...byId.values()];
}
function resourcesOf(f:Frame,mode:'A'|'B'):ResourceContents[]{return SEATS.flatMap(seat=>zones.map(zone=>({
  seat,zone,ids:zone==='resourcePool'&&mode==='B'&&seat!==f.activeSeat?[]:
    [...f.resources[seat][zone]],visibility:'owner' as const,
})));}
function newEvents(c:Commit){const before=c.before.resolutionEvents,after=c.after.resolutionEvents;
  const fresh=c.commandType==='PLAY_CARD'||c.before.resolutionScenario!==c.after.resolutionScenario||
    after.length<before.length;
  const old=new Map(fresh?[]:before.map(e=>[e.id,e]));
  return after.filter(e=>e.applied&&e.ended&&(!old.get(e.id)?.applied||!old.get(e.id)?.ended));
}
function timing(s:GameState,f:Frame){if(s.activeSeat!==f.activeSeat||s.round!==f.round){
  s.turnFlags=undefined;s.roundUses={};}
  s.activeSeat=f.activeSeat;s.round=f.round;s.phase=f.phase;
}
function resourceOps(current:Record<SeatId,Record<ResourceZone,string[]>>,c:Commit,
  mode:'A'|'B',n:number):TrainingStep['operations']{
  const output:TrainingStep['operations']=[];
  const emit=(change:ResourceOperation)=>output.push({kind:'resource',change});
  for(const seat of SEATS){const from=current[seat],target=c.after.resources[seat];
    for(const zone of ['discardPile','drawPile'] as const){
      for(let index=0;index<target[zone].length;index++){
        const id=target[zone][index];if(from[zone][index]===id)continue;
        const other=zone==='drawPile'?'discardPile':'drawPile';
        const source=from[zone].includes(id)?zone:from[other].includes(id)?other:null;
        const sourceZone=source??fail(n,`资源 ${id} 未在牌库或弃牌堆中`);
        const sourceList=from[sourceZone],oldIndex=sourceList.indexOf(id);
        sourceList.splice(oldIndex,1);from[zone].splice(index,0,id);
        emit({op:'move',id,from:{seat,zone:sourceZone},to:{seat,zone},index});
      }
    }
    if(!same(from.drawPile,target.drawPile)||!same(from.discardPile,target.discardPile))
      fail(n,`${seat} 的牌库/弃牌堆未能用移动操作还原`);
    if(mode==='A'){if(from.resourcePool.length)fail(n,'A 模式资源池必须为空');continue;}
    const ownTurnStart=(c.before.activeSeat!==c.after.activeSeat||c.before.round!==c.after.round)&&
      c.after.activeSeat===seat;
    if(ownTurnStart){from.resourcePool=[...target.resourcePool];
      emit({op:'set',seat,zone:'resourcePool',ids:[...from.resourcePool],visibility:'owner'});
    }else for(const id of [...from.resourcePool])if(!target.resourcePool.includes(id)){
      from.resourcePool.splice(from.resourcePool.indexOf(id),1);
      emit({op:'remove',seat,zone:'resourcePool',id});
    }
  }
  return output;
}
function applyCommit(s:GameState,c:Commit,cards:Map<string,TrainingCard>,n:number,
  resources:Record<SeatId,Record<ResourceZone,string[]>>,mode:'A'|'B'):TrainingStep['operations'] {
  const ops:TrainingStep['operations']=[];
  timing(s,c.after);
  for(const recorded of c.boardEvents??[]){const {type:_,revision:__,...fields}=recorded;
    const board={kind:'board',...fields} as SceneEffect;
    try{applyScene(s,board,cards);}catch(error){fail(n,`场面动作 ${recorded.action} ${JSON.stringify(board)}：${String(error)}`);}ops.push(board);
  }
  for(const event of newEvents(c)){
    const effect=event.effect;if(effect?.kind==='remove'){
      const id=effect.unit?.id;
      if(id&&s.units.some(u=>u.id===id)){
        const cause=String(effect.cause??'');
        const reason=cause.includes('补给')||cause.includes('supply')?'supply':
          cause.includes('费用')||cause.includes('cost')?'cost':'retreat';
        const remove={kind:'remove',unitId:id,reason} as const;
        try{applyScene(s,remove,cards);}catch(error){fail(n,`直接移除 ${id}：${String(error)}`);}ops.push(remove);
      }
    }
  }
  // Automatic supply loss is still a real removal, and is checked by the scene engine.
  for(const unit of [...s.units])if(!c.after.units.some(u=>u.id===unit.id)){
    const op={kind:'remove',unitId:unit.id,reason:'supply'} as const;
    try{applyScene(s,op,cards);}catch{fail(n,`未记录的部队移除 ${unit.id}；不能冒充断补`);}ops.push(op);
  }
  if(!same(s.units,c.after.units))fail(n,'场面部队与训练引擎不一致');
  for(const seat of SEATS){const amount=c.after.scores[seat]-s.scores[seat];if(amount){
    const op={kind:'score',seat,amount} as const;applyScene(s,op,cards);ops.push(op);
  }}
  for(const seat of SEATS){const current=s.decks[seat].active.map(card=>card.id);
    for(const id of current.filter(id=>!c.after.activeCards[seat].includes(id))){
      const op={kind:'status',seat,cardId:id,operation:'remove'} as const;
      try{applyScene(s,op,cards);}catch(error){fail(n,String(error));}ops.push(op);
    }
    for(const id of c.after.activeCards[seat].filter(id=>!current.includes(id))){
      const op={kind:'status',seat,cardId:id,operation:'install'} as const;
      try{applyScene(s,op,cards);}catch(error){fail(n,String(error));}ops.push(op);
    }
  }
  if(!same(s.turnFlags??null,c.after.turnFlags??null))fail(n,'临时规则标记无法由 v1.0 能力表示');
  if(!same(sceneProjection(s),frameProjection(c.after))){const actual=sceneProjection(s),expected=frameProjection(c.after);
    const keys=Object.keys(expected).filter(k=>!same((actual as any)[k],(expected as any)[k]));
    fail(n,'场面摘要内容不一致：'+keys.map(k=>`${k}=${JSON.stringify((actual as any)[k])} / ${JSON.stringify((expected as any)[k])}`).join('; ').slice(0,1200));}
  ops.push(...resourceOps(resources,c,mode,n));
  return ops;
}
export async function exportTrainingReplay(rawText:string):Promise<string>{
  const raw=rawText.trimEnd().split('\n').map(line=>JSON.parse(line) as RawRow);
  const first=raw[0],startRow=raw[1],last=[...raw].reverse().find(r=>r.recordType==='result');
  if(first?.recordType!=='AI训练记录'||startRow?.recordType!=='state'||!startRow.snapshot||
    last?.termination!=='natural')throw Error('必须提供完整自然终局的 AI 训练原始记录');
  const original=startRow.snapshot,initial=frame(original.state),metadata=first.trainingMetadata??{};
  const cards=cardsFrom(original.state),cardMap=new Map(cards.map(c=>[c.id,c]));
  const effectiveBasicCounts=Object.fromEntries(SEATS.map(seat=>[seat,Object.fromEntries(
    ['build_army','land_battle','build_navy','sea_battle','air_power'].map(id=>[
      id,cards.filter(card=>card.deckOwner===seat&&card.definitionId===id).length]))]));
  const header:TrainingHeader={type:'header',seq:0,format:'quartermaster-match-log',
    formatVersion:3,recordingModel:'scene_actions',mode:'resource_pool',
    replayAdapter:{id:'quartermaster-training-scene',version:'1.0.0'},
    recordingId:`ppo-${original.header.mode}-${original.header.seed}-${String(metadata.round??0)}`,
    gameId:original.header.gameId,gameVersion:VERSION,
    producer:{name:'quartermaster-ppo-training',version:'1.0.0'},
    sceneEngineFingerprint:ENGINE,
    requiredCapabilities:['resources.independent.v1','scene.board.v1','scene.score.v1',
      'scene.remove.v1','scene.supply.v1','scene.status.v1'],
    training:{courseId:`ppo-events-${original.header.mode}`,courseVersion:original.header.courseVersion,
      configuration:{recordKind:'AI训练记录',seed:original.header.seed,
        mode:original.header.mode,cardSet:original.header.cardSet,
        eventIds:original.header.eventIds,basicCounts:BASIC_COUNTS,effectiveBasicCounts,
        opening:{special:'min(remaining,max(6,ceil(remaining*0.6)))',
          basicProbability:{'1':0.4,'2':0.7,'3':0.9,'4+':1},
          opensAt:'own-country-turn-start',aMode:'all-remaining'},
        overridesVersion:original.header.overridesVersion,
        configHash:original.header.configHash,mapVersion:original.header.mapVersion,
        sourceBuildFingerprint:original.header.buildFingerprint,
        handSemantics:'always-empty',drawPileSemantics:'unspent-resource-inventory',
        resourcePoolSemantics:original.header.mode==='A'?'always-empty':'opened-on-own-turn',
        outcome:{termination:last.termination,winner:last.winner,round:last.round,
          decisions:last.decisions,scores:last.scores,allianceScores:last.allianceScores},
        ...metadata},ruleOverrides:[]},cards};
  const start:TrainingStart={type:'start',seq:1,scene:{units:initial.units,scores:initial.scores,
    round:initial.round,phase:initial.phase as TrainingStart['scene']['phase'],
    activeSeat:initial.activeSeat,balance:true,activeCards:initial.activeCards},
    resources:resourcesOf(initial,original.header.mode)};
  const scene=createTrainingScene(start.scene,header.gameId,cardMap),steps:TrainingStep[]=[];
  const resources=Object.fromEntries(SEATS.map(seat=>[seat,Object.fromEntries(zones.map(zone=>[
    zone,[...start.resources!.find(r=>r.seat===seat&&r.zone===zone)!.ids]]))])) as
    Record<SeatId,Record<ResourceZone,string[]>>;
  if(!same(sceneProjection(scene),frameProjection(initial)))throw Error('初始训练场面与客户端场面规则不等价');
  type Pending={cardId:string;seat:SeatId;round:number;name:string;response:boolean;
    operations:TrainingStep['operations'];cancelled:boolean};
  let pending:Pending|null=null;
  const suspended:Pending[]=[];
  const append=async(seat:SeatId,cardId:string|undefined,summary:string,
    operations:TrainingStep['operations'])=>{
    const index=steps.length+1;
    steps.push({type:'training_action',seq:index+1,id:`training-${index}`,
      seat,activeSeat:scene.activeSeat,round:scene.round,
      phase:scene.phase as TrainingStep['phase'],
      ...(cardId&&cardMap.has(cardId)?{cardId}:{}),summary,operations,
      sceneHash:await trainingSceneHash(scene)});
  };
  for(const row of raw){if(row.type!=='ppo-decision')continue;
    const commits=row.replayCommits;
    if(!commits)throw Error('训练记录缺少逐命令场面轨迹；请开启 replay capture');
    for(const commit of commits){
      if(['PLAY_CARD','PLAY_BASIC'].includes(commit.commandType)&&commit.cardId){
        if(pending)fail(steps.length+1,'上一张牌尚未完成，不能开始另一张标准出牌');
        pending={cardId:commit.cardId,seat:commit.seat,round:commit.before.round,
          name:cardMap.get(commit.cardId)?.name??commit.cardId,response:false,
          operations:[],cancelled:false};
      }
      if(commit.responseCardId){
        if(pending){
          if(pending.operations.length)await append(pending.seat,pending.cardId,
            `第${pending.round}轮 ${COUNTRY_NAMES[pending.seat]}打出【${pending.name}】（响应前）`,
            pending.operations);
          pending.operations=[];suspended.push(pending);
        }
        pending={cardId:commit.responseCardId,seat:commit.seat,round:commit.before.round,
          name:cardMap.get(commit.responseCardId)?.name??commit.responseCardId,
          response:true,operations:[],cancelled:false};
      }
      const before=sceneProjection(scene),ops=applyCommit(scene,commit,cardMap,
        steps.length+1,resources,original.header.mode);
      if(pending)pending.operations.push(...ops);
      else if(ops.length||!same(before,sceneProjection(scene))){
        const actor=COUNTRY_NAMES[commit.seat];
        const summary=commit.commandType==='ADVANCE_PHASE'||commit.commandType==='DISCARD_HAND'?
          `${actor}回合推进`:`${actor}：${row.action?.label??'结算选择'}`;
        await append(commit.seat,commit.cardId,summary,ops);
      }
      for(const outcome of commit.cardOutcomes??[]){
        if(!pending||outcome.id!==pending.cardId)continue;
        pending.cancelled=outcome.outcome==='cancelled';
        const action=`第${pending.round}轮 ${COUNTRY_NAMES[pending.seat]}`+
          `${pending.response?'响应【':'打出【'}${pending.name}】`+
          (pending.cancelled?'，被取消':'');
        await append(pending.seat,pending.cardId,action,pending.operations);
        pending=suspended.pop()??null;
      }
    }
  }
  if(pending)throw Error(`训练记录的【${pending.name}】尚未完成结算`);
  if(suspended.length)throw Error('训练记录存在尚未完成的响应父结算');
  const text=await sealTraining([header,start,...steps]);
  await new TrainingController(await parseTrainingReplay(text)).checkReplay();
  return text;
}

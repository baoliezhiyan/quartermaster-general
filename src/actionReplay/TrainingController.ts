import type {GameState,Command,SeatId,CardInstance} from '../core/types';
import {SEATS} from '../core/types';
import type {GameController,RoomAccess,SessionInfo,DispatchResult} from '../controller/GameController';
import {projectState} from '../network/project';
import {COUNTRY_NAMES} from '../core/basic';
import {createTrainingScene,applyScene,trainingSceneHash,trainingCards} from './trainingScene';
import {applyResource,zoneKey} from './resources';
import type {Resources} from './resources';
import type {TrainingArchive,TrainingStep,TrainingCard} from './trainingContract';
import type {Entry,Detail} from './player';
import type {Phrase} from './narrative';
const readonly=async():Promise<never>=>{throw Error('训练回放是只读的。');};
export const displayTrainingCard=(c:TrainingCard)=>({...c,__replayCard:{name:c.name,text:c.text,type:c.type}});
export class TrainingController implements GameController {
 readonly entries:Entry[];readonly narratives=new Map<string,Phrase[]>();readonly player:{details:Detail[]}={details:[]};
 selectedId:string|null=null;after=false;
 private raw:GameState;private view:GameState;private resources:Resources;private cards:Map<string,TrainingCard>;
 private generation=0;
 private access:RoomAccess={kind:'gm'};private seat:SeatId='germany';private listeners=new Set<()=>void>();
 private info:SessionInfo={replayMode:true,replayCursor:0,replayEntries:[],ready:true,canUndo:false,undoCount:0,savedAt:null,storageError:'',rounds:[],nations:[]};
 constructor(readonly archive:TrainingArchive){
  this.cards=trainingCards(archive);this.raw=this.initial();this.resources=this.initialResources();this.view=this.raw;
  this.entries=archive.steps.map(s=>({id:s.id,groupId:s.id,round:s.round,stage:'formal',seat:s.seat,kind:'play_card',summary:s.summary??(s.cardId?COUNTRY_NAMES[s.seat]+'打出【'+this.cards.get(s.cardId)!.name+'】':COUNTRY_NAMES[s.seat]+'执行训练动作')}));this.publish();
 }
 private initial(){return createTrainingScene(this.archive.start.scene,this.archive.header.gameId,this.cards);}
 private initialResources(){let r:Resources=new Map();for(const z of this.archive.start.resources??[])r=applyResource(r,{op:'set',...z},new Set(this.cards.keys()));return r;}
 private timing(s:GameState,step:TrainingStep){if(s.activeSeat!==step.activeSeat||s.round!==step.round){s.turnFlags=undefined;s.roundUses={};}s.activeSeat=step.activeSeat;s.round=step.round;s.phase=step.phase;}
 private async execute(s:GameState,r:Resources,step:TrainingStep,stop?:number){
  this.timing(s,step);const phrases:Phrase[]=[];const details:Detail[]=[];const known=new Set(this.cards.keys());
  // Source references are available to the index without creating an implicit zone move.
  if(step.cardId){const c=this.cards.get(step.cardId)!;phrases.push({text:'',cards:[displayTrainingCard(c)],public:true});}
  for(let i=0;i<step.operations.length;i++){
   if(stop===i)break;const op=step.operations[i];let text:string;
   if(op.kind==='resource'){
    const change=op.change;r=applyResource(r,change,known);const z=change.op==='move'?change.to:change;
    const item=r.get(zoneKey(z))!,ids=change.op==='set'?change.ids:[change.id],cards=ids.map(id=>displayTrainingCard(this.cards.get(id)!));
    const names={hand:'手牌',drawPile:'牌库',discardPile:'弃牌堆',resourcePool:'资源池'};
    text=COUNTRY_NAMES[z.seat]+names[z.zone]+({set:'全量设置为',add:'添加',remove:'移除',move:'移入'}[change.op])+ (cards.length?cards.map(c=>'【'+c.name+'】').join('、'):'空');
    phrases.push({text,cards,owner:item.visibility==='owner'?z.seat:undefined,public:item.visibility==='public'});
   }else {text=applyScene(s,op,this.cards);phrases.push({text,cards:op.kind==='status'?[displayTrainingCard(this.cards.get(op.cardId)!)]:[],public:true});}
   details.push({id:step.id+'@operation:'+i,label:text});
  }
  if(stop===undefined&&await trainingSceneHash(s)!==step.sceneHash)throw Error('训练场面摘要不一致：'+step.id);
  return {resources:r,phrases,details};
 }
 async describe(){if(this.narratives.size===this.entries.length)return;let s=this.initial(),r=this.initialResources();for(const step of this.archive.steps){const result=await this.execute(s,r,step);r=result.resources;this.narratives.set(step.id,result.phrases);this.info={...this.info};this.listeners.forEach(f=>f());await new Promise(resolve=>setTimeout(resolve,0));}}
 async seek(id:string|null,after=false){
  const generation=++this.generation;
  const base=id?.split('@')[0],index=base?this.archive.steps.findIndex(s=>s.id===base):-1;if(base&&index<0)throw Error('训练动作不存在');
  let state=this.initial(),resources=this.initialResources();this.player.details=[];
  for(let i=0;i<=index;i++){const step=this.archive.steps[i];if(i===index){this.timing(state,step);const full=await this.execute(structuredClone(state),resources,step);this.player.details=full.details;
    const marker=id?.split('@operation:')[1];if(marker!==undefined){const n=Number(marker);if(!Number.isInteger(n)||n<0||n>=step.operations.length)throw Error('训练子步骤不存在');resources=(await this.execute(state,resources,step,n+(after?1:0))).resources;}
    else if(after)resources=(await this.execute(state,resources,step)).resources;
    break;
   }resources=(await this.execute(state,resources,step)).resources;}
  if(generation!==this.generation)return;
  this.raw=state;this.resources=resources;this.selectedId=id;this.after=after;this.publish();
 }
 private publish(){
  const view=projectState(this.raw,this.access,this.seat)!;const pool:Record<string,CardInstance[]>={},available:string[]=[];
  for(const seat of SEATS){view.decks[seat].active=view.decks[seat].active.map(c=>displayTrainingCard(this.cards.get(c.id)!));pool[seat]=[];for(const zone of ['hand','drawPile','discardPile','resourcePool'] as const){const item=this.resources.get(zoneKey({seat,zone}));const visible=item&&(this.access.kind==='gm'||item.visibility==='public'||item.visibility==='owner'&&'seat'in this.access&&this.access.seat===seat);
   const cards=visible?item.ids.map(id=>displayTrainingCard(this.cards.get(id)!)):[];if(visible)available.push(seat+':'+zone);
   if(zone==='resourcePool')pool[seat]=cards;else view.decks[seat][zone]=cards;
  }}
  delete view.publicDiscardCounts;this.view=Object.assign(view,{resourcePool:pool,trainingReplay:{available}});this.info={...this.info,replayCursor:this.entries.findIndex(e=>e.id===this.selectedId?.split('@')[0])+1};this.listeners.forEach(f=>f());
 }
 getSnapshot=()=>this.view;getSessionInfo=()=>this.info;subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 setRoomAccess=(access:RoomAccess)=>{this.access=access;if('seat'in access)this.seat=access.seat;this.publish();};
 dispatch=async(c:Command):Promise<DispatchResult>=>{if(c.type!=='SET_VIEW')return {ok:false,error:'WRONG_OPERATOR'};this.seat=c.seat;this.publish();return {ok:true};};
 seekReplay=async(index:number)=>this.seek(this.entries[index]?.id??null);
 checkReplay=async()=>{await this.describe();return true;};
 undo=readonly;loadCheckpoint=readonly;exportSave=readonly;exportReplay=readonly;importReplay=readonly;exportReplayNodeSave=readonly;importSave=readonly;editScene=readonly;
 exportDiagnostics=()=>JSON.stringify({adapter:'training-scene',recordingId:this.archive.header.recordingId,selectedId:this.selectedId});
}

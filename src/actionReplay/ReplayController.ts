import type {GameController,RoomAccess,SessionInfo,DispatchResult} from '../controller/GameController';
import type {GameState,Command,SeatId} from '../core/types';
import {projectState} from '../network/project';
import type {Archive} from './codec';
import {Player,entries} from './player';
import {restore} from './state';
const readonly=async():Promise<never>=>{throw Error('回放是只读的，不会提交游戏操作。');};
export class ReplayController implements GameController {
 readonly player:Player;readonly entries;private raw:GameState;private view:GameState;private listeners=new Set<()=>void>();
 private access:RoomAccess={kind:'gm'};private seat:SeatId='germany';private generation=0;
 selectedId:string|null=null;after=false;
 private info:SessionInfo={replayMode:true,replayCursor:0,replayEntries:[],ready:true,canUndo:false,undoCount:0,savedAt:null,storageError:'',rounds:[],nations:[]};
 constructor(readonly archive:Archive){this.player=new Player(archive);this.entries=entries(archive);this.raw=restore(archive.start.state);this.view=projectState(this.raw,this.access,this.seat)!;}
 getSnapshot=()=>this.view;
 getSessionInfo=()=>this.info;
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 private publish(){this.view=projectState(this.raw,this.access,this.seat)!;this.info={...this.info,replayCursor:this.entries.findIndex(e=>e.id===this.selectedId)+1};this.listeners.forEach(f=>f());}
 setRoomAccess=(access:RoomAccess)=>{this.access=access.kind==='player'?{kind:'observer',seat:access.seat}:access;if('seat'in access)this.seat=access.seat;this.publish();};
 dispatch=async(c:Command):Promise<DispatchResult>=>{if(c.type!=='SET_VIEW')return {ok:false,error:'WRONG_OPERATOR'};this.seat=c.seat;this.publish();return {ok:true};};
 async seek(id:string|null,after=false){const generation=++this.generation;const state=await this.player.seek(id,after);if(generation!==this.generation)return;this.raw=state;this.selectedId=id;this.after=after;this.publish();}
 seekReplay=async(index:number)=>{await this.seek(this.entries[index]?.id??null);};
 undo=readonly;loadCheckpoint=readonly;exportSave=readonly;exportReplay=readonly;importReplay=readonly;exportReplayNodeSave=readonly;importSave=readonly;editScene=readonly;
 checkReplay=async()=>{const last=this.archive.groups.at(-1);if(last)await this.player.seek(last.root.actionId,true,true);return true;};
 exportDiagnostics=()=>JSON.stringify({mode:'readonly-replay',recordingId:this.archive.header.recordingId,selectedId:this.selectedId});
}

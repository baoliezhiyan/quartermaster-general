import type {GameState, SeatId} from '../core';
import type {RoomAccess, SessionInfo} from '../controller/GameController';
export interface ChatMessage {id:string;userId:string;name:string;seats:string[];text:string;sentAt:string;tone?:0|1}
export interface ChatStore {read():Promise<ChatMessage[]>;write(messages:ChatMessage[]):Promise<void>}
export interface Member {id:string;name:string;access:RoomAccess;online:boolean;bindings?:SeatId[]}
export interface RoomInfo {chat?:ChatMessage[];sceneLocked?:boolean;userId:string;name:string;access:RoomAccess;members:Member[];connected:boolean;recoveryAvailable:boolean;epoch:string;decision?:string;serverId?:string;sequence?:number;error?:string;bindings?:SeatId[];bindingAttention?:{seat:SeatId;key:string;kind:'response'|'turn'|'attack';text?:string}[]}
export interface RoomSnapshot {state:GameState|null;info:SessionInfo;room:RoomInfo}
export type RoomWireSnapshot=Omit<RoomSnapshot,'state'|'info'>&{info?:SessionInfo;infoPatch?:import('./jsonPatch').Patch[];state?:GameState|null;chatPatch?:import('./jsonPatch').Patch[];statePatch?:import('./jsonPatch').Patch[];baseSequence?:number;baseEpoch?:string};
export interface RoomRequest {id:string;connection:string;epoch:string;revision:number|null;decision?:string;method:string;args:unknown[]}
export interface Identity {id:string;name:string;token:string;bindings?:SeatId[]}
export const seatKey=(a:RoomAccess)=>a.kind==='player'?a.seat:a.kind==='gm'?'gm':null;
export type ViewSeat=SeatId;

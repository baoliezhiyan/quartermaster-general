import type { Command, CommandError, DeepReadonly, GameState } from '../core';
import type { Checkpoint } from './saveFormat';

export interface SessionInfo {
  room?:import('../network/protocol').RoomInfo;
  replayMode:boolean; replayCursor:number; replayEntries:readonly import('./replay').ReplayEntry[];
  ready:boolean; canUndo:boolean; undoCount:number; savedAt:string|null; storageError:string;
  rounds:Omit<Checkpoint,'state'>[]; nations:Omit<Checkpoint,'state'>[];
}

export type DispatchResult = { ok: true } | { ok: false; error: CommandError };
/** UI depends on this interface; a future network adapter can implement the same boundary. */
export type RoomAccess = {kind:'gm'}|{kind:'player'|'observer';seat:import('../core').SeatId}|{kind:'public'};
export interface GameController {
  setRoomAccess(access:RoomAccess):void;
  getSnapshot(): DeepReadonly<GameState> | null;
  subscribe(listener: () => void): () => void;
  dispatch(command: Command): Promise<DispatchResult>;
  getSessionInfo():SessionInfo;
  setSceneLocked?(locked:boolean):Promise<void>;
  undo():Promise<void>;
  loadCheckpoint(id:string):Promise<void>;
  exportSave():string|Promise<string>;
  exportReplay():string|Promise<string>;
  importReplay(json:string):Promise<void>;
  loadReplayEntries?():Promise<void>;
  seekReplay(index:number):Promise<void>;
  exportReplayNodeSave():string|Promise<string>;
  importSave(json:string):Promise<void>;
  checkReplay():boolean|Promise<boolean>;
  exportDiagnostics(note:string):string|Promise<string>;
  editScene(state:unknown,options?:{endPrelude?:boolean;endNeutrality?:'soviet_union'|'united_states'}):Promise<void>;
}

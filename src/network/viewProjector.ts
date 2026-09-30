import {projectState,publicViewParts,publicDeckViews,gmView,type PublicViewParts} from './project';
import {shareView} from './shareView';
import type {ReadState,GameState,SeatId} from '../core';
import type {RoomAccess} from '../controller/GameController';

function freeze<T>(value:T):T {
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}
 return value;
}
/** Per-room immutable projections. Permissions are part of the key; never share
 * a GM projection with a player. Only committed frozen engine states may cache.
 */
export function createViewProjector(){
 let lastSource:ReadState|null=null,shared:PublicViewParts,publicDecks:GameState['decks']|undefined;
 const current=new Map<string,GameState|null>(),previous=new Map<string,GameState|null>();
 return (source:ReadState|null,access:RoomAccess,view:SeatId):GameState|null=>{
  if(!source||!Object.isFrozen(source))return projectState(source,access,view);
  if(lastSource?.gameId!==source.gameId){previous.clear();current.clear();}
  if(lastSource!==source){current.clear();lastSource=source;shared=freeze(publicViewParts(source));publicDecks=undefined;}
  const key=JSON.stringify([access.kind,'seat' in access?access.seat:null,view]);
  if(current.has(key))return current.get(key)!;
  if(access.kind!=='gm')publicDecks??=freeze(publicDeckViews(source));
  const next=access.kind==='gm'?freeze(gmView(source,view,shared)):freeze(shareView(previous.get(key)??null,projectState(source,access,view,shared,publicDecks)));
  if(access.kind!=='gm')previous.set(key,next);current.set(key,next);return next;
 };
}

import type {GameState,ReadState,SeatId} from './types';
import {isPrelude} from './prelude';
import {insertRandom} from './basic';

const zones=['hand','drawPile','discardPile','active','faceDown','removed'] as const;
export type SceneZone=typeof zones[number];
export type SceneDestination=SceneZone|'drawTop'|'drawBottom';
export function scenePile(s:GameState,seat:SeatId,prelude:boolean,zone:SceneZone){
 if(prelude&&(['hand','drawPile','discardPile'] as string[]).includes(zone)){
  if(!s.prelude)throw new Error('本局未开启序章。');
  return s.prelude.decks[seat][zone as 'hand'|'drawPile'|'discardPile'];
 }
 return s.decks[seat][zone];
}
export function sceneCards(s:ReadState,seat:SeatId,prelude:boolean){
 return zones.flatMap(zone=>{
  const pile=prelude&&(['hand','drawPile','discardPile'] as string[]).includes(zone)
   ?s.prelude?.decks[seat][zone as 'hand'|'drawPile'|'discardPile']??[]:s.decks[seat][zone];
  return pile.flatMap((card,position)=>isPrelude(card)===prelude?[{...card,zone,position,length:pile.length}]:[]);
 });
}
export function moveSceneCard(s:GameState,seat:SeatId,prelude:boolean,id:string,destination:SceneDestination){
 const entry=sceneCards(s,seat,prelude).find(c=>c.id===id);
 if(!entry)throw new Error('卡牌已移动或正在结算，请重新选择。');
 const source=scenePile(s,seat,prelude,entry.zone),index=source.findIndex(c=>c.id===id);
 const [card]=source.splice(index,1),zone=destination==='drawTop'||destination==='drawBottom'?'drawPile':destination;
 const target=scenePile(s,seat,prelude,zone);
 if(destination==='drawBottom')target.push(card);
 else if(destination==='drawPile'){
  insertRandom(target,card,s);
 }else target.unshift(card);
}

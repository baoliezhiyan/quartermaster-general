import type {GameState,ReadState,SeatId,CardInstance} from './types';
import type {Effect,ResolutionFrame} from './resolutionTypes';
import {COUNTRY_NAMES,UNIT_NAMES,cardName,seatOf} from './basic';
import {specialCard} from './cardCatalog';
import {REGION_BY_ID} from './map';
import {ACTION_NAMES} from './effectNames';
export function publicRecord(s:GameState,seat:SeatId,text:string){(s.publicLog??=[]).push({round:s.round,seat,text});}
export function revealPublic(s:GameState,cards:CardInstance[]){s.publicCardIds=[...new Set([...(s.publicCardIds??[]),...cards.map(c=>c.id)])];}
export function concealPublic(s:GameState,ids:string[]){s.faceUpResponseIds=s.faceUpResponseIds?.filter(id=>!ids.includes(id));s.publicCardIds=s.publicCardIds?.filter(id=>!ids.includes(id));}
export function revealDiscardedCards(s:GameState,seat:SeatId,cards:CardInstance[]){
 const fresh=cards.filter(c=>!s.publicCardIds?.includes(c.id));
 if(fresh.length){revealPublic(s,fresh);publicRecord(s,seat,COUNTRY_NAMES[seat]+'公开弃置：'+fresh.map(c=>'【'+cardName(c)+'】').join('、')+'。');}
}
export function publicDiscard(s:ReadState,seat:SeatId){return s.decks[seat].discardPile.filter(c=>s.publicCardIds?.includes(c.id));}
export function declarePublicCard(s:GameState,f:ResolutionFrame){
 if(!f.cardId||f.publicDeclared)return;
 const c=s.decks[f.owner].resolving.find(c=>c.id===f.cardId);if(!c)return;
 f.publicDeclared=true;const type=specialCard(c.definitionId,c.balance)?.type??'基本牌';
 if(f.finalZone==='faceDown'&&f.publicSourceZone!=='faceDown'){publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+`暗置了一张${type==='军备'?'军备':'响应'}。`);return;}
 revealPublic(s,[c]);const verb=f.publicSourceZone==='active'?'发动':f.publicSourceZone==='faceDown'?`翻开${type==='军备'?'军备':'响应'}`: '打出';
 publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+verb+(verb.startsWith('翻开')?'':type)+'【'+cardName(c)+'】。');
}
export function recordPublicEffect(s:GameState,f:ResolutionFrame,e:Effect){
 if(e.fee)return;
 if(e.kind==='action'&&e.option){publicRecord(s,seatOf(e.country),COUNTRY_NAMES[e.country]+'在'+(REGION_BY_ID[e.option.regionId]?.name??'地图上')+(e.option.mode==='deploy'?'部署空军':e.option.mode==='supremacy'?'争夺制空权':e.action==='destroy'?'消灭'+(e.destroyedType?UNIT_NAMES[e.destroyedType]:'部队'):ACTION_NAMES[e.action]??e.action)+'。');}
 else if(e.kind==='remove'&&e.cause!=='supply')publicRecord(s,f.owner,COUNTRY_NAMES[e.unit.country]+'位于'+REGION_BY_ID[e.unit.regionId].name+'的'+UNIT_NAMES[e.unit.type]+'被移除。');
 else if(e.kind==='frameChange'&&e.cancel||e.kind==='cancel')publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+'使目标效果无效。');
 else if(e.kind==='score')publicRecord(s,f.owner,COUNTRY_NAMES[e.seat]+(e.amount>=0?'获得':'失去')+Math.abs(e.amount)+'分（卡牌效果）。');
 else if(e.kind==='draw')publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+'执行摸牌效果。');
 else if(e.kind==='randomReturn')publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+'执行随机回收弃牌的效果。');
 else if(e.kind==='countChange')publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+'调整目标效果。');
 else if(e.kind==='flag')publicRecord(s,f.owner,COUNTRY_NAMES[f.owner]+'执行效果：'+e.label+'。');
}

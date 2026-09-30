import type {ReadState} from './types';
import {seatAirMoveOptions,airPowerOptions} from './actions';
import {canExecuteEffects} from './resolution';
import {statusActionEffects} from './statusActions';
import {cardEffects} from './specialCards';
import {cardTargetChoices} from './extraCards';
import {specialCard} from './cardCatalog';
export function airActionOptions(s:ReadState){
 const d=s.decks[s.activeSeat],power=d.hand.some(c=>c.definitionId==='air_power'),options=airPowerOptions(s,s.activeSeat);
 return [
  {id:'move' as const,label:'调度空军',enabled:!!d.hand.length&&!!seatAirMoveOptions(s,s.activeSeat).length},
  {id:'deploy' as const,label:'部署空军',enabled:power&&options.some(o=>o.mode==='deploy')},
  {id:'supremacy' as const,label:'夺取制空权',enabled:power&&options.some(o=>o.mode==='supremacy')},
 ];
}
export function hasStandardPlay(s:ReadState){
 const d=s.decks[s.activeSeat];
 if(d.active.some(c=>canExecuteEffects(s,statusActionEffects(s,c))))return true;
 return d.hand.some(c=>{
  const def=specialCard(c.definitionId,c.balance);
  if(c.definitionId==='air_power'||def?.type==='增强'||s.basicPlaysRemaining&&def)return false;
  const probe={...s,decks:{...s.decks,[s.activeSeat]:{...d,hand:d.hand.filter(v=>v.id!==c.id)}}};
  const targets=cardTargetChoices(s,c);
  return (targets.length?targets.map(id=>[id]):[[]]).some(ids=>canExecuteEffects(probe,cardEffects(s,c,ids)));
 });
}

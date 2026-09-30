import {specialCard} from '../core/cardCatalog';
import {waitingResponseSeats} from '../core/resolution';
import {SEATS} from '../core';
import type {GameState,ReadState,SeatId,CardInstance} from '../core';
import type {RoomAccess} from '../controller/GameController';

const hiddenCards=(count:number,seat:SeatId,zone:string):CardInstance[]=>Array.from({length:count},(_,i)=>({id:`hidden:${seat}:${zone}:${i}`,definitionId:'hidden',country:seat,deckOwner:seat}));
/** Rollback trees are host-only. All visible state and choice context stay intact. */
export function gmView(source:ReadState,view:SeatId,shared:PublicViewParts=publicViewParts(source)):GameState {
 const resolution=source.resolution?{...source.resolution,frames:source.resolution.frames.map(frame=>{
  const {rollback,extraRollback,...display}=frame;return display;
 })}:source.resolution;
 return {...source,...shared,viewSeat:view,operatorSeat:view,resolution} as GameState;
}
/** Country-level public zones are identical for every foreign viewer. */
export function publicDeckViews(source:ReadState):GameState['decks'] {
 const known=new Set(source.publicCardIds??[]),faceUp=new Set(source.faceUpResponseIds??[]);
 return structuredClone(Object.fromEntries(SEATS.map(seat=>{const d=source.decks[seat];return [seat,{...d,
  hand:hiddenCards(d.hand.length,seat,'hand'),drawPile:hiddenCards(d.drawPile.length,seat,'deck'),
  faceDown:d.faceDown.map((c,i)=>faceUp.has(c.id)?c:hiddenCards(1,seat,'response:'+i)[0]),
  discardPile:d.discardPile.filter(c=>known.has(c.id)),removed:[],resolving:d.resolving.filter(c=>known.has(c.id))}];}))) as unknown as GameState['decks'];
}
export type PublicViewParts=Pick<GameState,'units'|'scores'|'publicLog'|'rules'|'setupCompleted'|'publicDiscardCounts'|'publicArmamentCounts'>;
export function publicViewParts(source:ReadState):PublicViewParts {
 return {units:source.units,scores:source.scores,publicLog:source.publicLog,rules:source.rules,setupCompleted:source.setupCompleted,
  publicDiscardCounts:Object.fromEntries(SEATS.map(seat=>[seat,source.decks[seat].discardPile.length])),
  publicArmamentCounts:Object.fromEntries(SEATS.map(seat=>[seat,source.decks[seat].faceDown.filter(c=>specialCard(c.definitionId,c.balance)?.type==='军备').length]))} as PublicViewParts;
}
/** Build a wire view; never serialize engine rollback snapshots or hidden trigger rules. */
export function projectState(source:ReadState|null,access:RoomAccess,view:SeatId,shared?:PublicViewParts,publicDecks?:GameState['decks']):GameState|null {
 if(!source)return null;
 if(access.kind==='gm')return structuredClone(gmView(source,view,shared));
 const own=access.kind==='public'?null:access.seat;
 const r=source.resolution;
 // Exclude histories and rollback trees before cloning a restricted view.
 const seed={...source,events:[],responseNotices:source.responseNotices?.filter(n=>own&&n.recipients.includes(own)),resolution:r?{...r,scoreBatches:undefined,events:[],windows:[],stack:[],trace:[],frames:r.frames.map(f=>({...f,rollback:undefined,extraRollback:undefined,memory:undefined})),rules:r.rules.filter(rule=>r.choice?.seat===own&&rule.owner===own).map(rule=>({...rule,effects:[]}))}:null};
 // Sanitize hidden zones before cloning. Never copy large private histories just
 // to discard them; every container mutated below is detached from the source.
 const s=({...seed,
  decks:Object.fromEntries(SEATS.map(seat=>[seat,{...source.decks[seat],drawPile:[...source.decks[seat].drawPile]}])),
  prelude:source.prelude?{...source.prelude,decks:Object.fromEntries(SEATS.map(seat=>[seat,{...source.prelude!.decks[seat]}]))}:source.prelude,
 }) as unknown as GameState;s.viewSeat=view;s.operatorSeat=view;
 const counts=shared??publicViewParts(source);s.publicDiscardCounts=counts.publicDiscardCounts;s.publicArmamentCounts=counts.publicArmamentCounts;
 const known=new Set(source.publicCardIds??[]);
 const visible=new Set<string>(known);
 if(own)for(const cards of Object.values(source.decks[own]))for(const c of cards)visible.add(c.id);
 for(const seat of SEATS)for(const c of source.decks[seat].active)visible.add(c.id);
 const hidden=(count:number,seat:SeatId,zone:string):CardInstance[]=>Array.from({length:count},(_,i)=>({id:`hidden:${seat}:${zone}:${i}`,definitionId:'hidden',country:seat,deckOwner:seat}));
 for(const seat of SEATS){
  const d=s.decks[seat];
  if(seat!==own&&publicDecks){s.decks[seat]=publicDecks[seat];continue;}
  if(seat!==own){d.hand=hidden(d.hand.length,seat,'hand');d.drawPile=hidden(d.drawPile.length,seat,'deck');d.faceDown=d.faceDown.map((c,i)=>source.faceUpResponseIds?.includes(c.id)?c:hidden(1,seat,'response:'+i)[0]);d.discardPile=d.discardPile.filter(c=>known.has(c.id));d.removed=[];d.resolving=d.resolving.filter(c=>known.has(c.id));}
  else d.drawPile.sort((a,b)=>a.definitionId.localeCompare(b.definitionId)||a.id.localeCompare(b.id));
 }
 if(s.prelude){
  s.prelude.installed={};s.prelude.installedWar={};s.prelude.installedEvent={};s.prelude.wars=[];
  for(const seat of SEATS){const d=s.prelude.decks[seat];if(seat!==own){d.hand=hidden(d.hand.length,seat,'prelude-hand');d.drawPile=hidden(d.drawPile.length,seat,'prelude-deck');d.discardPile=hidden(d.discardPile.length,seat,'prelude-discard');}
   else d.drawPile=[...d.drawPile.slice(0,1),...d.drawPile.slice(1).sort((a,b)=>a.definitionId.localeCompare(b.definitionId))];
  }
 }
 delete s.balanceFirstAttacks;
 s.seed=0;s.randomState=0;s.events=[];
 s.disabledResponseIds=s.disabledResponseIds?.filter(id=>own&&Object.values(source.decks[own]).flat().some(c=>c.id===id));
 s.responseNotices=s.responseNotices?.filter(n=>own&&n.recipients.includes(own));
 if(s.resolution){
  const r=s.resolution; r.waiting=!!own&&waitingResponseSeats(source,own).length>0;delete r.revealGroup;delete r.scoreBatches;
  const choice=r.choice?.seat===own?r.choice:null;
  // Only the acting country's request and the minimum display context are sent.
  r.choice=choice;r.scenario='当前结算';r.trace=[];r.turnUses={};r.fired=[];r.stack=[];r.events=[];r.windows=[];
  r.rules=r.rules.filter(rule=>choice&&rule.owner===own).map(rule=>({...rule,effects:[]}));
  r.frames=r.frames.filter(f=>known.has(f.cardId??'')||f.id===choice?.frameId).map(f=>{
   const effect=f.effects[f.nextEffectIndex];
   const effects=choice?.frameId===f.id&&effect?(effect.kind==='action'||effect.kind==='cards'||effect.kind==='extraPlay'?[structuredClone(effect)]:[]):[];
   return {id:f.id,source:known.has(f.cardId??'')?f.source:'当前效果',cardId:visible.has(f.cardId??'')?f.cardId:undefined,owner:f.owner,effects,nextEffectIndex:0,stage:f.stage,status:f.status,parentEventId:null,ancestorIds:[],sourceAncestors:[],currentEventId:null,finalZone:f.finalZone,publicSourceZone:f.publicSourceZone};
  });
  // Card/action effects may contain private selections or remembered card IDs.
  for(const f of r.frames)for(const e of f.effects){if(e.kind==='cards')delete e.remember;if(e.kind==='action'){delete e.recycledId;delete e.bindAs;delete e.fromBinding;}}
 }
 if(shared){
  // These exact public fields are immutable engine data, prepared once per state.
  const privatePart={...s};if(publicDecks)privatePart.decks=(own?{[own]:s.decks[own]}:{}) as GameState['decks'];for(const key of Object.keys(shared))delete (privatePart as unknown as Record<string,unknown>)[key];
  const detached=structuredClone(privatePart);return {...detached,...shared,...(publicDecks?{decks:{...publicDecks,...detached.decks}}:{})};
 }
 return structuredClone(s);
}

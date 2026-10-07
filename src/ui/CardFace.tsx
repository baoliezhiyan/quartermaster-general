import {useCardArtHidden} from './cardDisplay';
import {memo} from 'react';
import {CardArtImage} from './CardArtImage';
import type { CardInstance, ReadState } from '../core';
import { BASIC_NAMES, cardName } from '../core/basic';
import {cardArt} from './cardArt';
import { specialCard } from '../core/cardCatalog';

/** Only resolve publicly labelled card choices; a hidden choice still carries a real instance ID. */
export function choiceCard(state: ReadState, option: { id: string; label: string }) {
  if (!specialCard(option.label,!!state.rules?.balanceEnabled) && !Object.hasOwn(BASIC_NAMES, option.label)) return undefined;
  return [...Object.values(state.prelude?.decks??{}).flatMap(d=>[...d.hand,...d.drawPile,...d.discardPile]),...Object.values(state.decks).flatMap(d => [...d.hand, ...d.drawPile, ...d.discardPile, ...d.active, ...d.faceDown, ...d.resolving, ...d.removed])]
    .find(c => c.id === option.id && c.definitionId === option.label) ?? (specialCard(option.label,!!state.rules?.balanceEnabled)?{id:option.id,definitionId:option.label,balance:!!state.rules?.balanceEnabled,country:specialCard(option.label,!!state.rules?.balanceEnabled)!.country,deckOwner:specialCard(option.label,!!state.rules?.balanceEnabled)!.deckOwner}:undefined);
}

function CardFaceContent({ card, hint, nameSuffix }: { card: Pick<CardInstance, 'definitionId' | 'country' | 'balance'>; hint?: string; nameSuffix?:string }) {
  const hideArt=useCardArtHidden();
  const recorded=(card as typeof card & {__replayCard?:{name:string;text:string;type:string}}).__replayCard;
  const definition = specialCard(card.definitionId,card.balance);
  const art=cardArt(card),prelude=card.definitionId.startsWith('prelude_')?specialCard(card.definitionId,card.balance):undefined;
  return <span className={`card-face${hideArt?' card-face-text-only':''}`} data-country={specialCard(card.definitionId,card.balance)?.country??card.country}>
    {hideArt&&<span className="card-type-header">{recorded?.type||definition?.type||(Object.hasOwn(BASIC_NAMES,card.definitionId)?'基本牌':'卡牌')}</span>}
    {!hideArt&&!recorded&&art.src&&<CardArtImage src={art.src} basic={art.basic}/>}
    <span className="card-body">
      <strong className="card-name">{recorded?.name??cardName(card)}{nameSuffix}</strong>
      {prelude?.type==='历史'&&<span className="card-tension">紧张度 {(prelude.tension??0)>=0?'+':''}{prelude.tension}</span>}
      {(recorded||definition) && <span className="card-effect">{recorded?.text??definition?.text}</span>}
    </span>
    {hint && <span className="card-hint">{hint}</span>}
  </span>;
}

// Only these four values affect the static face; selection hints still update.
export const CardFace=memo(CardFaceContent,(a,b)=>a.card.definitionId===b.card.definitionId&&a.card.country===b.card.country&&a.card.balance===b.card.balance&&a.hint===b.hint&&a.nameSuffix===b.nameSuffix&&(a.card as any).__replayCard===(b.card as any).__replayCard);

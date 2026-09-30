import images from '../data/card-art.json';
import {BASIC_NAMES,COUNTRY_NAMES} from '../core/basic';
import {specialCard} from '../core/cardCatalog';
import type {CardInstance} from '../core';

declare const __CARD_ART_HASHES__:Record<string,string>;

export function cardArt(card:Pick<CardInstance,'definitionId'|'country'|'balance'>){
 const d=specialCard(card.definitionId,card.balance),type=d?.type??BASIC_NAMES[card.definitionId as keyof typeof BASIC_NAMES];
 const cardCountry=d?.country??card.country;
 const country=cardCountry==='china'?(d?.deckOwner==='soviet_union'?'中共':'民国'):COUNTRY_NAMES[cardCountry];
 const key=country+(['历史','军备'].includes(type)?'':'-')+type;
 const src=images[key as keyof typeof images];
 return {src:src?`${src}?v=${__CARD_ART_HASHES__[src]}`:undefined,basic:!d};
}

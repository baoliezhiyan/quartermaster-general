import { specialCard } from './cardCatalog';
import type { CardInstance } from './types';
export function matchesCard(card:CardInstance,requirement:string):boolean {
  if(requirement.includes('|'))return requirement.split('|').some(r=>matchesCard(card,r));
  return requirement==='*'||card.definitionId===requirement||specialCard(card.definitionId,card.balance)?.type===requirement;
}
export function coversCost(cards:readonly CardInstance[],requirements:readonly string[]):boolean {
  const remaining=[...cards];
  for(const requirement of [...requirements.filter(r=>r!=='*'),...requirements.filter(r=>r==='*')]) {
    const i=remaining.findIndex(c=>matchesCard(c,requirement));
    if(i<0)return false;
    remaining.splice(i,1);
  }
  return true;
}
/** Every requirement needs a distinct hand card, including arbitrary-card costs. */
export function canAffordHandCost(cards:readonly CardInstance[],requirements:readonly string[]):boolean {
  return coversCost(cards,requirements);
}

/** Reveal only cards proving typed cost requirements, not unrestricted filler cards. */
export function publicCostIds(cards:readonly CardInstance[],requirements?:readonly string[],filter?:string,all=false):string[]{
 if(all||filter&&filter!=='*')return cards.map(c=>c.id);
 const remaining=[...cards],ids:string[]=[];
 for(const requirement of requirements??[]){if(requirement==='*')continue;const i=remaining.findIndex(c=>matchesCard(c,requirement));if(i>=0)ids.push(remaining.splice(i,1)[0].id);}
 return ids;
}

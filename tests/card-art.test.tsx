import art from '../src/data/card-art.json';
import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ALL_SPECIAL_CARDS,PRELUDE_CARDS,NEUTRALITY_CARDS} from '../src/core/cardCatalog';
import {BASIC_NAMES} from '../src/core/basic';
import {SEATS} from '../src/core';
import {cardArt} from '../src/ui/cardArt';
import {CardFace} from '../src/ui/CardFace';
import {logCard,PublicGameLog} from '../src/ui/PublicGameLog';
it('maps every real card to a supplied illustration including Chinese and French cards',()=>{
 const cards=[...ALL_SPECIAL_CARDS,...PRELUDE_CARDS,...NEUTRALITY_CARDS].map(d=>({definitionId:d.id,country:d.country}));
 cards.push(...SEATS.flatMap(country=>Object.keys(BASIC_NAMES).map(definitionId=>({definitionId,country}))));
 for(const card of cards){const art=cardArt(card);expect(art.src,card.definitionId).toBeTruthy();}
});
it('keeps card names and tension without a top edge or redundant headings',()=>{
 const card=PRELUDE_CARDS.find(c=>c.type==='历史')!;
 const html=renderToStaticMarkup(<CardFace card={{definitionId:card.id,country:card.country}}/>);
 expect(html).toContain('card-art-category');expect(html).toContain(card.name);expect(html).toContain('紧张度');expect(html).not.toContain('card-top-edge');expect(html).not.toContain('card-country-heading');expect(html).not.toContain('card-type');
});
it('indexes public names using country and card type, while generic and hidden text stays plain',()=>{
 for(const d of [...ALL_SPECIAL_CARDS,...PRELUDE_CARDS,...NEUTRALITY_CARDS]){const c=logCard(d.name,d.deckOwner,d.id.startsWith('prelude_')?0:1,`打出${d.type}【${d.name}】`);expect(c?.definitionId,d.id).toBe(d.id);}
 expect(logCard('状态卡','germany',1,'【状态卡】')).toBeUndefined();
 expect(logCard('建设陆军','italy',2,'打出基本牌【建设陆军】')).toEqual({definitionId:'build_army',country:'italy'});
 const html=renderToStaticMarkup(<PublicGameLog entries={[{seat:'germany',round:1,text:'德国暗置了一张响应。'},{seat:'germany',round:1,text:'德国打出基本牌【建设陆军】。'}]}/>);
 expect(html.match(/class="card-index-link"/g)).toHaveLength(1);
});

it.each([false,true])('neutrality treaties use national history art, balance=%s',balance=>{
 expect(cardArt({definitionId:'neutrality_united_states_status',country:'united_states',balance}).src?.split('?')[0]).toBe(art['美国历史']);
 expect(cardArt({definitionId:'neutrality_soviet_union_status',country:'soviet_union',balance}).src?.split('?')[0]).toBe(art['苏联历史']);
});

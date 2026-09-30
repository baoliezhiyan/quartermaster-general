import type {CardInstance,Command,ReadState} from '../core';
import {specialCard} from '../core/cardCatalog';
import {cardName} from '../core/basic';
export function CardResponseToggle({state,card,dispatch,busy}:{state:ReadState;card:CardInstance;dispatch:(c:Command)=>Promise<void>;busy:boolean}) {
 if(card.deckOwner!==state.viewSeat||!['响应','增强','军备'].includes(specialCard(card.definitionId,card.balance)?.type??''))return null;
 return <label className="response-toggle" title="允许此牌响应"><input type="checkbox" aria-label={cardName(card)+'允许响应'} disabled={busy} checked={!state.disabledResponseIds?.includes(card.id)} onChange={e=>dispatch({type:'SET_CARD_RESPONSE',seat:state.viewSeat,expectedRevision:state.revision,cardId:card.id,enabled:e.target.checked})}/></label>;
}

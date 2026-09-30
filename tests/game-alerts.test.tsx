import {it,expect} from 'vitest';
import {renderToStaticMarkup as render} from 'react-dom/server';
import {createGame} from '../src/core/game';
import {TurnEntryNotice,VictoryNotice} from '../src/ui/GameAlerts';
import {MapPanelContent} from '../src/ui/MapPanels';
import {GuidedPrompt} from '../src/ui/GuidedPrompt';
import {guidedChoices} from '../src/ui/guidedChoices';
import {startResolution} from '../src/core/resolution';
import {preludeEffect} from '../src/core/prelude';
import {specialCard} from '../src/core/cardCatalog';
it('announces own normal and prelude turns and hides spectator notices',()=>{
 const s=createGame('notices',1,'FULL',true);
 expect(render(<TurnEntryNotice state={s} enabled/>)).toContain('德国的序章回合');
 s.prelude!.active=false;s.phase='PLAY';s.round=1;
 expect(render(<TurnEntryNotice state={s} enabled/>)).toContain('德国的回合');
 expect(render(<TurnEntryNotice state={s} enabled={false}/>)).toBe('');
 s.status='FINISHED';s.winner='allies';s.victoryReason='ALLIES_LEAD';
 expect(render(<VictoryNotice state={s}/>)).toContain('同盟国获胜');
});
it('counts treaties separately from statuses and omits empty treaty rows',()=>{
 const s=createGame('treaties',1,'FULL',true),d=specialCard('prelude_SU-08')!;
 s.decks.soviet_union.active=[{id:'treaty',definitionId:d.id,deckOwner:d.deckOwner,country:d.country}];
 const html=render(<MapPanelContent panel="record" state={s} dispatch={async()=>{}} busy={false}/>);
 expect(html).toContain('条约：1');expect(html.match(/条约：/g)).toHaveLength(1);
 s.decks.soviet_union.active=[];
 expect(render(<MapPanelContent panel="record" state={s} dispatch={async()=>{}} busy={false}/>)).not.toContain('条约：');
});
it.each(['germany','united_states'] as const)('shows only offered status cards in a dedicated chooser for %s',seat=>{
 const s=createGame('search',1,'FULL',true);s.activeSeat=s.viewSeat=s.operatorSeat=seat;
 const status=specialCard(seat==='germany'?'special_131':'special_80')!;
 s.decks[seat].drawPile=[{id:'candidate',definitionId:status.id,country:status.country,deckOwner:seat}];
 startResolution(s,'search',seat,[preludeEffect(seat,'inspect-status')],[]);
 expect(s.resolution?.choice?.kind).toBe('SELECT');
 expect(guidedChoices(s).panels.has('deck')).toBe(false);
 const html=render(<GuidedPrompt state={s} selected={[]} toggle={()=>{}} focusCard={null} playCardId={null} playTargets={[]} setPlayTargets={()=>{}} busy={false} dispatch={async()=>{}} cancelPlay={()=>{}}/>);
 expect(html).toContain('aria-label="选择状态牌"');expect(html).toContain(status.name);
});

it.each([false,true])('counts neutral USA and USSR as treaties without prelude, balance=%s',balance=>{
 const s=createGame('neutral-treaties',1,'FULL',false,true,balance);
 const html=render(<MapPanelContent panel="record" state={s} dispatch={async()=>{}} busy={false}/>);
 expect(html.match(/条约：1/g)).toHaveLength(2);expect(html.match(/局势：0/g)).toHaveLength(6);
});

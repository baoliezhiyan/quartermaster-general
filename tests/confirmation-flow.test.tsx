import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createGame,transition,SEATS} from '../src/core';
import type {GameState,Command} from '../src/core';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {fullCardEffects} from '../src/core/fullCardEffects';
import {GuidedPrompt} from '../src/ui/GuidedPrompt';
import {projectState} from '../src/network/project';
import {validateState} from '../src/controller/saveFormat';
function game(){const s=createGame('confirmation',1940,'FULL',false,false,true);s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];for(const d of Object.values(s.decks))d.drawPile.push(...d.hand.splice(0),...d.faceDown.splice(0),...d.active.splice(0));return s;}
function add(s:GameState,id:string,zone:'hand'|'active'='hand'){for(const d of Object.values(s.decks)){const i=d.drawPile.findIndex(c=>c.definitionId===id);if(i>=0){const c=d.drawPile.splice(i,1)[0];d[zone].push(c);return c;}}throw Error(id);}
function reply(s:GameState,ids:string[]){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids,true)).toBe(true);}
function markup(s:GameState,selected:string[]=[]){const view=projectState(s,{kind:'player',seat:s.operatorSeat},s.operatorSeat)!;return renderToStaticMarkup(<GuidedPrompt state={view} selected={selected} toggle={()=>{}} focusCard={null} playCardId={null} playTargets={[]} setPlayTargets={()=>{}} busy={false} dispatch={async()=>{}} cancelPlay={()=>{}}/>);}
const disabled=(html:string)=>/<button[^>]*disabled=""[^>]*>确认<\/button>/.test(html);
it('optional extra state play has disabled confirm until a card is selected, then installs without a second confirmation',()=>{
 const s=game(),card=add(s,'special_47');s.neutralityStatusPending=true;startResolution(s,'参战','germany',[{kind:'trace',label:'结束'}],[]);
 expect(s.resolution!.choice!.kind).toBe('EXTRA_CARD');expect(disabled(markup(s))).toBe(true);expect(disabled(markup(s,[card.id]))).toBe(false);
 reply(s,[card.id]);expect(s.resolution!.running).toBe(false);expect(s.decks.soviet_union.active.some(c=>c.id===card.id)).toBe(true);
});
it.each([false,true])('wash-back pays the selected build card in one confirmation, or skips without payment (%s)',pay=>{
 const s=game(),source=add(s,'special_255'),fee=add(s,'build_army');s.activeSeat=s.viewSeat=s.operatorSeat='united_states';
 // Move a genuine US construction card into hand for the fee.
 s.decks.germany.drawPile.push(...s.decks.germany.hand.splice(0));const us=s.decks.united_states;const i=us.drawPile.findIndex(c=>c.definitionId==='build_army');const cost=us.drawPile.splice(i,1)[0];us.hand.push(cost);
 const effect=fullCardEffects(s,source,[])!.find(e=>e.kind==='choose')!;startResolution(s,'湘西会战','united_states',[effect],[],source.id,'discardPile',true);
 expect(s.resolution!.choice!.kind).toBe('CARDS');expect(s.resolution!.choice!.options.map(o=>o.id)).toEqual([cost.id]);expect(s.resolution!.choice!.prompt).toContain('建设陆军');expect(disabled(markup(s))).toBe(true);expect(markup(s)).not.toContain('支付并洗回');
 const restored=JSON.parse(JSON.stringify(s));validateState(restored);reply(restored,pay?[cost.id]:[]);expect(restored.resolution!.running).toBe(false);
 expect(restored.decks.united_states.drawPile.some(c=>c.id===source.id)).toBe(pay);expect(restored.decks.united_states.discardPile.some(c=>c.id===cost.id)).toBe(pay);expect(restored.decks.united_states.hand.some(c=>c.id===cost.id)).toBe(!pay);expect(fee).toBeTruthy();
});
it.each([false,true])('kamikaze supply trigger can be used or declined without another air action (%s)',use=>{
 let s=game();add(s,'special_247','active');s.activeSeat=s.viewSeat=s.operatorSeat='japan';s.phase='AIR';s.units=[{id:'a',country:'japan',type:'army',regionId:'eastern_china'},{id:'air',country:'japan',type:'air',regionId:'eastern_china'},{id:'target',country:'soviet_union',type:'army',regionId:'vladivostok'}];
 const send=(payload:Record<string,unknown>)=>{const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...payload} as Command);expect(r.ok).toBe(true);if(r.ok)s=r.state;};send({type:'ADVANCE_PHASE'});
 expect(s.phase).toBe('SUPPLY');let q=s.resolution!.choice!;send({type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids:use?[q.options.find(o=>o.label==='神风敢死队')!.id]:[],guided:true});
 if(use){expect(s.resolution!.choice).toMatchObject({kind:'SELECT',options:[{id:'air'}]});expect(disabled(markup(s))).toBe(true);expect(disabled(markup(s,['air']))).toBe(false);}
 for(let i=0;s.resolution?.running&&i<15;i++){q=s.resolution!.choice!;send({type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids:q.kind==='TRIGGER'?[]:[q.options[0].id],guided:true});}
 expect(s.phase).toBe('DISCARD');expect(s.units.some(u=>u.id==='air')).toBe(!use);expect(s.units.some(u=>u.id==='target')).toBe(!use);
});
it('optional hand selection is direct and an empty confirmation remains disabled',()=>{
 const s=game(),source=add(s,'special_169'),c=add(s,'build_army');startResolution(s,'选牌','germany',[{kind:'cards',seat:'germany',from:'hand',to:'drawPile',min:0,max:1,label:'选择一张手牌放回牌库'}],[],source.id,'discardPile',true);
 expect(s.resolution!.choice!.kind).toBe('CARDS');expect(disabled(markup(s))).toBe(true);reply(s,[c.id]);expect(s.resolution!.running).toBe(false);expect(s.decks.germany.drawPile.some(v=>v.id===c.id)).toBe(true);
});

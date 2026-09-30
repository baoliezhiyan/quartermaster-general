import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createGame,transition} from '../src/core';
import type {GameState,SeatId,Command} from '../src/core';
import {cardEffects,realTriggers} from '../src/core/specialCards';
import {startResolution,resolveChoice,canExecuteEffects} from '../src/core/resolution';
import {specialCard} from '../src/core/cardCatalog';
import {projectState} from '../src/network/project';
import {MapPanelContent} from '../src/ui/MapPanels';
import {PublicCountryInfo} from '../src/ui/PublicCountryInfo';
function ready(seat:SeatId){const s=createGame('playtest',1940,'FULL');s.status='PLAYING';s.round=1;s.phase='PLAY';s.activeSeat=s.viewSeat=s.operatorSeat=seat;for(const d of Object.values(s.decks))for(const z of ['hand','drawPile','discardPile','active','faceDown','resolving','removed'] as const)d[z]=[];return s;}
function add(s:GameState,id:string,zone:'hand'|'active'|'drawPile'='hand'){const d=specialCard(id);const seat=d?.deckOwner??s.activeSeat;const c={id:`test:${id}:${s.decks[seat][zone].length}`,definitionId:id,country:d?.country??seat,deckOwner:seat};s.decks[seat][zone].push(c);return c;}
function send(s:GameState,p:Record<string,unknown>){const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...p} as Command);if(!r.ok)throw Error(r.error);return r.state;}
function choose(s:GameState,ids:string[]){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);}
it('reports discard totals without exposing privately discarded cards, including panel counts',()=>{
 const s=ready('germany'),a=add(s,'build_army'),b=add(s,'land_battle');s.decks.germany.hand=[];s.decks.germany.discardPile=[a,b];add(s,'build_navy','drawPile');
 const other=projectState(s,{kind:'public'},'germany')!;expect(other.decks.germany.discardPile).toEqual([]);expect(other.publicDiscardCounts?.germany).toBe(2);
 const html=renderToStaticMarkup(<PublicCountryInfo state={other} seat="germany" onClose={()=>{}}/>);expect(html).toContain('牌库 1 张 · 弃牌堆 2 张');expect(html).not.toContain(a.id);
 const own=projectState(s,{kind:'player',seat:'germany'},'germany')!;
 for(const [panel,label] of [['deck','牌库 1 张'],['discard','弃牌堆 2 张']] as const)expect(renderToStaticMarkup(<MapPanelContent panel={panel} state={own} dispatch={async()=>{}} busy={false}/>)).toContain(label);
});
it('logs only the discard count and zero-discard penalty',()=>{
 for(const count of [0,2]){let s=ready('germany');s.phase='DISCARD';const ids=[add(s,'build_army'),add(s,'land_battle')].slice(0,count).map(c=>c.id);s=send(s,{type:'DISCARD_HAND',cardIds:ids});expect(s.publicLog!.map(e=>e.text)).toContain(`德国弃牌阶段弃置 ${count} 张牌。`);expect(JSON.stringify(s.publicLog)).not.toContain('建设陆军');expect(s.scores.germany).toBe(0);}
});
it('skips all score triggers when headquarters is occupied, including hand enhancements and active statuses',()=>{
 let s=ready('united_states');s.phase='SUPPLY';add(s,'special_117');add(s,'special_120');add(s,'special_86','active');s.units.push({id:'occupier',country:'germany',type:'army',regionId:'united_states'});
 s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('DISCARD');expect(s.resolution?.events.some(e=>e.effect?.kind==='signal'&&e.effect.tag==='PHASE:SCORE')).toBe(false);expect(s.scores.united_states).toBe(0);expect(s.decks.united_states.hand).toHaveLength(2);expect(s.publicLog!.at(-1)!.text).toContain('跳过计分阶段');
});
it('summarizes territorial and triggered score changes together',()=>{
 let s=ready('united_kingdom');s.phase='SUPPLY';add(s,'special_3','active');s.units.push({id:'canada',country:'united_kingdom',type:'army',regionId:'canada'});
 const before=s.scores.united_kingdom;s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('DISCARD');expect(s.scores.united_kingdom).toBeGreaterThan(before);expect(s.publicLog!.at(-1)!.text).toBe(`英国计分阶段获得 ${s.scores.united_kingdom-before} 分。`);expect(s.scoringStart).toBeUndefined();
});
it('Arkhangelsk grants its independent point without armies, with conditional Soviet discard only when both regions qualify',()=>{
 for(const occupied of [false,true]){const s=ready('germany'),c=add(s,'special_163');if(occupied)for(const regionId of ['scandinavia','ross_region'])s.units.push({id:regionId,country:'italy',type:'army',regionId});for(let i=0;i<6;i++){const c=add(s,'build_army','drawPile');s.decks.germany.drawPile.pop();s.decks.soviet_union.drawPile.push({...c,id:`soviet:${i}`,country:'soviet_union',deckOwner:'soviet_union'});}
 const effects=cardEffects(s,c);expect(canExecuteEffects(s,effects)).toBe(true);startResolution(s,'economic','germany',effects,[],c.id);expect(s.scores.germany).toBe(1);expect(s.decks.soviet_union.discardPile).toHaveLength(occupied?5:0);}
 const old=ready('germany');old.resolutionVersion=2;expect(cardEffects(old,add(old,'special_163'))).toEqual([]);
});
it('returns the played build army at the same action timing and allows Tank Transport to spend it exactly once',()=>{
 const s=ready('soviet_union');add(s,'special_44','active');add(s,'special_45','active');const build=add(s,'build_army'),battle=add(s,'land_battle');s.units.push({id:'enemy',country:'germany',type:'army',regionId:'eastern_europe'});
 startResolution(s,'build','soviet_union',[{kind:'action',country:'soviet_union',action:'build_army',regions:['ukraine'],label:'build'},{kind:'signal',tag:'CARD_PLAYED',label:'played'}],[],build.id);
 for(let n=0;n<10&&s.resolution?.choice?.kind!=='TRIGGER';n++){const c=s.resolution!.choice!;choose(s,[c.options[0].id]);}
 let c=s.resolution!.choice!;expect(c.options.some(o=>o.label==='坦克运输')).toBe(false);choose(s,[c.options.find(o=>o.label==='女性义务兵役')!.id]);expect(s.decks.soviet_union.hand.some(c=>c.id===build.id)).toBe(true);
 c=s.resolution!.choice!;choose(s,[c.options.find(o=>o.label==='坦克运输')!.id]);expect(s.resolution!.choice!.kind).toBe('PAY_COST');choose(s,[build.id,battle.id]);
 for(let n=0;n<30&&s.resolution?.choice;n++){const c=s.resolution.choice;choose(s,c.kind==='TRIGGER'?[]:c.options.slice(0,Math.max(1,c.min)).map(o=>o.id));}
 expect(s.decks.soviet_union.hand.some(c=>c.id===build.id)).toBe(false);expect(s.decks.soviet_union.discardPile.filter(c=>c.id===build.id)).toHaveLength(1);expect(s.resolution!.running).toBe(false);
});

it('Radar protects only the current attack, including a later attack in the same turn',()=>{
 const s=ready('japan');add(s,'special_86','active');s.turnFlags={protected:[],battleProtected:[],supplied:[],supplyCountries:['japan','united_states'],supplyRegions:[],suppressed:[],noAirDefense:false};
 s.units.push({id:'us-navy',country:'united_states',type:'navy',regionId:'sea_east_pacific'},{id:'jp-navy',country:'japan',type:'navy',regionId:'sea_central_pacific'});
 for(let i=0;i<3;i++)s.decks.united_states.drawPile.push({id:'fee'+i,definitionId:'build_army',country:'united_states',deckOwner:'united_states'});
 const attack=()=>{expect(startResolution(s,'attack','japan',[{kind:'action',country:'japan',action:'sea_battle',regions:['sea_east_pacific'],label:'attack'}],[])).toBe(true);for(let n=0;s.resolution?.choice&&n<30;n++){const c=s.resolution.choice;const radar=c.options.find(o=>o.label==='雷达');choose(s,radar?[radar.id]:c.kind==='TRIGGER'?[]:[c.options[0].id]);}expect(s.resolution?.running).toBe(false);};
 attack();expect(s.units.some(u=>u.id==='us-navy')).toBe(true);expect(s.decks.united_states.discardPile).toHaveLength(2);
 attack();expect(s.units.some(u=>u.id==='us-navy')).toBe(false);expect(s.decks.united_states.discardPile).toHaveLength(2);
});

it.each([false,true])('Ration shuffles installed cards without activating them (guided %s)',guided=>{
 for(const id of ['special_3','special_14']){let s=ready('united_kingdom');const ration=add(s,'special_13');s.decks.united_kingdom.hand=[];s.decks.united_kingdom.faceDown=[ration];const target=add(s,id);
 s=send(s,{type:'PLAY_CARD',cardId:target.id,targetIds:[],effectIndices:[0],guided});
 for(let i=0;s.resolution?.choice&&i<30;i++){const c=s.resolution.choice;const r=c.options.find(o=>o.label==='配给');choose(s,r?[r.id]:c.kind==='TRIGGER'?[]:[c.options[0].id]);}
 expect(s.decks.united_kingdom.drawPile.some(c=>c.id===target.id)).toBe(true);
 expect(s.decks.united_kingdom.active).toHaveLength(0);expect(s.decks.united_kingdom.faceDown).toHaveLength(0);
 expect(s.decks.united_kingdom.discardPile.some(c=>c.id===ration.id)).toBe(true);
 }
});

it.each(['build_army','special_25'])('Ration preserves the effect of standard %s and shuffles that card',id=>{
 let s=ready('united_kingdom');const ration=add(s,'special_13');s.decks.united_kingdom.hand=[];s.decks.united_kingdom.faceDown=[ration];const target=add(s,id);
 for(let i=0;i<5;i++)s.decks.germany.drawPile.push({id:'econ'+i,definitionId:'build_army',country:'germany',deckOwner:'germany'});
 s=send(s,{type:'PLAY_CARD',cardId:target.id,targetIds:id==='special_25'?['germany']:[],effectIndices:[0]});
 for(let i=0;s.resolution?.choice&&i<30;i++){const c=s.resolution.choice,r=c.options.find(o=>o.label==='配给');choose(s,r?[r.id]:c.kind==='TRIGGER'?[]:[c.options[0].id]);}
 expect(s.decks.united_kingdom.drawPile.some(c=>c.id===target.id)).toBe(true);
 if(id==='build_army')expect(s.events.some(e=>e.type==='UNIT_PLACED'&&e.country==='united_kingdom')).toBe(true);else expect(s.decks.germany.discardPile).toHaveLength(4);
});
it('Ration does not respond to extra cards, enhancements, air power, or the old generic played signal',()=>{
 const s=ready('united_kingdom'),ration=add(s,'special_13');s.decks.united_kingdom.hand=[];s.decks.united_kingdom.faceDown=[ration];
 for(const [id,parent,tag] of [['special_23','parent','STANDARD_CARD_PLAYED'],['special_23',null,'CARD_PLAYED'],['air_power',null,'STANDARD_CARD_PLAYED'],['special_36',null,'STANDARD_CARD_PLAYED']] as const){const target=add(s,id);s.decks.united_kingdom.hand=[];s.decks.united_kingdom.resolving=[target];const frame={id:'root',cardId:target.id,parentEventId:parent,currentEventId:'event'} as any;expect(realTriggers(s,frame,{kind:'signal',tag,label:'played'},'After').some(r=>r.sourceInstanceId===ration.id)).toBe(false);}
});

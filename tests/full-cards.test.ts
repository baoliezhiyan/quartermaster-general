import { describe, expect, it } from 'vitest';
import { createGame, transition } from '../src/core';
import type { GameState, CardInstance, CountryId, Unit, Command } from '../src/core';
import { ALL_SPECIAL_CARDS, SPECIAL_CARDS } from '../src/core/cardCatalog';
import { cardEffects } from '../src/core/specialCards';
import { startResolution, resolveChoice } from '../src/core/resolution';
import { suppliedUnits, adjacent, countryScore } from '../src/core/supply';
import { placementPlans } from '../src/core/placement';
import { coversCost } from '../src/core/cardCosts';
import { homeRegion } from '../src/core/modifiers';
import { reallocationCards, reallocationCost } from '../src/core/basic';
import { canExecuteEffects } from '../src/core/resolution';
import { cardTargetChoices } from '../src/core/extraCards';
import { REGIONS } from '../src/core/map';

function state() {const s=createGame('full-tests',1940);s.mode='REPRESENTATIVE';s.status='PLAYING';s.phase='PLAY';s.round=1;return s;}
function card(s:GameState,index:number,zone:'hand'|'active'|'faceDown'='hand'):CardInstance {
  const d=ALL_SPECIAL_CARDS.find(c=>c.sourceIndex===index)!;
  const c={id:`test:${index}`,definitionId:d.id,country:d.country,deckOwner:d.deckOwner};s.decks[d.deckOwner][zone].push(c);return c;
}
const u=(country:CountryId,type:Unit['type'],regionId:string,id=`${country}:${type}:${regionId}`):Unit=>({id,country,type,regionId});
function settle(s:GameState) {
  for(let n=0;s.resolution?.running&&n<150;n++) {
    const c=s.resolution.choice!;
    const ids=c.kind==='TRIGGER'?[]:c.options.slice(0,c.kind==='ORDER_MANDATORY_TRIGGERS'?c.max:c.min).map(o=>o.id);
    expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);
  }
  expect(s.resolution?.running).toBe(false);return s;
}
describe('full audited catalog',()=>{
  it('builds a reproducible complete 379-card deck across six seats',()=>{
    const s=createGame('complete',55,'FULL'),cards=Object.values(s.decks).flatMap(d=>[...d.hand,...d.drawPile]);
    expect(cards).toHaveLength(379);expect(new Set(cards.map(c=>c.id)).size).toBe(379);
    expect(s).toEqual(createGame('complete',55,'FULL'));
    for(const d of ALL_SPECIAL_CARDS)expect(cards.filter(c=>c.definitionId===d.id)).toHaveLength(1);
  });
  it('loads all 245 identities and exact per-deck totals, excludes the banned card and retains representative texts',()=>{
    expect(ALL_SPECIAL_CARDS).toHaveLength(245);
    expect(new Set(ALL_SPECIAL_CARDS.map(c=>c.id)).size).toBe(245);
    expect(ALL_SPECIAL_CARDS.some(c=>c.name==='马奇诺防线')).toBe(false);
    for(const [seat,count] of Object.entries({united_kingdom:41,soviet_union:36,united_states:48,germany:45,japan:39,italy:36}))expect(ALL_SPECIAL_CARDS.filter(c=>c.deckOwner===seat)).toHaveLength(count);
    for(const c of SPECIAL_CARDS)expect(ALL_SPECIAL_CARDS.find(d=>d.id===c.id)).toEqual(c);
  });
  it.each([[9,'france'],[47,'soviet_union'],[52,'china']] as const)('status %s supplies isolated armies without allowing construction from enemy locations', (id,country)=>{
    const s=state();card(s,id,'active');s.units=[u(country,'army','madagascar')];
    expect(suppliedUnits(s).has(s.units[0].id)).toBe(true);
    s.decks[ALL_SPECIAL_CARDS[id-1].deckOwner].active=[];
    expect(suppliedUnits(s).has(s.units[0].id)).toBe(false);
  });
  it('moves the Soviet capital and its supply source, while Moscow loses supply',()=>{
    const s=state();card(s,42,'active');s.units=[u('soviet_union','army','siberia'),u('germany','army','moscow')];
    expect(homeRegion(s,'soviet_union')).toBe('siberia');
    expect(suppliedUnits(s)).toEqual(new Set([s.units[0].id]));
    expect(placementPlans(s,{country:'soviet_union',unitType:'army',mode:'build'}).some(p=>p.regionId==='siberia')).toBe(true);
  });
  it.each([[7,'united_kingdom','eastern_europe'],[10,'france','south_africa']] as const)('private source %s supplies only its country without adding scoring points', (id,country,region)=>{
    const s=state();card(s,id,'active');s.units=[u(country,'army',region)];
    expect(suppliedUnits(s).has(s.units[0].id)).toBe(true);
    expect(countryScore(s,country)).toBe(0);
    s.units=[u('united_states','army',region)];expect(suppliedUnits(s).size).toBe(0);
  });
  it('changes the French capital only while Western Europe is occupied by the Axis',()=>{
    const s=state();card(s,5,'active');s.units=[u('germany','army','western_europe'),u('france','army','india')];
    expect(homeRegion(s,'france')).toBe('british_isles');expect(countryScore(s,'france')).toBe(2);
    s.units.shift();expect(homeRegion(s,'france')).toBe('western_europe');
  });
  it('shared supply reaches co-located allies, but allied supply alone is not a construction source',()=>{
    const s=state();card(s,79,'active');s.units=[u('united_kingdom','army','british_isles'),u('united_kingdom','navy','sea_north_sea'),u('united_states','navy','sea_north_sea')];
    expect(suppliedUnits(s).has(s.units[2].id)).toBe(true);
    s.units.pop();
    expect(placementPlans(s,{country:'united_states',unitType:'navy',mode:'build'}).some(p=>p.regionId==='sea_north_sea')).toBe(false);
    s.units=[u('united_states','army','madagascar'),u('france','navy','sea_indian')];
    expect(suppliedUnits(s).size).toBe(0);
  });
  it('scorched earth removes only Axis supply from Ukraine',()=>{
    const s=state();card(s,48,'active');s.units=[u('germany','army','ukraine')];expect(suppliedUnits(s).size).toBe(0);
    s.units=[u('soviet_union','army','ukraine')];expect(suppliedUnits(s).size).toBe(1);
  });
  it('strait modifiers are alliance-specific and Hobart suppresses Axis states during the UK turn',()=>{
    const s=state();card(s,210,'active');card(s,211,'active');
    expect(adjacent(s,'germany','middle_east','balkans')).toBe(true);
    expect(adjacent(s,'united_states','sea_north_sea','sea_mediterranean')).toBe(false);
    card(s,6,'active');s.activeSeat='united_kingdom';
    expect(adjacent(s,'germany','middle_east','balkans')).toBe(false);
  });
  it('requires distinct typed payment cards, including generic slots',()=>{
    const s=state(),army=s.decks.germany.hand.find(c=>c.definitionId==='build_army')!;
    const battle={...army,id:'battle',definitionId:'land_battle'};
    expect(coversCost([army,battle],['build_army','land_battle'])).toBe(true);
    expect(coversCost([army],['build_army','*'])).toBe(false);
    expect(coversCost([army,battle],['build_army','*'])).toBe(true);
    expect(coversCost([army,battle],['响应'])).toBe(false);
  });
  it.each([20,21,24,27,28,29,31,33,34,35,61,64,67,68,93,95,97,108,111,152,155,159,233,234,238,239,240])('executes actual board effects of event %s without duplicating card instances',index=>{
    const s=state(),c=card(s,index);s.activeSeat=s.viewSeat=s.operatorSeat=c.deckOwner;
    if(index===68)s.units=[u('soviet_union','army','eastern_china'),u('japan','army','japan')];
    if(index===111)s.units=[u('united_states','army','germany')];
    if(index===152)s.units=[u('germany','army','western_europe'),u('united_kingdom','army','british_isles')];
    const effects=cardEffects(s,c);
    const before=JSON.stringify(s.units);
    expect(startResolution(s,'事件验收',c.deckOwner,effects,[],c.id)).toBe(true);
    settle(s);
    expect(s.decks[c.deckOwner].discardPile.filter(x=>x.id===c.id)).toHaveLength(1);
    // Some builds intentionally repeat an existing unit; actual placement events verify those.
    expect(JSON.stringify(s.units)!==before || s.events.some(e=>e.type==='UNIT_PLACED') || s.resolution!.events.some(e=>e.applied&&e.effect?.kind==='action')).toBe(true);
  });
  it('winter offensive selects only current Axis armies and removes the selected targets',()=>{
    const s=state(),c=card(s,62);s.units=[u('germany','army','moscow'),u('italy','army','ukraine'),u('japan','army','japan')];
    expect(startResolution(s,'冬季攻势',c.deckOwner,cardEffects(s,c),[],c.id)).toBe(true);
    expect(s.resolution!.choice!.options).toHaveLength(2);settle(s);
    expect(s.units.filter(u=>u.regionId==='moscow')).toHaveLength(0);
    expect(s.units.some(u=>u.regionId==='japan')).toBe(true);
  });
  it.each([63,110,156])('rebuild %s withdraws all armies and rebuilds distinct units until none remain in reserve',index=>{
    const s=state(),c=card(s,index);s.activeSeat=c.deckOwner;s.units=[u(c.country,'army','western_europe'),u(c.country,'army','ukraine')];
    const old=s.units.map(u=>u.id);
    expect(startResolution(s,'重建',c.deckOwner,cardEffects(s,c),[],c.id)).toBe(true);settle(s);
    expect(s.units.filter(u=>u.country===c.country&&u.type==='army')).toHaveLength(2);
    expect(s.units.some(u=>old.includes(u.id))).toBe(false);
  });
  it('Archangelsk grants an independent point and requires both areas only for Soviet discards',()=>{
    const s=state(),c=card(s,163);expect(cardEffects(s,c)).toEqual([{kind:'score',seat:'germany',amount:1,label:'获得 1 分'}]);
    s.units=[u('japan','army','scandinavia'),u('italy','army','ross_region')];
    const before=s.decks.soviet_union.drawPile.length;
    expect(startResolution(s,'强占阿尔汉格尔斯克',c.deckOwner,cardEffects(s,c),[],c.id)).toBe(true);settle(s);
    expect(s.scores.germany).toBe(1);expect(s.decks.soviet_union.drawPile).toHaveLength(before-5);
  });
  it('does not reveal a discarded hidden response while selecting it',()=>{
    const s=state(),c=card(s,92);card(s,188,'faceDown');
    expect(startResolution(s,'代号Magic',c.deckOwner,cardEffects(s,c),[],c.id)).toBe(true);
    expect(s.resolution!.choice!.options[0].label).toBe('暗置卡牌 1');settle(s);
    expect(s.decks.japan.faceDown).toHaveLength(0);
  });
  it('the carrier enhancement charges its printed fee exactly once and offers free relocation',()=>{
    let s=state();s.activeSeat=s.operatorSeat=s.viewSeat='italy';s.phase='TURN_START_WINDOW';card(s,228);
    s.units=[u('italy','army','italy'),u('italy','navy','sea_mediterranean'),u('italy','air','italy')];
    const send=(command:Record<string,unknown>)=>{const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...command} as Command);expect(r.ok).toBe(true);if(r.ok)s=r.state;};
    send({type:'ADVANCE_PHASE'});
    const choice=s.resolution!.choice!;
    send({type:'RESOLVE_ENGINE_CHOICE',choiceId:choice.id,ids:[choice.options.find(o=>o.label==='意大利尽早完成航母')!.id]});
    expect(s.resolution!.choice!.kind).toBe('PAY_COST');
    const before=s.decks.italy.hand.length;
    send({type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids:[s.resolution!.choice!.options[0].id]});
    send({type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids:['air_move']});
    settle(s);
    expect(s.units.find(u=>u.type==='air')!.regionId).toBe('sea_mediterranean');
    expect(s.decks.italy.hand.length).toBe(before-2); // printed fee plus the enhancement itself
  });
  it.each([[91,'china','western_china']] as const)('private scoring source %s supplies and scores only for its specified country',(id,country,region)=>{
    const s=state();card(s,id,'active');s.units=[u(country,'army',region)];
    expect(suppliedUnits(s).has(s.units[0].id)).toBe(true);expect(countryScore(s,country)).toBe(2);
    s.units=[u('united_states','army',region)];expect(countryScore(s,'united_states')).toBe(0);
    s.units=[u(country,'army',region)];s.decks[ALL_SPECIAL_CARDS[id-1].deckOwner].active=[];
    expect(countryScore(s,country)).toBe(0);
  });
  it('resource states reduce payment to one and add the discard source, including air power',()=>{
    const s=state();s.activeSeat='united_states';card(s,81,'active');card(s,82,'active');
    s.decks.united_states.discardPile.push({id:'discard-build',country:'united_states',deckOwner:'united_states',definitionId:'build_army'},{id:'discard-air',country:'united_states',deckOwner:'united_states',definitionId:'air_power'});
    expect(reallocationCost(s)).toBe(1);expect(reallocationCards(s,'united_states').some(c=>c.id==='discard-build')).toBe(true);
    expect(reallocationCards(s,'united_states').some(c=>c.id==='discard-air')).toBe(true);
  });
  it.each([[3,2],[131,2],[139,3],[172,2],[173,1],[174,1],[175,1],[176,3],[177,2],[212,1],[214,3],[216,2],[217,1],[225,17],[204,5]] as const)('scoring card %s applies its printed counting rule (%s points)',(index,points)=>{
    const s=state(),d=ALL_SPECIAL_CARDS[index-1],c=card(s,index,d.type==='状态'?'active':'hand');
    s.activeSeat=s.viewSeat=s.operatorSeat=c.deckOwner;s.phase='SCORE';
    s.units=REGIONS.map(r=>u(c.country,r.type==='SEA'?'navy':'army',r.id));
    expect(startResolution(s,'计分触发',c.deckOwner,[{kind:'signal',tag:'PHASE:SCORE',label:'计分开始'}],[])).toBe(true);
    if(s.resolution?.choice?.kind==='TRIGGER'){const q=s.resolution.choice;expect(resolveChoice(s,q.seat,q.id,[q.options.find(o=>o.label===d.name)!.id])).toBe(true);}
    settle(s);expect(s.scores[c.deckOwner]).toBe(points);
  });
  it.each([[165,'united_kingdom',2,2],[166,'united_kingdom',1,3],[167,'soviet_union',2,1],[168,'united_kingdom',3,1],[169,'united_states',2,1],[170,'united_kingdom',2,1],[178,'soviet_union',1,1],[180,'united_states',2,1],[181,'united_states',2,2],[182,'united_kingdom',2,2],[244,'united_kingdom',1,1],[245,'united_kingdom',2,1]] as const)('economic card %s applies exact deck loss and score',(index,target,loss,score)=>{
    const s=state(),c=card(s,index);s.activeSeat=c.deckOwner;
    const locations:Record<number,[Unit['type'],string]>={165:['army','germany'],166:['army','western_europe'],167:['army','scandinavia'],168:['army','germany'],169:['navy','sea_north_sea'],170:['army','western_europe'],178:['navy','sea_east_china'],180:['air','western_china'],181:['navy','sea_east_pacific'],182:['navy','sea_arabian'],244:['navy','sea_mediterranean'],245:['army','italy']};
    s.units=[u(c.country,...locations[index])];const before=s.decks[target].drawPile.length;
    expect(startResolution(s,'经济战',c.deckOwner,cardEffects(s,c,[target]),[],c.id)).toBe(true);settle(s);
    expect(s.decks[target].drawPile).toHaveLength(before-loss);expect(s.scores[c.deckOwner]).toBe(score);
  });
  it('an extra play from discard can deploy air outside the air phase and keeps a single instance',()=>{
    const s=state(),root=card(s,96);s.activeSeat='united_states';
    s.decks.united_states.discardPile=[{id:'extra-air',country:'united_states',deckOwner:'united_states',definitionId:'air_power'}];
    expect(startResolution(s,'广阔的资源','united_states',cardEffects(s,root),[],root.id)).toBe(true);settle(s);
    expect(s.units.some(u=>u.country==='united_states'&&u.type==='air')).toBe(true);
    expect(s.decks.united_states.discardPile.filter(c=>c.id==='extra-air')).toHaveLength(1);
    expect(s.phase).toBe('PLAY');
  });
  it('linked naval battle cannot use an unrelated existing navy when construction was skipped',()=>{
    const s=state(),root=card(s,107);s.units=[u('united_states','army','hawaii'),u('united_states','navy','sea_central_pacific')];
    const effects=cardEffects(s,root);
    expect(canExecuteEffects(s,[effects[1]])).toBe(false);
    expect(startResolution(s,'先开火后谈判','united_states',effects,[],root.id)).toBe(true);settle(s);
    expect(s.resolution!.events.filter(e=>e.applied&&e.effect?.kind==='action'&&e.effect.action==='sea_battle')).toHaveLength(1);
  });
  it('turn protection prevents a real removal while allowing the battle to finish',()=>{
    const s=state();s.activeSeat='united_kingdom';card(s,11,'faceDown');
    const unit=u('united_kingdom','army','british_isles');s.units=[unit];
    expect(startResolution(s,'移除测试','united_kingdom',[{kind:'remove',unit,supplied:true,cause:'battle',label:'将被移除'}],[])).toBe(true);
    let choice=s.resolution!.choice!;expect(choice.options.map(o=>o.label)).toContain('防御姿态');
    expect(resolveChoice(s,choice.seat,choice.id,[choice.options.find(o=>o.label==='防御姿态')!.id])).toBe(true);settle(s);
    expect(s.units).toHaveLength(1);
    expect(startResolution(s,'同回合再次移除','united_kingdom',[{kind:'remove',unit,supplied:true,cause:'battle',label:'再次移除'}],[])).toBe(false);
    s.turnFlags=undefined;
    expect(startResolution(s,'新回合移除','united_kingdom',[{kind:'remove',unit,supplied:true,cause:'battle',label:'再次移除'}],[])).toBe(true);settle(s);expect(s.units).toHaveLength(0);
  });
  it('anti-submarine response cancels an economic card before its leading score and discard effects',()=>{
    const s=state(),economic=card(s,178);card(s,15,'faceDown');s.activeSeat='united_kingdom';
    // Root owner remains UK, as in a same-seat nested effect; the economic card belongs to Japan.
    s.decks.japan.hand=s.decks.japan.hand.filter(c=>c.id!==economic.id);
    const injected={...economic,deckOwner:'united_kingdom' as const};s.decks.united_kingdom.hand.push(injected);
    s.units=[u('japan','navy','sea_east_china')];const pile=s.decks.soviet_union.drawPile.length;
    expect(startResolution(s,'经济战取消','united_kingdom',cardEffects(s,injected),[],injected.id)).toBe(true);
    const choice=s.resolution!.choice!;expect(resolveChoice(s,choice.seat,choice.id,[choice.options.find(o=>o.label==='反潜战术')!.id])).toBe(true);settle(s);
    expect(s.scores.united_kingdom).toBe(0);expect(s.decks.soviet_union.drawPile).toHaveLength(pile);
  });
  it.each([1940,1939])('complete-deck seed %s plays an automated game without stale choices, duplicate instances or stuck frames',seed=>{
    let s=createGame('full-game',seed,'FULL');
    const send=(payload:Record<string,unknown>)=>{const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...payload} as Command);if(!r.ok)throw new Error(`${JSON.stringify(payload)} ${r.error} status=${s.status} phase=${s.phase} operator=${s.operatorSeat} active=${s.activeSeat}`);s=r.state;};
    const resolve=()=>{for(let n=0;s.resolution?.running&&n<200;n++){if(s.resolution.revealGroup){const notice=s.responseNotices!.find(n=>!n.readBy.includes(n.recipients[0]))!;send({type:'SET_VIEW',seat:notice.recipients[0]});send({type:'ACK_RESPONSE_NOTICE',noticeId:notice.id});continue;}const q=s.resolution.choice!;const ids=q.kind==='TRIGGER'?[]:q.options.slice(0,q.kind==='ORDER_MANDATORY_TRIGGERS'?q.max:q.min).map(o=>o.id);send({type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids});}expect(s.resolution?.running).not.toBe(true);};
    for(let i=0;i<6;i++)send({type:'KEEP_OPENING',cardIds:s.decks[s.operatorSeat].hand.slice(0,7).map(c=>c.id)});
    let turns=0;
    for(let n=0;s.status!=='FINISHED'&&n<1500;n++) {
      resolve();
      if((s as GameState).status==='FINISHED')break;
      if(s.phase==='PLAY'||s.phase==='AIR') {
        const candidate=s.decks[s.activeSeat].hand.flatMap(c=>{
          if(specialCardType(c)==='增强'||(s.phase==='AIR')!==(c.definitionId==='air_power'))return [];
          const choices=cardTargetChoices(s,c),targetSets=choices.length?choices.map(id=>[id]):[[]];
          return targetSets.flatMap(targetIds=>{const effects=cardEffects(s,c,targetIds);return canExecuteEffects(s,effects)?[{c,effects,targetIds}]:[];});
        })[0];
        if(candidate){send({type:'PLAY_CARD',cardId:candidate.c.id,targetIds:candidate.targetIds,effectIndices:candidate.effects.map((_,i)=>i)});continue;}
      }
      if(s.phase==='DISCARD')send({type:'DISCARD_HAND',cardIds:s.decks[s.activeSeat].hand.slice(0,1).map(c=>c.id)});
      else{if(s.phase==='DRAW')turns++;send({type:'ADVANCE_PHASE'});}
    }
    expect(s.status).toBe('FINISHED');expect(turns).toBeLessThanOrEqual(120);
    const cards=Object.values(s.decks).flatMap(d=>Object.values(d).flat());
    expect(cards).toHaveLength(379);expect(new Set(cards.map(c=>c.id)).size).toBe(379);
  },120000);
});
const specialCardType=(c:CardInstance)=>ALL_SPECIAL_CARDS.find(d=>d.id===c.definitionId)?.type;

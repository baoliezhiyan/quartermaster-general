import { describe, expect, it } from 'vitest';
import { createGame, transition, SEATS } from '../src/core';
import type { Command, GameState, SeatId, CountryId, Unit } from '../src/core';
import { SPECIAL_CARDS } from '../src/core/cardCatalog';
import { cardEffects, barbarossaTargets } from '../src/core/specialCards';
import { reserve } from '../src/core/basic';
import { startResolution } from '../src/core/resolution';

function send(s:GameState,payload:Record<string,unknown>):GameState {
  const result=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...payload} as Command);
  if(!result.ok)throw new Error(`${JSON.stringify(payload)}: ${result.error}`);
  return result.state;
}
function choose(s:GameState,ids:string[]) {return send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids});}
function settle(s:GameState):GameState {
  for(let i=0;s.resolution?.running && i<100;i++) {
    const c=s.resolution.choice!;
    s=choose(s,c.kind==='TRIGGER'?[]:c.options.slice(0,c.kind==='ORDER_MANDATORY_TRIGGERS'?c.max:c.min).map(o=>o.id));
  }
  if(s.resolution?.running)throw new Error('Choice loop did not terminate');return s;
}
function ready(seat:SeatId='germany',phase:GameState['phase']='PLAY') {
  let s=createGame('representative',1940,'REPRESENTATIVE');
  for(const seat of SEATS)s=send(s,{type:'KEEP_OPENING',cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)});
  s=settle(s);s.activeSeat=s.operatorSeat=s.viewSeat=seat;s.phase=phase;return s;
}
function card(s:GameState,id:string,zone:'hand'|'active'|'faceDown'='hand') {
  const d=SPECIAL_CARDS.find(c=>c.id===id),owner=d?.deckOwner??s.activeSeat;
  for(const z of ['hand','active','faceDown','drawPile','discardPile','resolving','removed'] as const)s.decks[owner][z]=s.decks[owner][z].filter(c=>c.definitionId!==id);
  const instance={id:`fixture:${id}`,definitionId:id,deckOwner:owner,country:d?.country??owner};s.decks[owner][zone].push(instance);return instance;
}
const unit=(country:CountryId,type:Unit['type'],regionId:string,id=`${country}:${type}:${regionId}`):Unit=>({id,country,type,regionId});
function play(s:GameState,id:string,targets:string[]=[],indices?:number[]) {
  const c=s.decks[s.activeSeat].hand.find(c=>c.definitionId===id)!;
  return send(s,{type:'PLAY_CARD',cardId:c.id,targetIds:targets,effectIndices:indices??cardEffects(s,c,targets).map((_,i)=>i)});
}
describe('representative card integration',()=>{
  it('adds exactly 27 audited real cards, keeping all six decks deterministic and every identity unique',()=>{
    const s=createGame('x',3,'REPRESENTATIVE');
    expect(SPECIAL_CARDS).toHaveLength(27);
    const cards=Object.values(s.decks).flatMap(d=>[...d.hand,...d.drawPile]);
    expect(cards).toHaveLength(161);expect(new Set(cards.map(c=>c.id)).size).toBe(161);
    expect(cards.filter(c=>c.definitionId.startsWith('special_'))).toHaveLength(27);
    expect(s).toEqual(createGame('x',3,'REPRESENTATIVE'));
    expect(new Set(SPECIAL_CARDS.map(c=>c.type))).toEqual(new Set(['状态','事件','响应','增强','经济战']));
  });
  it('puts resource reallocation and Volkssturm in one turn-start window',()=>{
    let s=ready('germany','DRAW');s.activeSeat=s.viewSeat=s.operatorSeat='united_states';card(s,'special_129','active');
    s=send(s,{type:'ADVANCE_PHASE'});
    expect(s.phase).toBe('TURN_START_WINDOW');
    expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('资源重整');
    expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('人民冲锋队');
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='资源重整')!.id]);
    expect(s.resolution!.choice!.kind).toBe('PAY_COST');
    s=choose(s,s.resolution!.choice!.options.slice(0,3).map(o=>o.id));
    expect(s.resolution!.choice!.kind).toBe('REALLOCATE');
    expect(s.resolution!.choice!.options.every(o=>['build_army','build_navy','land_battle','sea_battle','air_power'].includes(o.label))).toBe(true);
    s=choose(s,[s.resolution!.choice!.options[0].id]);
    expect(s.redistributed).toBe(true);expect(s.phase).toBe('TURN_START_WINDOW');
    expect(s.resolution!.choice!.options.map(o=>o.label)).not.toContain('资源重整');
    expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('人民冲锋队');
    s=choose(s,[]);
    expect(s.phase).toBe('PLAY');
    expect(s.resolution!.running).toBe(false);
  });
  it('goes directly from the opening trigger window to play, then does the same for the next country',()=>{
    let s=createGame('turn-start',1940,'REPRESENTATIVE');
    for(const seat of SEATS)s=send(s,{type:'KEEP_OPENING',cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)});
    expect(s.phase).toBe('TURN_START_WINDOW');
    s=choose(s,[]);
    expect(s.phase).toBe('PLAY');
    expect(s.resolution!.running).toBe(false);
    s.phase='DRAW';
    s=send(s,{type:'ADVANCE_PHASE'});
    expect(s.activeSeat).toBe('united_kingdom');
    expect(s.phase).toBe('TURN_START_WINDOW');
    s=choose(s,[]);
    expect(s.phase).toBe('PLAY');
    expect(s.resolution!.running).toBe(false);
  });
  it('skips empty action phases after turn-start effects',()=>{
    let s=ready('germany','DRAW');
    s.decks.united_kingdom.discardPile.push(...s.decks.united_kingdom.hand);
    s.decks.united_kingdom.hand=[];
    s=send(s,{type:'ADVANCE_PHASE'});
    expect(s.activeSeat).toBe('united_kingdom');
    expect(s.phase).toBe('DISCARD');
    expect(s.resolution!.running).toBe(false);
  });
  it('still opens play-start responses after the turn-start window closes',()=>{
    let s=ready('united_kingdom','DRAW');card(s,'special_188','faceDown');
    s=send(s,{type:'ADVANCE_PHASE'});
    expect(s.phase).toBe('TURN_START_WINDOW');
    s=choose(s,[]);
    expect(s.phase).toBe('PLAY');
    expect(s.resolution!.running).toBe(true);
    expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('泰国');
    s=settle(s);
    expect(s.phase).toBe('PLAY');
  });
  it('runs independent recruitment effects in printed order and permits selecting only the second',()=>{
    let s=ready('united_kingdom');card(s,'special_23');
    s=settle(play(s,'special_23',[],[1]));
    expect(s.units.some(u=>u.country==='united_kingdom'&&u.type==='navy'&&u.regionId==='sea_south_china')).toBe(true);
    expect(s.units.some(u=>u.country==='united_kingdom'&&u.type==='army'&&u.regionId==='southeast_asia')).toBe(false);
    expect(s.phase).toBe('AIR');
  });
  it('rejects all-skipped and impossible cards without spending the card or phase',()=>{
    const s=ready(),c=card(s,'special_158'),before=structuredClone(s);
    expect(transition(s,{type:'PLAY_CARD',seat:s.activeSeat,expectedRevision:s.revision,cardId:c.id,targetIds:[],effectIndices:[]}).ok).toBe(false);
    expect(transition(s,{type:'PLAY_CARD',seat:s.activeSeat,expectedRevision:s.revision,cardId:c.id,targetIds:[],effectIndices:[1]}).ok).toBe(false);
    expect(s).toEqual(before);
  });
  it('discards Ration and shuffles the standard played event into the deck',()=>{
    let s=ready('united_kingdom');const ration=card(s,'special_13','faceDown'),event=card(s,'special_23');
    s=play(s,'special_23',[],[0]);
    while(s.resolution!.choice!.kind!=='TRIGGER')s=choose(s,[s.resolution!.choice!.options[0].id]);
    expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('配给');
    expect(s.decks.united_kingdom.resolving.some(c=>c.id===event.id)).toBe(true);
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='配给')!.id]);s=settle(s);
    expect(s.decks.united_kingdom.drawPile.some(c=>c.id===ration.id)).toBe(false);
    expect(s.decks.united_kingdom.discardPile.some(c=>c.id===ration.id)).toBe(true);
    expect(s.decks.united_kingdom.drawPile.some(c=>c.id===event.id)).toBe(true);
  });
  it('asks for Warsaw Uprising during score start and fully pays before recruitment',()=>{
    let s=ready('united_kingdom','SUPPLY');card(s,'special_36');
    s=send(s,{type:'ADVANCE_PHASE'});expect(s.phase).toBe('SCORE');
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='华沙起义')!.id]);
    expect(s.resolution!.choice!.kind).toBe('PAY_COST');
    s=choose(s,s.resolution!.choice!.options.slice(0,2).map(o=>o.id));s=settle(s);
    expect(s.units.some(u=>u.country==='united_kingdom'&&u.regionId==='eastern_europe')).toBe(true);
    expect(s.decks.united_kingdom.discardPile.some(c=>c.definitionId==='special_36')).toBe(true);
  });
  it.each([['special_41','united_kingdom','france'],['special_77','soviet_union','china'],['special_125','united_states','china']] as const)('deploys cross-country air from %s at its deck-owner stage', (id,seat,country)=>{
    let s=ready(seat);card(s,id);
    s=send(s,{type:'ADVANCE_PHASE'});
    const name=SPECIAL_CARDS.find(c=>c.id===id)!.name;
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label===name)!.id]);s=settle(s);
    expect(s.units.some(u=>u.country===country&&u.type==='air')).toBe(true);
    expect(reserve(s,country,'air')).toBe(country==='china'?0:0);
    expect(s.phase).toBe('AIR');
  });
  it('economic target pays each deck-top shortfall while the acting country gains its own points',()=>{
    let s=ready();card(s,'special_164');s.decks.united_kingdom.drawPile=[];
    s=settle(play(s,'special_164',['united_kingdom']));
    expect(s.scores.united_kingdom).toBe(-1);expect(s.scores.germany).toBe(2);
  });
  it('Bomb Tokyo still grants three points when its independent naval range clause is false',()=>{
    let s=ready('united_states');card(s,'special_104');const before=s.decks.japan.drawPile.length;
    s=settle(play(s,'special_104'));expect(s.scores.united_states).toBe(3);expect(s.decks.japan.drawPile).toHaveLength(before);
  });
  it('Chinese recruitment uses Chinese stock and mandatory Volunteers makes Japan choose a discard',()=>{
    let s=ready('united_states');card(s,'special_90','active');card(s,'special_114');
    s=play(s,'special_114');
    while(s.resolution!.choice!.kind==='ACTION')s=choose(s,[s.resolution!.choice!.options.find(o=>o.id==='western_china')?.id??s.resolution!.choice!.options[0].id]);
    expect(s.resolution!.choice!.kind).toBe('FORCE_HAND');expect(s.operatorSeat).toBe('japan');
    const before=s.decks.japan.hand.length;s=choose(s,[s.resolution!.choice!.options[0].id]);s=settle(s);
    expect(s.decks.japan.hand).toHaveLength(before-1);expect(reserve(s,'china','army')).toBe(0);expect(s.operatorSeat).toBe('united_states');
  });
  it('Italian card recruits German pieces, not Italian pieces',()=>{
    let s=ready('italy');card(s,'special_235');const old=reserve(s,'italy','army');
    s=settle(play(s,'special_235'));expect(reserve(s,'italy','army')).toBe(old);
    expect(s.units.some(u=>u.country==='germany'&&u.regionId==='north_africa')).toBe(true);
    expect(s.units.some(u=>u.country==='germany'&&u.regionId==='sea_mediterranean')).toBe(true);
  });
  it('state score effects are applied once before the US victory check',()=>{
    let s=ready('italy','SUPPLY');card(s,'special_213','active');s.units.push(unit('italy','navy','sea_mediterranean'),unit('italy','navy','sea_north_sea'));
    s=settle(send(s,{type:'ADVANCE_PHASE'}));expect(s.scores.italy).toBe(4);
  });
  it.each([false,true])('Ardennes handles air defense, interception=%s, and revalidates its later build',intercept=>{
    let s=ready();card(s,'special_158');s.units.push(unit('germany','air','germany'),unit('france','air','western_europe'));
    s=play(s,'special_158');
    for(let i=0;s.resolution?.running&&i<30;i++) {
      const c=s.resolution.choice!;
      if(c.kind==='ACTION'&&c.field==='option')s=choose(s,[c.options.find(o=>o.id.endsWith(`:${intercept}`))!.id]);else s=choose(s,c.kind==='TRIGGER'?[]:[c.options[0].id]);
    }
    expect(s.units.some(u=>u.country==='france'&&u.type==='army')).toBe(!intercept);
    expect(s.units.some(u=>u.country==='germany'&&u.type==='army'&&u.regionId==='western_europe')).toBe(intercept);
    expect(s.units.some(u=>u.country==='germany'&&u.type==='air')).toBe(!intercept);
    expect(s.units.some(u=>u.country==='france'&&u.type==='air')).toBe(false);
  });
  it('Barbarossa freezes up to three targets and allows a different attacker for each battle',()=>{
    let s=ready();card(s,'special_162');
    s.units=[unit('germany','army','germany','first'),unit('germany','army','ukraine','second'),unit('soviet_union','army','eastern_europe','target1'),unit('soviet_union','army','moscow','target2')];
    expect(barbarossaTargets(s)).toEqual(['target1','target2']);s=play(s,'special_162',['target1','target2']);
    s=settle(s);expect(s.units.filter(u=>u.country==='soviet_union')).toHaveLength(0);
    const applied=s.events.filter(e=>e.type==='RULE_EVENT'&&e.code==='EFFECT_APPLIED'&&e.text.includes('发起陆战'));
    expect(applied).toHaveLength(2);
  });
  it('completes all 120 country turns with the representative deck and empty piles',()=>{
    let s=ready('germany','TURN_START_WINDOW'),turns=0;
    for(let i=0;s.status!=='FINISHED'&&i<1000;i++) {
      s=settle(s);
      if(s.status==='FINISHED')break;
      if(s.phase==='DISCARD')turns++;
      // Keep this lifecycle fixture below the early-victory threshold.
      if(s.phase==='DISCARD'&&s.activeSeat==='united_states')s.scores.germany=s.scores.united_kingdom+s.scores.soviet_union+s.scores.united_states-s.scores.italy-s.scores.japan-1;
      s=send(s,s.phase==='DISCARD'?{type:'DISCARD_HAND',cardIds:s.decks[s.activeSeat].hand.slice(0,1).map(c=>c.id)}:{type:'ADVANCE_PHASE'});
    }
    expect(turns).toBe(120);expect(s.status).toBe('FINISHED');expect(s.axisBonus).toBe(.5);
  });
  it('Katyusha pays once and cannot retrigger itself or duplicate a later event rule',()=>{
    let s=ready('soviet_union');card(s,'special_51','active');card(s,'land_battle');
    s.units=[unit('soviet_union','army','germany'),unit('germany','army','western_europe'),unit('italy','army','western_europe')];
    s=play(s,'land_battle');
    while(s.resolution!.choice!.kind==='ACTION')s=choose(s,[s.resolution!.choice!.options[0].id]);
    expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['喀秋莎']);
    const hand=s.decks.soviet_union.hand.length;
    s=choose(s,[s.resolution!.choice!.options[0].id]);
    s=choose(s,[s.resolution!.choice!.options[0].id]);s=settle(s);
    expect(s.decks.soviet_union.hand).toHaveLength(hand-1);
    expect(s.units.filter(u=>u.regionId==='western_europe')).toHaveLength(0);
    const applies=s.events.filter(e=>e.type==='RULE_EVENT'&&e.code==='EFFECT_APPLIED'&&e.text.includes('苏联 · 发起陆战'));
    expect(applies).toHaveLength(2);
  });
  it('Wartime Production takes its deck-top fee and executes exactly one additional build',()=>{
    let s=ready('united_states');card(s,'special_83','active');card(s,'build_army');
    const pile=s.decks.united_states.drawPile.length;
    s=play(s,'build_army');s=choose(s,['canada']);
    while(s.resolution!.choice!.kind==='ACTION')s=choose(s,[s.resolution!.choice!.options[0].id]);
    expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('战时生产');
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='战时生产')!.id]);s=settle(s);
    expect(s.decks.united_states.drawPile).toHaveLength(pile-1);
    expect(s.events.filter(e=>e.type==='UNIT_PLACED')).toHaveLength(2);
  });
  it('Thailand response is prepared in advance, recruits on PLAY start and does not spend the play action',()=>{
    let s=ready('japan','TURN_START_WINDOW');card(s,'special_188','faceDown');
    s=send(s,{type:'ADVANCE_PHASE'});
    expect(s.resolution!.choice!.options.map(o=>o.label)).toContain('泰国');
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='泰国')!.id]);s=settle(s);
    expect(s.phase).toBe('PLAY');expect(s.units.some(u=>u.country==='japan'&&u.regionId==='southeast_asia')).toBe(true);
    expect(s.decks.japan.discardPile.some(c=>c.definitionId==='special_188')).toBe(true);
  });
  it('Japan scores the three-navy state only when its condition is met',()=>{
    let s=ready('japan','SUPPLY');card(s,'special_171','active');
    s.units.push(unit('japan','navy','sea_east_china'),unit('japan','navy','sea_south_china'),unit('japan','navy','sea_central_pacific'));
    s=settle(send(s,{type:'ADVANCE_PHASE'}));expect(s.scores.japan).toBe(3);
  });
  it('recycles a complete build plan and resolves free air relocation before resuming',()=>{
    let s=ready();
    s.units=['germany','ukraine','moscow','india','australia','eastern_china','western_europe'].map(id=>unit('germany','army',id));
    s.units.push(unit('germany','air','germany'));
    const hand=s.decks.germany.hand.length;
    startResolution(s,'回收建设','germany',[{kind:'action',country:'germany',action:'build_army',regions:['eastern_europe'],label:'回收后建设'}],[]);
    s=choose(s,['eastern_europe']);
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.id==='build:eastern_europe:germany:army:germany')!.id]);
    expect(s.resolution!.choice!.kind).toBe('RELOCATE');
    s=choose(s,['ukraine']);
    expect(s.units.find(u=>u.type==='air')?.regionId).toBe('ukraine');
    expect(s.decks.germany.hand).toHaveLength(hand);expect(reserve(s,'germany','army')).toBe(0);expect(s.pendingAir).toEqual([]);
  });
  it('binds repeated battle triggers to their event and consumes once-per-turn across ancestor windows',()=>{
    let s=ready();card(s,'special_134','active');card(s,'special_136','active');card(s,'land_battle');
    s=play(s,'land_battle');s=choose(s,['western_europe']);
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='俯冲式轰炸机')!.id]);
    s=choose(s,['western_europe']);
    expect(s.resolution!.choice!.options.filter(o=>o.label==='闪电战')).toHaveLength(1);
    s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='闪电战')!.id]);s=settle(s);
    expect(s.events.filter(e=>e.type==='UNIT_PLACED')).toHaveLength(1);
    expect(s.units.some(u=>u.country==='germany'&&u.regionId==='western_europe')).toBe(true);
  });
});

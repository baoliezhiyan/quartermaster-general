import {it,expect} from 'vitest';
import {createGame,SEATS} from '../src/core';
import type {GameState,CountryId} from '../src/core';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {countryScore,suppliedUnits} from '../src/core/supply';
import {homeRegion,supplySource} from '../src/core/modifiers';
function setup(balance:boolean){const s=createGame('cost-capital',1940,'FULL');s.status='PLAYING';s.round=1;s.phase='PLAY';s.activeSeat='italy';s.rules={preludeEnabled:false,neutralityEnabled:false,...s.rules,balanceEnabled:balance};for(const seat of SEATS)for(const zone of ['hand','drawPile','discardPile','active','faceDown','resolving','removed'] as const)s.decks[seat][zone]=[];return s;}
function add(s:GameState,seat:'italy'|'united_kingdom'|'soviet_union',definitionId:string,id:string,zone:'hand'|'active'='hand'){s.decks[seat][zone].push({id,definitionId,country:seat,deckOwner:seat});}
function choose(s:GameState,ids:string[]){const c=s.resolution!.choice!;expect(resolveChoice(s,c.seat,c.id,ids)).toBe(true);}
it.each([[false,false],[false,true],[true,false],[true,true]])('Bletchley leaves the cancelled enhancement fee in hand, balance=%s guided=%s',(balance,guided)=>{
 const s=setup(balance);s.mode='REPRESENTATIVE';add(s,'italy','special_228','enhance');add(s,'italy','build_army','fee');add(s,'united_kingdom','special_39','stop');add(s,'united_kingdom','build_army','uk-fee');
 s.units=[{id:'home',country:'italy',type:'army',regionId:'italy'},{id:'navy',country:'italy',type:'navy',regionId:'sea_mediterranean'}];
 startResolution(s,'phase','italy',[{kind:'signal',tag:'PHASE:PLAY',label:'出牌开始'}],[],undefined,'discardPile',guided);
 choose(s,[s.resolution!.choice!.options.find(o=>o.label.includes('意大利'))?.id??s.resolution!.choice!.options[0].id]);
 expect(s.resolution!.choice!.kind).toBe('PAY_COST');choose(s,['fee']);
 expect(s.decks.italy.hand.some(c=>c.id==='fee')).toBe(true);
 choose(s,[s.resolution!.choice!.options.find(o=>o.label==='布莱切利园')!.id]);choose(s,['uk-fee']);
 while(s.resolution!.running){const c=s.resolution!.choice!;choose(s,c.options.slice(0,c.min).map(o=>o.id));}
 expect(s.decks.italy.hand.map(c=>c.id)).toEqual(['fee']);expect(s.decks.italy.discardPile.map(c=>c.id)).toEqual(['enhance']);
 expect(s.decks.united_kingdom.discardPile.map(c=>c.id).sort()).toEqual(['stop','uk-fee']);expect(s.units.some(u=>u.type==='air')).toBe(false);
});
it.each([false,true])('relocated Siberia is a supply and scoring point for every country, balance=%s',balance=>{
 const s=setup(balance);add(s,'soviet_union','special_42','capital','active');expect(homeRegion(s,'soviet_union')).toBe('siberia');
 for(const country of [...SEATS,'france','china'] as CountryId[]){
 s.units=[{id:'occupant',country,type:'army',regionId:'siberia'}];
 expect(supplySource(s,country,'siberia',false)).toBe(true);expect(supplySource(s,country,'moscow',true)).toBe(false);
 expect(suppliedUnits(s).has('occupant')).toBe(true);expect(countryScore(s,country)).toBe(2);
 }
});

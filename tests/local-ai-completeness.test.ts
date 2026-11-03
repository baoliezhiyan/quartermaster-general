import {it,expect} from 'vitest';
import {createGame} from '../src/core';
import type {GameState,CountryId} from '../src/core';
import {PRELUDE_CARDS} from '../src/core/cardCatalog';
import {observePlayer} from '../src/localAi/observation';
import {referenceData,referenceIdentity} from '../src/localAi/reference';
import {mapFacts} from '../src/localAi/mapFacts';
import {adjacentRegions,suppliedUnits} from '../src/core/supply';
import {REGIONS,STRAITS} from '../src/core/map';
import {homeRegion,supplySource} from '../src/core/modifiers';
import {reserve,COUNTRY_NAMES} from '../src/core/basic';
import {revealPublic,rememberPublicDiscards,concealPublic} from '../src/core/publicHistory';
// @ts-expect-error Node-only JS cache integration.
import {cachedReference,validReference} from '../scripts/local-ai-reference-cache.mjs';
// @ts-expect-error Node-only fixture files.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const meta={epoch:'test',sequence:1,serverId:'test',userId:'ai',name:'ai',locked:false,replay:false};
function game(){return createGame('ai-completeness',17,'FULL',true,true,true);}
function observation(s:GameState){const o=observePlayer(s,['germany','italy','japan'],meta);if(!('privateCountries'in o))throw Error();return o;}
function install(s:GameState,id:string){for(const d of Object.values(s.decks)){for(const zone of ['hand','drawPile'] as const){const i=d[zone].findIndex(c=>c.definitionId===id);if(i>=0){const c=d[zone].splice(i,1)[0];d.active.push(c);return c;}}}throw Error('missing '+id);}
it('card metadata retains positive and zero tension; ordinary basic card has null tension',()=>{
 const s=game(),positive=PRELUDE_CARDS.find(c=>c.name==='德奥合并')!,zero=PRELUDE_CARDS.find(c=>c.tension===0)!;
 s.prelude!.decks.germany.hand=[positive,zero].map((d,i)=>({id:'fixture:'+i,definitionId:d.id,country:d.country,deckOwner:d.deckOwner}));
 const o=observation(s),cards=o.privateCountries.germany.prelude!.hand;
 expect(cards[0]).toMatchObject({tension:positive.tension,sourceIndex:positive.sourceIndex,text:positive.text,deckOwner:positive.deckOwner});expect(cards[0].tension).toBe(1);expect(cards[1].tension).toBe(0);
 expect(o.privateCountries.germany.hand.find(c=>c.type==='基本牌')!.tension).toBeNull();
});
it('unknown discard identities stay hidden while total, history, armament/response and prelude counts are separate',()=>{
 const s=game(),d=s.decks.united_kingdom,[known,a,b]=d.drawPile.splice(0,3);
 d.discardPile.push(known);revealPublic(s,[known]);rememberPublicDiscards(s);d.discardPile=[];d.hand.push(known);concealPublic(s,[known.id]);
 let o=observation(s),uk=o.public.countries.united_kingdom;expect(uk.discardCount).toBe(0);expect(uk.visibleDiscard.map(c=>c.id)).toEqual([known.id]);
 d.discardPile.push(a,b);const armament=PRELUDE_CARDS.find(c=>c.deckOwner==='united_kingdom'&&c.type==='军备')!;d.faceDown.push({id:'secret-arm',definitionId:armament.id,country:'united_kingdom',deckOwner:'united_kingdom'});
 o=observation(s);uk=o.public.countries.united_kingdom;expect(uk.discardCount).toBe(2);expect(uk.visibleDiscard).toHaveLength(1);expect(uk.armamentCount).toBe(1);expect(uk.responseCount).toBe(d.faceDown.length-1);
 expect(uk.prelude).toEqual({handCount:s.prelude!.decks.united_kingdom.hand.length,deckCount:s.prelude!.decks.united_kingdom.drawPile.length,discardCount:s.prelude!.decks.united_kingdom.discardPile.length});
 const text=JSON.stringify(o);for(const id of [a.id,b.id,'secret-arm'])expect(text).not.toContain(id);
});
it('strait occupation and card-added/removed connections match formal country queries',()=>{
 const s=game(),strait=STRAITS[0];s.units=s.units.filter(u=>u.regionId!==strait.landRegion);s.units.push({id:'occupy',type:'army',country:'germany',regionId:strait.landRegion});
 let o=observation(s);expect(o.mapFacts.countries.germany.adjacency[strait.seaA]).toContain(strait.seaB);expect(o.mapFacts.countries.united_states.adjacency[strait.seaA]).not.toContain(strait.seaB);
 s.units.find(u=>u.id==='occupy')!.country='united_states';o=observation(s);expect(o.mapFacts.countries.united_states.adjacency[strait.seaA]).toContain(strait.seaB);
 install(s,'special_257');install(s,'special_210');install(s,'special_211');o=observation(s);
 expect(o.mapFacts.countries.united_states.adjacency.north_africa).not.toContain('middle_east');expect(o.mapFacts.countries.germany.adjacency.sea_mediterranean).toContain('sea_arabian');
 for(const country of Object.keys(COUNTRY_NAMES) as CountryId[])for(const r of REGIONS)expect(o.mapFacts.countries[country].adjacency[r.id]).toEqual(adjacentRegions(s,country,r.id));
});
it('relocated Soviet capital, card-created and removed supply points and live unit supply reuse formal rules',()=>{
 const s=game();install(s,'special_42');install(s,'special_48');install(s,'special_91');const o=observation(s);
 expect(o.mapFacts.countries.soviet_union.homeRegion).toBe('siberia');expect(o.mapFacts.countries.germany.supplySources).toContain('siberia');expect(o.mapFacts.countries.germany.supplySources).not.toContain('moscow');expect(o.mapFacts.countries.china.supplySources).toContain('western_china');
 for(const country of Object.keys(COUNTRY_NAMES) as CountryId[]){expect(o.mapFacts.countries[country].homeRegion).toBe(homeRegion(s,country));expect(o.mapFacts.countries[country].supplySources).toEqual(REGIONS.filter(r=>supplySource(s,country,r.id,r.supply)).map(r=>r.id));}
 expect(o.mapFacts.units.filter(u=>u.supplied).map(u=>u.id).sort()).toEqual([...suppliedUnits(s)].sort());
});
it('all eight countries reserves follow placement, removal and balance switch without reimplementing limits',()=>{
 const s=game();for(const balance of [false,true]){s.rules!.balanceEnabled=balance;const before=mapFacts(s);s.units.push({id:'italian-extra',type:'army',country:'italy',regionId:'balkans'});const after=observation(s).mapFacts;expect(after.countries.italy.reserve.army).toBe(Number(before.countries.italy.reserve.army)-1);
 for(const c of Object.keys(COUNTRY_NAMES) as CountryId[])for(const type of ['army','navy','air'] as const)expect(after.countries[c].reserve[type]).toBe(reserve(s,c,type));s.units=s.units.filter(u=>u.id!=='italian-extra');expect(mapFacts(s).countries.italy.reserve).toEqual(before.countries.italy.reserve);}
 s.rules!.balanceEnabled=false;const standard=mapFacts(s).countries.italy.reserve.army;s.rules!.balanceEnabled=true;expect(mapFacts(s).countries.italy.reserve.army).toBe(Number(standard)+1);
});
it('static reference cache checks rule identity, schema and digest and refetches stale data',async()=>{
 const o=observation(game()),fresh=await referenceData();expect(fresh.data.map.regions).toEqual(REGIONS);expect(fresh.data.id).toBe(referenceIdentity.id);expect(validReference(fresh,o)).toBe(true);
 const folder='outputs/local-ai-reference-tests';await mkdir(folder,{recursive:true});const path=folder+'/cache.json';await writeFile(path,JSON.stringify({...fresh,data:{...fresh.data,rulesFingerprint:'old'}}));let calls=0;
 const load=async()=>{calls++;return fresh;};expect(await cachedReference(path,o,load)).toEqual(fresh);expect(calls).toBe(1);await cachedReference(path,o,load);expect(calls).toBe(1);
 const bad=JSON.parse(await readFile(path,'utf8'));bad.data.map.regions[0].supply=!bad.data.map.regions[0].supply;await writeFile(path,JSON.stringify(bad));await cachedReference(path,o,load);expect(calls).toBe(2);
 await writeFile(path,'{}');await expect(cachedReference(path,o,async()=>({...fresh,data:{...fresh.data,version:99}}))).rejects.toMatchObject({code:'REFERENCE_MISMATCH'});
});

import {it,expect} from 'vitest';
import {compactObservationChange,applyObservationChange,decisionObservation,decisionSummary} from '../scripts/local-ai-compact.mjs';
import {createGame} from '../src/core';
import {observePlayer} from '../src/localAi/observation';
const observe=(s,sequence=1)=>observePlayer(s,['germany','japan','italy'],{epoch:'epoch',sequence,serverId:'server',userId:'ai',name:'test',locked:false,replay:false});
it('legal baseline plus compact change restores units, scores, logs, private zones and choices without enemy secrets',()=>{
 const s=createGame('compact',17,'FULL',false,false,true);s.publicLog=[{round:1,seat:'germany',text:'initial'}];const a=observe(s),next=structuredClone(s);
 next.units.push({id:'new-public-army',country:'germany',type:'army',regionId:'eastern_europe'});next.units.find(u=>u.country==='japan').regionId='china_east';next.units=next.units.filter(u=>u.country!=='italy');next.scores.germany+=2;
 next.publicLog.push({round:1,seat:'germany',text:'public action'});const d=next.decks.germany;d.hand.push(d.drawPile.shift());d.active.push(d.hand.shift());d.faceDown.push(d.hand.shift());next.revision++;
 const b=observe(next,2),delta=compactObservationChange(a,b);expect(delta.mode).toBe('delta');expect(applyObservationChange(a,delta)).toEqual(decisionObservation(b));expect(delta.newPublicLog).toEqual([next.publicLog[1]]);expect(delta.units.added.some(u=>u.id==='new-public-army')).toBe(true);expect(delta.units.removed.length).toBeGreaterThan(0);expect(delta.units.moved.length).toBeGreaterThan(0);expect(delta.scores.changes.germany.delta).toBe(2);expect(delta.privateAreas.germany.hand).toEqual(b.privateCountries.germany.hand);expect(delta.privateAreas.germany.active).toEqual(b.privateCountries.germany.active);expect(delta.privateAreas.germany.faceDown).toEqual(b.privateCountries.germany.faceDown);
 expect(JSON.stringify(delta)).not.toContain(s.decks.united_states.hand[0].id);expect(decisionSummary(b)).toMatchObject({representation:'decision_summary',changesRequired:true});
});
it.each(['missing','rewind','shortened','replaced','epoch','reference','binding'])('returns an explicit snapshot for %s, including rewind and log truncation',kind=>{
 const s=createGame('compact',17,'FULL',false,false,true);s.publicLog=[{round:1,seat:'germany',text:'first'},{round:1,seat:'germany',text:'second'}];s.revision=5;const a=observe(s,5),b=structuredClone(a);
 if(kind==='rewind'){b.revision=4;b.sequence=4;}if(kind==='shortened')b.public.log.pop();if(kind==='replaced')b.public.log[0].text='changed';if(kind==='epoch')b.epoch='new';if(kind==='reference')b.reference={...b.reference,id:'new'};if(kind==='binding')b.bindings=['germany'];
 const change=compactObservationChange(kind==='missing'?null:a,b);expect(change.mode).toBe('snapshot');expect(applyObservationChange(null,change)).toEqual(decisionObservation(b));
});
it('a wrong receiver baseline is rejected, not silently treated as the latest state',()=>{
 const s=createGame('compact',17,'FULL',false,false,true),a=observe(s),b=observe(s,2),delta=compactObservationChange(a,b);const wrong=structuredClone(a);wrong.public.scores.germany++;
 expect(()=>applyObservationChange(wrong,delta)).toThrow('FULL_SYNC_REQUIRED');expect(()=>applyObservationChange(null,delta)).toThrow('FULL_SYNC_REQUIRED');
});

it('the first public log can appear after a baseline without any log field',()=>{
 const s=createGame('first-log',17,'FULL',false,false,true),a=observe(s);s.publicLog=[{round:1,seat:'germany',text:'first action'}];const b=observe(s,2),change=compactObservationChange(a,b);expect(change.mode).toBe('delta');expect(applyObservationChange(a,change)).toEqual(decisionObservation(b));expect(change.newPublicLog).toHaveLength(1);
});

it('an incomplete or malformed cache falls back to a necessary snapshot rather than emitting a partial delta',()=>{
 const s=createGame('bad-cache',17,'FULL',false,false,true),o=observe(s);for(const damage of [x=>delete x.public.units,x=>x.public.units={},x=>delete x.privateCountries.germany.hand]){const bad=structuredClone(o);damage(bad);const change=compactObservationChange(bad,o);expect(change.mode).toBe('snapshot');expect(applyObservationChange(null,change)).toEqual(decisionObservation(o));}
});

import {it,expect} from 'vitest';
// @ts-expect-error Node-only fixture output.
import {mkdir,writeFile} from 'node:fs/promises';
// @ts-expect-error Node-only size measurement.
import {gzipSync} from 'node:zlib';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay,seal} from '../src/actionReplay/codec';
import {Player} from '../src/actionReplay/player';
import {stateHash,snapshot,restore} from '../src/actionReplay/state';
import {responsePreset} from '../src/controller/responsePresets';
import {captureTransition} from '../src/actionReplay/recorder';
import {transition} from '../src/core/game';
import {SEATS} from '../src/core/types';
import type {Command,GameState} from '../src/core/types';
import {createGame} from '../src/core/game';
import {cardEffects} from '../src/core/specialCards';
import {specialCard} from '../src/core/cardCatalog';
async function send(c:LocalGameController,input:Record<string,unknown>){const s=c.getSnapshot()!;expect(await c.dispatch({seat:s.operatorSeat,expectedRevision:s.revision,...input} as Command)).toEqual({ok:true});}
async function settled(c:LocalGameController){for(let i=0;c.getSnapshot()!.resolution?.running&&i<200;i++){const q=c.getSnapshot()!.resolution!.choice!;expect(q).toBeTruthy();await send(c,{type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids:q.options.slice(0,q.min).map(o=>o.id)});}expect(c.getSnapshot()!.resolution?.running).toBe(false);}
async function load(c:LocalGameController,s:GameState){await c.importSave(JSON.stringify({format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state:s,replayBase:s,rounds:[],nations:[],undo:[],commands:[]}));}
async function replayEquals(c:LocalGameController){const a=await parseReplay(await c.exportReplay()),p=new Player(a),last=a.groups.at(-1)!;expect(await stateHash(await p.seek(last.root.actionId,true))).toBe(await stateHash(c.getSnapshot()!));return a;}
it('records initialization once and keeps six opening decisions with the exact formal boundary',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'delta',seed:1940,mode:'FULL',balance:true});
 for(const seat of SEATS){const s=c.getSnapshot()!;expect(await c.dispatch({type:'KEEP_OPENING',seat,expectedRevision:s.revision,cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)})).toEqual({ok:true});}
 const text=await c.exportReplay(),a=await parseReplay(text),p=new Player(a);
 expect(a.groups.filter(g=>g.root.kind==='opening_keep')).toHaveLength(6);
 expect(a.records.filter(r=>'state'in r)).toHaveLength(2);
 const last=a.groups.at(-1)!;
 expect(await stateHash(await p.seek(last.root.actionId,true))).toBe(await stateHash(c.getSnapshot()!));
 expect(await stateHash(await p.seek(last.root.actionId,true,true))).toBe(await stateHash(c.getSnapshot()!));
 expect(text.length).toBeLessThan(300000);
});
it('keeps multi-effect cards in one group and replays pending, final and undo prefixes',async()=>{
 const s=createGame('multi',1940,'FULL',false,false,false);s.status='PLAYING';s.round=1;s.phase='PLAY';s.setupCompleted=[...SEATS];
 for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand);d.hand=[];}
 const d=s.decks.germany,card=d.drawPile.splice(d.drawPile.findIndex(c=>c.definitionId==='special_158'),1)[0];d.hand.push(card);
 const c=new LocalGameController();await load(c,s);
 await send(c,{type:'PLAY_CARD',cardId:card.id,targetIds:[],effectIndices:cardEffects(s,card).map((_,i)=>i)});
 await replayEquals(c);await settled(c);const a=await replayEquals(c);expect(a.groups).toHaveLength(1);
 await c.undo();expect((await replayEquals(c)).header.recordingRevision).toBe(1);
});
it('replays a whole prelude without intermediate snapshots and crosses two formal round ends',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'prelude-rounds',seed:1940,mode:'FULL',prelude:true,neutrality:true,balance:true});
 for(let i=0;c.getSnapshot()!.prelude?.active&&i<150;i++){
  const s=c.getSnapshot()!,d=s.prelude!.decks[s.activeSeat];const candidates=[...d.hand,...d.drawPile.slice(0,1)];const card=candidates.find(c=>specialCard(c.definitionId,c.balance)?.type==='军备')??candidates[0];
  await send(c,{type:'PLAY_PRELUDE',seat:s.activeSeat,cardId:card.id});await settled(c);
 }
 expect(c.getSnapshot()!.phase).toBe('SETUP');const prelude=await replayEquals(c);expect(prelude.records.filter(r=>'state'in r)).toHaveLength(1);
 for(const seat of SEATS){const s=c.getSnapshot()!;await send(c,{type:'KEEP_OPENING',seat,cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)});}await settled(c);
 const sample=await c.exportReplay(),lines=sample.trimEnd().split('\n'),sizes:Record<string,number>={};for(const line of lines){const kind=JSON.parse(line).type;sizes[kind]=(sizes[kind]??0)+new TextEncoder().encode(line+'\n').length;}
 await mkdir('outputs/match-log-samples',{recursive:true});await writeFile('outputs/match-log-samples/client-prelude-round1.jsonl',sample);
 const begin=performance.now(),parsed=await parseReplay(sample),parseMs=performance.now()-begin,replayBegin=performance.now();await new Player(parsed).seek(parsed.groups.at(-1)!.root.actionId,true,true);
 await writeFile('outputs/action-replay-metrics.json',JSON.stringify({fixture:'client commands, seed 1940, full/prelude/neutrality/balance; formal round 1 not completed',bytes:new TextEncoder().encode(sample).length,gzipBytes:gzipSync(sample).length,byRecordType:sizes,fullSnapshots:parsed.records.filter(r=>'state'in r).length,actions:parsed.groups.length,parseMs,fromStartMs:performance.now()-replayBegin},null,2));
 for(let n=0;c.getSnapshot()!.round<3&&n<100;n++){const s=c.getSnapshot()!;if(s.resolution?.running)await settled(c);else await send(c,s.phase==='DISCARD'?{type:'DISCARD_HAND',cardIds:[]}:{type:'ADVANCE_PHASE'});}
 const a=await replayEquals(c);expect(a.records.filter(r=>r.type==='checkpoint'&&r.boundary==='round_end')).toHaveLength(2);
 const p=new Player(a);expect(await stateHash(await p.seek(a.groups.at(-1)!.root.actionId,true,true))).toBe(await stateHash(c.getSnapshot()!));
},60000);
it('injects recorded shuffle order, verifies exact consumption and rejects missing random results',async()=>{
 const s=createGame('shuffle',1940,'FULL',false,false,true);s.status='PLAYING';s.round=1;s.phase='PLAY';s.setupCompleted=[...SEATS];
 const d=s.decks.germany;d.drawPile.push(...d.hand);d.hand=[];const card=d.drawPile.splice(d.drawPile.findIndex(c=>c.definitionId==='special_153'),1)[0];expect(card).toBeTruthy();d.hand.push(card);
 const c=new LocalGameController();await load(c,s);await send(c,{type:'PLAY_CARD',cardId:card.id,targetIds:[],effectIndices:cardEffects(s,card).map((_,i)=>i)});await settled(c);const a=await replayEquals(c);
 expect(a.records.some(r=>r.type==='shuffle')).toBe(true);
 const bad=a.records.filter(r=>r.type!=='end'&&r.type!=='shuffle').map((r,seq)=>({...r,seq})) as any;
 const corrupted=await parseReplay(await seal(bad));await expect(new Player(corrupted).seek(corrupted.groups.at(-1)!.root.actionId,true)).rejects.toThrow('洗牌');
});
it('serializes pending guided cancellation as patches and can restore it exactly',async()=>{
 const c=new LocalGameController();await c.importSave(JSON.stringify(responsePreset('guided-democracy','cancel')));const s=c.getSnapshot()!,card=s.decks.united_states.hand.find(c=>c.definitionId==='special_98')!;
 await send(c,{type:'PLAY_CARD',seat:'united_states',cardId:card.id,guided:true,targetIds:[],effectIndices:cardEffects(s,card).map((_,i)=>i)});
 const pending=c.getSnapshot()!,encoded=snapshot(pending),restored=restore(encoded);expect(JSON.stringify(encoded)).not.toContain('"rollback":');expect(restored.resolution?.frames.some(f=>f.rollback)).toBe(true);
 expect(await stateHash(restored)).toBe(await stateHash(pending));
 const external=new LocalGameController();await load(external,pending);await settled(external);await replayEquals(external);
});
it('recording hooks do not change RNG, outcomes or unit identity',()=>{
 const cmd={type:'CREATE_GAME' as const,gameId:'observer-equivalence',seed:51,mode:'FULL' as const,prelude:true,balance:true};expect(captureTransition([],()=>transition(null,cmd))).toEqual(transition(null,cmd));
});
it('rejects corrupted, truncated, incompatible and incomplete mandatory histories',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'validation',seed:19,mode:'FULL'});const s=c.getSnapshot()!;await send(c,{type:'KEEP_OPENING',seat:'germany',cardIds:s.decks.germany.hand.slice(0,7).map(c=>c.id)});
 const file=await c.exportReplay(),a=await parseReplay(file);
 await expect(parseReplay(file.slice(0,-1))).rejects.toThrow();await expect(parseReplay(file.split('\n').slice(0,-2).join('\n')+'\n')).rejects.toThrow('end');
 for(const change of [{gameVersion:'other'},{engineFingerprint:'other'},{mode:'resource_pool'},{commandSchemaVersion:'999'}]){const r=structuredClone(a.records.slice(0,-1)) as any;r[0]={...r[0],...change};await expect(parseReplay(await seal(r))).rejects.toThrow();}
 const bad=structuredClone(a.records.slice(0,-1)) as any;bad.find((r:any)=>r.type==='action_group').root.input.cardIds=[];const corrupt=await parseReplay(await seal(bad));await expect(new Player(corrupt).seek(corrupt.groups[0].root.actionId,true)).rejects.toThrow();
 await expect(parseReplay(file.replace('validation','tamperedxx'))).rejects.toThrow();
});

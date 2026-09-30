import {it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {observeFacts} from '../src/core/factObserver';
import {normalize,GAME_VERSION} from '../src/matchLog/normalize';
import {projectFacts,replayNode} from '../src/matchLog/view';
import {parseMatchLog,sealMatchLog,validateFacts} from '../src/matchLog/codec';
import {constructedPool} from './match-fixtures';
import {LocalGameController} from '../src/controller/LocalGameController';
import {SEATS} from '../src/core/types';
it('observer never changes initialization RNG or decisions across both rulesets',()=>{
 for(const prelude of [false,true])for(const balance of [false,true]){const cmd={type:'CREATE_GAME' as const,gameId:'rng',seed:947234,mode:'FULL' as const,prelude,balance,neutrality:true};const a=transition(null,cmd);let seen=0;const b=observeFacts((s)=>{normalize(s);seen++;},()=>transition(null,cmd));expect(b).toEqual(a);expect(seen).toBeGreaterThan(10);}
});
it('constructed A/B snapshots use declared schemas, never the foreign game version',async()=>{
 for(const mode of ['A','B'] as const){const records=constructedPool(mode);const file=await sealMatchLog(records);const archive=await parseMatchLog(file,GAME_VERSION);expect(archive.header.mode).toBe('resource_pool');expect(archive.start.state.areas.some(a=>a.kind==='regular_hand')).toBe(false);const view=replayNode(archive,2,false,'japan');expect(view.state.availability!.germany.openInstanceIds).toEqual([]);expect(view.state.availability!.japan.cycleId).toBe('japan/initial');expect(view.state.areas.find(a=>a.areaId==='germany/resource_discard')!.cardIds).toEqual([]);}
});
it('rejects corruption, truncated files, missing end, unsupported features and false counts',async()=>{
 const records=constructedPool('B'),file=await sealMatchLog(records);await expect(parseMatchLog(file.slice(0,-1),GAME_VERSION)).rejects.toThrow('截断');await expect(parseMatchLog(file.split('\n').slice(0,-2).join('\n')+'\n',GAME_VERSION)).rejects.toThrow('end');await expect(parseMatchLog(file.replace('payment_result','tampered'),GAME_VERSION)).rejects.toThrow('SHA256');
 const bad=structuredClone(records);(bad[0] as any).compatibility.requiredFeatures.push('future.secret.v2');await expect(parseMatchLog(await sealMatchLog(bad),GAME_VERSION)).rejects.toThrow('future.secret.v2');
 const invalid=structuredClone(records);(invalid[1] as any).state.availability.germany.openCount++;await expect(parseMatchLog(await sealMatchLog(invalid),GAME_VERSION)).rejects.toThrow('开放集合');
});
it('six perspectives conceal foreign cards, private prompts, exact order and engine memory',()=>{
 const s=createGame('privacy-facts',5,'FULL',true,true,true);s.responseNotices=[{id:'secret',recipients:['japan'],readBy:[],text:'日本私密提示',cards:s.decks.japan.hand.slice(0,1)}];const full=normalize(s);
 for(const seat of [...SEATS,'public'] as const){const view=projectFacts(full,seat),serialized=JSON.stringify(view);for(const other of SEATS)if(other!==seat){for(const c of s.decks[other].hand)expect(serialized).not.toContain(c.id);}if(seat!=='japan')expect(serialized).not.toContain('日本私密提示');if(seat!=='public')expect(view.areas.find(a=>a.areaId===seat+'/regular_deck')!.ordered).toBe(false);}
});
it('exports a fixed revision while play continues, rejects standard version mismatch',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'concurrent-export',seed:3,mode:'FULL'});const s=c.getSnapshot()!,download=c.exportReplay();const play=c.dispatch({type:'KEEP_OPENING',seat:'germany',expectedRevision:s.revision,cardIds:s.decks.germany.hand.slice(0,7).map(c=>c.id)});const a=await parseMatchLog(await download,GAME_VERSION);await play;expect(a.frames.at(-1)!.state.areas.find(a=>a.areaId==='germany/regular_hand')!.cardIds).toHaveLength(12);const b=await parseMatchLog(await c.exportReplay(),GAME_VERSION);expect(b.frames.at(-1)!.state.areas.find(a=>a.areaId==='germany/regular_hand')!.cardIds).toHaveLength(7);await expect(parseMatchLog(await download,'other')).rejects.toThrow('版本');for(const f of b.frames)validateFacts(f.state,b.header);
},60000);
